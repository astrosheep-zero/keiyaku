import { documentDiff } from "../markdown/diff.js";
import { applyAmendDocument } from "../body/amend.js";
import { decodeArcDocument } from "../body/arc.js";
import { decodeContractDocument } from "../body/decode.js";
import { renderContractGuidance } from "../contract-worktree.js";
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
import { observeChangedRegion, type RegionOverlap } from "./region.js";
import { worktreeHooksOption } from "./configuration.js";
import {
  contractId,
  type ChangeId,
  type FactKind,
  type ContractId,
  type ContractState,
  type SnapshotId,
} from "../core/facts/types.js";
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
  AfterEndpointObservation,
  ContractAfterEdge,
  ContractDependent,
  ContractWorkspaceObservation,
} from "../protocol/read/status.js";
import { abandonOperation } from "../protocol/abandon.js";
import { amendOperation } from "../protocol/amend.js";
import { arcOperation } from "../protocol/arc.js";
import type { AuditReport } from "../protocol/audit.js";
import type { IntegrationConflictMaterialized, VerificationReuse } from "../protocol/deliver.js";
import { readDispatchesAt } from "../dispatch/index.js";
import { mintSnapshotId } from "../git/identity.js";
import { observeContractsForAdmissionInObservationAt } from "../git/observe.js";
import { withGitDecodeChannel, withGitReadObservation } from "../git/read-observation.js";
import { releaseTaskHolder, releaseTaskHolderWithFence, taskHolderObservationSelection } from "../settlement/holder.js";
import type { TaskId } from "../task/identity.js";
import { reconcileInput, scopeForRepo, type ReconcileInput } from "./repo.js";
import { injectedBodyRequests, requestBodyDeliver, requestBodyReview } from "../akuma/requests.js";
import { auditContract, type AuditInput } from "./audit.js";
import { Delivery, deliveryHandle, type DeliveryValue } from "./delivery.js";
import { type ContinuationReport } from "./continuation.js";
import { completionInput, completeHolderMutation, completeMutation, type MutationResult } from "./mutation.js";
import { completeReconcile } from "./reconcile.js";
import { bindFromCli as bindFromCliImplementation, bindKeiyaku as bindKeiyakuImplementation } from "./contract-bind.js";
import type {
  AbandonInput,
  AmendInput,
  AmendResult,
  ArcInput,
  BindInput,
  BindResult,
  ContractListInput,
  ContractObservationInput,
  DeliverInput,
  ForkBindInput,
  KeiyakuOfInput,
  MarkdownBindInput,
  ReconcileReport,
  ReviewInput,
  ContractHistory,
  ContractHistoryEvent,
  Fact,
  Lag,
  TopologyEffect,
} from "./contract-types.js";
import {
  executeLocalDelivery,
  executeLocalReview,
  forwardedReceipt,
  requireForwarded,
  type AttestationVerdict as OperationAttestationVerdict,
  type ForwardedDeliveryReceipt,
  type ForwardedReviewReceipt,
  type Review as OperationReview,
} from "./contract-operations.js";
import {
  KeiyakuRefused,
  KeiyakuRetry,
  requireAccepted,
  type KeiyakuRefusal,
  type KeiyakuRetryReason,
} from "./refusal.js";
export { KeiyakuRefused } from "./refusal.js";
export { KeiyakuRetry, type KeiyakuRefusal, type KeiyakuRetryReason };
export { executeForwardedDeliver, executeForwardedReview } from "./contract-operations.js";
export { gatesFrom, requireBranchesToBeUpToDateFrom, SettingsError } from "./configuration.js";
export type {
  Gate,
  GatesFromInput,
  HookCommand,
  RequireBranchesToBeUpToDateFromInput,
  WorktreeHooks,
} from "./configuration.js";

export type {
  AbandonInput,
  AmendInput,
  AmendResult,
  ArcInput,
  AuditInput,
  AuditReport,
  ChangeId,
  ContinuationReport,
  ContractBoard,
  ContractDisposition,
  ContractGateCurrent,
  ContractGateReport,
  ContractAfterEdge,
  ContractId,
  ContractHistory,
  ContractHistoryEvent,
  ContractDependent,
  ContractObservation,
  ContractPhase,
  ContractRow,
  ContractState,
  ContractWorkspaceObservation,
  BindInput,
  BindResult,
  ContractListInput,
  ContractObservationInput,
  DeliverInput,
  ForkBindInput,
  KeiyakuOfInput,
  MarkdownBindInput,
  ReconcileReport,
  ReviewInput,
  DeliveryPreparationRefusal,
  Fact,
  FactKind,
  IntegrationConflictMaterialized,
  Lag,
  MutationResult,
  PlacementStop,
  RegionOverlap,
  SnapshotId,
  TaskId,
  TopologyEffect,
  VerificationReuse,
  VerificationStop,
};
export type { AfterEndpointObservation };

export type ActorId = string;
export type AttestationVerdict = OperationAttestationVerdict;
export type Review = OperationReview;

export { Delivery };

export type { SettlementAction, SettlementLag, SettlementReport } from "../settlement/settle.js";

export class KeiyakuHandle {
  constructor(
    private readonly id: ContractId,
    private readonly scope: RepositoryScope,
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
      throw new TypeError("amend requires markdown, after, or gates");
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
    const requests = injectedBodyRequests();
    const result =
      requests === null
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
        : requireForwarded(
            forwardedReceipt<ForwardedDeliveryReceipt>(
              await requestBodyDeliver({
                directory: requests,
                repoRoot: this.scope.primaryWorktree,
                contractId: this.id,
                ...(message === undefined ? {} : { message }),
                includeDirty,
                materializeConflict,
                ...(signal === undefined ? {} : { signal }),
              }),
              "deliver",
            ),
          );
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
      return requireForwarded(
        forwardedReceipt<ForwardedReviewReceipt>(
          await requestBodyReview({
            directory: requests,
            repoRoot: this.scope.primaryWorktree,
            contractId: this.id,
            verdict,
            ...(summary === undefined ? {} : { summary }),
          }),
          "review",
        ),
      );
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
  for (const key of Object.keys(values))
    if (key !== "repo") throw new TypeError(`Keiyaku.list input has unknown field: ${key}`);
  const scope = scopeForRepo(values.repo);
  return withGitDecodeChannel(scope, (channel) => contractsOperation({ scope, channel }));
}

export async function observeKeiyaku(input: ContractObservationInput): Promise<ContractObservation> {
  const values = requireInput(input, "Keiyaku.observe input");
  for (const key of Object.keys(values))
    if (key !== "repo" && key !== "id") throw new TypeError(`Keiyaku.observe input has unknown field: ${key}`);
  const scope = scopeForRepo(values.repo);
  if (typeof values.id !== "string") throw new TypeError("contract ID must be a string");
  let id: ContractId;
  try {
    id = contractId(values.id);
  } catch (error) {
    throw new TypeError(error instanceof Error ? error.message : "contract ID is invalid");
  }
  return withGitDecodeChannel(scope, (channel) => contractObservationOperation({ scope, channel, contractId: id }));
}

export async function bindKeiyaku(input: BindInput): Promise<BindResult> {
  return bindKeiyakuImplementation(input, (id, scope) => new KeiyakuHandle(id, scope));
}

/** Internal CLI composition; not exported from the package root. */
export async function bindFromCli(input: BindInput): Promise<BindResult> {
  return bindFromCliImplementation(input, (id, scope) => new KeiyakuHandle(id, scope));
}
