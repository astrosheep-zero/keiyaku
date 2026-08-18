import { Repo } from "../library/repo.js";
import type { ContractBoard, ContractDisposition } from "../library/contract.js";
import { scopeForRepo } from "../library/repo.js";
import { observeTaskBoard } from "../task/operations.js";
import { contractNamespace } from "../settlement/settle.js";
import { Akuma } from "../akuma/index.js";
import { readAliases, type AliasBinding } from "../alias/index.js";
import { readDispatchesAt, type Dispatch } from "../dispatch/index.js";
import { readTaskHolderProjectionAt, type TaskHolderProjection } from "../settlement/holder.js";
import { readContractBoard } from "../protocol/read/status.js";
import { withGitDecodeChannel, withGitReadObservation, type GitReadObservation } from "../git/read-observation.js";
import { readDocuments } from "../protocol/read/documents.js";
import { readRegionDeclarations, validateRegionPath } from "../library/region.js";
import { contractId } from "../core/facts/types.js";
import { selectKanshi, selectRegion } from "./select.js";
import type { TaskRow } from "../task/index.js";
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
    try { source = JSON.stringify(error); } catch { source = String(error); }
  } else source = String(error);
  const line = source.replaceAll(/\s+/gu, " ").trim();
  return line.length <= 240 ? line : `${line.slice(0, 239)}…`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`kanshi ${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`kanshi ${label} has unknown field: ${key}`);
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
    try { return { kind: "contract", contract: contractId(selection.contract) }; }
    catch { throw new TypeError("kanshi region contract must be a canonical ContractId"); }
  }
  if (selection.kind === "overlap") {
    exactKeys(selection, ["kind", "contract"], "region selection");
    if (selection.contract === undefined) return { kind: "overlap" };
    if (typeof selection.contract !== "string") throw new TypeError("kanshi region contract must be a ContractId");
    try { return { kind: "overlap", contract: contractId(selection.contract) }; }
    catch { throw new TypeError("kanshi region contract must be a canonical ContractId"); }
  }
  if (selection.kind === "path") {
    exactKeys(selection, ["kind", "path"], "region selection");
    try { validateRegionPath(selection.path); }
    catch (error) { throw new TypeError(error instanceof Error ? error.message : String(error)); }
    return { kind: "path", path: selection.path };
  }
  throw new TypeError(`kanshi region selection kind is invalid: ${selection.kind}`);
}

function coordinate(input: KanshiInput): KanshiInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new TypeError("kanshi input must be an object");
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

async function readRegion(observation: GitReadObservation, selection: KanshiRegionSelection): Promise<Section<RegionRead>> {
  try {
    const declarations: readonly RegionDeclaration[] = [...readRegionDeclarations(await readDocuments(observation))].sort((left, right) => left.contract.localeCompare(right.contract));
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
  selected?: ContractBoard["rows"][number]["id"],
): Promise<Section<ContractBoard>> {
  try {
    return { kind: "present", value: await readContractBoard(observation, selected) };
  } catch (error) {
    return { kind: "failed", failure: { message: diagnostic(error) } };
  }
}

type HolderRead =
  | Readonly<{ kind: "present"; value: TaskHolderProjection }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "failed"; failure: Readonly<{ message: string }> }>;

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
  contracts: Section<ContractBoard>,
  holders: HolderRead,
  namespaceTasks: (id: ContractBoard["rows"][number]["id"]) => Section<readonly TaskRow[]>,
): Section<ContractKanshiBoard> {
  if (contracts.kind !== "present") return contracts;
  return {
    kind: "present",
    value: {
      ...contracts.value,
      rows: contracts.value.rows.map((row) => {
        const selected = namespaceTasks(row.id);
        if (holders.kind === "failed") {
          return { ...row, holder: { kind: "unavailable" as const }, fleet: [], namespaceTasks: selected };
        }
        const holder = holders.kind === "present" ? holders.value.get(row.id) : undefined;
        return {
          ...row,
          fleet: [],
          namespaceTasks: selected,
          holder: holder?.disposition === "held"
            ? { kind: "held" as const, taskId: holder.taskId }
            : { kind: "none" as const },
        };
      }),
    },
  };
}

type ObserveContractEndpoint = (id: string) => ContractEndpointObservation;

function contractEndpointObserver(contracts: Section<ContractKanshiBoard>): ObserveContractEndpoint {
  const dispositions = contracts.kind === "present"
    ? new Map<string, ContractDisposition>(contracts.value.rows.map((row) => [row.id, row.disposition]))
    : null;
  return (id) => dispositions === null ? "unavailable" : dispositions.get(id) ?? "missing";
}

function joinTasks(
  rows: Awaited<ReturnType<typeof observeTaskBoard>>["statusRows"],
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

function readTasks(
  path: WorldRoot,
  board: TaskWorldRead,
  holders: HolderRead,
  observeContract: ObserveContractEndpoint,
): Section<TaskKanshiWorld> {
  if (holders.kind === "failed") return { kind: "failed", failure: holders.failure };
  if (board.kind === "failed") return { kind: "failed", failure: board.failure };
  if (board.kind === "absent") return { kind: "absent" };
  return {
    kind: "present",
    value: { root: path, rows: joinTasks(board.observation.statusRows, holders, observeContract) },
  };
}

async function joinAkuma(
  path: WorldRoot,
  observeContract: ObserveContractEndpoint,
  dispatches: readonly Dispatch[],
  aliases: Section<readonly AliasBinding[]>,
): Promise<Section<AkumaKanshiWorld>> {
  if (aliases.kind !== "present") return aliases;
  try {
    const source = await Akuma.of(path).list();
    const aliasById = new Map<string, typeof aliases.value>();
    for (const binding of aliases.value) aliasById.set(binding.akuId, [...(aliasById.get(binding.akuId) ?? []), binding]);
    const dispatchById = new Map(dispatches.map((dispatch) => [dispatch.akuId, dispatch]));
    return {
      kind: "present",
      value: {
        ...source,
        rows: source.rows.map((row) => {
          const dispatch = dispatchById.get(row.id);
          return {
            ...row,
            aliases: (aliasById.get(row.id) ?? []).map((binding) => binding.alias),
            ...(dispatch === undefined ? {} : {
              contract: {
                id: dispatch.contractId,
                observed: observeContract(dispatch.contractId),
              },
            }),
          };
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

async function readDispatches(observation: GitReadObservation): Promise<
  | Readonly<{ kind: "present"; value: readonly Dispatch[] }>
  | Readonly<{ kind: "failed"; failure: Readonly<{ message: string }> }>
> {
  try {
    return { kind: "present", value: await readDispatchesAt(observation) };
  } catch (error) {
    return { kind: "failed", failure: { message: diagnostic(error) } };
  }
}

export async function observeKanshi(input: KanshiInput): Promise<KanshiObservation> {
  const observedAt = new Date().toISOString();
  const { world, repo } = coordinate(input);
  const branch = await readBranch(repo);
  if (repo === undefined) {
    const contracts = { kind: "absent" as const };
    const holders = { kind: "absent" as const };
    const observeContract = contractEndpointObserver(contracts);
    const board = await readTaskWorld(world);
    const tasks = world === null ? { kind: "absent" as const } : readTasks(world, board, holders, observeContract);
    const aliases = world === null ? { kind: "absent" as const } : await readAliasBindings(world);
    const akuma = world === null ? { kind: "absent" as const } : await joinAkuma(world, observeContract, [], aliases);
    return {
      report: { root: world, observedAt, branch, contracts, tasks, akuma, ...(input.region === undefined ? {} : { region: { kind: "absent" as const } }) },
      aliases,
    };
  }
  try {
    const repository = scopeForRepo(repo);
    return await withGitDecodeChannel(repository, (channel) => withGitReadObservation(repository, channel, async (observation) => {
      const [contractSection, holders, dispatches, region, board] = await Promise.all([
        readContracts(observation, input.contract),
        readHolders(observation),
        readDispatches(observation),
        input.region === undefined ? Promise.resolve(undefined) : readRegion(observation, input.region),
        readTaskWorld(world),
      ]);
      const contracts = decorateContracts(contractSection, holders, (id) => namespaceTaskSection(board, id));
      const observeContract = contractEndpointObserver(contracts);
      const aliases = world === null ? { kind: "absent" as const } : await readAliasBindings(world);
      const tasks = world === null ? { kind: "absent" as const } : readTasks(world, board, holders, observeContract);
      const akuma = world === null
        ? { kind: "absent" as const }
        : dispatches.kind === "failed"
          ? dispatches
          : await joinAkuma(world, observeContract, dispatches.value, aliases);
      const report = {
        root: world,
        observedAt,
        branch,
        contracts: attachFleet(contracts, akuma),
        tasks,
        akuma,
        ...(region === undefined ? {} : { region }),
      } satisfies KanshiReport;
      return {
        report: input.contract === undefined
          ? report
          : selectKanshi({ report, contract: input.contract }),
        aliases,
      };
    }));
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
        ...(input.region === undefined ? {} : { region: failure }),
      },
      aliases: world === null ? { kind: "absent" } : failure,
    };
  }
}

export async function kanshi(input: KanshiInput): Promise<KanshiReport> {
  return (await observeKanshi(input)).report;
}
