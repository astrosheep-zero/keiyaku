import {
  currentBranchOperation,
  NoGitWorldError,
  reconcileAllOperation,
  scopeOperation,
  type ReconcileReport as ProtocolReconcileReport,
  type RepositoryScope,
} from "../protocol/operations.js";
import { settleAll, type SettlementReport } from "../settlement/settle.js";
import { optionalNonblank, requireInput } from "./input.js";
import { worktreeHooksOption, type WorktreeHooks } from "./configuration.js";
import type { ContractId } from "../core/facts/types.js";
import { withGitDecodeChannel } from "../git/read-observation.js";

export { NoGitWorldError };

export type RepoAtInput = Readonly<{ path?: string }>;
export type ReconcileInput = Readonly<{ hooks?: WorktreeHooks; retryHooks?: boolean }>;
export type RepoContractReconcileReport = Readonly<ProtocolReconcileReport & { settlement: SettlementReport }>;
export type RepoReconcileReport = Readonly<{
  contracts: readonly Readonly<{ contractId: ContractId; report: RepoContractReconcileReport }>[];
}>;

const REPO_SCOPES = new WeakMap<object, RepositoryScope>();

function resolvePinnedScope(path?: string): RepositoryScope {
  return scopeOperation({ coordinate: path === undefined ? process.cwd() : path });
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

  private constructor(scope: RepositoryScope) {
    this.root = scope.primaryWorktree;
    REPO_SCOPES.set(this, scope);
  }

  static at(input?: RepoAtInput): Repo {
    const values = input === undefined ? undefined : requireInput(input, "Repo.at input");
    return new Repo(resolvePinnedScope(optionalNonblank(values?.path, "repository path")));
  }

  async currentBranch(): Promise<string | null> {
    return currentBranchOperation({ scope: scopeForRepo(this) });
  }

  async reconcile(input?: ReconcileInput): Promise<RepoReconcileReport> {
    const scope = scopeForRepo(this);
    return withGitDecodeChannel(scope, async (channel) => {
      const reconciled = await reconcileAllOperation({ scope, channel, ...reconcileInput(input) });
      const settlements = await settleAll({
        repository: scope,
        channel,
        contracts: reconciled.contracts.map((contract) => ({
          state: contract.state,
          effects: contract.report.effects,
        })),
      });
      return {
        contracts: reconciled.contracts.map((contract, index) => ({
          contractId: contract.contractId,
          report: {
            ...contract.report,
            settlement: settlements[index]!,
          },
        })),
      };
    });
  }
}

export function scopeForRepo(value: unknown): RepositoryScope {
  if (!(value instanceof Repo)) throw new TypeError("repo must be a Repo");
  const scope = REPO_SCOPES.get(value);
  if (scope === undefined) throw new TypeError("repo must be a Repo");
  return scope;
}
