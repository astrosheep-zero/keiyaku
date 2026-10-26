import { withoutReportedChanges } from "../akuma/projection.js";
import { observeAkumaRoster, readAkumaTimeline } from "../akuma/akuma.js";
import { readAliases, type AliasBinding } from "../alias/index.js";
import { decodeContractDocument } from "../body/decode.js";
import { assertRegionPattern } from "../body/region.js";
import { contractId } from "../core/facts/types.js";
import { readDispatchesAt, type Dispatch } from "../dispatch/index.js";
import { withGitDecodeChannel, withGitReadObservation, type GitReadObservation } from "../git/read-observation.js";
import { Repo, scopeForRepo } from "../library/repo.js";
import { readDocuments, type ContractDocumentProjection } from "../protocol/read/documents.js";
import { observeCurrentPhysicalIssue } from "../protocol/read/observation.js";
import type { ContractBoard, ContractCatalogue, ContractDisposition } from "../protocol/read/status.js";
import { readContractBoard, readContractCatalogue, readContractPhase } from "../protocol/read/status.js";
import { readDebtHolderProjectionAt, type DebtHolderProjection } from "../settlement/holder.js";
import { contractNamespace } from "../debt/identity.js";
import { observeRecentDebtStatus, DebtAuthorityCorruptionError, type DebtRow } from "../debt/index.js";
import { observeDebtBoard } from "../debt/operations.js";
import type { WorldRoot } from "../world.js";
import type {
  AkumaKanshiWorld,
  ContractEndpointObservation,
  ContractKanshiBoard,
  KanshiCategoryReport,
  KanshiRegionSelection,
  KanshiReport,
  RegionDeclaration,
  RegionRead,
  Section,
  DebtKanshiWorld,
} from "./report.js";
import { ROSTER_SNAPSHOT_ROWS, ROSTER_VISIBLE_ROWS } from "./roster.js";
import { selectKanshi, selectRegion } from "./select.js";

const WORLD_CONTRACT_ROWS = 10;

export type KanshiInput = Readonly<{
  world: WorldRoot | null;
  repo?: Repo;
  region?: KanshiRegionSelection;
  contract?: ContractBoard["rows"][number]["id"];
}>;

export type KanshiObservation = Readonly<{
  report: KanshiReport;
  aliases: Section<readonly AliasBinding[]>;
}>;

function diagnostic(error: unknown): string {
  let source: string;
  if (error instanceof Error) source = error.message;
  else if (typeof error === "object" && error !== null) {
    try {
      source = JSON.stringify(error);
    } catch {
      source = String(error);
    }
  } else source = String(error);
  const line = source.replaceAll(/\s+/gu, " ").trim();
  return line.length <= 240 ? line : `${line.slice(0, 239)}…`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`kanshi ${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new TypeError(`kanshi ${label} has unknown field: ${key}`);
}

function validateRegionPatterns(patterns: unknown): readonly [string, ...string[]] {
  if (!Array.isArray(patterns) || patterns.length === 0)
    throw new Error("Region query requires one or more path patterns");
  return patterns.map((pattern) => {
    if (typeof pattern !== "string") throw new Error("Region path patterns must be strings");
    return assertRegionPattern(pattern);
  }) as [string, ...string[]];
}

function readRegionDeclarations(documents: readonly ContractDocumentProjection[]): readonly RegionDeclaration[] {
  return documents.map((document) => ({
    contract: document.contract,
    patterns: decodeContractDocument(document.documentBytes).region,
  }));
}

function regionSelection(value: unknown): KanshiRegionSelection {
  const selection = record(value, "region selection");
  if (typeof selection.kind !== "string") throw new TypeError("kanshi region selection kind must be a string");
  if (selection.kind === "declarations") {
    exactKeys(selection, ["kind"], "region selection");
    return { kind: "declarations" };
  }
  if (selection.kind === "contract") {
    exactKeys(selection, ["kind", "contract"], "region selection");
    if (typeof selection.contract !== "string") throw new TypeError("kanshi region contract must be a ContractId");
    try {
      return { kind: "contract", contract: contractId(selection.contract) };
    } catch {
      throw new TypeError("kanshi region contract must be a canonical ContractId");
    }
  }
  if (selection.kind === "path") {
    exactKeys(selection, ["kind", "patterns"], "region selection");
    try {
      return { kind: "path", patterns: validateRegionPatterns(selection.patterns) };
    } catch (error) {
      throw new TypeError(error instanceof Error ? error.message : String(error));
    }
  }
  throw new TypeError(`kanshi region selection kind is invalid: ${selection.kind}`);
}

function worldCoordinate(world: unknown, repo: unknown): void {
  if (world !== null && (typeof world !== "string" || world.trim().length === 0))
    throw new TypeError("kanshi world must be a WorldRoot or null");
  if (repo !== undefined && !(repo instanceof Repo)) throw new TypeError("kanshi repo must be a Repo");
}

function coordinate(input: KanshiInput): KanshiInput {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new TypeError("kanshi input must be an object");
  for (const key of Object.keys(input)) {
    if (!["world", "repo", "region", "contract"].includes(key)) {
      throw new TypeError(`kanshi input has unknown field: ${key}`);
    }
  }
  worldCoordinate(input.world, input.repo);
  return {
    ...input,
    ...(input.region === undefined ? {} : { region: regionSelection(input.region) }),
    ...(input.contract === undefined ? {} : { contract: contractId(input.contract) }),
  };
}

async function readRegion(
  observation: GitReadObservation,
  selection: KanshiRegionSelection,
): Promise<Section<RegionRead>> {
  try {
    const declarations: readonly RegionDeclaration[] = [
      ...readRegionDeclarations(await readDocuments(observation)),
    ].sort((left, right) => left.contract.localeCompare(right.contract));
    return { kind: "present", value: selectRegion({ declarations, selection }) };
  } catch (error) {
    return { kind: "failed", failure: { message: diagnostic(error) } };
  }
}

async function readBranch(repo?: Repo): Promise<string | null> {
  if (repo === undefined) return null;
  try {
    return await repo.currentBranch();
  } catch {
    return null;
  }
}

async function readContracts(
  observation: GitReadObservation,
  include?: ContractBoard["rows"][number]["id"],
  limit = WORLD_CONTRACT_ROWS,
): Promise<Section<ContractBoard | ContractCatalogue>> {
  try {
    return {
      kind: "present",
      value:
        include === undefined
          ? await readContractCatalogue(observation, limit)
          : await readContractBoard(observation, include),
    };
  } catch (error) {
    return { kind: "failed", failure: { message: diagnostic(error) } };
  }
}

type HolderRead = Section<DebtHolderProjection>;
type DispatchRead = Section<readonly Dispatch[]>;

async function readHolders(observation: GitReadObservation): Promise<HolderRead> {
  try {
    return { kind: "present", value: await readDebtHolderProjectionAt(observation) };
  } catch (error) {
    return { kind: "failed", failure: { message: diagnostic(error) } };
  }
}

function attachRoster(
  contracts: Section<ContractKanshiBoard>,
  akuma: Section<AkumaKanshiWorld>,
  dispatches: DispatchRead,
): Section<ContractKanshiBoard> {
  if (contracts.kind !== "present") return contracts;
  if (dispatches.kind === "failed" || akuma.kind === "failed") {
    return {
      kind: "present",
      value: {
        ...contracts.value,
        rows: contracts.value.rows.map((row) => ({ ...row, roster: [], rosterUnavailable: true })),
      },
    };
  }
  if (dispatches.kind === "absent" || akuma.kind === "absent") {
    return {
      kind: "present",
      value: { ...contracts.value, rows: contracts.value.rows.map((row) => ({ ...row, roster: [] })) },
    };
  }
  const attachments = new Map<string, ContractKanshiBoard["rows"][number]["roster"][number][]>();
  for (const row of akuma.value.rows) {
    if (row.contract === undefined) continue;
    const current = attachments.get(row.contract.id) ?? [];
    current.push({
      id: row.id,
      aliases: row.aliases,
      ...(akuma.value.aliasesUnavailable === true ? { aliasesUnavailable: true as const } : {}),
    });
    attachments.set(row.contract.id, current);
  }
  return {
    kind: "present",
    value: {
      ...contracts.value,
      rows: contracts.value.rows.map((row) => ({ ...row, roster: attachments.get(row.id) ?? [] })),
    },
  };
}

function decorateContracts(
  contracts: Section<ContractBoard | ContractCatalogue>,
  holders: HolderRead,
  dispatches: DispatchRead,
  namespaceDebts?: (id: ContractBoard["rows"][number]["id"]) => Section<readonly DebtRow[]> | undefined,
): Section<ContractKanshiBoard> {
  if (contracts.kind !== "present") return contracts;
  return {
    kind: "present",
    value: {
      ...contracts.value,
      rows: contracts.value.rows.map((row) => {
        const selected = namespaceDebts?.(row.id);
        const holder = holders.kind === "present" ? holders.value.get(row.id) : undefined;
        return {
          ...row,
          roster: [],
          ...(dispatches.kind === "failed" ? { rosterUnavailable: true as const } : {}),
          ...(selected === undefined ? {} : { namespaceDebts: selected }),
          holder:
            holders.kind === "failed"
              ? { kind: "unavailable" as const }
              : holder?.disposition === "held"
                ? { kind: "held" as const, debtId: holder.debtId }
                : { kind: "none" as const },
        };
      }),
    },
  };
}

type ObserveContractEndpoint = (id: string) => ContractEndpointObservation;

function contractEndpointObserver(contracts: Section<ContractKanshiBoard>): ObserveContractEndpoint {
  if (contracts.kind !== "present") return () => "unavailable";
  const dispositions = new Map<string, ContractDisposition>(
    contracts.value.rows.map((row) => [row.id, row.disposition]),
  );
  return (id) => {
    const disposition = dispositions.get(id);
    if (disposition !== undefined) return disposition;
    return "hasMore" in contracts.value ? "unavailable" : "missing";
  };
}

function joinDebts(
  section: Section<DebtKanshiWorld>,
  holders: HolderRead,
  observeContract: ObserveContractEndpoint,
): Section<DebtKanshiWorld> {
  if (section.kind !== "present") return section;
  const associations = new Map(
    holders.kind === "present"
      ? [...holders.value.values()]
          .filter((holder) => holder.disposition === "held")
          .map((holder) => [holder.debtId, holder.contractId] as const)
      : [],
  );
  return {
    kind: "present",
    value: {
      ...section.value,
      rows: section.value.rows.map((row) => {
        if (holders.kind === "failed") return { ...row, contractAssociationUnavailable: true as const };
        const id = associations.get(row.id);
        return id === undefined ? row : { ...row, contract: { id, observed: observeContract(id) } };
      }),
    },
  };
}

type DebtWorldRead =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "present"; observation: Awaited<ReturnType<typeof observeDebtBoard>> }>
  | Readonly<{ kind: "failed"; failure: Readonly<{ message: string; coordinate?: string }> }>;

/** Attribute a Debt board failure to the malformed document that caused it, when one is known. */
function debtFailure(error: unknown): Readonly<{ message: string; coordinate?: string }> {
  return {
    message: diagnostic(error),
    ...(error instanceof DebtAuthorityCorruptionError && error.coordinate !== undefined
      ? { coordinate: error.coordinate }
      : {}),
  };
}

async function readDebtWorld(path: WorldRoot | null): Promise<DebtWorldRead> {
  if (path === null) return { kind: "absent" };
  try {
    return { kind: "present", observation: await observeDebtBoard(path) };
  } catch (error) {
    return { kind: "failed", failure: debtFailure(error) };
  }
}

/**
 * A selected Contract's own Debt namespace view. A failed Debt board is reported once by the
 * board's Debt section, so the entity block omits it rather than repeating the same row.
 */
function namespaceDebtSection(
  board: DebtWorldRead,
  id: ContractBoard["rows"][number]["id"],
): Section<readonly DebtRow[]> | undefined {
  if (board.kind === "absent") return { kind: "absent" };
  if (board.kind === "failed") return undefined;
  return { kind: "present", value: board.observation.selectNamespace(contractNamespace(id)) };
}

function debtRowsFromBoard(path: WorldRoot | null, board: DebtWorldRead): Section<DebtKanshiWorld> {
  if (path === null || board.kind === "absent") return { kind: "absent" };
  if (board.kind === "failed") return { kind: "failed", failure: board.failure };
  const recent = board.observation.selectRecentStatus(10);
  return {
    kind: "present",
    value: {
      root: path,
      hasMore: recent.hasMore,
      rows: recent.rows.map((row) => {
        const copy = { ...row };
        delete copy.children;
        return copy;
      }),
    },
  };
}

async function readDebtRows(path: WorldRoot | null): Promise<Section<DebtKanshiWorld>> {
  if (path === null) return { kind: "absent" };
  try {
    const recent = await observeRecentDebtStatus(path, { limit: 10 });
    return {
      kind: "present",
      value: { root: path, hasMore: recent.hasMore, rows: recent.rows },
    };
  } catch (error) {
    return { kind: "failed", failure: debtFailure(error) };
  }
}
/**
 * Placement discharge for the observed roster snapshots: an associated Contract
 * whose own observation proves it claimed has placed the candidate those
 * reported changes describe, so the composite report no longer presents them
 * as pending. An unproven or failed Contract read keeps the changes.
 */
async function claimedAssociatedContracts(
  observation: GitReadObservation,
  dispatches: readonly Dispatch[],
): Promise<ReadonlySet<string>> {
  const ids = [...new Set(dispatches.map((dispatch) => dispatch.contractId))];
  const claimed = new Set<string>();
  await Promise.all(
    ids.map(async (id) => {
      try {
        if ((await readContractPhase(observation, id)) === "claimed") claimed.add(id);
      } catch {
        /* unproven placement keeps reported changes */
      }
    }),
  );
  return claimed;
}

type AkumaProductRow = Awaited<ReturnType<typeof observeAkumaRoster>>["rows"][number] & {
  snapshot?: Awaited<ReturnType<typeof readAkumaTimeline>>;
};
type AkumaProductWorld = Omit<AkumaKanshiWorld, "rows"> & Readonly<{ rows: readonly AkumaProductRow[] }>;

async function readAkumaProduct(path: WorldRoot, limit = ROSTER_VISIBLE_ROWS): Promise<Section<AkumaProductWorld>> {
  try {
    const source = await observeAkumaRoster(path, limit);
    const snapshots = new Map(
      await Promise.all(
        source.rows.slice(0, ROSTER_SNAPSHOT_ROWS).map(async (row) => {
          try {
            return [row.id, await readAkumaTimeline(path, row.id)] as const;
          } catch {
            return [row.id, undefined] as const;
          }
        }),
      ),
    );
    return {
      kind: "present",
      value: {
        ...source,
        rows: source.rows.map((row) => {
          const snapshot = snapshots.get(row.id);
          return snapshot === undefined ? row : { ...row, snapshot };
        }),
      },
    };
  } catch (error) {
    return { kind: "failed", failure: { message: diagnostic(error) } };
  }
}

function attachAkumaAssociations(
  product: Section<AkumaProductWorld>,
  aliases: Section<readonly AliasBinding[]>,
  dispatches: DispatchRead,
  observeContract: ObserveContractEndpoint,
  claimed: ReadonlySet<string>,
): Section<AkumaKanshiWorld> {
  if (product.kind !== "present") return product;
  const aliasById = new Map<string, AliasBinding[]>();
  if (aliases.kind === "present") {
    for (const binding of aliases.value)
      aliasById.set(binding.akuId, [...(aliasById.get(binding.akuId) ?? []), binding]);
  }
  const dispatchById = new Map(
    dispatches.kind === "present" ? dispatches.value.map((dispatch) => [dispatch.akuId, dispatch] as const) : [],
  );
  return {
    kind: "present",
    value: {
      ...product.value,
      ...(aliases.kind === "failed" ? { aliasesUnavailable: true as const } : {}),
      rows: product.value.rows.map((row) => {
        const dispatch = dispatchById.get(row.id);
        const snapshot = row.snapshot;
        const placed = dispatch !== undefined && claimed.has(dispatch.contractId);
        return {
          ...row,
          aliases: aliases.kind === "present" ? (aliasById.get(row.id) ?? []).map((binding) => binding.alias) : [],
          ...(dispatches.kind === "failed"
            ? { contractAssociationUnavailable: true as const }
            : dispatch === undefined
              ? {}
              : {
                  contract: {
                    id: dispatch.contractId,
                    observed: observeContract(dispatch.contractId),
                  },
                }),
          ...(snapshot === undefined ? {} : { snapshot: placed ? withoutReportedChanges(snapshot) : snapshot }),
        };
      }),
    },
  };
}

async function readAliasBindings(path: WorldRoot): Promise<Section<readonly AliasBinding[]>> {
  try {
    return { kind: "present", value: await readAliases(path) };
  } catch (error) {
    return { kind: "failed", failure: { message: diagnostic(error) } };
  }
}

async function readDispatches(observation: GitReadObservation): Promise<DispatchRead> {
  try {
    return { kind: "present", value: await readDispatchesAt(observation) };
  } catch (error) {
    return { kind: "failed", failure: { message: diagnostic(error) } };
  }
}

async function observeWithoutRepo(
  world: WorldRoot | null,
  region: KanshiRegionSelection | undefined,
  observedAt: string,
  branch: string | null,
): Promise<KanshiObservation> {
  const contracts = { kind: "absent" as const };
  const holders = { kind: "absent" as const };
  const dispatches = { kind: "absent" as const };
  const [debtRows, aliases, akumaProduct] =
    world === null
      ? ([{ kind: "absent" as const }, { kind: "absent" as const }, { kind: "absent" as const }] as const)
      : await Promise.all([readDebtRows(world), readAliasBindings(world), readAkumaProduct(world)]);
  const observeContract = contractEndpointObserver(contracts);
  const debts = world === null ? debtRows : joinDebts(debtRows, holders, observeContract);
  const akuma =
    world === null
      ? akumaProduct
      : attachAkumaAssociations(akumaProduct, aliases, dispatches, observeContract, new Set());
  return {
    report: {
      root: world,
      observedAt,
      branch,
      contracts,
      debts,
      akuma,
      ...(region === undefined ? {} : { region: { kind: "absent" as const } }),
    },
    aliases,
  };
}

type RepoObservationInput = Readonly<{
  world: WorldRoot | null;
  repo: ReturnType<typeof scopeForRepo>;
  region: KanshiRegionSelection | undefined;
  contract: ContractBoard["rows"][number]["id"] | undefined;
  observedAt: string;
  branch: string | null;
}>;

async function observeRepo(input: RepoObservationInput): Promise<KanshiObservation> {
  const { world, repo, region, contract, observedAt, branch } = input;
  const [initialDebtRows, aliases, akumaProduct] =
    world === null
      ? ([{ kind: "absent" as const }, { kind: "absent" as const }, { kind: "absent" as const }] as const)
      : await Promise.all([
          contract === undefined ? readDebtRows(world) : Promise.resolve(undefined),
          readAliasBindings(world),
          readAkumaProduct(world),
        ]);
  let observedDebtRows = initialDebtRows;
  try {
    return await withGitDecodeChannel(repo, (channel) =>
      withGitReadObservation(repo, channel, async (observation) => {
        const [contractSection, holders, dispatches, regionSection] = await Promise.all([
          readContracts(observation, contract),
          readHolders(observation),
          readDispatches(observation),
          region === undefined ? Promise.resolve(undefined) : readRegion(observation, region),
        ]);
        const selectedContract =
          contract !== undefined &&
          contractSection.kind === "present" &&
          contractSection.value.rows.some((row) => row.id === contract);
        const board = selectedContract ? await readDebtWorld(world) : undefined;
        observedDebtRows =
          world === null
            ? { kind: "absent" as const }
            : board === undefined
              ? (initialDebtRows ?? (await readDebtRows(world)))
              : debtRowsFromBoard(world, board);
        const contracts = decorateContracts(
          contractSection,
          holders,
          dispatches,
          board === undefined ? undefined : (id) => (id === contract ? namespaceDebtSection(board, id) : undefined),
        );
        const observeContract = contractEndpointObserver(contracts);
        const debts =
          world === null ? observedDebtRows : joinDebts(observedDebtRows, holders, observeContract);
        const claimed =
          dispatches.kind === "present"
            ? await claimedAssociatedContracts(observation, dispatches.value)
            : new Set<string>();
        const akuma =
          world === null
            ? akumaProduct
            : attachAkumaAssociations(akumaProduct, aliases, dispatches, observeContract, claimed);
        const assembled = {
          root: world,
          observedAt,
          branch,
          contracts: attachRoster(contracts, akuma, dispatches),
          debts,
          akuma,
          ...(regionSection === undefined ? {} : { region: regionSection }),
        } satisfies KanshiReport;
        if (contract === undefined) return { report: assembled, aliases };
        const selected = selectKanshi({ report: assembled, contract });
        return {
          report: {
            ...selected,
            contracts: await attachSelectedIssue(observation, selected.contracts, contract),
          },
          aliases,
        };
      }),
    );
  } catch (error) {
    const failure = { kind: "failed" as const, failure: { message: diagnostic(error) } };
    observedDebtRows ??= await readDebtRows(world);
    const observeContract = contractEndpointObserver(failure);
    return {
      report: {
        root: world,
        observedAt,
        branch,
        contracts: failure,
        debts: world === null ? { kind: "absent" } : joinDebts(observedDebtRows, failure, observeContract),
        akuma:
          world === null
            ? { kind: "absent" }
            : attachAkumaAssociations(akumaProduct, aliases, failure, observeContract, new Set()),
        ...(region === undefined ? {} : { region: failure }),
      },
      aliases,
    };
  }
}

export async function observeKanshi(input: KanshiInput): Promise<KanshiObservation> {
  const observedAt = new Date().toISOString();
  const { world, repo, region, contract } = coordinate(input);
  const branch = await readBranch(repo);
  if (repo === undefined) return observeWithoutRepo(world, region, observedAt, branch);
  return observeRepo({ world, repo: scopeForRepo(repo), region, contract, observedAt, branch });
}

export async function kanshi(input: KanshiInput): Promise<KanshiReport> {
  return (await observeKanshi(input)).report;
}

export type KanshiCategoryInput = Readonly<{
  world: WorldRoot | null;
  repo?: Repo;
  category: KanshiCategoryReport["category"];
  limit?: number;
}>;

/** Category observations reuse owner rows without reading the Debt board. */
async function observeAkumaCategory(
  world: WorldRoot | null,
  repo: ReturnType<typeof scopeForRepo> | undefined,
  limit: number,
  observedAt: string,
): Promise<KanshiCategoryReport> {
  const report = (akuma: Section<AkumaKanshiWorld>): KanshiCategoryReport => ({
    category: "akuma",
    root: world,
    observedAt,
    akuma,
  });
  if (world === null) return report({ kind: "absent" });
  const aliases = await readAliasBindings(world);
  const product = await readAkumaProduct(world, limit);
  const compose = (dispatches: DispatchRead, claimed: ReadonlySet<string>): KanshiCategoryReport =>
    report(attachAkumaAssociations(product, aliases, dispatches, () => "unavailable", claimed));
  if (repo === undefined) return compose({ kind: "absent" }, new Set());
  try {
    return await withGitDecodeChannel(repo, (channel) =>
      withGitReadObservation(repo, channel, async (observation) => {
        const dispatches = await readDispatches(observation);
        const claimed =
          dispatches.kind === "present"
            ? await claimedAssociatedContracts(observation, dispatches.value)
            : new Set<string>();
        return compose(dispatches, claimed);
      }),
    );
  } catch (error) {
    const failure = { kind: "failed" as const, failure: { message: diagnostic(error) } };
    return compose(failure, new Set());
  }
}

async function observeContractCategory(
  world: WorldRoot | null,
  repo: ReturnType<typeof scopeForRepo>,
  limit: number,
  observedAt: string,
): Promise<KanshiCategoryReport> {
  const report = (contracts: Section<ContractKanshiBoard>): KanshiCategoryReport => ({
    category: "contract",
    root: world,
    observedAt,
    contracts,
  });
  try {
    return await withGitDecodeChannel(repo, (channel) =>
      withGitReadObservation(repo, channel, async (observation) => {
        const [contracts, holders] = await Promise.all([
          readContracts(observation, undefined, limit),
          readHolders(observation),
        ]);
        return report(decorateContracts(contracts, holders, { kind: "absent" }));
      }),
    );
  } catch (error) {
    return report({ kind: "failed", failure: { message: diagnostic(error) } });
  }
}

const DEFAULT_CATEGORY_LIMIT = 10;

/** Caller-invalid category requests are refused here, before any owner observation runs. */
function validateCategoryInput(input: KanshiCategoryInput): void {
  const value = record(input, "category input");
  exactKeys(value, ["world", "repo", "category", "limit"], "category input");
  worldCoordinate(value.world, value.repo);
  if (value.category !== "akuma" && value.category !== "contract")
    throw new TypeError(`kanshi category is invalid: ${String(value.category)}`);
  const { limit } = value;
  if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1))
    throw new TypeError("kanshi category limit must be a positive safe integer");
}

export async function kanshiCategory(input: KanshiCategoryInput): Promise<KanshiCategoryReport> {
  const observedAt = new Date().toISOString();
  validateCategoryInput(input);
  const { world, repo, category, limit = DEFAULT_CATEGORY_LIMIT } = input;
  if (category === "contract") {
    if (repo === undefined) throw new TypeError("kanshi contract category requires a Repo");
    return await observeContractCategory(world, scopeForRepo(repo), limit, observedAt);
  }
  return await observeAkumaCategory(world, repo === undefined ? undefined : scopeForRepo(repo), limit, observedAt);
}

async function attachSelectedIssue(
  observation: GitReadObservation,
  contracts: Section<ContractKanshiBoard>,
  selected: ContractBoard["rows"][number]["id"],
): Promise<Section<ContractKanshiBoard>> {
  if (contracts.kind !== "present") return contracts;
  try {
    const rows = await Promise.all(
      contracts.value.rows.map(async (row) => {
        if (row.id !== selected) return row;
        const issue = await observeCurrentPhysicalIssue(observation.repository, row);
        return issue === undefined ? row : { ...row, issue };
      }),
    );
    return { kind: "present", value: { ...contracts.value, rows } };
  } catch (error) {
    return { kind: "failed", failure: { message: diagnostic(error) } };
  }
}
