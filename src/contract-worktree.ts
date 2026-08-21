import { chmod, lstat, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { acquireSqliteTransactionLock } from "./coordination/sqlite-transaction-lock.js";
import { repairDerivedFile, type DerivedFileAction } from "./coordination/durable-file.js";
import { contractId, type ArcData, type ContractId, type ContractState } from "./core/facts/types.js";
import { worktreeGitDirectory, worktreeRoot } from "./git/repository.js";
import { GitPlumbingError, runGit, type GitRepository } from "./git/process.js";
import { worktreePath } from "./git/workspace.js";
import { appointmentFor, placeRegisterPath, type PlaceRegister } from "./workspace-place.js";

const IGNORE_BYTES = ".gitignore\nKEIYAKU.md\n";
const APPOINTMENT_DESCRIPTION = "This is a read-only projection. Do not edit manually.";
export type ContractAppointment =
  | Readonly<{ kind: "absent"; path: string }>
  | Readonly<{ kind: "appointed"; path: string; contract: ContractId }>
  | Readonly<{ kind: "invalid"; path: string }>;
function appointmentBytes(contract: ContractId): string {
  return `---\ncontract: ${contract}\ndescription: ${APPOINTMENT_DESCRIPTION}\n---\n`;
}
function renderArc(arc: ArcData): string {
  return [
    "## Arc",
    "",
    "### Sequence",
    "",
    String(arc.seq),
    "",
    "### Title",
    "",
    arc.title.trimEnd(),
    "",
    "### Objective",
    "",
    arc.objective.trimEnd(),
    "",
    "### Brief",
    "",
    arc.brief.trimEnd(),
  ].join("\n");
}

const FULFILLMENT = [
  "## Fulfillment",
  "",
  "### Appointment",
  "",
  "Each commission names exactly one seat: Deliverer or Reviewer.",
  "If no seat was named, stop and ask the caller. Never infer it.",
  "",
  "### Worktree",
  "",
  "This file is a derived view of the journal-authoritative Contract. Never edit it to change the Contract.",
  "Treat the directory containing `.keiyaku/KEIYAKU.md` as the Contract worktree root.",
  "Read the complete Contract before acting and keep work inside that worktree.",
  "",
  "### Deliverer",
  "",
  "Implement and verify the Objective under the Design, Region, and Criteria in this Contract.",
  "When an Arc is active, stay within that current chapter.",
  "For work requiring three or more steps, prefer `keiyaku task -C <worktree>` " + "to organize and manage Tasks.",
  "Promptly update progress for Tasks already present in the current worktree.",
  "Leave lifecycle decisions to the caller; report the candidate, verification performed, and any unmet term.",
  "Deliver from this worktree. A clean worktree delivers HEAD; uncommitted work",
  "needs `deliver --include-dirty`, which captures the final non-ignored tree and",
  "stages or commits nothing. If deliver reports a conflict, run",
  "`deliver --materialize-conflict`, resolve the conflicted files, stage them,",
  "and deliver again; while the merge stays uncommitted that continuation uses",
  "`--include-dirty`. Unresolved paths always refuse.",
  "",
  "### Reviewer",
  "",
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
  ]
    .join("\n\n")
    .concat("\n");
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
  const lines = bytes.split(/\r?\n/u),
    close = lines.indexOf("---", 1);
  if (lines[0] !== "---" || (close !== 2 && close !== 3) || !lines[1]?.startsWith("contract: ")) return undefined;
  if (close === 3 && !lines[2]?.startsWith("description: ")) return undefined;
  try {
    return contractId(lines[1]!.slice("contract: ".length));
  } catch {
    return undefined;
  }
}
export async function readContractAppointment(repository: GitRepository): Promise<ContractAppointment> {
  const path = generatedPath(await worktreeRoot(repository), "KEIYAKU.md");
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? undefined : Promise.reject(error),
  );
  if (stat === undefined) return { kind: "absent", path };
  if (!stat.isFile() || stat.isSymbolicLink()) return { kind: "invalid", path };
  const contract = appointedContract(await readFile(path, "utf8"));
  return contract === undefined ? { kind: "invalid", path } : { kind: "appointed", path, contract };
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
  if ((await readFile(appointment.path, "utf8")) !== appointmentBytes(contract)) return;
  try {
    await unlink(appointment.path);
  } catch {
    /* reservation cleanup is best effort */
  }
}

async function repair(
  repository: GitRepository,
  worktree: string,
  relativePath: string,
  bytes: string,
): Promise<ContractFileEffect> {
  const path = join(worktree, relativePath);
  if (await isTracked(repository, relativePath)) throw new Error(`generated path is tracked by Git: ${path}`);
  const action = await repairDerivedFile(path, bytes);
  if (relativePath === ".keiyaku/KEIYAKU.md") {
    try {
      await chmod(path, 0o444);
    } catch {
      /* advisory protection only */
    }
  }
  return { kind: "contract-file", path, action };
}

async function materialize(
  repository: GitRepository,
  worktree: string,
  guidance: string,
): Promise<ContractWorktreeResult> {
  const stat = await lstat(worktree).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stat === undefined || !stat.isDirectory()) {
    return {
      effects: [],
      lag: [
        {
          kind: "contract-file-failed",
          worktree,
          path: generatedPath(worktree, "KEIYAKU.md"),
          diagnostic: "Contract worktree is unavailable",
        },
      ],
    };
  }
  const scoped = { ...repository, effectiveCwd: worktree };
  const effects: ContractFileEffect[] = [];
  for (const [relativePath, bytes] of [
    [".keiyaku/.gitignore", IGNORE_BYTES],
    [".keiyaku/KEIYAKU.md", guidance],
  ] as const) {
    try {
      effects.push(await repair(scoped, worktree, relativePath, bytes));
    } catch (error) {
      return {
        effects,
        lag: [
          {
            kind: "contract-file-failed",
            worktree,
            path: join(worktree, relativePath),
            diagnostic: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }
  return { effects, lag: [] };
}

export async function projectContractWorktree(
  repository: GitRepository,
  state: ContractState | null,
  register?: PlaceRegister,
  _onConflict?: (diagnostic: string) => never,
): Promise<ContractWorktreeResult> {
  if (state === null || state.terminal) return { effects: [], lag: [] };
  const appointed = register === undefined ? undefined : appointmentFor(register, state.id);
  if (appointed === undefined) {
    return {
      effects: [],
      lag: [
        {
          kind: "contract-file-failed",
          worktree: repository.primaryWorktree,
          path: placeRegisterPath(repository),
          diagnostic: "managed Contract is unappointed",
        },
      ],
    };
  }
  return await materialize(repository, worktreePath(repository, appointed.place), renderContractGuidance(state));
}
