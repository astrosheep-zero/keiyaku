import { decodeContractDocument } from "../body/decode.js";
import type { ContractId } from "../core/facts/types.js";
import { withGitDecodeChannel } from "../git/read-observation.js";
import {
  auditOperation,
  type AuditReport,
  type RepositoryScope,
} from "../protocol/operations.js";
import { worktreeHooksOption, type WorktreeHooks } from "./configuration.js";
import {
  actorOption,
  documentDerivation,
  optionalBoolean,
  optionalSignal,
  requireInput,
} from "./input.js";
import { completeMutation, type MutationResult } from "./mutation.js";
import { requireAccepted } from "./refusal.js";

export type AuditInput = Readonly<{
  actor?: string;
  hooks?: WorktreeHooks;
  includeDirty?: boolean;
  showDiff?: boolean;
  requireBranchesToBeUpToDate?: boolean;
  signal?: AbortSignal;
}>;

function normalizeAuditInput(input?: AuditInput) {
  const values = input === undefined ? undefined : requireInput(input, "audit input");
  const signal = optionalSignal(values?.signal);
  return {
    hooks: worktreeHooksOption(values?.hooks),
    ...actorOption(values?.actor),
    includeDirty: optionalBoolean(values?.includeDirty, "includeDirty") ?? false,
    showDiff: optionalBoolean(values?.showDiff, "showDiff") ?? false,
    requireBranchesToBeUpToDate: optionalBoolean(
      values?.requireBranchesToBeUpToDate,
      "requireBranchesToBeUpToDate",
    ) ?? false,
    ...(signal === undefined ? {} : { signal }),
  };
}

/** Normalize public audit input and project the protocol audit operation. */
export async function auditContract(input: Readonly<{
  scope: RepositoryScope;
  contractId: ContractId;
  input?: AuditInput;
}>): Promise<MutationResult<AuditReport>> {
  const normalized = normalizeAuditInput(input.input);
  return withGitDecodeChannel(input.scope, async (channel) => {
    const accepted = requireAccepted(await auditOperation({
      scope: input.scope,
      channel,
      contractId: input.contractId,
      deriveDocument: (state) => documentDerivation(
        decodeContractDocument(state.terms.document.bytes),
        state.terms.gates,
        state.id,
      ),
      includeDirty: normalized.includeDirty,
      showDiff: normalized.showDiff,
      requireBranchesToBeUpToDate: normalized.requireBranchesToBeUpToDate,
      ...(normalized.signal === undefined ? {} : { signal: normalized.signal }),
      ...(normalized.actor === undefined ? {} : { actor: normalized.actor }),
    }));
    return completeMutation({
      scope: input.scope,
      channel,
      contractId: input.contractId,
      accepted,
      value: (report: AuditReport) => report,
      hooks: normalized.hooks,
    });
  });
}
