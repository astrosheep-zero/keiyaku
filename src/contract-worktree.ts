import { chmodSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { acquireSqliteTransactionLock } from "./coordination/sqlite-transaction-lock.js";
import {
  createFileDurablyExclusive,
  repairDerivedFile,
  type DerivedFileAction,
} from "./coordination/durable-file.js";
import { contractId, type ArcData, type ContractId, type ContractState } from "./core/facts/types.js";
import {
  GitPlumbingError,
  runGit,
  worktreeGitDirectory,
  worktreeRoot,
  type GitRepository,
} from "./git/repository.js";
import { deliveryWorktreePath } from "./git/workspace.js";

const IGNORE_BYTES = ".gitignore\nKEIYAKU.md\n";

function appointmentBytes(contract: ContractId): string {
  return `---\ncontract: ${contract}\n---\n`;
}

function renderArc(arc: ArcData): string {
  return [
    "## Arc", "", "### Sequence", "", String(arc.seq), "", "### Title", "", arc.title.trimEnd(), "",
    "### Objective", "", arc.objective.trimEnd(), "", "### Brief", "", arc.brief.trimEnd(),
  ].join("\n");
}

const FULFILLMENT = [
  "## Fulfillment", "", "### Appointment", "",
  "Each commission names exactly one seat: Deliverer or Reviewer.",
  "If no seat was named, stop and ask the caller. Never infer it.", "",
  "### Worktree", "",
  "This file is a derived view of the journal-authoritative Contract. Never edit it to change the Contract.",
  "Treat the directory containing `.keiyaku/KEIYAKU.md` as the Contract worktree root.",
  "Read the complete Contract before acting and keep work inside that worktree.", "",
  "### Deliverer", "",
  "Implement and verify the Objective under the Design, Region, and Criteria in this Contract.",
  "Leave lifecycle decisions to the caller; report the candidate, verification performed, and any unmet term.", "",
  "### Reviewer", "",
  "Review this Contract worktree against the complete Contract.",
  "Review the complete current worktree snapshot, not a named candidate commit.",
  "Do not modify it; report covered Criteria, findings, and missing evidence.",
].join("\n");

export function renderContractGuidance(state: ContractState): string {
  return [
    appointmentBytes(state.id).trimEnd(),
    state.terms.document.bytes.trimEnd(),
    ...(state.currentArc === undefined ? [] : [renderArc(state.currentArc.data)]),
    FULFILLMENT,
  ].join("\n\n").concat("\n");
}

export type ContractFileEffect = Readonly<{
  kind: "contract-file";
  path: string;
  action: DerivedFileAction | "removed";
}>;

export type ContractFileLag = Readonly<{
  kind: "contract-file-failed";
  worktree: string;
  path: string;
  diagnostic: string;
}>;

export type ContractWorktreeResult = Readonly<{
  effects: readonly ContractFileEffect[];
  lag: readonly ContractFileLag[];
}>;

function isTracked(repository: GitRepository, relativePath: string): boolean {
  try {
    runGit(repository, ["ls-files", "--error-unmatch", "--", relativePath]);
    return true;
  } catch (error) {
    if (error instanceof GitPlumbingError && error.status === 1) return false;
    throw error;
  }
}

function generatedPath(worktree: string, name: string): string {
  return join(worktree, ".keiyaku", name);
}

export type ContractAppointment =
  | Readonly<{ kind: "absent"; path: string }>
  | Readonly<{ kind: "appointed"; path: string; contract: ContractId }>
  | Readonly<{ kind: "invalid"; path: string }>;

export function readContractAppointment(repository: GitRepository): ContractAppointment {
  const path = generatedPath(worktreeRoot(repository), "KEIYAKU.md");
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return { kind: "absent", path };
  if (!stat.isFile() || stat.isSymbolicLink()) return { kind: "invalid", path };
  const match = /^---\r?\ncontract: ([^\r\n]+)\r?\n---(?:\r?\n|$)/u.exec(readFileSync(path, "utf8"));
  if (match?.[1] === undefined) return { kind: "invalid", path };
  try {
    return { kind: "appointed", path, contract: contractId(match[1]) };
  } catch {
    return { kind: "invalid", path };
  }
}

export type ContractReservation =
  | Readonly<{ kind: "reserved"; path: string }>
  | Exclude<ContractAppointment, Readonly<{ kind: "absent"; path: string }>>;

export function reserveContractWorktree(repository: GitRepository, contract: ContractId): ContractReservation {
  const worktree = worktreeRoot(repository);
  const scoped = { ...repository, effectiveCwd: worktree };
  const ignore = generatedPath(worktree, ".gitignore");
  if (isTracked(scoped, ".keiyaku/.gitignore")) throw new Error(`generated path is tracked by Git: ${ignore}`);
  repairDerivedFile(ignore, IGNORE_BYTES);
  const path = generatedPath(worktree, "KEIYAKU.md");
  if (isTracked(scoped, ".keiyaku/KEIYAKU.md")) throw new Error(`generated path is tracked by Git: ${path}`);
  if (createFileDurablyExclusive(path, appointmentBytes(contract), 0o444)) return { kind: "reserved", path };
  const appointment = readContractAppointment(repository);
  return appointment.kind === "absent" ? { kind: "invalid", path } : appointment;
}

export async function withContractWorktreeAppointment<T>(
  repository: GitRepository,
  action: () => T | Promise<T>,
): Promise<T> {
  const root = worktreeRoot(repository);
  const lock = await acquireSqliteTransactionLock({
    path: join(worktreeGitDirectory(repository, root), "keiyaku", "contract-worktree.sqlite"),
    mode: "immediate",
  });
  try {
    return await action();
  } finally {
    lock.close();
  }
}

export function releaseContractWorktree(repository: GitRepository, contract: ContractId): void {
  const appointment = readContractAppointment(repository);
  if (appointment.kind !== "appointed" || appointment.contract !== contract) return;
  if (readFileSync(appointment.path, "utf8") !== appointmentBytes(contract)) return;
  try { unlinkSync(appointment.path); } catch { /* reservation cleanup is best effort */ }
}

export function removeContractWorktreeAppointment(repository: GitRepository, contract: ContractId): void {
  const appointment = readContractAppointment(repository);
  if (appointment.kind !== "appointed" || appointment.contract !== contract) return;
  unlinkSync(appointment.path);
}

function repair(repository: GitRepository, worktree: string, relativePath: string, bytes: string): ContractFileEffect {
  const path = join(worktree, relativePath);
  if (isTracked(repository, relativePath)) throw new Error(`generated path is tracked by Git: ${path}`);
  const action = repairDerivedFile(path, bytes);
  if (relativePath === ".keiyaku/KEIYAKU.md") {
    try { chmodSync(path, 0o444); } catch { /* advisory protection only */ }
  }
  return { kind: "contract-file", path, action };
}

function materialize(repository: GitRepository, worktree: string, guidance: string): ContractWorktreeResult {
  const stat = lstatSync(worktree, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory()) {
    return {
      effects: [],
      lag: [{
        kind: "contract-file-failed",
        worktree,
        path: generatedPath(worktree, "KEIYAKU.md"),
        diagnostic: "Contract worktree is unavailable",
      }],
    };
  }
  const scoped = { ...repository, effectiveCwd: worktree };
  const effects: ContractFileEffect[] = [];
  for (const [relativePath, bytes] of [
    [".keiyaku/.gitignore", IGNORE_BYTES],
    [".keiyaku/KEIYAKU.md", guidance],
  ] as const) {
    try { effects.push(repair(scoped, worktree, relativePath, bytes)); } catch (error) {
      return {
        effects,
        lag: [{
          kind: "contract-file-failed",
          worktree,
          path: join(worktree, relativePath),
          diagnostic: error instanceof Error ? error.message : String(error),
        }],
      };
    }
  }
  return { effects, lag: [] };
}

function here(repository: GitRepository, state: ContractState, guidance: string): ContractWorktreeResult {
  const worktree = worktreeRoot(repository);
  const appointment = readContractAppointment(repository);
  if (appointment.kind === "appointed" && appointment.contract === state.id) {
    return materialize(repository, worktree, guidance);
  }
  const diagnostic = appointment.kind === "appointed"
    ? `here worktree is appointed to ${appointment.contract}`
    : `here Contract appointment is ${appointment.kind}`;
  return {
    effects: [],
    lag: [{ kind: "contract-file-failed", worktree, path: appointment.path, diagnostic }],
  };
}

function removeHere(repository: GitRepository, contract: ContractId): ContractWorktreeResult {
  const worktree = worktreeRoot(repository);
  const appointment = readContractAppointment(repository);
  if (appointment.kind === "absent" || (appointment.kind === "appointed" && appointment.contract !== contract)) {
    return { effects: [], lag: [] };
  }
  if (appointment.kind === "invalid") {
    return { effects: [], lag: [{
      kind: "contract-file-failed", worktree, path: appointment.path, diagnostic: "here Contract appointment is invalid",
    }] };
  }
  try {
    unlinkSync(appointment.path);
    return { effects: [{ kind: "contract-file", path: appointment.path, action: "removed" }], lag: [] };
  } catch (error) {
    return { effects: [], lag: [{
      kind: "contract-file-failed",
      worktree,
      path: appointment.path,
      diagnostic: error instanceof Error ? error.message : String(error),
    }] };
  }
}

export function projectContractWorktree(repository: GitRepository, state: ContractState | null): ContractWorktreeResult {
  if (state === null) return { effects: [], lag: [] };
  if (state.coordinates.workspace === "here") {
    return state.terminal ? removeHere(repository, state.id) : here(repository, state, renderContractGuidance(state));
  }
  return state.terminal
    ? { effects: [], lag: [] }
    : materialize(repository, deliveryWorktreePath(repository, state.id), renderContractGuidance(state));
}
