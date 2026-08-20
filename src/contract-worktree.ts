import { chmod, lstat, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { acquireSqliteTransactionLock } from "./coordination/sqlite-transaction-lock.js";
import {
  createFileDurablyExclusive,
  repairDerivedFile,
  type DerivedFileAction,
} from "./coordination/durable-file.js";
import { contractId, type ArcData, type ContractId, type ContractState } from "./core/facts/types.js";
import {
  registeredWorktrees,
  worktreeGitDirectory,
  worktreeRoot,
} from "./git/repository.js";
import { GitPlumbingError, runGit, type GitRepository } from "./git/process.js";
import { worktreePath } from "./git/workspace.js";
import {
  appointmentFor,
  placeRegisterPath,
  type PlaceRegister,
} from "./workspace-place.js";

const IGNORE_BYTES = ".gitignore\nKEIYAKU.md\n";
const APPOINTMENT_DESCRIPTION = "This is a read-only projection. Do not edit manually.";
export type ContractAppointment = Readonly<{ kind: "absent"; path: string }>
  | Readonly<{ kind: "appointed"; path: string; contract: ContractId }>
  | Readonly<{ kind: "invalid"; path: string }>;
export type HereContractWorkspaceObservation = Readonly<{ kind: "appointed"; path: string }>
  | Readonly<{ kind: "unappointed" }>
  | Readonly<{ kind: "failed"; diagnostic: string; cause?: "duplicate" | "observation" }>;
type HereContractWorkspaceAppointment = Readonly<{ kind: "appointed"; path: string }>
  | Readonly<{ kind: "unappointed" }>
  | Readonly<{ kind: "conflicted"; paths: readonly string[] }>
  | Readonly<{ kind: "failed"; diagnostic: string }>;
function appointmentBytes(contract: ContractId): string { return `---\ncontract: ${contract}\ndescription: ${APPOINTMENT_DESCRIPTION}\n---\n`; }
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
  "When an Arc is active, stay within that current chapter.",
  "For work requiring three or more steps, prefer `keiyaku task -C <worktree>` "
    + "to organize and manage Tasks.",
  "Promptly update progress for Tasks already present in the current worktree.",
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

async function isTracked(repository: GitRepository, relativePath: string): Promise<boolean> {
  try {
    await runGit(repository, ["ls-files", "--error-unmatch", "--", relativePath]);
    return true;
  } catch (error) {
    if (error instanceof GitPlumbingError && error.status === 1) return false;
    throw error;
  }
}

function generatedPath(worktree: string, name: string): string {
  return join(worktree, ".keiyaku", name);
}

function appointedContract(bytes: string): ContractId | undefined {
  const lines = bytes.split(/\r?\n/u), close = lines.indexOf("---", 1);
  if (lines[0] !== "---" || (close !== 2 && close !== 3) || !lines[1]?.startsWith("contract: ")) return undefined;
  if (close === 3 && !lines[2]?.startsWith("description: ")) return undefined;
  try { return contractId(lines[1]!.slice("contract: ".length)); } catch { return undefined; }
}
export async function readContractAppointment(repository: GitRepository): Promise<ContractAppointment> {
  const path = generatedPath(await worktreeRoot(repository), "KEIYAKU.md");
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (stat === undefined) return { kind: "absent", path };
  if (!stat.isFile() || stat.isSymbolicLink()) return { kind: "invalid", path };
  const contract = appointedContract(await readFile(path, "utf8"));
  return contract === undefined ? { kind: "invalid", path } : { kind: "appointed", path, contract };
}
async function readHereContractWorkspaceAppointment(repository: GitRepository, contract: ContractId): Promise<HereContractWorkspaceAppointment> {
  const matches: string[] = [];
  let worktrees;
  try {
    worktrees = await registeredWorktrees(repository);
  } catch (error) {
    if (error instanceof GitPlumbingError) return { kind: "failed", diagnostic: error.message };
    throw error;
  }
  for (const worktree of worktrees) {
    const appointment = await readContractAppointment({ ...repository, effectiveCwd: worktree.path });
    if (appointment.kind === "appointed" && appointment.contract === contract) matches.push(worktree.path);
  }
  if (matches.length === 0) return { kind: "unappointed" };
  if (matches.length > 1) return { kind: "conflicted", paths: matches.sort() };
  return { kind: "appointed", path: matches[0]! };
}

function conflictDiagnostic(paths: readonly string[]): string {
  const displayed = paths.slice(0, 3);
  return `duplicate here Contract workspace appointments: ${displayed.join(", ")}${paths.length > displayed.length ? ", ..." : ""}`;
}

/** Fold existing here appointments over all registered worktrees for one Contract. */
export async function resolveHereContractWorkspace(
  repository: GitRepository,
  contract: ContractId,
): Promise<HereContractWorkspaceObservation> {
  const appointment = await readHereContractWorkspaceAppointment(repository, contract);
  if (appointment.kind === "failed") return { kind: "failed", diagnostic: appointment.diagnostic, cause: "observation" };
  if (appointment.kind === "conflicted") {
    return { kind: "failed", diagnostic: conflictDiagnostic(appointment.paths), cause: "duplicate" };
  }
  return appointment;
}

export type ContractReservation =
  | Readonly<{ kind: "reserved"; path: string }>
  | Exclude<ContractAppointment, Readonly<{ kind: "absent"; path: string }>>;

export async function reserveContractWorktree(repository: GitRepository, contract: ContractId): Promise<ContractReservation> {
  const worktree = await worktreeRoot(repository);
  const scoped = { ...repository, effectiveCwd: worktree };
  const ignore = generatedPath(worktree, ".gitignore");
  if (await isTracked(scoped, ".keiyaku/.gitignore")) throw new Error(`generated path is tracked by Git: ${ignore}`);
  await repairDerivedFile(ignore, IGNORE_BYTES);
  const path = generatedPath(worktree, "KEIYAKU.md");
  if (await isTracked(scoped, ".keiyaku/KEIYAKU.md")) throw new Error(`generated path is tracked by Git: ${path}`);
  if (await createFileDurablyExclusive(path, appointmentBytes(contract), 0o444)) return { kind: "reserved", path };
  const appointment = await readContractAppointment(repository);
  return appointment.kind === "absent" ? { kind: "invalid", path } : appointment;
}

export async function withContractWorktreeAppointment<T>(
  repository: GitRepository,
  action: () => T | Promise<T>,
): Promise<T> {
  const root = await worktreeRoot(repository);
  const lock = await acquireSqliteTransactionLock({
    path: join(await worktreeGitDirectory(repository, root), "keiyaku", "contract-worktree.sqlite"),
    mode: "immediate",
  });
  try {
    return await action();
  } finally {
    lock.close();
  }
}

export async function releaseContractWorktree(repository: GitRepository, contract: ContractId): Promise<void> {
  const appointment = await readContractAppointment(repository);
  if (appointment.kind !== "appointed" || appointment.contract !== contract) return;
  if (await readFile(appointment.path, "utf8") !== appointmentBytes(contract)) return;
  try { await unlink(appointment.path); } catch { /* reservation cleanup is best effort */ }
}

async function removeOwnedHereSupport(worktree: string): Promise<number> {
  const path = generatedPath(worktree, ".gitignore");
  try {
    const value = await lstat(path);
    if (!value.isFile() || value.isSymbolicLink()) return 0;
    if (await readFile(path, "utf8") !== IGNORE_BYTES) return 0;
    await unlink(path);
    return 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

/** Remove matching here appointments and their exact generated support from registered worktrees. */
export async function nukeHereAppointments(repository: GitRepository): Promise<void> {
  for (const registered of await registeredWorktrees(repository)) {
    const scoped = { ...repository, effectiveCwd: registered.path };
    const appointment = await readContractAppointment(scoped);
    if (appointment.kind === "appointed") {
      await unlink(appointment.path);
      await removeOwnedHereSupport(registered.path);
    }
  }
}


async function repair(repository: GitRepository, worktree: string, relativePath: string, bytes: string): Promise<ContractFileEffect> {
  const path = join(worktree, relativePath);
  if (await isTracked(repository, relativePath)) throw new Error(`generated path is tracked by Git: ${path}`);
  const action = await repairDerivedFile(path, bytes);
  if (relativePath === ".keiyaku/KEIYAKU.md") {
    try { await chmod(path, 0o444); } catch { /* advisory protection only */ }
  }
  return { kind: "contract-file", path, action };
}

async function materialize(repository: GitRepository, worktree: string, guidance: string): Promise<ContractWorktreeResult> {
  const stat = await lstat(worktree).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
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
    try { effects.push(await repair(scoped, worktree, relativePath, bytes)); } catch (error) {
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

async function here(
  repository: GitRepository,
  state: ContractState,
  guidance: string,
  onConflict?: (diagnostic: string) => never,
): Promise<ContractWorktreeResult> {
  const appointment = await resolveHereContractWorkspace(repository, state.id);
  if (appointment.kind === "appointed") return await materialize(repository, appointment.path, guidance);
  if (appointment.kind === "failed") {
    if (onConflict !== undefined) return onConflict(appointment.diagnostic);
    throw new Error(appointment.diagnostic);
  }
  return {
    effects: [],
    lag: [{
      kind: "contract-file-failed",
      worktree: repository.primaryWorktree,
      path: generatedPath(repository.primaryWorktree, "KEIYAKU.md"),
      diagnostic: "here Contract is unappointed",
    }],
  };
}

async function removeHere(repository: GitRepository, state: ContractState): Promise<ContractWorktreeResult> {
  const effects: ContractFileEffect[] = [];
  for (const worktree of await registeredWorktrees(repository)) {
    const appointment = await readContractAppointment({ ...repository, effectiveCwd: worktree.path });
    if (appointment.kind !== "appointed" || appointment.contract !== state.id) continue;
    try { await unlink(appointment.path); effects.push({ kind: "contract-file", path: appointment.path, action: "removed" }); }
    catch (error) { return { effects, lag: [{ kind: "contract-file-failed", worktree: worktree.path, path: appointment.path, diagnostic: error instanceof Error ? error.message : String(error) }] }; }
  }
  return { effects, lag: [] };
}

export async function projectContractWorktree(
  repository: GitRepository,
  state: ContractState | null,
  register?: PlaceRegister,
  onConflict?: (diagnostic: string) => never,
): Promise<ContractWorktreeResult> {
  if (state === null || state.terminal) {
    return state?.coordinates.workspace === "here"
      ? await removeHere(repository, state)
      : { effects: [], lag: [] };
  }
  if (state.coordinates.workspace === "here") {
    return await here(repository, state, renderContractGuidance(state), onConflict);
  }
  const appointed = register === undefined ? undefined : appointmentFor(register, state.id);
  if (appointed === undefined) {
    return {
      effects: [],
      lag: [{
        kind: "contract-file-failed",
        worktree: repository.primaryWorktree,
        path: placeRegisterPath(repository),
        diagnostic: "managed Contract is unappointed",
      }],
    };
  }
  return await materialize(
    repository,
    worktreePath(repository, appointed.place),
    renderContractGuidance(state),
  );
}
