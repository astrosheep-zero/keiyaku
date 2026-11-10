/** @architectureCompositionRoot */
import { prepareAmendDocument } from "../body/amend.js";
import { decodeArcDocument } from "../body/arc.js";
import { decodeContractDocument } from "../body/decode.js";
import { normalizeTitle } from "../markdown/query.js";
import { contractId, type ContractId, type ContractState } from "../core/facts/types.js";
import type { WorktreeHooks } from "../git/hooks.js";
import { withGitDecodeChannel, type GitDecodeChannel } from "../git/read-observation.js";
import { abandonOperation } from "../protocol/abandon.js";
import { amendOperation } from "../protocol/amend.js";
import { arcOperation } from "../protocol/arc.js";
import { previewDeliveryOperation, type DeliveryPreviewReport } from "../protocol/delivery-preview.js";
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
import { admitReviewOperation, type ReviewAdmissionValue } from "../protocol/review.js";
import { verifyOperation, compactVerify } from "../protocol/verify.js";
import { releaseDebtHolder, releaseDebtHolderWithFence, debtHolderObservationSelection } from "../settlement/holder.js";
import { continueDeliveredDependents } from "./continuation.js";
import type {
  AbandonOutcome,
  AmendOutcome,
  AmendValue,
  ArcOutcome,
  DeliveryPreviewInput,
  DeliveryPreviewOutcome,
  DeliverOutcome,
  MutationObservation,
  ReviewOutcome,
  VerifyOutcome,
} from "./contract-outcomes.js";
import { acceptedOutcome, expected, retainAdmission } from "./contract-outcomes.js";
import {
  derivedContractPolicy,
  derivedFreshness,
  derivedGates,
  derivedHooks,
  gateNames,
  type LocalContractCompositionCapture,
} from "./contract-settings.js";
import type { AbandonInput, AmendInput, ArcInput, DeliverInput, ReviewInput, VerifyInput } from "./contract-types.js";
import { compactDelivery, type Delivery, type RawDeliveryValue } from "./delivery.js";
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
  project,
  compactReview,
  validated,
  type ContractVerb,
  type OutcomeProjection,
  type Projected,
  type ProjectedOutcome,
  type Review,
  type Verify,
} from "./outcome.js";
import { reconcileAffectedContracts } from "./reconcile.js";
import {
  compactDeliverRefusal,
  compactPreviewRefusal,
  compactVerifyRefusal,
  type OperationRefusals,
} from "./refusal.js";
import { observeChangedRegion } from "./region.js";

type AcceptedIntent<Value> = Extract<IntentOutcome<Value>, { kind: "accepted" }>;
type RawReview = CompletionEvidence &
  ReviewAdmissionValue &
  Readonly<{ continuation?: import("./continuation.js").ContinuationReport }>;
export class ContractExecution {
  constructor(
    private readonly seat: Readonly<{
      id: ContractId;
      scope: RepositoryScope;
      composition: LocalContractCompositionCapture;
    }>,
  ) {}
  private get id() {
    return this.seat.id;
  }
  private get scope() {
    return this.seat.scope;
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
        gates: derived,
        prerequisites: values.after === undefined ? undefined : normalizedList(values.after, "after", contractId),
        actor: actorOption(values.actor).actor,
      };
    });
  }
  async amend(input: AmendInput): Promise<AmendOutcome> {
    const { markdown, gates, prerequisites, actor } = this.amendInput(input);
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
        const admission = await amendOperation({
          scope,
          channel,
          contractId: this.id,
          progress: accumulator,
          ...(actor === undefined ? {} : { actor }),
          deriveAmendment: (source) => {
            const current = persistedDocument(source.document.bytes);
            const amendment = amendmentPlan === undefined ? undefined : validated(() => amendmentPlan(current));
            const amended =
              amendment === undefined ? current : validated(() => decodeContractDocument(amendment.document));
            changedSections =
              amendment === undefined
                ? undefined
                : new Set(
                    [...amendment.changedSections].filter(
                      (section) => sectionValue(current, section) !== sectionValue(amended, section),
                    ),
                  );
            const terms = contractTerms(amended, gates ?? source.gates, prerequisites ?? source.after);
            return { terms, verification: documentDerivation(amended, terms.gates).verification };
          },
        });
        if (admission.kind !== "accepted") return expected(this.id, admission);
        const changes = changedAmendTerms(admission.value.source, admission.value.terms);
        const sections =
          changedSections === undefined || changedSections.size === 0 ? {} : { changedSections: [...changedSections] };
        accumulator.extendConclusions(this.id, { ...sections, ...changes });
        const region = await observeChangedRegion(
          scope,
          this.id,
          changedSections,
          decodeContractDocument(admission.value.terms.document.bytes).region,
        );
        const value = await this.conclude(accumulator, {
          scope,
          channel,
          leading: admission,
          hooks,
          value: (): AmendValue => ({
            ...sections,
            ...changes,
            ...region,
          }),
        });
        return acceptedOutcome(this.id, accumulator, value);
      },
    );
  }

  /** One promise with an optional observation callback; observation never delays custody. */
  async deliver(input?: DeliverInput, options?: MutationObservation): Promise<DeliverOutcome> {
    const values = validated(() => normalizeDeliverInput(input));
    const observer = validated(() => observationOptions(options));
    const { hooks, requireBranchesToBeUpToDate } = derivedContractPolicy(this.composition);
    return await this.local(
      "deliver",
      async (
        accumulator,
        localChannel,
        scope,
      ): Promise<OutcomeProjection<"deliver", Delivery, OperationRefusals["deliver"]>> => {
        let leadingValue: RawDeliveryValue | undefined;
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
          if (outcome.kind === "refused")
            return { kind: "refused", contract: this.id, refusal: compactDeliverRefusal(outcome.refusal) };
          if (outcome.kind !== "accepted") return expected(this.id, outcome);
          leadingValue = outcome.value;
          accumulator.extendConclusions(this.id, { leading: outcome.value.leading });
          await advanceAndContinue(accumulator, scope, localChannel, this.id, this.composition, outcome, values.signal);
        } catch (error) {
          retainTrailingFailure(accumulator, this.id, error, values.signal);
        }
        const base = admittedDeliveryValue(accumulator, this.id);
        requireMatchingDeliveryLeading(leadingValue, base);
        const retained = accumulator.conclusions(this.id) ?? {};
        const integration = accumulator.checkpoint(this.id)?.state.currentIntegration;
        const value: RawDeliveryValue = {
          ...base,
          ...leadingValue,
          ...retained,
          ...(integration == null ? {} : { integration }),
        };
        accumulator.recordConclusions(this.id, value);
        await reconcileAffectedContracts(accumulator, this.id, scope, localChannel, hooks);
        return acceptedOutcome(this.id, accumulator, compactDelivery(value));
      },
      values.signal,
      observer,
    );
  }

  async verify(input?: VerifyInput, options?: MutationObservation): Promise<VerifyOutcome> {
    const values = validated(() =>
      input === undefined ? undefined : requireInput(input, "verify input", ["index", "includeDirty", "signal"]),
    );
    const index = validated(() => {
      if (values?.index === undefined) return undefined;
      if (typeof values.index !== "number" || !Number.isSafeInteger(values.index) || values.index < 1)
        throw new TypeError("verification index must be a positive safe integer");
      return values.index;
    });
    const includeDirty = validated(() => optionalBoolean(values?.includeDirty, "includeDirty") ?? false);
    const signal = validated(() => optionalSignal(values?.signal));
    const observer = validated(() => observationOptions(options));
    const { hooks, requireBranchesToBeUpToDate } = derivedContractPolicy(this.composition);
    return await this.local(
      "verify",
      async (
        accumulator,
        localChannel,
        scope,
      ): Promise<OutcomeProjection<"verify", Verify, OperationRefusals["verify"]>> => {
        const outcome = await verifyOperation({
          scope,
          channel: localChannel,
          contractId: this.id,
          progress: accumulator,
          deriveDocument: derivedDocument,
          includeDirty,
          requireBranchesToBeUpToDate,
          ...(index === undefined ? {} : { index }),
          ...(signal === undefined ? {} : { signal }),
          ...(this.composition.actor === undefined ? {} : { actor: this.composition.actor }),
        });
        if (outcome.kind === "refused")
          return { kind: "refused", contract: this.id, refusal: compactVerifyRefusal(outcome.refusal) };
        accumulator.extendConclusions(this.id, outcome.value);
        let completion: CompletionEvidence & Pick<RawDeliveryValue, "continuation"> = {};
        try {
          if (!signal?.aborted)
            completion = await advanceAndContinue(
              accumulator,
              scope,
              localChannel,
              this.id,
              this.composition,
              {
                kind: "accepted",
                facts: [],
                state: outcome.checkpoint.state,
                journal: outcome.checkpoint.journal,
              },
              signal,
            );
        } catch (error) {
          retainTrailingFailure(accumulator, this.id, error, signal);
        }
        const raw = { ...outcome.value, ...completion };
        accumulator.extendConclusions(this.id, raw);
        await reconcileAffectedContracts(accumulator, this.id, scope, localChannel, hooks);
        const continuation = completion.continuation;
        const value: Verify = {
          ...compactVerify(raw),
          ...(continuation === undefined || Object.keys(continuation).length === 0 ? {} : { continuation }),
        };
        return acceptedOutcome(this.id, accumulator, value);
      },
      signal,
      observer,
    );
  }

  async review(input: ReviewInput, options?: MutationObservation): Promise<ReviewOutcome> {
    const values = validated(() => requireInput(input, "review input", ["verdict", "summary", "actor", "signal"]));
    const actor = validated(() => actorOption(values.actor));
    const verdict = values.verdict;
    if (verdict !== "satisfied" && verdict !== "unsatisfied")
      throw new KeiyakuError("invalid-input", "verdict must be satisfied or unsatisfied", {
        cause: new TypeError("verdict must be satisfied or unsatisfied"),
      });
    const summary = validated(() => {
      const value = optionalNonblank(values.summary, "review summary");
      if (value === undefined) throw new TypeError("review summary is required");
      return value;
    });
    const signal = validated(() => optionalSignal(values.signal));
    const observer = validated(() => observationOptions(options));
    const hooks = derivedHooks(this.composition);
    return await this.local(
      "review",
      async (
        accumulator,
        localChannel,
        scope,
      ): Promise<OutcomeProjection<"review", Review, OperationRefusals["review"]>> => {
        let value: RawReview = {};
        try {
          signal?.throwIfAborted();
          const outcome = await admitReviewOperation({
            scope,
            channel: localChannel,
            contractId: this.id,
            progress: accumulator,
            ...(this.composition.actor === undefined ? {} : { actor: this.composition.actor }),
            ...actor,
            ...(signal === undefined ? {} : { signal }),
            verdict,
            summary,
          });
          if (outcome.kind === "refused")
            return {
              kind: "refused",
              contract: this.id,
              refusal: outcome.refusal,
            };
          if (outcome.kind !== "accepted") return expected(this.id, outcome);
          value = outcome.value;
          accumulator.extendConclusions(this.id, value);
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
              )),
            };
        } catch (error) {
          retainTrailingFailure(accumulator, this.id, error, signal);
        }
        const retained: RawReview = { ...value, ...accumulator.conclusions(this.id) };
        accumulator.extendConclusions(this.id, retained);
        await reconcileAffectedContracts(accumulator, this.id, scope, localChannel, hooks);
        return acceptedOutcome(this.id, accumulator, compactReview(retained));
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
      ): Promise<OutcomeProjection<"abandon", Record<never, never>, OperationRefusals["abandon"]>> => {
        const admission = (
          await releaseDebtHolderWithFence(scope, channel, this.id, () =>
            abandonOperation({
              scope,
              channel,
              contractId: this.id,
              ...actor,
              ...(note === undefined ? {} : { note }),
              observationSelection: debtHolderObservationSelection(),
              progress: accumulator,
              decorateOffer: async ({ observation, contractId: owner }) => {
                const companion = await releaseDebtHolder(channel, observation, owner);
                return companion === null ? [] : [companion];
              },
            }),
          )
        ).result;
        if (admission.kind !== "accepted") return expected(this.id, admission);
        await this.conclude(accumulator, {
          scope,
          channel,
          leading: admission,
          hooks,
          value: () => ({}),
        });
        return acceptedOutcome(this.id, accumulator, {});
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
      async (
        accumulator,
        channel,
        scope,
      ): Promise<OutcomeProjection<"arc", Readonly<{ chapter: number }>, OperationRefusals["arc"]>> => {
        const admission = await arcOperation({
          scope,
          channel,
          contractId: this.id,
          ...actor,
          chapter,
          progress: accumulator,
        });
        if (admission.kind !== "accepted") return expected(this.id, admission);
        const value = await this.conclude(accumulator, {
          scope,
          channel,
          leading: admission,
          hooks,
          value: () => ({ chapter: admission.value.chapter }),
        });
        return acceptedOutcome(this.id, accumulator, value);
      },
    );
  }

  async previewDelivery(input?: DeliveryPreviewInput, options?: MutationObservation): Promise<DeliveryPreviewOutcome> {
    const values = validated(() =>
      input === undefined
        ? undefined
        : requireInput(input, "delivery preview input", ["includeDirty", "showDiff", "signal"]),
    );
    const includeDirty = validated(() => optionalBoolean(values?.includeDirty, "includeDirty") ?? false);
    const showDiff = validated(() => optionalBoolean(values?.showDiff, "showDiff") ?? false);
    const signal = validated(() => optionalSignal(values?.signal));
    const observer = validated(() => observationOptions(options));
    const requireBranchesToBeUpToDate = derivedFreshness(this.composition);
    return await this.local(
      "deliver-preview",
      async (
        accumulator,
        localChannel,
        scope,
      ): Promise<OutcomeProjection<"deliver-preview", DeliveryPreviewReport, OperationRefusals["deliver-preview"]>> => {
        const admission = await previewDeliveryOperation({
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
        });
        if (admission.kind === "refused")
          return { kind: "refused", contract: this.id, refusal: compactPreviewRefusal(admission.refusal) };
        if (admission.kind !== "accepted") return expected(this.id, admission);
        accumulator.recordDeliveryPreview(this.id, admission.value);
        return { kind: "accepted", contract: this.id, value: admission.value };
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
      value: (value: Value) => Public;
    }>,
  ): Promise<Public> {
    retainAdmission(accumulator, this.id, input.leading);
    const value = input.value(input.leading.value);
    accumulator.extendConclusions(this.id, value as Readonly<Record<string, unknown>>);
    await reconcileAffectedContracts(accumulator, this.id, input.scope, input.channel, input.hooks);
    return value;
  }
}
function changedAmendTerms(
  before: ContractState["terms"],
  after: ContractState["terms"],
): Pick<AmendValue, "gatesChanged" | "afterChanged"> {
  return {
    ...(before.gates.length === after.gates.length && before.gates.every((gate, index) => gate === after.gates[index])
      ? {}
      : { gatesChanged: true as const }),
    ...(before.after.length === after.after.length && before.after.every((id, index) => id === after.after[index])
      ? {}
      : { afterChanged: true as const }),
  };
}

function sectionValue(document: ReturnType<typeof decodeContractDocument>, section: string): string | undefined {
  switch (section) {
    case "context":
    case "objective":
    case "design":
    case "region":
    case "criteria":
    case "verification":
      return JSON.stringify(document[section]);
    default:
      return JSON.stringify(document.extensions.find((extension) => normalizeTitle(extension.title) === section));
  }
}

function persistedDocument(bytes: string): ReturnType<typeof decodeContractDocument> {
  try {
    return decodeContractDocument(bytes);
  } catch (cause) {
    throw new KeiyakuError("authority-corruption", "undecodable persisted Contract document", { cause });
  }
}

function derivedDocument(state: ContractState): DocumentDerivation {
  return documentDerivation(persistedDocument(state.terms.document.bytes), state.terms.gates);
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
): void {
  if (accumulator.head(contractId) === undefined) throw error;
  if (!isOperationalStop(error, signal)) throw error;
  accumulator.recordStop(executionStop(contractId, error, signal));
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
): Promise<CompletionEvidence & Pick<RawDeliveryValue, "continuation">> {
  const checkpoint: ContractCheckpoint = { state: outcome.state, journal: outcome.journal };
  const result = await completeCandidate({
    repository: scope,
    channel,
    checkpoint,
    progress: accumulator,
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
    ...(composition.actor === undefined ? {} : { actor: composition.actor }),
    ...(signal === undefined ? {} : { signal }),
  });
  accumulator.observe({ kind: "stage", contractId, stage: "continuation", state: "finished" });
  return { ...result.evidence, ...(continuation === undefined ? {} : { continuation }) };
}

/** An accepted delivery's leading act must be the fact this invocation admitted. */
function requireMatchingDeliveryLeading(leading: RawDeliveryValue | undefined, base: RawDeliveryValue): void {
  const mismatched =
    leading !== undefined && (leading.leading.kind !== base.leading.kind || leading.leading.fact !== base.leading.fact);
  if (mismatched) throw new Error("accepted delivery leading disagrees with its admitted fact");
}

function admittedDeliveryValue(accumulator: InvocationAccumulator, contractId: ContractId): RawDeliveryValue {
  const fact = accumulator.snapshot().facts.find((entry) => entry.contract === contractId && entry.kind === "deliver");
  if (fact?.kind === "deliver") return { ...fact.data, leading: { kind: "admitted-now", fact: fact.entry } };
  const delivery = accumulator.checkpoint(contractId)?.state.delivery;
  if (delivery !== undefined && delivery !== null)
    return { ...delivery.data, leading: { kind: "already-admitted", fact: delivery.entry } };
  throw new Error("confirmed delivery requires its own receipt");
}

function invocationFailure(error: unknown, signal?: AbortSignal): unknown {
  return signal?.aborted === true && error === signal.reason
    ? new KeiyakuError("aborted", errorMessage(error), { cause: error })
    : error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
