import { Repo } from "../library/repo.js";
import type { ContractBoard, ContractCatalogue, ContractDisposition } from "../library/contract.js";
import { scopeForRepo } from "../library/repo.js";
import { observeTaskBoard } from "../task/operations.js";
import { contractNamespace } from "../task/identity.js";
import { Akuma } from "../akuma/index.js";
import { readAliases, type AliasBinding } from "../alias/index.js";
import { readDispatchesAt, type Dispatch } from "../dispatch/index.js";
import { readTaskHolderProjectionAt, type TaskHolderProjection } from "../settlement/holder.js";
import { observeCurrentPhysicalIssue } from "../protocol/read/observation.js";
import { readContractBoard, readContractCatalogue } from "../protocol/read/status.js";
import { withGitDecodeChannel, withGitReadObservation, type GitReadObservation } from "../git/read-observation.js";
import { readDocuments } from "../protocol/read/documents.js";
import { readRegionDeclarations, validateRegionPatterns } from "../library/region.js";
import { contractId } from "../core/facts/types.js";
import { selectKanshi, selectRegion } from "./select.js";
import { FLEET_SNAPSHOT_ROWS, FLEET_VISIBLE_ROWS } from "./fleet.js";
import { observeRecentTaskStatus, type TaskRow } from "../task/index.js";
import type {
  AkumaKanshiWorld,
  ContractEndpointObservation,
  ContractKanshiBoard,
  KanshiReport,
  Section,
  TaskKanshiRow,
  TaskKanshiWorld,
  KanshiRegionSelection,
  RegionDeclaration,
  RegionRead,
} from "./report.js";
import type { WorldRoot } from "../world.js";

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

function coordinate(input: KanshiInput): KanshiInput {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new TypeError("kanshi input must be an object");
  for (const key of Object.keys(input)) {
    if (!["world", "repo", "region", "contract"].includes(key)) {
      throw new TypeError(`kanshi input has unknown field: ${key}`);
    }
  }
  if (input.world !== null && (typeof input.world !== "string" || input.world.trim().length === 0)) {
    throw new TypeError("kanshi world must be a WorldRoot or null");
  }
  if (input.repo !== undefined && !(input.repo instanceof Repo)) throw new TypeError("kanshi repo must be a Repo");
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
): Promise<Section<ContractBoard | ContractCatalogue>> {
  try {
    return {
      kind: "present",
      value:
        include === undefined
          ? await readContractCatalogue(observation, 10)
          : await readContractBoard(observation, include),
    };
  } catch (error) {
    return { kind: "failed", failure: { message: diagnostic(error) } };
  }
}

type HolderRead = Section<TaskHolderProjection>;
type DispatchRead = Exclude<Section<readonly Dispatch[]>, Readonly<{ kind: "absent" }>>;

async function readHolders(observation: GitReadObservation): Promise<HolderRead> {
  try {
    return { kind: "present", value: await readTaskHolderProjectionAt(observation) };
  } catch (error) {
    return { kind: "failed", failure: { message: diagnostic(error) } };
  }
}

function attachFleet(
  contracts: Section<ContractKanshiBoard>,
  akuma: Section<AkumaKanshiWorld>,
): Section<ContractKanshiBoard> {
  if (contracts.kind !== "present") return contracts;
  const attachments = new Map<string, ContractKanshiBoard["rows"][number]["fleet"][number][]>();
  if (akuma.kind === "present") {
    for (const row of akuma.value.rows) {
      if (row.contract === undefined) continue;
      const current = attachments.get(row.contract.id) ?? [];
      current.push({ id: row.id, aliases: row.aliases });
      attachments.set(row.contract.id, current);
    }
  }
  return {
    kind: "present",
    value: {
      ...contracts.value,
      rows: contracts.value.rows.map((row) => ({ ...row, fleet: attachments.get(row.id) ?? [] })),
    },
  };
}

function decorateContracts(
  contracts: Section<ContractBoard | ContractCatalogue>,
  holders: HolderRead,
  namespaceTasks?: (id: ContractBoard["rows"][number]["id"]) => Section<readonly TaskRow[]> | undefined,
): Section<ContractKanshiBoard> {
  if (contracts.kind !== "present") return contracts;
  return {
    kind: "present",
    value: {
      ...contracts.value,
      rows: contracts.value.rows.map((row) => {
        const selected = namespaceTasks?.(row.id);
        if (holders.kind === "failed") {
          return {
            ...row,
            holder: { kind: "unavailable" as const },
            fleet: [],
            ...(selected === undefined ? {} : { namespaceTasks: selected }),
          };
        }
        const holder = holders.kind === "present" ? holders.value.get(row.id) : undefined;
        return {
          ...row,
          fleet: [],
          ...(selected === undefined ? {} : { namespaceTasks: selected }),
          holder:
            holder?.disposition === "held"
              ? { kind: "held" as const, taskId: holder.taskId }
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

function joinTasks(
  rows: ReadonlyArray<Awaited<ReturnType<typeof observeRecentTaskStatus>>["rows"][number]>,
  holders: HolderRead,
  observeContract: ObserveContractEndpoint,
): readonly TaskKanshiRow[] {
  const associations = new Map(
    holders.kind === "present"
      ? [...holders.value.values()]
          .filter((holder) => holder.disposition === "held")
          .map((holder) => [holder.taskId, holder.contractId] as const)
      : [],
  );
  return rows.map((row) => {
    const contractId = associations.get(row.id);
    if (contractId === undefined) return row;
    return { ...row, contract: { id: contractId, observed: observeContract(contractId) } };
  });
}

type TaskWorldRead =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "present"; observation: Awaited<ReturnType<typeof observeTaskBoard>> }>
  | Readonly<{ kind: "failed"; failure: Readonly<{ message: string }> }>;

async function readTaskWorld(path: WorldRoot | null): Promise<TaskWorldRead> {
  if (path === null) return { kind: "absent" };
  try {
    return { kind: "present", observation: await observeTaskBoard(path) };
  } catch (error) {
    return { kind: "failed", failure: { message: diagnostic(error) } };
  }
}

function namespaceTaskSection(
  board: TaskWorldRead,
  id: ContractBoard["rows"][number]["id"],
): Section<readonly TaskRow[]> {
  if (board.kind === "absent") return { kind: "absent" };
  if (board.kind === "failed") return { kind: "failed", failure: board.failure };
  return { kind: "present", value: board.observation.selectNamespace(contractNamespace(id)) };
}

async function readTasks(
  path: WorldRoot,
  holders: HolderRead,
  observeContract: ObserveContractEndpoint,
): Promise<Section<TaskKanshiWorld>> {
  if (holders.kind === "failed") return { kind: "failed", failure: holders.failure };
  return observeRecentTaskStatus(path, { limit: 10 }).then(
    (recent) => ({
      kind: "present" as const,
      value: { root: path, hasMore: recent.hasMore, rows: joinTasks(recent.rows, holders, observeContract) },
    }),
    (error: unknown) => ({ kind: "failed" as const, failure: { message: diagnostic(error) } }),
  );
}

async function joinAkuma(
  path: WorldRoot,
  observeContract: ObserveContractEndpoint,
  dispatches: readonly Dispatch[],
  aliases: Section<readonly AliasBinding[]>,
): Promise<Section<AkumaKanshiWorld>> {
  if (aliases.kind !== "present") return aliases;
  try {
    const source = await Akuma.of(path).list({ limit: FLEET_VISIBLE_ROWS });
    const aliasById = new Map<string, typeof aliases.value>();
    for (const binding of aliases.value)
      aliasById.set(binding.akuId, [...(aliasById.get(binding.akuId) ?? []), binding]);
    const dispatchById = new Map(dispatches.map((dispatch) => [dispatch.akuId, dispatch]));
    const rows = source.rows.map((row) => {
      const dispatch = dispatchById.get(row.id);
      return {
        ...row,
        aliases: (aliasById.get(row.id) ?? []).map((binding) => binding.alias),
        ...(dispatch === undefined
          ? {}
          : {
              contract: {
                id: dispatch.contractId,
                observed: observeContract(dispatch.contractId),
              },
            }),
      };
    });
    const snapshotRows = rows.slice(0, FLEET_SNAPSHOT_ROWS);
    const snapshots = new Map(
      await Promise.all(
        snapshotRows.map(async (row) => {
          try {
            return [row.id, (await Akuma.of(path).of({ id: row.id }).status()).timeline] as const;
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
        rows: rows.map((row) => {
          const snapshot = snapshots.get(row.id);
          return snapshot === undefined ? row : { ...row, snapshot };
        }),
      },
    };
  } catch (error) {
    return { kind: "failed", failure: { message: diagnostic(error) } };
  }
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
  const observeContract = contractEndpointObserver(contracts);
  const tasks = world === null ? { kind: "absent" as const } : await readTasks(world, holders, observeContract);
  const aliases = world === null ? { kind: "absent" as const } : await readAliasBindings(world);
  const akuma = world === null ? { kind: "absent" as const } : await joinAkuma(world, observeContract, [], aliases);
  return {
    report: {
      root: world,
      observedAt,
      branch,
      contracts,
      tasks,
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
        const board = selectedContract ? await readTaskWorld(world) : undefined;
        const contracts = decorateContracts(
          contractSection,
          holders,
          selectedContract ? (id) => (id === contract ? namespaceTaskSection(board!, id) : undefined) : undefined,
        );
        const observeContract = contractEndpointObserver(contracts);
        const aliases = world === null ? { kind: "absent" as const } : await readAliasBindings(world);
        const tasks = world === null ? { kind: "absent" as const } : await readTasks(world, holders, observeContract);
        const akuma =
          world === null
            ? { kind: "absent" as const }
            : dispatches.kind === "failed"
              ? dispatches
              : await joinAkuma(world, observeContract, dispatches.value, aliases);
        const assembled = {
          root: world,
          observedAt,
          branch,
          contracts: attachFleet(contracts, akuma),
          tasks,
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
    return {
      report: {
        root: world,
        observedAt,
        branch,
        contracts: failure,
        tasks: world === null ? { kind: "absent" } : failure,
        akuma: world === null ? { kind: "absent" } : failure,
        ...(region === undefined ? {} : { region: failure }),
      },
      aliases: world === null ? { kind: "absent" } : failure,
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
