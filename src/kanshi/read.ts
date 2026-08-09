import { resolve } from "node:path";
import { Keiyaku, NoGitWorldError, Repo, type ContractBoard, type ContractDisposition } from "../index.js";
import { Tasks, type TaskRow } from "../task/index.js";
import { Akuma, type AkumaList } from "../akuma/index.js";
import type { AkumaKanshiRow, AkumaKanshiWorld, KanshiReport, Section, TaskKanshiRow, TaskKanshiWorld } from "./report.js";

export type KanshiInput = Readonly<{ path?: string }>;

function diagnostic(error: unknown): string {
  let source: string;
  if (error instanceof Error) source = error.message;
  else if (typeof error === "object" && error !== null) {
    try { source = JSON.stringify(error); } catch { source = String(error); }
  } else source = String(error);
  const line = source.replaceAll(/\s+/gu, " ").trim();
  return line.length <= 240 ? line : `${line.slice(0, 239)}…`;
}

function coordinate(input: KanshiInput | undefined): string {
  if (input === undefined) return process.cwd();
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new TypeError("kanshi input must be an object");
  for (const key of Object.keys(input)) if (key !== "path") throw new TypeError(`kanshi input has unknown field: ${key}`);
  if (input.path === undefined) return process.cwd();
  if (typeof input.path !== "string" || input.path.trim().length === 0) throw new TypeError("kanshi path must be a nonblank string");
  return input.path;
}

async function readContracts(path: string): Promise<Section<ContractBoard>> {
  try {
    const repo = Repo.at({ path });
    return { kind: "present", value: await Keiyaku.list({ repo }) };
  } catch (error) {
    return error instanceof NoGitWorldError
      ? { kind: "absent" }
      : { kind: "failed", failure: { message: diagnostic(error) } };
  }
}

function joinTasks(rows: readonly TaskRow[], contracts: Section<ContractBoard>): readonly TaskKanshiRow[] {
  const dispositions = contracts.kind === "present"
    ? new Map<string, ContractDisposition>(contracts.value.rows.map((row) => [row.id, row.disposition]))
    : null;
  return rows.map(({ contractId, ...row }) => {
    if (contractId === null) return row;
    const observed = contracts.kind !== "present"
      ? "unavailable"
      : dispositions?.get(contractId) ?? "missing";
    return { ...row, contract: { id: contractId, observed } };
  });
}

function joinAkuma(rows: AkumaList["rows"], contracts: Section<ContractBoard>): readonly AkumaKanshiRow[] {
  const dispositions = contracts.kind === "present"
    ? new Map<string, ContractDisposition>(contracts.value.rows.map((row) => [row.id, row.disposition]))
    : null;
  return rows.map((row) => {
    if (!("persona" in row)) return row;
    const { contract, ...source } = row;
    if (contract === undefined) return source;
    const observed = contracts.kind !== "present"
      ? "unavailable"
      : dispositions?.get(contract) ?? "missing";
    return { ...source, contract: { id: contract, observed } };
  });
}

async function readTasks(path: string, contracts: Section<ContractBoard>): Promise<Section<TaskKanshiWorld>> {
  try {
    const tasks = Tasks.at({ path });
    const result = await tasks.list({ selection: "all", scope: "world" });
    if (result.kind !== "accepted") return { kind: "failed", failure: { message: diagnostic(result) } };
    return {
      kind: "present",
      value: { root: tasks.root, rows: joinTasks(result.value, contracts) },
    };
  } catch (error) {
    return { kind: "failed", failure: { message: diagnostic(error) } };
  }
}

function readAkuma(path: string, contracts: Section<ContractBoard>): Section<AkumaKanshiWorld> {
  try {
    const source = Akuma.at({ path }).list();
    return { kind: "present", value: { ...source, rows: joinAkuma(source.rows, contracts) } };
  } catch (error) {
    return { kind: "failed", failure: { message: diagnostic(error) } };
  }
}

export async function kanshi(input?: KanshiInput): Promise<KanshiReport> {
  const path = resolve(coordinate(input));
  const contracts = await readContracts(path);
  const tasks = await readTasks(path, contracts);
  return { root: path, contracts, tasks, akuma: readAkuma(path, contracts) };
}
