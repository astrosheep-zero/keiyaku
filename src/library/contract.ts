import { documentDiff } from "../markdown/diff.js";
import { applyAmendDocument } from "../body/amend.js";
import { decodeArcDocument } from "../body/arc.js";
import { decodeContractDocument } from "../body/decode.js";
import {
  renderContractGuidance,
  resolveHereContractWorkspace,
  type ContractFileEffect,
  type ContractFileLag,
} from "../contract-worktree.js";
import {
  actorOption,
  contractTerms,
  documentDerivation,
  normalizedGates,
  normalizedList,
  optionalBoolean,
  optionalNonblank,
  optionalSignal,
  requireInput,
  requireMarkdown,
} from "./input.js";
import { observeRegion, type RegionObservation, type RegionOverlap } from "./region.js";
import { type Gate, type WorktreeHooks, worktreeHooksOption } from "./configuration.js";
import {
  type ActorId as FactActorId,
  contractId,
  type ChangeId,
  type ContractId,
  type ContractState,
  type JournalEntry,
  type SnapshotId,
} from "../core/facts/types.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
export { AuthorityCorruptionError } from "../core/facts/errors.js";
import {
  contractObservationOperation,
  contractsOperation,
  deliveryDiffOperation,
  deliveryOperation,
  stateOperation,
  type PlacementStop,
  type RepositoryScope,
  type VerificationStop,
  type DeliveryPreparationRefusal,
} from "../protocol/operations.js";
import type {
  ContractBoard,
  ContractDisposition,
  ContractGateCurrent,
  ContractGateReport,
  ContractObservation,
  ContractPhase,
  ContractRow,
} from "../protocol/read/status.js";
import type { AfterEndpointObservation, ContractAfterEdge, ContractDependent, ContractWorkspaceObservation } from "../protocol/read/status.js";
import { abandonOperation } from "../protocol/abandon.js";
import { amendOperation } from "../protocol/amend.js";
import { arcOperation } from "../protocol/arc.js";
import type { AuditReport } from "../protocol/audit.js";
import {
  deliverOperation,
  type IntegrationConflictMaterialized,
  type VerificationReuse,
} from "../protocol/deliver.js";
import type { ReconcileReport as ProtocolReconcileReport } from "../protocol/reconcile.js";
import { reviewOperation, type ReviewValue } from "../protocol/review.js";
import type { FactKind } from "../core/facts/types.js";
import { readDispatchesAt, type Dispatch } from "../dispatch/index.js";
import { mintSnapshotId } from "../git/identity.js";
import { observeContractsForAdmissionInObservationAt } from "../git/observe.js";
import { withGitDecodeChannel, withGitReadObservation, type GitDecodeChannel } from "../git/read-observation.js";
import { type SettlementReport } from "../settlement/settle.js";
import {
  claimTaskHolderWithFence,
  releaseTaskHolder,
  releaseTaskHolderWithFence,
  taskHolderObservationSelection,
} from "../settlement/holder.js";
import { parseTaskId, type TaskId } from "../task/identity.js";
import { Repo, reconcileInput, scopeForRepo, type ReconcileInput } from "./repo.js";
import {
  injectedBodyRequests,
  requestBodyDeliver,
  requestBodyReview,
  type UpstreamRequestOutcome,
} from "../akuma/requests.js";
import { auditContract, type AuditInput } from "./audit.js";
import { Delivery, deliveryHandle, type DeliveryValue } from "./delivery.js";
import { continueDeliveredDependents, type ContinuationReport } from "./continuation.js";
import {
  completionInput,
  completeHolderMutation,
  completeMutation,
  type AcceptedIntent,
  type MutationResult,
} from "./mutation.js";
import { completeReconcile } from "./reconcile.js";
import { admitBindWithAppointment } from "./bind.js";
import {
  KeiyakuRefused,
  KeiyakuRetry,
  requireAccepted,
  type KeiyakuRefusal,
  type KeiyakuRetryReason,
} from "./refusal.js";
export {
  KeiyakuRefused,
  type ContractAppointmentRefusal,
} from "./refusal.js";
export { KeiyakuRetry };
export type { KeiyakuRefusal, KeiyakuRetryReason };
export { gatesFrom, requireBranchesToBeUpToDateFrom, SettingsError } from "./configuration.js";
export type { Gate, GatesFromInput, HookCommand, RequireBranchesToBeUpToDateFromInput, WorktreeHooks } from "./configuration.js";

export type {
  AuditReport,
  DeliveryPreparationRefusal,
  ChangeId,
  ContractId,
  ContractState,
  ContractBoard,
  ContractDisposition,
  ContractGateCurrent,
  ContractGateReport,
  ContractObservation,
  ContractPhase,
  ContractRow,
  FactKind,
  SnapshotId,
};
export type { AfterEndpointObservation, ContractAfterEdge, ContractDependent, ContractWorkspaceObservation };
export type { TaskId };
export type { RegionOverlap };

export type Fact = JournalEntry;
export type ContractHistoryEvent =
  | Readonly<{ source: "journal"; fact: Fact }>
  | Readonly<{ source: "dispatch"; dispatch: Dispatch }>;
export type ContractHistory = Readonly<{
  id: ContractId;
  state: SnapshotId;
  events: readonly ContractHistoryEvent[];
}>;
export type ActorId = string;
export type AttestationVerdict = "satisfied" | "unsatisfied";
export type Review = ReviewValue & Readonly<{ continuation?: ContinuationReport }>;
export type { PlacementStop, VerificationReuse, VerificationStop, IntegrationConflictMaterialized };
export type { ContinuationReport };

export type TopologyEffect = ProtocolReconcileReport["effects"][number] | ContractFileEffect;
export type Lag = ProtocolReconcileReport["lag"][number] | ContractFileLag;
export type { MutationResult };
export { Delivery };

export type BindResult = Readonly<Omit<MutationResult<Keiyaku>, "value"> & { keiyaku: Keiyaku } & RegionObservation>;
export type AmendResult = Readonly<MutationResult<void> & RegionObservation & { documentDiff: string }>;
export type ReconcileReport = Readonly<{
  effects: readonly TopologyEffect[];
  lag: readonly Lag[];
  settlement: SettlementReport;
}>;
export type { SettlementAction, SettlementLag, SettlementReport } from "../settlement/settle.js";

export type BindInput = Readonly<{
  repo: Repo;
  markdown: string;
  task?: TaskId;
  target?: string;
  workspace?: "worktree" | "here";
  actor?: ActorId;
  after?: readonly ContractId[];
  gates?: readonly Gate[];
  hooks?: WorktreeHooks;
}>;

export type AmendInput = Readonly<{
  markdown?: string;
  actor?: ActorId;
  after?: readonly ContractId[];
  gates?: readonly Gate[];
  hooks?: WorktreeHooks;
}>;

export type ArcInput = Readonly<{
  markdown: string;
  actor?: ActorId;
  hooks?: WorktreeHooks;
}>;

type HookOptions = Readonly<{ hooks?: WorktreeHooks }>;
type ActorOptions = Readonly<{ actor?: ActorId }> & HookOptions;
export type ContractListInput = Readonly<{ repo: Repo }>;
export type ContractObservationInput = Readonly<{ repo: Repo; id: ContractId }>;
export type KeiyakuOfInput = Readonly<{ repo: Repo; id: ContractId }>;
export type ReviewInput = ActorOptions & Readonly<{ verdict: AttestationVerdict; summary?: string }>;
export type AbandonInput = ActorOptions & Readonly<{ note?: string }>;
export type DeliverInput = ActorOptions & Readonly<{
  message?: string; requireBranchesToBeUpToDate?: boolean;
  includeDirty?: boolean; materializeConflict?: boolean; signal?: AbortSignal;
}>;

type DeliveryExecutionInput = Readonly<{
  scope: RepositoryScope; contractId: ContractId;
  actor?: ReturnType<typeof actorOption>["actor"]; message?: string;
  requireBranchesToBeUpToDate: boolean; includeDirty: boolean; materializeConflict: boolean;
  signal?: AbortSignal; hooks: WorktreeHooks;
}>;

type ReviewExecutionInput = Readonly<{
  scope: RepositoryScope; contractId: ContractId;
  actor?: ReturnType<typeof actorOption>["actor"];
  verdict: AttestationVerdict; summary?: string; hooks: WorktreeHooks;
}>;

type ForwardedDeliveryReceipt =
  | Readonly<{ kind: "accepted"; result: MutationResult<DeliveryValue> }>
  | Readonly<{ kind: "refused"; refusal: KeiyakuRefusal }>
  | Readonly<{ kind: "retry"; reason: KeiyakuRetryReason }>
  | IntegrationConflictMaterialized;
type ForwardedReviewReceipt =
  | Readonly<{ kind: "accepted"; result: MutationResult<Review> }>
  | Readonly<{ kind: "refused"; refusal: KeiyakuRefusal }>
  | Readonly<{ kind: "retry"; reason: KeiyakuRetryReason }>;
export type { AuditInput };

function taskOption(value: unknown): TaskId | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError("task must be a TaskId");
  try {
    parseTaskId(value);
  } catch (error) {
    throw new TypeError(error instanceof Error ? error.message : "task must be a TaskId");
  }
  return value as TaskId;
}

async function resolveHereWorkspace(scope: RepositoryScope, id: ContractId): Promise<string | undefined> {
  const appointment = await resolveHereContractWorkspace(scope, id);
  if (appointment.kind === "failed") {
    if (appointment.cause === "duplicate") throw new AuthorityCorruptionError(appointment.diagnostic);
    throw new Error(appointment.diagnostic);
  }
  return appointment.kind === "appointed" ? appointment.path : undefined;
}

function derivedDocument(state: ContractState) {
  return documentDerivation(decodeContractDocument(state.terms.document.bytes), state.terms.gates, state.id);
}

async function continueAfterCompletion<Value extends Readonly<{ completion?: unknown }>>(input: Readonly<{
  scope: RepositoryScope;
  channel: GitDecodeChannel;
  contractId: ContractId;
  accepted: AcceptedIntent<Value>;
  actor?: FactActorId;
  signal?: AbortSignal;
}>): Promise<AcceptedIntent<Value & Readonly<{ continuation?: ContinuationReport }>>> {
  if (input.accepted.value.completion === undefined) return input.accepted;
  return await continueDeliveredDependents({
    ...input,
    deriveDocument: derivedDocument,
    resolveHereWorkspace: async (id) => await resolveHereWorkspace(input.scope, id),
  });
}

async function executeLocalDelivery(
  input: DeliveryExecutionInput,
): Promise<MutationResult<DeliveryValue> | IntegrationConflictMaterialized> {
  return withGitDecodeChannel(input.scope, async (channel) => {
    const outcome = await deliverOperation({
      scope: input.scope,
      channel,
      contractId: input.contractId,
      deriveDocument: derivedDocument,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      ...(input.message === undefined ? {} : { message: input.message }),
      requireBranchesToBeUpToDate: input.requireBranchesToBeUpToDate,
      includeDirty: input.includeDirty,
      materializeConflict: input.materializeConflict,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      resolveHereWorkspace: async (id) => await resolveHereWorkspace(input.scope, id),
    });
    if (outcome.kind === "integration-conflict-materialized") return outcome;
    const accepted = requireAccepted(outcome);
    const continued = await continueAfterCompletion({
      scope: input.scope,
      channel,
      contractId: input.contractId,
      accepted,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return completeMutation({
      ...completionInput(input.scope, channel, input.contractId, (delivery: DeliveryValue) => delivery, input.hooks),
      accepted: continued,
    });
  });
}

async function executeLocalReview(input: ReviewExecutionInput): Promise<MutationResult<Review>> {
  return withGitDecodeChannel(input.scope, async (channel) => {
    const accepted = requireAccepted(await reviewOperation({
      scope: input.scope,
      channel,
      contractId: input.contractId,
      deriveDocument: derivedDocument,
      verdict: input.verdict,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      resolveHereWorkspace: async (id) => await resolveHereWorkspace(input.scope, id),
    }));
    const continued = await continueAfterCompletion({
      scope: input.scope,
      channel,
      contractId: input.contractId,
      accepted,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
    });
    return completeMutation({
      ...completionInput(input.scope, channel, input.contractId, (review: Review) => review, input.hooks),
      accepted: continued,
    });
  });
}

function forwardedReceipt<Receipt>(outcome: UpstreamRequestOutcome, action: string): Receipt {
  if (outcome.kind === "failed") {
    throw new Error(outcome.failure.kind === "failed"
      ? outcome.failure.diagnostic
      : `Unexpected Akuma target failure for ${action}: ${outcome.failure.id}`);
  }
  return outcome.result as Receipt;
}

function requireForwardedDelivery(
  receipt: ForwardedDeliveryReceipt,
): MutationResult<DeliveryValue> | IntegrationConflictMaterialized {
  if (receipt.kind === "refused") throw new KeiyakuRefused(receipt.refusal);
  if (receipt.kind === "retry") throw new KeiyakuRetry(receipt.reason);
  return receipt.kind === "accepted" ? receipt.result : receipt;
}

function requireForwardedReview(receipt: ForwardedReviewReceipt): MutationResult<Review> {
  if (receipt.kind === "refused") throw new KeiyakuRefused(receipt.refusal);
  if (receipt.kind === "retry") throw new KeiyakuRetry(receipt.reason);
  return receipt.result;
}

export async function executeForwardedDeliver(input: Readonly<{
  repo: Repo; contractId: string; requester: string; message?: string;
  includeDirty: boolean; materializeConflict: boolean;
  requireBranchesToBeUpToDate: boolean; hooks: WorktreeHooks; signal?: AbortSignal;
}>): Promise<Readonly<{ result: ForwardedDeliveryReceipt; deliveryFactId?: string }>> {
  const id = contractId(input.contractId);
  const actor = actorOption(input.requester).actor;
  const message = optionalNonblank(input.message, "deliver message");
  try {
    const result = await executeLocalDelivery({
      scope: scopeForRepo(input.repo),
      contractId: id,
      ...(actor === undefined ? {} : { actor }),
      ...(message === undefined ? {} : { message }),
      requireBranchesToBeUpToDate: input.requireBranchesToBeUpToDate,
      includeDirty: input.includeDirty,
      materializeConflict: input.materializeConflict,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      hooks: input.hooks,
    });
    if (!("facts" in result)) return { result };
    const delivery = result.facts.find((fact) => fact.kind === "deliver");
    if (delivery === undefined) throw new Error("accepted delivery is missing its journal fact");
    return { result: { kind: "accepted", result }, deliveryFactId: delivery.entry };
  } catch (error) {
    if (error instanceof KeiyakuRefused) return { result: { kind: "refused", refusal: error.refusal } };
    if (error instanceof KeiyakuRetry) return { result: { kind: "retry", reason: error.reason } };
    throw error;
  }
}

export async function executeForwardedReview(input: Readonly<{
  repo: Repo;
  contractId: string;
  requester: string;
  verdict: AttestationVerdict;
  summary?: string;
  hooks: WorktreeHooks;
}>): Promise<Readonly<{ result: ForwardedReviewReceipt; reviewFactId?: string }>> {
  const id = contractId(input.contractId);
  const actor = actorOption(input.requester).actor;
  if (input.verdict !== "satisfied" && input.verdict !== "unsatisfied") {
    throw new TypeError("verdict must be satisfied or unsatisfied");
  }
  const summary = optionalNonblank(input.summary, "review summary");
  try {
    const result = await executeLocalReview({
      scope: scopeForRepo(input.repo),
      contractId: id,
      ...(actor === undefined ? {} : { actor }),
      verdict: input.verdict,
      ...(summary === undefined ? {} : { summary }),
      hooks: input.hooks,
    });
    const review = result.facts.find((fact) => fact.kind === "attestation");
    if (review === undefined) throw new Error("accepted review is missing its journal fact");
    return { result: { kind: "accepted", result }, reviewFactId: review.entry };
  } catch (error) {
    if (error instanceof KeiyakuRefused) return { result: { kind: "refused", refusal: error.refusal } };
    if (error instanceof KeiyakuRetry) return { result: { kind: "retry", reason: error.reason } };
    throw error;
  }
}

export class KeiyakuHandle {
  constructor(
    private readonly id: ContractId,
    private readonly scope: RepositoryScope,
  ) {
    KEIYAKU_SEATS.set(this, { id, scope });
  }

  async state(): Promise<ContractState> {
    return withGitDecodeChannel(this.scope, (channel) => stateOperation({
      scope: this.scope,
      channel,
      contractId: this.id,
    }));
  }

  async history(): Promise<ContractHistory> {
    return withGitDecodeChannel(this.scope, (channel) => withGitReadObservation(
      this.scope,
      channel,
      async (observation) => {
        const [journals, dispatches] = await Promise.all([
          observeContractsForAdmissionInObservationAt(observation, [this.id]),
          readDispatchesAt(observation),
        ]);
        const record = journals.journals.get(this.id);
        if (record === undefined) throw new Error(`missing requested contract observation: ${this.id}`);
        if (record.state === null) throw new KeiyakuRefused({ kind: "contract-missing", contractId: this.id });
        const commit = observation.snapshot.commit;
        if (commit === null) throw new Error("contract history requires a keiyaku-state snapshot");
        const recordedAt = (event: ContractHistoryEvent): string => (
          event.source === "journal" ? event.fact.at : event.dispatch.dispatchedAt
        );
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
      },
    ));
  }

  async guidance(): Promise<string> {
    return withGitDecodeChannel(this.scope, async (channel) => {
      const observed = await contractObservationOperation({ scope: this.scope, channel, contractId: this.id });
      if (observed.kind === "missing") throw new KeiyakuRefused({ kind: "contract-missing", contractId: this.id });
      return renderContractGuidance(await stateOperation({ scope: this.scope, channel, contractId: this.id }));
    });
  }

  async delivery(): Promise<Delivery | null> {
    const delivery = await withGitDecodeChannel(this.scope, (channel) => deliveryOperation({
      scope: this.scope,
      channel,
      contractId: this.id,
    }));
    return delivery === null
      ? null
      : this.deliveryHandle(delivery);
  }

  async amend(input: AmendInput): Promise<AmendResult> {
    const values = requireInput(input, "amend input");
    const hooks = worktreeHooksOption(values.hooks);
    const markdown = values.markdown === undefined ? undefined : requireMarkdown(values.markdown);
    const actor = actorOption(values.actor);
    const gates = values.gates === undefined ? undefined : normalizedGates(values.gates);
    const prerequisites = values.after === undefined
      ? undefined
      : normalizedList(values.after, "after", contractId);
    if (markdown === undefined && gates === undefined && prerequisites === undefined) {
      throw new TypeError("amend requires markdown, after, or gates");
    }
    return withGitDecodeChannel(this.scope, async (channel) => {
      const accepted = requireAccepted(await amendOperation({
        scope: this.scope,
        channel,
        contractId: this.id,
        ...actor,
        deriveAmendment: (source) => {
          const document = markdown === undefined
            ? decodeContractDocument(source.document.bytes)
            : decodeContractDocument(applyAmendDocument(
              markdown,
              decodeContractDocument(source.document.bytes),
            ));
          const terms = markdown === undefined
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
      }));
      const document = decodeContractDocument(accepted.value.terms.document.bytes);
      return {
        ...await completeMutation({
          ...completionInput(this.scope, channel, this.id, () => undefined, hooks),
          accepted,
        }),
        documentDiff: documentDiff(
          "before",
          "after",
          accepted.value.source.document.bytes,
          accepted.value.terms.document.bytes,
        ),
        ...await observeRegion(this.scope, channel, this.id, document.region),
      };
    });
  }

  async deliver(input?: DeliverInput): Promise<MutationResult<Delivery> | IntegrationConflictMaterialized> {
    const values = input === undefined ? undefined : requireInput(input, "deliver input");
    const hooks = worktreeHooksOption(values?.hooks);
    const message = optionalNonblank(values?.message, "deliver message");
    const requireBranchesToBeUpToDate = optionalBoolean(
      values?.requireBranchesToBeUpToDate, "requireBranchesToBeUpToDate",
    ) ?? false;
    const includeDirty = optionalBoolean(values?.includeDirty, "includeDirty") ?? false;
    const materializeConflict = optionalBoolean(values?.materializeConflict, "materializeConflict") ?? false;
    const actor = actorOption(values?.actor);
    const signal = optionalSignal(values?.signal);
    const requests = injectedBodyRequests();
    const result = requests === null
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
      : requireForwardedDelivery(forwardedReceipt<ForwardedDeliveryReceipt>(await requestBodyDeliver({
          directory: requests,
          repoRoot: this.scope.primaryWorktree,
          contractId: this.id,
          ...(message === undefined ? {} : { message }),
          includeDirty,
          materializeConflict,
          ...(signal === undefined ? {} : { signal }),
        }), "deliver"));
    return "facts" in result ? { ...result, value: this.deliveryHandle(result.value) } : result;
  }

  async review(input: ReviewInput): Promise<MutationResult<Review>> {
    const values = requireInput(input, "review input");
    const hooks = worktreeHooksOption(values.hooks);
    const verdict = values.verdict;
    if (verdict !== "satisfied" && verdict !== "unsatisfied") {
      throw new TypeError("verdict must be satisfied or unsatisfied");
    }
    const summary = optionalNonblank(values.summary, "review summary");
    const actor = actorOption(values.actor);
    const requests = injectedBodyRequests();
    if (requests !== null) {
      return requireForwardedReview(forwardedReceipt<ForwardedReviewReceipt>(await requestBodyReview({
        directory: requests,
        repoRoot: this.scope.primaryWorktree,
        contractId: this.id,
        verdict,
        ...(summary === undefined ? {} : { summary }),
      }), "review"));
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
      const admission = await releaseTaskHolderWithFence(this.scope, channel, this.id, () => abandonOperation({
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
      }));
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
      const accepted = requireAccepted(await arcOperation({
        scope: this.scope,
        channel,
        contractId: this.id,
        ...actorOption(values.actor),
        chapter,
      }));
      return completeMutation({
        ...completionInput(this.scope, channel, this.id, () => undefined, hooks),
        accepted,
      });
    });
  }

  async audit(input?: AuditInput): Promise<MutationResult<AuditReport>> {
    return auditContract({
      scope: this.scope,
      contractId: this.id,
      ...(input === undefined ? {} : { input }),
    });
  }

  async reconcile(input?: ReconcileInput): Promise<ReconcileReport> {
    const options = reconcileInput(input);
    return withGitDecodeChannel(this.scope, (channel) => completeReconcile({
      scope: this.scope, channel, contractId: this.id, ...options,
    }));
  }

  private deliveryHandle(delivery: DeliveryValue): Delivery {
    return deliveryHandle(
      delivery,
      () => deliveryDiffOperation({
        scope: this.scope,
        integrationPredecessor: delivery.integration.predecessor,
        integrationSnapshot: delivery.integration.snapshot,
      }),
    );
  }

}

const KEIYAKU_SEATS = new WeakMap<object, Readonly<{ id: ContractId; scope: RepositoryScope }>>();

/** Internal package composition capability; not exported from the package root. */
export function seatForKeiyaku(value: unknown): Readonly<{ id: ContractId; scope: RepositoryScope }> {
  if (!(value instanceof KeiyakuHandle)) throw new TypeError("contract must be a Keiyaku");
  const seat = KEIYAKU_SEATS.get(value);
  if (seat === undefined) throw new TypeError("contract must be a Keiyaku");
  return seat;
}

export type Keiyaku = KeiyakuHandle;

export function keiyakuOf(input: KeiyakuOfInput): Keiyaku {
  const values = requireInput(input, "Keiyaku.of input");
  const scope = scopeForRepo(values.repo);
  if (typeof values.id !== "string") throw new TypeError("contract ID must be a string");
  return new KeiyakuHandle(contractId(values.id), scope);
}

export async function listKeiyaku(input: ContractListInput): Promise<ContractBoard> {
  const values = requireInput(input, "Keiyaku.list input");
  for (const key of Object.keys(values)) if (key !== "repo") throw new TypeError(`Keiyaku.list input has unknown field: ${key}`);
  const scope = scopeForRepo(values.repo);
  return withGitDecodeChannel(scope, (channel) => contractsOperation({
    scope,
    channel,
    hereWorkspace: async (id) => await resolveHereContractWorkspace(scope, id),
  }));
}

export async function observeKeiyaku(input: ContractObservationInput): Promise<ContractObservation> {
  const values = requireInput(input, "Keiyaku.observe input");
  for (const key of Object.keys(values)) if (key !== "repo" && key !== "id") throw new TypeError(`Keiyaku.observe input has unknown field: ${key}`);
  const scope = scopeForRepo(values.repo);
  if (typeof values.id !== "string") throw new TypeError("contract ID must be a string");
  let id: ContractId;
  try {
    id = contractId(values.id);
  } catch (error) {
    throw new TypeError(error instanceof Error ? error.message : "contract ID is invalid");
  }
  return withGitDecodeChannel(scope, (channel) => contractObservationOperation({
    scope,
    channel,
    contractId: id,
    hereWorkspace: async (contract) => await resolveHereContractWorkspace(scope, contract),
  }));
}

export async function bindKeiyaku(input: BindInput): Promise<BindResult> {
  const values = requireInput(input, "Keiyaku.bind input");
  const hooks = worktreeHooksOption(values.hooks);
  const scope = scopeForRepo(values.repo);
  const markdown = requireMarkdown(values.markdown);
  const task = taskOption(values.task);
  const document = decodeContractDocument(markdown);
  const workspace = values.workspace === undefined ? "worktree" : values.workspace;
  if (workspace !== "worktree" && workspace !== "here") throw new TypeError("workspace must be worktree or here");
  const target = values.target;
  if (target !== undefined && typeof target !== "string") throw new TypeError("target must be a string");
  const actor = actorOption(values.actor);
  const terms = contractTerms(
    document,
    normalizedGates(values.gates),
    normalizedList(values.after, "after", contractId),
  );
  return withGitDecodeChannel(scope, async (channel) => {
    const admitCandidate = () => admitBindWithAppointment({
      scope,
      channel,
      title: document.title,
      terms,
      verification: documentDerivation(document, terms.gates).verification,
      workspace,
      ...(target === undefined ? {} : { target }),
      ...(task === undefined ? {} : { task }),
      ...actor,
    });
    const admission = task === undefined ? null : await claimTaskHolderWithFence(scope, task, admitCandidate);
    const accepted = requireAccepted(admission === null ? await admitCandidate() : admission.result);
    const id = accepted.value.contractId;
    const toHandle = ({ contractId: contract }: { contractId: ContractId }): Keiyaku => new KeiyakuHandle(contract, scope);
    const result = admission === null
      ? await completeMutation({ ...completionInput(scope, channel, id, toHandle, hooks), accepted })
      : await completeHolderMutation({
          completion: completionInput(scope, channel, id, toHandle, hooks),
          admission,
          requireAccepted,
        });
    return {
      facts: result.facts,
      head: result.head,
      keiyaku: result.value,
      effects: result.effects,
      lags: result.lags,
      settlement: result.settlement,
      ...await observeRegion(scope, channel, id, document.region),
    };
  });
}
