import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { currentBranchOperation, scopeOperation, type RepositoryScope } from "../protocol/operations.js";
import { NoGitWorldError } from "../git/repository.js";
import { optionalNonblank, requireInput } from "./input.js";
import { worktreeHooksOption, type WorktreeHooks } from "./configuration.js";
import { withGitDecodeChannel } from "../git/read-observation.js";
import { completeRepoReconcile, type RepoContractReconcileReport, type RepoReconcileReport } from "./reconcile.js";

export { NoGitWorldError };
export type { RepoContractReconcileReport, RepoReconcileReport };

export type RepoAtInput = Readonly<{ path?: string; gitPath?: string }>;
export type ReconcileInput = Readonly<{ hooks?: WorktreeHooks; retryHooks?: boolean }>;

const REPO_SCOPES = new WeakMap<object, RepositoryScope>();

async function resolvePinnedScope(path?: string, gitPath?: string): Promise<RepositoryScope> {
  return await scopeOperation({
    coordinate: await realpath(resolve(path === undefined ? process.cwd() : path)),
    ...(gitPath === undefined ? {} : { gitPath }),
  });
}

export function reconcileInput(input: ReconcileInput | undefined): Readonly<{
  hooks: WorktreeHooks;
  retryHooks: boolean;
}> {
  const values = input === undefined ? undefined : requireInput(input, "reconcile input");
  if (values?.retryHooks !== undefined && typeof values.retryHooks !== "boolean") {
    throw new TypeError("retryHooks must be a boolean");
  }
  return {
    hooks: worktreeHooksOption(values?.hooks),
    retryHooks: values?.retryHooks ?? false,
  };
}

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

  async reconcile(input?: ReconcileInput): Promise<RepoReconcileReport> {
    const scope = scopeForRepo(this);
    const options = reconcileInput(input);
    return await withGitDecodeChannel(scope, (channel) =>
      completeRepoReconcile({
        scope,
        channel,
        ...options,
      }),
    );
  }
}

export function scopeForRepo(value: unknown): RepositoryScope {
  if (!(value instanceof Repo)) throw new TypeError("repo must be a Repo");
  const scope = REPO_SCOPES.get(value);
  if (scope === undefined) throw new TypeError("repo must be a Repo");
  return scope;
}
