/** @architectureCompositionRoot */
import { AkumaBodyRequestError } from "../akuma/request-rendezvous.js";
import { executionChannel, type ExecutionContext } from "../akuma/requests.js";
import { prepareAmendDocument } from "../body/amend.js";
import { decodeArcDocument } from "../body/arc.js";
import { decodeContractDocument } from "../body/decode.js";
import { contractId, type ContractId, type ContractState } from "../core/facts/types.js";
import type { WorktreeHooks } from "../git/hooks.js";
import { withGitDecodeChannel, type GitDecodeChannel } from "../git/read-observation.js";
import { documentDiff } from "../markdown/diff.js";
import { abandonOperation } from "../protocol/abandon.js";
import { amendOperation } from "../protocol/amend.js";
import { arcOperation } from "../protocol/arc.js";
import { auditOperation, type AuditReport } from "../protocol/audit.js";
import { completeCandidate, type CompletionEvidence } from "../protocol/completion.js";
import { admitDeliveryOperation } from "../protocol/deliver.js";
import type { ExecutionObserver } from "../protocol/execution-observation.js";
import {
  withScopeAbortSignal,
  type DocumentDerivation,
  type IntentOutcome,
  type RepositoryScope,
} from "../protocol/operations.js";
import type { AcceptedProtocolStep } from "../protocol/outcome.js";
import {
  executionStop,
  isOperationalFailure,
  isOperationalStop,
  type ContractCheckpoint,
} from "../protocol/progress.js";
import { admitReviewOperation } from "../protocol/review.js";
import { releaseTaskHolder, releaseTaskHolderWithFence, taskHolderObservationSelection } from "../settlement/holder.js";
import { continueDeliveredDependents } from "./continuation.js";
import { requestForwardedContractLive, type ContractRequest } from "./contract-operations.js";
import type {
  AbandonOutcome,
  AmendOutcome,
  AmendValue,
  ArcOutcome,
  AuditInput,
  AuditOutcome,
  DeliverOutcome,
  MutationObservation,
  ReviewOutcome,
} from "./contract-outcomes.js";
import { acceptedOutcome, admissionOf, conclusions, expected, retainAdmission } from "./contract-outcomes.js";
import {
  derivedContractPolicy,
  derivedGates,
  derivedHooks,
  gateNames,
  type LocalContractCompositionCapture,
} from "./contract-settings.js";
import type { AbandonInput, AmendInput, ArcInput, DeliverInput, ReviewInput } from "./contract-types.js";
import { deliveryForContract, type Delivery, type DeliveryValue } from "./delivery.js";
import {
  actorOption,
  contractTerms,
  documentDerivation,
  normalizedList,
  optionalBoolean,
  optionalNonblank,
  optionalSignal,
  requireInput,
  requireMarkdown,
} from "./input.js";
import { InvocationAccumulator } from "./invocation.js";
import {
  KeiyakuError,
  errorCategory,
  project,
  validated,
  type ContractVerb,
  type OutcomeProjection,
  type Projected,
  type ProjectedOutcome,
  type Review,
} from "./outcome.js";
import { completeReconcile } from "./reconcile.js";
import type { OperationRefusals } from "./refusal.js";
import { observeChangedRegion } from "./region.js";

type AcceptedIntent<Value> = Extract<IntentOutcome<Value>, { kind: "accepted" }>;
export class ContractExecution {
  constructor(
    private readonly seat: Readonly<{
      id: ContractId;
      scope: RepositoryScope;
      execution: ExecutionContext;
      composition: LocalContractCompositionCapture;
    }>,
  ) {}
  private get id() {
    return this.seat.id;
  }
  private get scope() {
    return this.seat.scope;
  }
  private get execution() {
    return this.seat.execution;
  }
  private get composition() {
    return this.seat.composition;
  }
  private amendInput(input: AmendInput) {
    return validated(() => {
      const values = requireInput(input, "amend input", ["actor", "markdown", "gates", "after"]);
      const derived = values.gates === undefined ? undefined : derivedGates(this.composition, gateNames(values.gates));
      return {
        markdown: values.markdown === undefined ? undefined : requireMarkdown(values.markdown),
        gates: derived === undefined ? undefined : derived.gates,
        gateWarnings: derived === undefined ? [] : derived.warnings,
        prerequisites: values.after === undefined ? undefined : normalizedList(values.after, "after", contractId),
        actor: actorOption(values.actor).actor,
      };
    });
  }
  async amend(input: AmendInput): Promise<AmendOutcome> {
    const { markdown, gates, gateWarnings, prerequisites, actor } = this.amendInput(input);
    const hooks = derivedHooks(this.composition);
    const amendmentPlan = markdown === undefined ? undefined : validated(() => prepareAmendDocument(markdown));
    validated(() => {
      if (markdown === undefined && gates === undefined && prerequisites === undefined)
        throw new TypeError("amend requires markdown, after, or gates");
    });
    let changedSections: ReadonlySet<string> | undefined;
    return await this.local(
      "amend",
      async (
        accumulator,
        channel,
        scope,
      ): Promise<OutcomeProjection<"amend", AmendValue, OperationRefusals["amend"]>> => {
        const admission = admissionOf(
          await amendOperation({
            scope,
            channel,
            contractId: this.id,
            progress: accumulator,
            ...(actor === undefined ? {} : { actor }),
            deriveAmendment: (source) => {
              const current = persistedDocument(source.document.bytes);
              const amendment = amendmentPlan === undefined ? undefined : validated(() => amendmentPlan(current));
              changedSections = amendment?.changedSections;
              const amended =
                amendment === undefined ? current : validated(() => decodeContractDocument(amendment.document));
              const terms =
                markdown === undefined
                  ? {
                      document: source.document,
                      segments: source.segments,
                      gates: gates ?? source.gates,
                      after: prerequisites ?? source.after,
                    }
                  : contractTerms(amended, gates ?? source.gates, prerequisites ?? source.after);
              return { terms, verification: documentDerivation(amended, terms.gates, this.id).verification };
            },
          }),
        );
        if (admission.kind !== "accepted") return expected(this.id, admission);
        const accepted = admission.accepted;
        const changes = changedAmendTerms(accepted.value.source, accepted.value.terms);
        const diff = documentDiff(
          "before",
          "after",
          accepted.value.source.document.bytes,
          accepted.value.terms.document.bytes,
        );
        accumulator.extendConclusions(this.id, { documentDiff: diff, changes });
        const region = await observeChangedRegion(
          scope,
          this.id,
          changedSections,
          decodeContractDocument(accepted.value.terms.document.bytes).region,
        );
        const value = await this.conclude(accumulator, {
          scope,
          channel,
          leading: accepted,
          hooks,
          verificationResidueRecorded: false,
          value: (): AmendValue => ({
            documentDiff: diff,
            changes,
            ...(gateWarnings.length === 0 ? {} : { gateWarnings }),
            ...region,
          }),
        });
        return acceptedOutcome("amend", this.id, accumulator, value);
      },
    );
  }

  /** One promise with an optional observation callback; observation never delays custody. */
  async deliver(input?: DeliverInput, options?: MutationObservation): Promise<DeliverOutcome> {
    const values = validated(() => normalizeDeliverInput(input));
    const observer = validated(() => observationOptions(options));
    const channel = executionChannel(this.execution);
    if (channel.kind === "body-request")
      return await forwardedContractOutcome<"deliver", Delivery & DeliveryValue>({
        revive: (value) => deliveryForContract(this.scope, value),
        directory: channel.directory,
        action: "contract.deliver",
        ...(observer === undefined ? {} : { observe: observer }),
        ...(values.signal === undefined ? {} : { signal: values.signal }),
        request: {
          action: "contract.deliver",
          repoRoot: this.scope.primaryWorktree,
          contractId: this.id,
          ...(values.message === undefined ? {} : { message: values.message }),
          includeDirty: values.includeDirty,
          materializeConflict: values.materializeConflict,
          overwrite: values.overwrite,
        },
      });
    const { hooks, requireBranchesToBeUpToDate } = derivedContractPolicy(this.composition);
    return await this.local(
      "deliver",
      async (
        accumulator,
        localChannel,
        scope,
      ): Promise<OutcomeProjection<"deliver", Delivery & DeliveryValue, OperationRefusals["deliver"]>> => {
        let leadingValue: DeliveryValue | undefined;
        let stage: import("../protocol/progress.js").ExecutionStage = "admission";
        try {
          values.signal?.throwIfAborted();
          const outcome = await admitDeliveryOperation({
            scope,
            channel: localChannel,
            contractId: this.id,
            progress: accumulator,
            ...(this.composition.actor === undefined ? {} : { actor: this.composition.actor }),
            ...(values.signal === undefined ? {} : { signal: values.signal }),
            ...(values.message === undefined ? {} : { message: values.message }),
            includeDirty: values.includeDirty,
            materializeConflict: values.materializeConflict,
            overwrite: values.overwrite,
            requireBranchesToBeUpToDate,
            deriveDocument: derivedDocument,
          });
          if (outcome.kind === "integration-conflict-materialized")
            return { kind: "handoff", contract: this.id, value: outcome };
          if (outcome.kind !== "accepted") return expected(this.id, outcome);
          leadingValue = outcome.value;
          stage = "verification";
          await advanceAndContinue(
            accumulator,
            scope,
            localChannel,
            this.id,
            this.composition,
            outcome,
            values.signal,
            "verification",
          );
        } catch (error) {
          retainTrailingFailure(accumulator, this.id, error, values.signal, stage);
        }
        const base = admittedDeliveryValue(accumulator, this.id);
        requireMatchingDeliveryLeading(leadingValue, base);
        const retained = accumulator.conclusions(this.id) ?? {};
        const value: DeliveryValue = { ...base, ...leadingValue, ...retained } as DeliveryValue;
        accumulator.recordConclusions(this.id, value);
        await this.reconcileContracts(accumulator, scope, localChannel, hooks);
        return acceptedOutcome("deliver", this.id, accumulator, deliveryForContract(this.scope, value));
      },
      values.signal,
      observer,
    );
  }

  async review(input: ReviewInput, options?: MutationObservation): Promise<ReviewOutcome> {
    const values = validated(() => requireInput(input, "review input", ["verdict", "summary", "signal"]));
    const verdict = values.verdict;
    if (verdict !== "satisfied" && verdict !== "unsatisfied")
      throw new KeiyakuError("invalid-input", "verdict must be satisfied or unsatisfied", {
        cause: new TypeError("verdict must be satisfied or unsatisfied"),
      });
    const summary = validated(() => optionalNonblank(values.summary, "review summary"));
    const signal = validated(() => optionalSignal(values.signal));
    const observer = validated(() => observationOptions(options));
    const channel = executionChannel(this.execution);
    if (channel.kind === "body-request")
      return await forwardedContractOutcome<"review", Review>({
        directory: channel.directory,
        action: "contract.review",
        ...(observer === undefined ? {} : { observe: observer }),
        ...(signal === undefined ? {} : { signal }),
        request: {
          action: "contract.review",
          repoRoot: this.scope.primaryWorktree,
          contractId: this.id,
          verdict,
          ...(summary === undefined ? {} : { summary }),
        },
      });
    const hooks = derivedHooks(this.composition);
    return await this.local(
      "review",
      async (
        accumulator,
        localChannel,
        scope,
      ): Promise<OutcomeProjection<"review", Review, OperationRefusals["review"]>> => {
        let value: Review = {};
        let stage: import("../protocol/progress.js").ExecutionStage = "admission";
        try {
          signal?.throwIfAborted();
          const outcome = await admitReviewOperation({
            scope,
            channel: localChannel,
            contractId: this.id,
            progress: accumulator,
            ...(this.composition.actor === undefined ? {} : { actor: this.composition.actor }),
            ...(signal === undefined ? {} : { signal }),
            verdict,
            ...(summary === undefined ? {} : { summary }),
          });
          if (outcome.kind !== "accepted") return expected(this.id, outcome);
          value = outcome.value;
          accumulator.extendConclusions(this.id, value);
          stage = "placement";
          if (verdict === "satisfied")
            value = {
              ...value,
              ...(await advanceAndContinue(
                accumulator,
                scope,
                localChannel,
                this.id,
                this.composition,
                outcome,
                signal,
                "placement",
              )),
            };
        } catch (error) {
          retainTrailingFailure(accumulator, this.id, error, signal, stage);
        }
        const retained: Review = { ...value, ...accumulator.conclusions(this.id) };
        accumulator.extendConclusions(this.id, retained);
        await this.reconcileContracts(accumulator, scope, localChannel, hooks);
        return acceptedOutcome("review", this.id, accumulator, retained);
      },
      signal,
      observer,
    );
  }

  async abandon(input?: AbandonInput): Promise<AbandonOutcome> {
    const { note, actor } = validated(() => {
      const values = input === undefined ? undefined : requireInput(input, "abandon input", ["note", "actor"]);
      return {
        note: optionalNonblank(values?.note, "abandon note"),
        actor: actorOption(values?.actor),
      };
    });
    const hooks = derivedHooks(this.composition);
    return await this.local(
      "abandon",
      async (
        accumulator,
        channel,
        scope,
      ): Promise<OutcomeProjection<"abandon", void, OperationRefusals["abandon"]>> => {
        const admission = admissionOf(
          (
            await releaseTaskHolderWithFence(scope, channel, this.id, () =>
              abandonOperation({
                scope,
                channel,
                contractId: this.id,
                ...actor,
                ...(note === undefined ? {} : { note }),
                observationSelection: taskHolderObservationSelection(),
                progress: accumulator,
                decorateOffer: async ({ observation, contractId: owner }) => {
                  const companion = await releaseTaskHolder(channel, observation, owner);
                  return companion === null ? [] : [companion];
                },
              }),
            )
          ).result,
        );
        if (admission.kind !== "accepted") return expected(this.id, admission);
        await this.conclude(accumulator, {
          scope,
          channel,
          leading: admission.accepted,
          hooks,
          verificationResidueRecorded: false,
          value: () => ({}),
        });
        return acceptedOutcome("abandon", this.id, accumulator, undefined);
      },
    );
  }

  async arc(input: ArcInput): Promise<ArcOutcome> {
    const { chapter, actor } = validated(() => {
      const values = requireInput(input, "arc input", ["markdown", "actor"]);
      return {
        chapter: decodeArcDocument(requireMarkdown(values.markdown)),
        actor: actorOption(values.actor),
      };
    });
    const hooks = derivedHooks(this.composition);
    return await this.local(
      "arc",
      async (accumulator, channel, scope): Promise<OutcomeProjection<"arc", void, OperationRefusals["arc"]>> => {
        const admission = admissionOf(
          await arcOperation({
            scope,
            channel,
            contractId: this.id,
            ...actor,
            chapter,
            progress: accumulator,
          }),
        );
        if (admission.kind !== "accepted") return expected(this.id, admission);
        await this.conclude(accumulator, {
          scope,
          channel,
          leading: admission.accepted,
          hooks,
          verificationResidueRecorded: false,
          value: () => ({}),
        });
        return acceptedOutcome("arc", this.id, accumulator, undefined);
      },
    );
  }

  async audit(input?: AuditInput, options?: MutationObservation): Promise<AuditOutcome> {
    const values = validated(() =>
      input === undefined ? undefined : requireInput(input, "audit input", ["includeDirty", "showDiff", "signal"]),
    );
    const includeDirty = validated(() => optionalBoolean(values?.includeDirty, "includeDirty") ?? false);
    const showDiff = validated(() => optionalBoolean(values?.showDiff, "showDiff") ?? false);
    const signal = validated(() => optionalSignal(values?.signal));
    const observer = validated(() => observationOptions(options));
    const channel = executionChannel(this.execution);
    if (channel.kind === "body-request")
      return await forwardedContractOutcome<"audit", AuditReport>({
        directory: channel.directory,
        action: "contract.audit",
        ...(observer === undefined ? {} : { observe: observer }),
        ...(signal === undefined ? {} : { signal }),
        request: {
          action: "contract.audit",
          repoRoot: this.scope.primaryWorktree,
          contractId: this.id,
          includeDirty,
          showDiff,
        },
      });
    const { hooks, requireBranchesToBeUpToDate } = derivedContractPolicy(this.composition);
    return await this.local(
      "audit",
      async (
        accumulator,
        localChannel,
        scope,
      ): Promise<OutcomeProjection<"audit", AuditReport, OperationRefusals["audit"]>> => {
        const admission = admissionOf(
          await auditOperation({
            scope,
            channel: localChannel,
            progress: accumulator,
            contractId: this.id,
            deriveDocument: derivedDocument,
            includeDirty,
            showDiff,
            requireBranchesToBeUpToDate,
            ...(signal === undefined ? {} : { signal }),
            ...(this.composition.actor === undefined ? {} : { actor: this.composition.actor }),
          }),
        );
        if (admission.kind !== "accepted") return expected(this.id, admission);
        const report = await this.conclude(accumulator, {
          scope,
          channel: localChannel,
          leading: admission.accepted,
          hooks,
          verificationResidueRecorded: false,
          value: (value: AuditReport) => value,
        });
        return acceptedOutcome("audit", this.id, accumulator, report);
      },
      signal,
      observer,
    );
  }

  /** One accumulator before the first admission-capable await, one projector after teardown. */
  private async local<Operation extends ContractVerb, Value, Refusal>(
    operation: Operation,
    run: (
      accumulator: InvocationAccumulator,
      channel: GitDecodeChannel,
      scope: RepositoryScope,
    ) => Promise<OutcomeProjection<Operation, Value, Refusal>>,
    signal?: AbortSignal,
    observer?: ExecutionObserver,
  ): Promise<ProjectedOutcome<Operation, Value, Refusal>> {
    const accumulator = new InvocationAccumulator(observer);
    const scope = withScopeAbortSignal(this.scope, signal);
    let projection: OutcomeProjection<Operation, Value, Refusal>;
    let completed: OutcomeProjection<Operation, Value, Refusal> | undefined;
    let retirement: unknown;
    try {
      projection = await withGitDecodeChannel(
        scope,
        async (channel) => {
          completed = await run(accumulator, channel, scope);
          return completed;
        },
        (error) => {
          retirement = error;
          accumulator.recordChannelRetirement(this.id, error);
        },
      );
    } catch (error) {
      projection =
        error === retirement && completed?.kind === "accepted" && isOperationalFailure(error)
          ? completed
          : { kind: "failed", contract: this.id, error: invocationFailure(error, scope.signal) };
    }
    const projected: Projected<Operation, Value, Refusal> = project(operation, accumulator.snapshot(), projection);
    if (projected.kind === "failed") throw projected.error;
    return projected.outcome;
  }

  private async conclude<Value, Public extends object>(
    accumulator: InvocationAccumulator,
    input: Readonly<{
      scope: RepositoryScope;
      channel: GitDecodeChannel;
      leading: AcceptedIntent<Value>;
      hooks: WorktreeHooks;
      verificationResidueRecorded: boolean;
      value: (value: Value) => Public;
    }>,
  ): Promise<Public> {
    retainAdmission(accumulator, this.id, input.leading, input.verificationResidueRecorded);
    const value = input.value(input.leading.value);
    accumulator.extendConclusions(this.id, conclusions(value));
    await this.reconcileContracts(accumulator, input.scope, input.channel, input.hooks);
    return value;
  }

  private async reconcileContracts(
    accumulator: InvocationAccumulator,
    scope: RepositoryScope,
    channel: GitDecodeChannel,
    hooks: WorktreeHooks,
  ): Promise<void> {
    for (const contract of [...new Set([this.id, ...accumulator.snapshot().affected])]) {
      try {
        scope.signal?.throwIfAborted();
        accumulator.observe({ kind: "stage", contractId: contract, stage: "reconciliation", state: "started" });
        const report = await (async () => {
          try {
            return await completeReconcile({
              scope,
              channel,
              contractId: contract,
              hooks,
              retryHooks: false,
              progress: accumulator,
            });
          } finally {
            accumulator.observe({ kind: "stage", contractId: contract, stage: "reconciliation", state: "finished" });
          }
        })();
        void report;
      } catch (error) {
        if (!isOperationalStop(error, scope.signal)) throw error;
        accumulator.recordStop(executionStop(contract, "reconciliation", error, scope.signal));
      }
    }
  }
}
function changedAmendTerms(before: ContractState["terms"], after: ContractState["terms"]): AmendValue["changes"] {
  return {
    ...(before.gates.length === after.gates.length && before.gates.every((gate, index) => gate === after.gates[index])
      ? {}
      : { gates: after.gates }),
    ...(before.after.length === after.after.length && before.after.every((id, index) => id === after.after[index])
      ? {}
      : { after: after.after }),
  };
}

function persistedDocument(bytes: string): ReturnType<typeof decodeContractDocument> {
  try {
    return decodeContractDocument(bytes);
  } catch (cause) {
    throw new KeiyakuError("authority-corruption", "undecodable persisted Contract document", { cause });
  }
}

function derivedDocument(state: ContractState): DocumentDerivation {
  return documentDerivation(persistedDocument(state.terms.document.bytes), state.terms.gates, state.id);
}

function observationOptions(options: MutationObservation | undefined): ExecutionObserver | undefined {
  if (options === undefined) return undefined;
  const input = requireInput(options, "observation options", ["observe"]);
  if (input.observe !== undefined && typeof input.observe !== "function")
    throw new TypeError("observe must be a function");
  return input.observe as ExecutionObserver | undefined;
}

type DeliverValues = Readonly<{
  message?: string;
  includeDirty: boolean;
  materializeConflict: boolean;
  overwrite: boolean;
  signal?: AbortSignal;
}>;

function normalizeDeliverInput(input: DeliverInput | undefined): DeliverValues {
  const values =
    input === undefined
      ? undefined
      : requireInput(input, "deliver input", ["message", "includeDirty", "materializeConflict", "overwrite", "signal"]);
  const message = optionalNonblank(values?.message, "deliver message");
  const signal = optionalSignal(values?.signal);
  return {
    ...(message === undefined ? {} : { message }),
    includeDirty: optionalBoolean(values?.includeDirty, "includeDirty") ?? false,
    materializeConflict: optionalBoolean(values?.materializeConflict, "materializeConflict") ?? false,
    overwrite: optionalBoolean(values?.overwrite, "overwrite") ?? false,
    ...(signal === undefined ? {} : { signal }),
  };
}

/** A trailing operational failure after a confirmed admission is a typed stop, never a lost receipt. */
function retainTrailingFailure(
  accumulator: InvocationAccumulator,
  contractId: ContractId,
  error: unknown,
  signal: AbortSignal | undefined,
  stage: import("../protocol/progress.js").ExecutionStage,
): void {
  if (accumulator.head(contractId) === undefined) throw error;
  if (!isOperationalStop(error, signal)) throw error;
  accumulator.recordStop(executionStop(contractId, stage, error, signal));
}

// eslint-disable-next-line max-params -- Keep this local operation's custody, admission, and policy witnesses explicit.
async function advanceAndContinue(
  accumulator: InvocationAccumulator,
  scope: RepositoryScope,
  channel: GitDecodeChannel,
  contractId: ContractId,
  composition: LocalContractCompositionCapture,
  outcome: AcceptedProtocolStep,
  signal: AbortSignal | undefined,
  start: "verification" | "placement",
): Promise<CompletionEvidence & Pick<DeliveryValue, "continuation">> {
  const checkpoint: ContractCheckpoint = { state: outcome.state, journal: outcome.journal };
  const result = await completeCandidate({
    repository: scope,
    channel,
    checkpoint,
    progress: accumulator,
    start,
    deriveDocument: derivedDocument,
    ...(composition.actor === undefined ? {} : { actor: composition.actor }),
    ...(signal === undefined ? {} : { signal }),
  });
  accumulator.recordCandidate(contractId, result.evidence);
  if (result.kind !== "completed") return { ...result.evidence };
  accumulator.observe({ kind: "stage", contractId, stage: "continuation", state: "started" });
  const continuation = await continueDeliveredDependents({
    scope,
    channel,
    progress: accumulator,
    completed: result,
    deriveDocument: derivedDocument,
    ...(composition.actor === undefined ? {} : { actor: composition.actor }),
    ...(signal === undefined ? {} : { signal }),
  });
  accumulator.observe({ kind: "stage", contractId, stage: "continuation", state: "finished" });
  return { ...result.evidence, ...(continuation === undefined ? {} : { continuation }) };
}

/** An accepted delivery's leading act must be the fact this invocation admitted. */
function requireMatchingDeliveryLeading(leading: DeliveryValue | undefined, base: DeliveryValue): void {
  const mismatched =
    leading !== undefined && (leading.leading.kind !== base.leading.kind || leading.leading.fact !== base.leading.fact);
  if (mismatched) throw new Error("accepted delivery leading disagrees with its admitted fact");
}

function admittedDeliveryValue(accumulator: InvocationAccumulator, contractId: ContractId): DeliveryValue {
  const fact = accumulator.snapshot().facts.find((entry) => entry.contract === contractId && entry.kind === "deliver");
  if (fact?.kind === "deliver") return { ...fact.data, leading: { kind: "admitted-now", fact: fact.entry } };
  const delivery = accumulator.checkpoint(contractId)?.state.delivery;
  if (delivery !== undefined && delivery !== null)
    return { ...delivery.data, leading: { kind: "already-admitted", fact: delivery.entry } };
  throw new Error("confirmed delivery requires its own receipt");
}

async function forwardedContractOutcome<Operation extends "deliver" | "review" | "audit", Value>(
  input: Readonly<{
    directory: string;
    action: ContractRequest["action"];
    revive?: (value: Value) => Value;
    request: ContractRequest;
    signal?: AbortSignal;
    observe?: ExecutionObserver;
  }>,
): Promise<ProjectedOutcome<Operation, Value, OperationRefusals[Operation]>> {
  try {
    const result = (await requestForwardedContractLive({
      directory: input.directory,
      action: input.action,
      request: input.request,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.observe === undefined ? {} : { observe: input.observe }),
    })) as ProjectedOutcome<Operation, Value, OperationRefusals[Operation]>;
    return result.kind === "accepted" && input.revive !== undefined
      ? { ...result, value: input.revive(result.value) }
      : result;
  } catch (error) {
    if (error instanceof KeiyakuError) throw error;
    if (input.signal?.aborted === true && error === input.signal.reason) throw invocationFailure(error, input.signal);
    throw new KeiyakuError(
      error instanceof AkumaBodyRequestError && (error.outcome === "unknown" || error.outcome === "unproven")
        ? "unknown-outcome"
        : errorCategory(error),
      errorMessage(error),
      {
        cause: error,
      },
    );
  }
}

function invocationFailure(error: unknown, signal?: AbortSignal): unknown {
  return signal?.aborted === true && error === signal.reason
    ? new KeiyakuError("aborted", errorMessage(error), { cause: error })
    : error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
