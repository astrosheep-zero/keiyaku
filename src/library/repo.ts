import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { currentBranchOperation, scopeOperation, type RepositoryScope } from "../protocol/operations.js";
import { NoGitWorldError } from "../git/repository.js";
import { optionalNonblank, requireInput } from "./input.js";

export { NoGitWorldError };
export type { RepoContractReconcileReport, RepoReconcileReport } from "./reconcile.js";

export type RepoAtInput = Readonly<{ path?: string; gitPath?: string }>;

const REPO_SCOPES = new WeakMap<object, RepositoryScope>();

async function resolvePinnedScope(path?: string, gitPath?: string): Promise<RepositoryScope> {
  return await scopeOperation({
    coordinate: await realpath(resolve(path === undefined ? process.cwd() : path)),
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

  static async at(input?: RepoAtInput): Promise<Repo> {
    const values = input === undefined ? undefined : requireInput(input, "Repo.at input");
    return new Repo(
      await resolvePinnedScope(
        optionalNonblank(values?.path, "repository path"),
        optionalNonblank(values?.gitPath, "Git executable path"),
      ),
    );
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
