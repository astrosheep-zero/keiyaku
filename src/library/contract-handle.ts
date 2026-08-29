import { documentDiff } from "../markdown/diff.js";
import { applyAmendDocument } from "../body/amend.js";
import { decodeArcDocument } from "../body/arc.js";
import { decodeContractDocument } from "../body/decode.js";
import { renderContractGuidance } from "../contract-guidance.js";
import {
  actorOption,
  contractTerms,
  documentDerivation,
  normalizedGates,
  normalizedList,
  optionalBoolean,
  optionalNonblank,
  optionalSignal,
  invalidInput,
  requireInput,
  requireMarkdown,
} from "./input.js";
import { observeChangedRegion } from "./region.js";
import { worktreeHooksOption } from "./configuration.js";
import { contractId, type ContractId, type ContractState } from "../core/facts/types.js";
import {
  contractObservationOperation,
  deliveryDiffOperation,
  deliveryOperation,
  stateOperation,
  type RepositoryScope,
} from "../protocol/operations.js";
import { abandonOperation } from "../protocol/abandon.js";
import { amendOperation } from "../protocol/amend.js";
import { arcOperation } from "../protocol/arc.js";
import type { AuditReport } from "../protocol/audit.js";
import type { IntegrationConflictMaterialized } from "../protocol/deliver.js";
import { readDispatchesAt } from "../dispatch/index.js";
import { mintSnapshotId } from "../git/identity.js";
import { observeContractsForAdmissionInObservationAt } from "../git/observe.js";
import { withGitDecodeChannel, withGitReadObservation } from "../git/read-observation.js";
import { releaseTaskHolder, releaseTaskHolderWithFence, taskHolderObservationSelection } from "../settlement/holder.js";
import { reconcileInput, type ReconcileInput } from "./repo.js";
import { executionChannel, localExecutionContext, type ExecutionContext } from "../akuma/requests.js";
import { auditContract, type AuditInput } from "./audit.js";
import { Delivery, deliveryHandle, type DeliveryValue } from "./delivery.js";
import { completionInput, completeHolderMutation, completeMutation, type MutationResult } from "./mutation.js";
import { completeReconcile } from "./reconcile.js";
import type {
  AbandonInput,
  AmendInput,
  AmendResult,
  ArcInput,
  DeliverInput,
  ReconcileReport,
  ReviewInput,
  ContractHistory,
  ContractHistoryEvent,
} from "./contract-types.js";
import {
  executeLocalDelivery,
  executeLocalReview,
  requestForwardedContractLive,
  type Review as OperationReview,
} from "./contract-operations.js";
import { KeiyakuRefused, requireAccepted } from "./refusal.js";
type Review = OperationReview;

export class KeiyakuHandle {
  constructor(
    private readonly id: ContractId,
    private readonly scope: RepositoryScope,
    private readonly execution: ExecutionContext = localExecutionContext(),
  ) {
    KEIYAKU_SEATS.set(this, { id, scope });
  }

  async state(): Promise<ContractState> {
    return withGitDecodeChannel(this.scope, (channel) =>
      stateOperation({
        scope: this.scope,
        channel,
        contractId: this.id,
      }),
    );
  }

  async history(): Promise<ContractHistory> {
    return withGitDecodeChannel(this.scope, (channel) =>
      withGitReadObservation(this.scope, channel, async (observation) => {
        const [journals, dispatches] = await Promise.all([
          observeContractsForAdmissionInObservationAt(observation, [this.id]),
          readDispatchesAt(observation),
        ]);
        const record = journals.journals.get(this.id);
        if (record === undefined) throw new Error(`missing requested contract observation: ${this.id}`);
        if (record.state === null) throw new KeiyakuRefused({ kind: "contract-missing", contractId: this.id });
        const commit = observation.snapshot.commit;
        if (commit === null) throw new Error("contract history requires a keiyaku-state snapshot");
        const recordedAt = (event: ContractHistoryEvent): string =>
          event.source === "journal" ? event.fact.at : event.dispatch.dispatchedAt;
        const events = [
          ...record.entries.map((fact) => ({ source: "journal" as const, fact })),
          ...dispatches
            .filter((dispatch) => dispatch.contractId === this.id)
            .map((dispatch) => ({ source: "dispatch" as const, dispatch })),
        ].sort((left, right) => {
          const leftAt = recordedAt(left);
          const rightAt = recordedAt(right);
          if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
          if (left.source !== right.source) return left.source === "journal" ? -1 : 1;
          return 0;
        });
        return { id: this.id, state: mintSnapshotId(commit), events };
      }),
    );
  }

  async guidance(): Promise<string> {
    return withGitDecodeChannel(this.scope, async (channel) => {
      const observed = await contractObservationOperation({ scope: this.scope, channel, contractId: this.id });
      if (observed.kind === "missing") throw new KeiyakuRefused({ kind: "contract-missing", contractId: this.id });
      return renderContractGuidance(await stateOperation({ scope: this.scope, channel, contractId: this.id }));
    });
  }

  async delivery(): Promise<Delivery | null> {
    const delivery = await withGitDecodeChannel(this.scope, (channel) =>
      deliveryOperation({
        scope: this.scope,
        channel,
        contractId: this.id,
      }),
    );
    return delivery === null ? null : this.deliveryHandle(delivery);
  }

  async amend(input: AmendInput): Promise<AmendResult> {
    const values = requireInput(input, "amend input");
    const hooks = worktreeHooksOption(values.hooks);
    const markdown = values.markdown === undefined ? undefined : requireMarkdown(values.markdown);
    const actor = actorOption(values.actor);
    const gates = values.gates === undefined ? undefined : normalizedGates(values.gates);
    const prerequisites = values.after === undefined ? undefined : normalizedList(values.after, "after", contractId);
    if (markdown === undefined && gates === undefined && prerequisites === undefined) {
      return invalidInput("amend requires markdown, after, or gates");
    }
    const amendment = await withGitDecodeChannel(this.scope, async (channel) => {
      let changedSections: ReadonlySet<string> | undefined;
      const accepted = requireAccepted(
        await amendOperation({
          scope: this.scope,
          channel,
          contractId: this.id,
          ...actor,
          deriveAmendment: (source) => {
            const amendment =
              markdown === undefined
                ? undefined
                : applyAmendDocument(markdown, decodeContractDocument(source.document.bytes));
            changedSections = amendment?.changedSections;
            const document =
              amendment === undefined
                ? decodeContractDocument(source.document.bytes)
                : decodeContractDocument(amendment.document);
            const terms =
              markdown === undefined
                ? {
                    document: source.document,
                    segments: source.segments,
                    gates: gates ?? source.gates,
                    after: prerequisites ?? source.after,
                  }
                : contractTerms(document, gates ?? source.gates, prerequisites ?? source.after);
            return {
              terms,
              verification: documentDerivation(document, terms.gates, this.id).verification,
            };
          },
        }),
      );
      const completed = await completeMutation({
        ...completionInput(this.scope, channel, this.id, () => undefined, hooks),
        accepted,
      });
      return {
        completed,
        document: decodeContractDocument(accepted.value.terms.document.bytes),
        changedSections,
        documentDiff: documentDiff(
          "before",
          "after",
          accepted.value.source.document.bytes,
          accepted.value.terms.document.bytes,
        ),
      };
    });
    const regionObservation = await observeChangedRegion(
      this.scope,
      this.id,
      amendment.changedSections,
      amendment.document.region,
    );
    return {
      ...amendment.completed,
      documentDiff: amendment.documentDiff,
      ...regionObservation,
    };
  }

  async deliver(input?: DeliverInput): Promise<MutationResult<Delivery> | IntegrationConflictMaterialized> {
    const values = input === undefined ? undefined : requireInput(input, "deliver input");
    const hooks = worktreeHooksOption(values?.hooks);
    const message = optionalNonblank(values?.message, "deliver message");
    const requireBranchesToBeUpToDate =
      optionalBoolean(values?.requireBranchesToBeUpToDate, "requireBranchesToBeUpToDate") ?? false;
    const includeDirty = optionalBoolean(values?.includeDirty, "includeDirty") ?? false;
    const materializeConflict = optionalBoolean(values?.materializeConflict, "materializeConflict") ?? false;
    const actor = actorOption(values?.actor);
    const signal = optionalSignal(values?.signal);
    const channel = executionChannel(this.execution);
    const result =
      channel.kind === "local"
        ? await executeLocalDelivery({
            scope: this.scope,
            contractId: this.id,
            ...actor,
            ...(message === undefined ? {} : { message }),
            requireBranchesToBeUpToDate,
            includeDirty,
            materializeConflict,
            ...(signal === undefined ? {} : { signal }),
            hooks,
          })
        : await requestForwardedContractLive({
            directory: channel.directory,
            action: "contract.deliver",
            request: {
              action: "contract.deliver",
              repoRoot: this.scope.primaryWorktree,
              contractId: this.id,
              ...(message === undefined ? {} : { message }),
              includeDirty,
              materializeConflict,
            },
            ...(signal === undefined ? {} : { signal }),
          });
    return "facts" in result ? { ...result, value: this.deliveryHandle(result.value) } : result;
  }

  async review(input: ReviewInput): Promise<MutationResult<Review>> {
    const values = requireInput(input, "review input");
    const hooks = worktreeHooksOption(values.hooks);
    const verdict = values.verdict;
    if (verdict !== "satisfied" && verdict !== "unsatisfied") {
      return invalidInput("verdict must be satisfied or unsatisfied");
    }
    const summary = optionalNonblank(values.summary, "review summary");
    const actor = actorOption(values.actor);
    const channel = executionChannel(this.execution);
    if (channel.kind === "body-request") {
      return await requestForwardedContractLive({
        directory: channel.directory,
        action: "contract.review",
        request: {
          action: "contract.review",
          repoRoot: this.scope.primaryWorktree,
          contractId: this.id,
          verdict,
          ...(summary === undefined ? {} : { summary }),
        },
      });
    }
    return await executeLocalReview({
      scope: this.scope,
      contractId: this.id,
      ...actor,
      verdict,
      ...(summary === undefined ? {} : { summary }),
      hooks,
    });
  }

  async abandon(input?: AbandonInput): Promise<MutationResult<void>> {
    const values = input === undefined ? undefined : requireInput(input, "abandon input");
    const hooks = worktreeHooksOption(values?.hooks);
    const note = optionalNonblank(values?.note, "abandon note");
    return withGitDecodeChannel(this.scope, async (channel) => {
      const admission = await releaseTaskHolderWithFence(this.scope, channel, this.id, () =>
        abandonOperation({
          scope: this.scope,
          channel,
          contractId: this.id,
          ...actorOption(values?.actor),
          ...(note === undefined ? {} : { note }),
          observationSelection: taskHolderObservationSelection(),
          decorateOffer: async ({ observation, contractId: owner }) => {
            const companion = await releaseTaskHolder(channel, observation, owner);
            return companion === null ? [] : [companion];
          },
        }),
      );
      return completeHolderMutation({
        completion: completionInput(this.scope, channel, this.id, () => undefined, hooks),
        admission,
        requireAccepted,
      });
    });
  }

  async arc(input: ArcInput): Promise<MutationResult<void>> {
    const values = requireInput(input, "arc input");
    const hooks = worktreeHooksOption(values.hooks);
    const chapter = decodeArcDocument(requireMarkdown(values.markdown));
    return withGitDecodeChannel(this.scope, async (channel) => {
      const accepted = requireAccepted(
        await arcOperation({
          scope: this.scope,
          channel,
          contractId: this.id,
          ...actorOption(values.actor),
          chapter,
        }),
      );
      return completeMutation({
        ...completionInput(this.scope, channel, this.id, () => undefined, hooks),
        accepted,
      });
    });
  }

  async audit(input?: AuditInput): Promise<MutationResult<AuditReport>> {
    const channel = executionChannel(this.execution);
    if (channel.kind === "body-request") {
      const values = input === undefined ? undefined : requireInput(input, "audit input");
      worktreeHooksOption(values?.hooks);
      actorOption(values?.actor);
      const includeDirty = optionalBoolean(values?.includeDirty, "includeDirty") ?? false;
      const showDiff = optionalBoolean(values?.showDiff, "showDiff") ?? false;
      const requireBranchesToBeUpToDate =
        optionalBoolean(values?.requireBranchesToBeUpToDate, "requireBranchesToBeUpToDate") ?? false;
      const signal = optionalSignal(values?.signal);
      return await requestForwardedContractLive({
        directory: channel.directory,
        action: "contract.audit",
        request: {
          action: "contract.audit",
          repoRoot: this.scope.primaryWorktree,
          contractId: this.id,
          includeDirty,
          showDiff,
          requireBranchesToBeUpToDate,
        },
        ...(signal === undefined ? {} : { signal }),
      });
    }
    return auditContract({
      scope: this.scope,
      contractId: this.id,
      ...(input === undefined ? {} : { input }),
    });
  }

  async reconcile(input?: ReconcileInput): Promise<ReconcileReport> {
    const options = reconcileInput(input);
    return withGitDecodeChannel(this.scope, (channel) =>
      completeReconcile({
        scope: this.scope,
        channel,
        contractId: this.id,
        ...options,
      }),
    );
  }

  private deliveryHandle(delivery: DeliveryValue): Delivery {
    return deliveryHandle(delivery, () =>
      deliveryDiffOperation({
        scope: this.scope,
        integrationPredecessor: delivery.integration.predecessor,
        integrationSnapshot: delivery.integration.snapshot,
      }),
    );
  }
}

const KEIYAKU_SEATS = new WeakMap<object, Readonly<{ id: ContractId; scope: RepositoryScope }>>();

/** Internal package composition capability; not exported from the package root. */
export function seatForKeiyaku(value: unknown): Readonly<{ id: ContractId; scope: RepositoryScope }> | null {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? (KEIYAKU_SEATS.get(value) ?? null)
    : null;
}
