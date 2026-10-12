import { z } from "zod";
import { chmod, lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { repairDerivedFile } from "./coordination/durable-file.js";
import { type ContractState } from "./core/facts/types.js";
import {
  CONTRACT_DELIVERER_SKILL,
  CONTRACT_REVIEWER_SKILL,
  CONTRACT_ONBOARDING_SKILL,
  renderContractGuidance,
} from "./contract-guidance.js";
import { executeGit, type GitRepository } from "./git/process.js";
import { worktreePath } from "./git/workspace.js";
import { appointmentFor, placeRegisterPath, type PlaceRegister } from "./workspace-place.js";
import { repairNamespaceContext } from "./task/context.js";
import { contractNamespace } from "./task/identity.js";

const IGNORE_BYTES = ".gitignore\nKEIYAKU.md\n";
const PRIMARY_IGNORE_BYTES = "*\n!settings.json\n!tasks/\n!tasks/**\n";
const SEAT_IGNORE_BYTES = ".gitignore\nSKILL.md\n";
const SEAT_SKILLS = [
  ["keiyaku-onboarding", CONTRACT_ONBOARDING_SKILL],
  ["keiyaku-deliver", CONTRACT_DELIVERER_SKILL],
  ["keiyaku-review", CONTRACT_REVIEWER_SKILL],
] as const;
const PRIMARY_GENERATED_PATHS = [".keiyaku/.gitignore"] as const;
const GENERATED_PATHS = [
  ...PRIMARY_GENERATED_PATHS,
  ".keiyaku/KEIYAKU.md",
  ...SEAT_SKILLS.flatMap(([seat]) => [`.agents/skills/${seat}/.gitignore`, `.agents/skills/${seat}/SKILL.md`]),
];
export const contractFileEffectSchema = z
  .object({
    kind: z.literal("contract-file"),
    path: z.string().refine((value) => value.trim() !== ""),
    action: z.enum(["created", "updated", "unchanged", "removed"]),
  })
  .strict();
export type ContractFileEffect = z.infer<typeof contractFileEffectSchema>;
export const contractFileLagSchema = z
  .object({
    kind: z.literal("contract-file-failed"),
    worktree: z.string().refine((value) => value.trim() !== ""),
    path: z.string().refine((value) => value.trim() !== ""),
    diagnostic: z.string().refine((value) => value.trim() !== ""),
  })
  .strict();
export type ContractFileLag = z.infer<typeof contractFileLagSchema>;

export type ContractWorktreeResult = Readonly<{
  effects: readonly ContractFileEffect[];
  lag: readonly ContractFileLag[];
}>;

async function readTrackedPaths(
  repository: GitRepository,
  worktree: string,
  paths: readonly string[],
): Promise<ReadonlySet<string>> {
  const output = await executeGit({ ...repository, effectiveCwd: worktree }, [
    "ls-files",
    "-z",
    "--",
    ...paths.map((path) => `:(literal)${path}`),
  ]);
  return new Set(
    output
      .toString("utf8")
      .split("\0")
      .filter((path) => path !== ""),
  );
}

function generatedPath(worktree: string, name: string): string {
  return join(worktree, ".keiyaku", name);
}

async function repair(
  worktree: string,
  relativePath: string,
  bytes: string,
  tracked: ReadonlySet<string>,
): Promise<ContractFileEffect> {
  const path = join(worktree, relativePath);
  if (tracked.has(relativePath)) throw new Error(`generated path is tracked by Git: ${path}`);
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
  worktree: string,
  seat: string,
  bytes: string,
  tracked: ReadonlySet<string>,
): Promise<readonly ContractFileEffect[]> {
  const leaf = `.agents/skills/${seat}`;
  const skill = `${leaf}/SKILL.md`;
  const skillPath = join(worktree, skill);
  const skillExists = await lstat(skillPath).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? false : Promise.reject(error),
  );
  if (!(await isKeiyakuSeatLeaf(worktree, seat)) && skillExists) return [];
  return [
    await repair(worktree, `${leaf}/.gitignore`, SEAT_IGNORE_BYTES, tracked),
    await repair(worktree, skill, bytes, tracked),
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
  const primaryWorktree = repository.primaryWorktree;
  let tracked: ReadonlySet<string>;
  try {
    tracked = await readTrackedPaths(
      repository,
      primaryWorktree,
      worktree === primaryWorktree ? GENERATED_PATHS : PRIMARY_GENERATED_PATHS,
    );
    effects.push(await repair(primaryWorktree, ".keiyaku/.gitignore", PRIMARY_IGNORE_BYTES, tracked));
  } catch (error) {
    return failed(primaryWorktree, join(primaryWorktree, ".keiyaku", ".gitignore"), error);
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
  try {
    await repairNamespaceContext(worktree, namespace);
  } catch (error) {
    return failed(worktree, join(worktree, ".keiyaku", "namespace", "current"), error);
  }
  if (worktree !== primaryWorktree) {
    try {
      tracked = await readTrackedPaths(repository, worktree, GENERATED_PATHS);
    } catch (error) {
      return failed(worktree, join(worktree, ".keiyaku", ".gitignore"), error);
    }
  }
  for (const [relativePath, bytes] of [
    [".keiyaku/.gitignore", IGNORE_BYTES],
    [".keiyaku/KEIYAKU.md", guidance],
  ] as const) {
    try {
      effects.push(await repair(worktree, relativePath, bytes, tracked));
    } catch (error) {
      return failed(worktree, join(worktree, relativePath), error);
    }
  }
  for (const [seat, bytes] of SEAT_SKILLS) {
    try {
      effects.push(...(await materializeSeatSkill(worktree, seat, bytes, tracked)));
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
