import { decodeContractDocument } from "../body/decode.js";
import type { ActorId, ContractId } from "../core/facts/types.js";
import { withContractExecution } from "./contract-execution.js";
import { auditOperation, type AuditReport } from "../protocol/audit.js";
import { type RepositoryScope } from "../protocol/operations.js";
import { worktreeHooksOption, type WorktreeHooks } from "./configuration.js";
import { documentDerivation } from "./input.js";
import { completeMutation, type MutationResult } from "./mutation.js";
import { requireAccepted } from "./refusal.js";

export type AuditInput = Readonly<{
  includeDirty?: boolean;
  showDiff?: boolean;
  signal?: AbortSignal;
}>;

export type AuditOptions = Readonly<{
  includeDirty: boolean;
  showDiff: boolean;
  signal?: AbortSignal;
}>;

export type AuditComposition = Readonly<{
  actor?: ActorId;
  hooks?: WorktreeHooks;
  requireBranchesToBeUpToDate?: boolean;
}>;

/** Normalize public audit input and project the protocol audit operation. */
export async function auditContract(
  input: Readonly<{
    scope: RepositoryScope;
    contractId: ContractId;
    input: AuditOptions;
    composition?: AuditComposition;
  }>,
): Promise<MutationResult<AuditReport>> {
  const composition = input.composition;
  return withContractExecution(
    {
      scope: input.scope,
      contractId: input.contractId,
      hooks: composition?.hooks ?? worktreeHooksOption(undefined),
      ...(input.input.signal === undefined ? {} : { signal: input.input.signal }),
    },
    "audit",
    async ({ scope, channel, progress }) => {
      const accepted = requireAccepted(
        await auditOperation({
          scope,
          channel,
          progress,
          contractId: input.contractId,
          deriveDocument: (state) =>
            documentDerivation(decodeContractDocument(state.terms.document.bytes), state.terms.gates, state.id),
          includeDirty: input.input.includeDirty,
          showDiff: input.input.showDiff,
          requireBranchesToBeUpToDate: composition?.requireBranchesToBeUpToDate ?? false,
          ...(input.input.signal === undefined ? {} : { signal: input.input.signal }),
          ...(composition?.actor === undefined ? {} : { actor: composition.actor }),
        }),
      );
      return completeMutation({
        operation: "audit",
        progress,
        scope,
        channel,
        contractId: input.contractId,
        accepted,
        value: (report: AuditReport) => report,
        hooks: composition?.hooks ?? worktreeHooksOption(undefined),
      });
    },
  );
}
