import { listKeiyaku, taskHolderProjectionForRepo } from "../library/contract.js";
import { Repo } from "../library/repo.js";
import type { ContractBoard, ContractDisposition } from "../library/contract.js";
import type { TaskHolderProjection } from "../settlement/holder.js";
import type { TaskStatusRow } from "../task/index.js";
import { readTaskStatusRows } from "../task/store.js";
import { Akuma } from "../akuma/index.js";
import { readAliases } from "../alias/index.js";
import { readDispatches } from "../dispatch/index.js";
import { scopeForRepo } from "../library/repo.js";
import type {
  AkumaKanshiWorld,
  ContractKanshiBoard,
  KanshiReport,
  Section,
  TaskKanshiRow,
  TaskKanshiWorld,
} from "./report.js";
import type { WorldRoot } from "../world.js";

export type KanshiInput = Readonly<{ world: WorldRoot | null; repo?: Repo }>;

function diagnostic(error: unknown): string {
  let source: string;
  if (error instanceof Error) source = error.message;
  else if (typeof error === "object" && error !== null) {
    try { source = JSON.stringify(error); } catch { source = String(error); }
  } else source = String(error);
  const line = source.replaceAll(/\s+/gu, " ").trim();
  return line.length <= 240 ? line : `${line.slice(0, 239)}…`;
}

function coordinate(input: KanshiInput): KanshiInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new TypeError("kanshi input must be an object");
  for (const key of Object.keys(input)) if (key !== "world" && key !== "repo") throw new TypeError(`kanshi input has unknown field: ${key}`);
  if (input.world !== null && (typeof input.world !== "string" || input.world.trim().length === 0)) {
    throw new TypeError("kanshi world must be a WorldRoot or null");
  }
  if (input.repo !== undefined && !(input.repo instanceof Repo)) throw new TypeError("kanshi repo must be a Repo");
  return input;
}

type ContractRead = Readonly<{
  branch: string | null;
  section: Section<ContractBoard>;
  repo?: Repo;
}>;

async function readContracts(repo?: Repo): Promise<ContractRead> {
  if (repo === undefined) return { branch: null, section: { kind: "absent" } };
  let branch: string | null = null;
  try {
    branch = await repo.currentBranch();
  } catch { /* optional invocation metadata remains unavailable */ }
  try {
    return { branch, repo, section: { kind: "present", value: await listKeiyaku({ repo }) } };
  } catch (error) {
    return { branch, repo, section: { kind: "failed", failure: { message: diagnostic(error) } } };
  }
}

type HolderRead =
  | Readonly<{ kind: "present"; value: TaskHolderProjection }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "failed"; failure: Readonly<{ message: string }> }>;

function readHolders(repo?: Repo): HolderRead {
  if (repo === undefined) return { kind: "absent" };
  try {
    return { kind: "present", value: taskHolderProjectionForRepo(repo) };
  } catch (error) {
    return { kind: "failed", failure: { message: diagnostic(error) } };
  }
}

function decorateContracts(
  contracts: Section<ContractBoard>,
  holders: HolderRead,
): Section<ContractKanshiBoard> {
  if (contracts.kind !== "present") return contracts;
  return {
    kind: "present",
    value: {
      ...contracts.value,
      rows: contracts.value.rows.map((row) => {
        if (holders.kind === "failed") return { ...row, holder: { kind: "unavailable" as const } };
        const holder = holders.kind === "present" ? holders.value.get(row.id) : undefined;
        return holder?.disposition === "held"
          ? { ...row, holder: { kind: "held" as const, taskId: holder.taskId, disposition: "held" as const } }
          : { ...row, holder: { kind: "none" as const } };
      }),
    },
  };
}

function joinTasks(
  rows: readonly TaskStatusRow[],
  holders: HolderRead,
  contracts: Section<ContractKanshiBoard>,
): readonly TaskKanshiRow[] {
  const dispositions = contracts.kind === "present"
    ? new Map<string, ContractDisposition>(contracts.value.rows.map((row) => [row.id, row.disposition]))
    : null;
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
    const observed = contracts.kind !== "present"
      ? "unavailable"
      : dispositions?.get(contractId) ?? "missing";
    return { ...row, contract: { id: contractId, observed } };
  });
}

function readTasks(
  path: WorldRoot,
  contracts: Section<ContractKanshiBoard>,
  holders: HolderRead,
): Section<TaskKanshiWorld> {
  if (holders.kind === "failed") return holders;
  try {
    return {
      kind: "present",
      value: { root: path, rows: joinTasks(readTaskStatusRows(path), holders, contracts) },
    };
  } catch (error) {
    return { kind: "failed", failure: { message: diagnostic(error) } };
  }
}

function readAkuma(path: WorldRoot, contracts: Section<ContractKanshiBoard>, repo?: Repo): Section<AkumaKanshiWorld> {
  try {
    const source = Akuma.of(path).list();
    const aliases = readAliases(path);
    const dispatches = repo === undefined ? [] : readDispatches(scopeForRepo(repo));
    const dispositions = contracts.kind === "present"
      ? new Map(contracts.value.rows.map((row) => [row.id, row.disposition]))
      : null;
    const aliasById = new Map<string, typeof aliases>();
    for (const binding of aliases) aliasById.set(binding.akuId, [...(aliasById.get(binding.akuId) ?? []), binding]);
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
                observed: contracts.kind !== "present"
                  ? "unavailable" as const
                  : dispositions?.get(dispatch.contractId) ?? "missing" as const,
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

export async function kanshi(input: KanshiInput): Promise<KanshiReport> {
  const observedAt = new Date().toISOString();
  const { world, repo } = coordinate(input);
  const contractRead = await readContracts(repo);
  const holders = readHolders(contractRead.repo);
  const contracts = decorateContracts(contractRead.section, holders);
  const tasks = world === null ? { kind: "absent" as const } : readTasks(world, contracts, holders);
  return {
    root: world,
    observedAt,
    branch: contractRead.branch,
    state: contracts.kind === "present" ? contracts.value.state : null,
    contracts,
    tasks,
    akuma: world === null ? { kind: "absent" } : readAkuma(world, contracts, contractRead.repo),
  };
}
