import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { currentBranchOperation, scopeOperation, type RepositoryScope } from "../protocol/operations.js";
import { NoGitWorldError } from "../git/repository.js";
import { optionalNonblank, requireInput } from "./input.js";

export { NoGitWorldError };

/** One explicit worktree coordinate. The caller resolves relative and ambient spellings, never this edge. */
export type RepoAtInput = Readonly<{ path: string; gitPath?: string }>;

const REPO_SCOPES = new WeakMap<object, RepositoryScope>();

async function resolvePinnedScope(values: Record<string, unknown>): Promise<RepositoryScope> {
  const path = values.path;
  if (typeof path !== "string" || path.trim().length === 0)
    throw new TypeError("repository path must be a nonblank string");
  if (!isAbsolute(path)) throw new TypeError(`repository path must be absolute: ${path}`);
  const gitPath = optionalNonblank(values.gitPath, "Git executable path");
  return await scopeOperation({
    coordinate: await realpath(path),
    ...(gitPath === undefined ? {} : { gitPath }),
  });
}

/** One Git world shared by its worktrees; it is coordinate proof and branch observation only. */
export class Repo {
  readonly root: string;
  readonly cwd: string;

  private constructor(scope: RepositoryScope) {
    this.root = scope.primaryWorktree;
    this.cwd = scope.invocationWorktree;
    REPO_SCOPES.set(this, scope);
  }

  static async at(input: RepoAtInput): Promise<Repo> {
    return new Repo(await resolvePinnedScope(requireInput(input, "Repo.at input", ["path", "gitPath"])));
  }

  async currentBranch(): Promise<string | null> {
    return await currentBranchOperation({ scope: scopeForRepo(this) });
  }
}

export function scopeForRepo(value: unknown): RepositoryScope {
  if (!(value instanceof Repo)) throw new TypeError("repo must be a Repo");
  const scope = REPO_SCOPES.get(value);
  if (scope === undefined) throw new TypeError("repo must be a Repo");
  return scope;
}
