import { chmod, lstat, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { acquireSqliteTransactionLock } from "./coordination/sqlite-transaction-lock.js";
import { repairDerivedFile, type DerivedFileAction } from "./coordination/durable-file.js";
import { contractId, type ContractId, type ContractState } from "./core/facts/types.js";
import {
  CONTRACT_DELIVERER_SKILL,
  CONTRACT_REVIEWER_SKILL,
  renderContractAppointment,
  renderContractGuidance,
} from "./contract-guidance.js";
import { worktreeGitDirectory, worktreeRoot } from "./git/repository.js";
import { GitPlumbingError, runGit, type GitRepository } from "./git/process.js";
import { worktreePath } from "./git/workspace.js";
import { appointmentFor, placeRegisterPath, type PlaceRegister } from "./workspace-place.js";
import { repairNamespaceContext } from "./task/context.js";
import { contractNamespace } from "./task/identity.js";

const IGNORE_BYTES = ".gitignore\nKEIYAKU.md\n";
const PRIMARY_IGNORE_BYTES = "*\n!settings.json\n!tasks/\n!tasks/**\n";
const SEAT_IGNORE_BYTES = ".gitignore\nSKILL.md\n";
const SEAT_SKILLS = [
  ["keiyaku-deliver", CONTRACT_DELIVERER_SKILL],
  ["keiyaku-review", CONTRACT_REVIEWER_SKILL],
] as const;
export type ContractAppointment =
  | Readonly<{ kind: "absent"; path: string }>
  | Readonly<{ kind: "appointed"; path: string; contract: ContractId }>
  | Readonly<{ kind: "invalid"; path: string }>;
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

export function decodeContractFileLag(value: unknown): ContractFileLag {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("malformed contract-file lag");
  const object = value as Record<string, unknown>;
  if (object.kind !== "contract-file-failed") throw new Error("malformed contract-file lag");
  if (Object.keys(object).some((key) => key !== "kind" && key !== "worktree" && key !== "path" && key !== "diagnostic"))
    throw new Error("malformed contract-file lag");
  if (typeof object.worktree !== "string" || object.worktree.trim() === "")
    throw new Error("malformed contract-file lag");
  if (typeof object.path !== "string" || object.path.trim() === "") throw new Error("malformed contract-file lag");
  if (typeof object.diagnostic !== "string" || object.diagnostic.trim() === "")
    throw new Error("malformed contract-file lag");
  return { kind: "contract-file-failed", worktree: object.worktree, path: object.path, diagnostic: object.diagnostic };
}

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
  if ((await readFile(appointment.path, "utf8")) !== renderContractAppointment(contract)) return;
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

async function isKeiyakuSeatLeaf(worktree: string, seat: string): Promise<boolean> {
  const sentinel = join(worktree, ".agents", "skills", seat, ".gitignore");
  const stat = await lstat(sentinel).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? undefined : Promise.reject(error),
  );
  return stat?.isFile() === true && !stat.isSymbolicLink() && (await readFile(sentinel, "utf8")) === SEAT_IGNORE_BYTES;
}

async function materializeSeatSkill(
  repository: GitRepository,
  worktree: string,
  seat: string,
  bytes: string,
): Promise<readonly ContractFileEffect[]> {
  const leaf = `.agents/skills/${seat}`;
  const skill = `${leaf}/SKILL.md`;
  const skillPath = join(worktree, skill);
  const skillExists = await lstat(skillPath).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? false : Promise.reject(error),
  );
  if (!(await isKeiyakuSeatLeaf(worktree, seat)) && skillExists) return [];
  return [
    await repair(repository, worktree, `${leaf}/.gitignore`, SEAT_IGNORE_BYTES),
    await repair(repository, worktree, skill, bytes),
  ];
}

async function materialize(
  repository: GitRepository,
  worktree: string,
  guidance: string,
  namespace: readonly string[],
): Promise<ContractWorktreeResult> {
  const effects: ContractFileEffect[] = [];
  const failed = (target: string, path: string, error: unknown): ContractWorktreeResult => ({
    effects,
    lag: [
      {
        kind: "contract-file-failed",
        worktree: target,
        path,
        diagnostic: error instanceof Error ? error.message : String(error),
      },
    ],
  });
  try {
    effects.push(
      await repair(
        { ...repository, effectiveCwd: repository.primaryWorktree },
        repository.primaryWorktree,
        ".keiyaku/.gitignore",
        PRIMARY_IGNORE_BYTES,
      ),
    );
  } catch (error) {
    return failed(repository.primaryWorktree, join(repository.primaryWorktree, ".keiyaku", ".gitignore"), error);
  }
  const stat = await lstat(worktree).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stat === undefined || !stat.isDirectory()) {
    return {
      effects,
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
  try {
    await repairNamespaceContext(worktree, namespace);
  } catch (error) {
    return failed(worktree, join(worktree, ".keiyaku", "namespace", "current"), error);
  }
  for (const [relativePath, bytes] of [
    [".keiyaku/.gitignore", IGNORE_BYTES],
    [".keiyaku/KEIYAKU.md", guidance],
  ] as const) {
    try {
      effects.push(await repair(scoped, worktree, relativePath, bytes));
    } catch (error) {
      return failed(worktree, join(worktree, relativePath), error);
    }
  }
  for (const [seat, bytes] of SEAT_SKILLS) {
    try {
      effects.push(...(await materializeSeatSkill(scoped, worktree, seat, bytes)));
    } catch (error) {
      return failed(worktree, join(worktree, ".agents", "skills", seat), error);
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
  return await materialize(
    repository,
    worktreePath(repository, appointed.place),
    renderContractGuidance(state),
    contractNamespace(state.id),
  );
}
