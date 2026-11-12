/** @architectureCompositionRoot */
import { z } from "zod";
import { renderContractGuidance } from "../contract-guidance.js";
import {
  type ContractId,
  type ContractState,
  type ContractTerms,
  type JournalEntry,
  contractId,
} from "../core/facts/types.js";
import { parseToAST } from "../markdown/parse.js";
import { indexDocument, indexedHeadings, sectionContent, normalizeTitle } from "../markdown/query.js";
import { readDispatchesAt } from "../dispatch/index.js";
import { observeContractsForAdmissionInObservationAt } from "../git/observe.js";
import { withGitDecodeChannel, withGitReadObservation, type GitDecodeChannel } from "../git/read-observation.js";
import {
  contractObservationOperation,
  deliveryOperation,
  stateOperation,
  type RepositoryScope,
  withScopeAbortSignal,
  type DocumentDerivation,
  type IntentOutcome,
} from "../protocol/operations.js";
import {
  errorCategory,
  readContractValue,
  validated,
  KeiyakuError,
  project,
  type ContractVerb,
  type InvocationFailure,
  type ContractConclusion,
} from "./outcome.js";
import {
  optionalBoolean,
  requireInput,
  amendInputSchema,
  actorOption,
  contractTerms,
  documentDerivation,
  normalizedList,
  optionalNonblank,
  optionalSignal,
  requireMarkdown,
} from "./input.js";
import {
  type AbandonOutcome,
  type AmendOutcome,
  type ArcOutcome,
  type DeliveryPreviewInput,
  type DeliveryPreviewOutcome,
  type DeliverOutcome,
  type MutationObservation,
  type ReviewOutcome,
  type VerifyOutcome,
  type AmendValue,
  retainAdmission,
} from "./contract-outcomes.js";
import {
  type LocalContractCompositionCapture,
  derivedContractPolicy,
  derivedFreshness,
  derivedGates,
  derivedHooks,
  gateNames,
} from "./contract-settings.js";
import {
  type AbandonInput,
  type AmendInput,
  type ArcInput,
  type ContractHistory,
  type ContractHistoryInput,
  type ContractHistoryEvent,
  type DeliverInput,
  type ReviewInput,
  type VerifyInput,
} from "./contract-types.js";
import { compactDelivery, admitDeliveryOperation, type DeliverLeading } from "../protocol/deliver.js";
import { type Delivery } from "./delivery.js";
import {
  validateContractWaitHandle,
  waitContractLocal,
  type ContractWaitOptions,
  type ContractWaitResult,
} from "./contract-wait.js";
import { prepareAmendDocument } from "../body/amend.js";
import { decodeArcDocument } from "../body/arc.js";
import { decodeContractDocument } from "../body/decode.js";
import { type WorktreeHooks } from "../git/hooks.js";
import { abandonOperation } from "../protocol/abandon.js";
import { amendOperation } from "../protocol/amend.js";
import { arcOperation } from "../protocol/arc.js";
import { previewDeliveryOperation } from "../protocol/delivery-preview.js";
import { completeCandidate } from "../protocol/completion.js";
import { type ExecutionObserver } from "../protocol/execution-observation.js";
import { type AcceptedProtocolStep } from "../protocol/outcome.js";
import {
  executionStop,
  isOperationalFailure,
  isOperationalStop,
  type ContractCheckpoint,
} from "../protocol/progress.js";
import { admitReviewOperation } from "../protocol/review.js";
import { verifyOperation } from "../protocol/verify.js";
import { releaseDebtHolder, releaseDebtHolderWithFence, debtHolderObservationSelection } from "../settlement/holder.js";
import { continueDeliveredDependents } from "./continuation.js";
import { InvocationAccumulator } from "./invocation.js";
import { reconcileAffectedContracts } from "./reconcile.js";
import { observeChangedRegion } from "./region.js";
import { compactReason, compactRetry } from "../protocol/result-reasons.js";

type AcceptedIntent<Value> = Extract<IntentOutcome<Value>, { kind: "accepted" }>;

export const guidanceNormalSchema = z.strictObject({ kind: z.literal("present"), guidance: z.string() }).readonly();
export const guidanceSchema = z.union([
  guidanceNormalSchema,
  z.strictObject({ kind: z.literal("missing") }).readonly(),
]);
export type Guidance = z.output<typeof guidanceSchema>;

const KEIYAKU_HANDLE = Symbol("Kei handle");

type HandleSeat = Readonly<{ id: ContractId; scope: RepositoryScope }>;
const KEIYAKU_SEATS = new WeakMap<object, HandleSeat>();

export class Kei {
  readonly id: ContractId;
  private readonly scope: RepositoryScope;
  private readonly composition: LocalContractCompositionCapture;

  private constructor(
    token: typeof KEIYAKU_HANDLE,
    id: ContractId,
    scope: RepositoryScope,
    composition: LocalContractCompositionCapture,
  ) {
    if (token !== KEIYAKU_HANDLE) throw new TypeError("Kei handles are created by Keis.of");
    this.id = id;
    this.scope = scope;
    this.composition = composition;
    // Process-local custody never serializes: identity-only JSON projection.
    Object.defineProperties(this, {
      id: { value: id, enumerable: false },
      scope: { value: scope, enumerable: false },
      composition: { value: composition, enumerable: false },
    });
    KEIYAKU_SEATS.set(this, { id, scope });
    Object.freeze(this);
  }

  /** The handle's one durable identity; everything else is process-local custody. */
  toJSON(): Readonly<{ contract: ContractId }> {
    return { contract: this.id };
  }

  async state(): Promise<ContractState | null> {
    return await readContractValue(() =>
      withGitDecodeChannel(this.scope, (channel) =>
        stateOperation({ scope: this.scope, channel, contractId: this.id }),
      ),
    );
  }

  async wait(input?: ContractWaitOptions): Promise<ContractWaitResult> {
    return await waitContractLocal(validateContractWaitHandle(this.scope, this.id, input));
  }

  async history(input?: ContractHistoryInput): Promise<ContractHistory> {
    const full = validated(() => {
      const values = input === undefined ? {} : requireInput(input, "Contract history input", ["full"]);
      return optionalBoolean(values.full, "full") === true;
    });
    return await readContractValue(() =>
      withGitDecodeChannel(this.scope, (channel) =>
        withGitReadObservation(this.scope, channel, async (observation) => {
          const journals = await observeContractsForAdmissionInObservationAt(observation, [this.id]);
          const record = journals.journals.get(this.id);
          if (record === undefined) throw new Error(`missing requested contract observation: ${this.id}`);
          if (record.state === null) return { kind: "contract-missing", contractId: this.id };
          let terms: ContractTerms | undefined;
          const events: ContractHistoryEvent[] = record.entries.map((entry) => {
            const event = historyEvent(entry, terms, full);
            if (entry.kind === "bind") terms = entry.data.terms;
            else if (entry.kind === "amend") terms = entry.data;
            return event;
          });
          let unavailable: Extract<ContractHistory, { kind: "contract" }>["dispatches"];
          let dispatches;
          try {
            dispatches = await readDispatchesAt(observation);
          } catch (error) {
            const category = errorCategory(error);
            if (category === "aborted" || this.scope.signal?.aborted === true) throw error;
            unavailable = {
              kind: "unavailable",
              category: category === "authority-corruption" ? category : "internal",
              diagnostic: error instanceof Error ? error.message : String(error),
            };
          }
          events.push(
            ...(dispatches ?? [])
              .filter((dispatch) => dispatch.contractId === this.id)
              .map((dispatch) => ({
                kind: "dispatch" as const,
                at: dispatch.dispatchedAt,
                akumaId: dispatch.akumaId,
              })),
          );
          events.sort((left, right) => {
            if (left.at !== right.at) return left.at < right.at ? -1 : 1;
            if ((left.kind === "dispatch") !== (right.kind === "dispatch")) return left.kind === "dispatch" ? 1 : -1;
            return 0;
          });
          return {
            kind: "contract",
            contractId: this.id,
            events,
            ...(unavailable === undefined ? {} : { dispatches: unavailable }),
          };
        }),
      ),
    );
  }

  async guidance(): Promise<Guidance> {
    return await readContractValue(() =>
      withGitDecodeChannel(this.scope, async (channel) => {
        const observed = await contractObservationOperation({ scope: this.scope, channel, contractId: this.id });
        if (observed.kind === "missing") return { kind: "missing" };
        const state = await stateOperation({ scope: this.scope, channel, contractId: this.id });
        return state === null ? { kind: "missing" } : { kind: "present", guidance: renderContractGuidance(state) };
      }),
    );
  }

  async delivery(): Promise<Delivery | null> {
    const delivery = await readContractValue(() =>
      withGitDecodeChannel(this.scope, (channel) =>
        deliveryOperation({ scope: this.scope, channel, contractId: this.id }),
      ),
    );
    return delivery === null ? null : compactDelivery(delivery);
  }

  private amendInput(input: AmendInput) {
    return validated(() => {
      const values = amendInputSchema.parse(input);
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
    let changedSections: ReadonlySet<string> | undefined;
    return await this.local("amend", async (accumulator, channel, scope): Promise<AmendOutcome> => {
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
          return { terms, verification: documentDerivation(amended).verification };
        },
      });
      if (admission.kind !== "accepted")
        return admission.kind === "refused"
          ? { kind: "refused", contractId: this.id, reason: compactReason(admission.refusal) }
          : { contractId: this.id, ...compactRetry(admission.reason) };
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
      return { kind: "accepted", contractId: this.id, ...value };
    });
  }

  /** One promise with an optional observation callback; observation never delays custody. */
  async deliver(input?: DeliverInput, options?: MutationObservation): Promise<DeliverOutcome> {
    const values = validated(() => normalizeDeliverInput(input));
    const observer = validated(() => observationOptions(options));
    const { hooks, requireBranchesToBeUpToDate } = derivedContractPolicy(this.composition);
    return await this.local(
      "deliver",
      async (accumulator, localChannel, scope): Promise<DeliverOutcome> => {
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
            return {
              kind: "handoff",
              contractId: this.id,
              worktreePath: outcome.workspace.path,
              targetHead: outcome.targetHead,
              conflictPaths: outcome.conflictPaths,
              handoffBase: outcome.handoffBase,
            };
          if (outcome.kind === "refused")
            return { kind: "refused", contractId: this.id, reason: compactReason(outcome.refusal) };
          if (outcome.kind !== "accepted") return { contractId: this.id, ...compactRetry(outcome.reason) };
          requireMatchingDeliveryLeading(outcome.value.leading, accumulator, this.id);
          await advanceAndContinue(accumulator, scope, localChannel, this.id, this.composition, outcome, values.signal);
        } catch (error) {
          retainTrailingFailure(accumulator, this.id, error, values.signal);
        }
        await reconcileAffectedContracts(accumulator, this.id, scope, localChannel, hooks);
        const { placement, ...value } = accumulator.conclusions(this.id) ?? {};
        const { candidate, integration, contentId } = value;
        if (candidate === undefined || integration === undefined || contentId === undefined)
          throw new Error("confirmed delivery requires its own receipt");
        return {
          kind: "accepted",
          contractId: this.id,
          ...value,
          candidate,
          integration,
          contentId,
          ...(placement === undefined
            ? {}
            : {
                placement:
                  placement.kind === "placed"
                    ? (({ integration: _integration, ...rest }) => rest)(placement)
                    : placement,
              }),
        };
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
      async (accumulator, localChannel, scope): Promise<VerifyOutcome> => {
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
          return { kind: "refused", contractId: this.id, reason: compactReason(outcome.refusal) };
        accumulator.extendConclusions(this.id, outcome.value);
        try {
          if (!signal?.aborted && outcome.checkpoint !== undefined)
            await advanceAndContinue(
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
        if (outcome.checkpoint !== undefined)
          await reconcileAffectedContracts(accumulator, this.id, scope, localChannel, hooks);
        const { continuation, ...value } = accumulator.conclusions(this.id) ?? {};
        return {
          kind: "accepted",
          contractId: this.id,
          ...outcome.value,
          ...value,
          ...(continuation === undefined || Object.keys(continuation).length === 0 ? {} : { continuation }),
        };
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
      async (accumulator, localChannel, scope): Promise<ReviewOutcome> => {
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
              contractId: this.id,
              reason: outcome.refusal,
            };
          if (outcome.kind !== "accepted") return { contractId: this.id, ...compactRetry(outcome.reason) };
          accumulator.extendConclusions(this.id, outcome.value);
          if (verdict === "satisfied")
            await advanceAndContinue(accumulator, scope, localChannel, this.id, this.composition, outcome, signal);
        } catch (error) {
          retainTrailingFailure(accumulator, this.id, error, signal);
        }
        await reconcileAffectedContracts(accumulator, this.id, scope, localChannel, hooks);
        return { kind: "accepted", contractId: this.id, ...accumulator.conclusions(this.id) };
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
    return await this.local("abandon", async (accumulator, channel, scope): Promise<AbandonOutcome> => {
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
      if (admission.kind !== "accepted")
        return admission.kind === "refused"
          ? { kind: "refused", contractId: this.id, reason: compactReason(admission.refusal) }
          : { contractId: this.id, ...compactRetry(admission.reason) };
      await this.conclude(accumulator, {
        scope,
        channel,
        leading: admission,
        hooks,
        value: () => ({}),
      });
      return { kind: "accepted", contractId: this.id };
    });
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
    return await this.local("arc", async (accumulator, channel, scope): Promise<ArcOutcome> => {
      const admission = await arcOperation({
        scope,
        channel,
        contractId: this.id,
        ...actor,
        chapter,
        progress: accumulator,
      });
      if (admission.kind !== "accepted")
        return admission.kind === "refused"
          ? { kind: "refused", contractId: this.id, reason: compactReason(admission.refusal) }
          : { contractId: this.id, ...compactRetry(admission.reason) };
      const value = await this.conclude(accumulator, {
        scope,
        channel,
        leading: admission,
        hooks,
        value: () => ({ chapter: admission.value.chapter }),
      });
      return { kind: "accepted", contractId: this.id, ...value };
    });
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
      async (accumulator, localChannel, scope): Promise<DeliveryPreviewOutcome> => {
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
          return { kind: "refused", contractId: this.id, reason: compactReason(admission.refusal) };
        accumulator.recordDeliveryPreview(this.id, admission.value);
        return admission.value;
      },
      signal,
      observer,
    );
  }

  /** One accumulator before the first admission-capable await, one projector after teardown. */
  private async local<Answer extends Readonly<{ kind: string; contractId?: ContractId }>>(
    operation: ContractVerb,
    run: (accumulator: InvocationAccumulator, channel: GitDecodeChannel, scope: RepositoryScope) => Promise<Answer>,
    signal?: AbortSignal,
    observer?: ExecutionObserver,
  ): Promise<Answer> {
    const accumulator = new InvocationAccumulator(observer, operation);
    const scope = withScopeAbortSignal(this.scope, signal);
    let projection: Answer | InvocationFailure;
    let completed: Answer | undefined;
    let retirement: unknown;
    try {
      projection = await withGitDecodeChannel(
        scope,
        async (channel) => {
          completed = await run(accumulator, channel, scope);
          if (completed.kind === "accepted" && accumulator.head(this.id) === undefined)
            throw new Error("missing leading admission receipt");
          return completed;
        },
        (error) => {
          retirement = error;
          accumulator.recordChannelRetirement(this.id, error);
        },
      );
    } catch (error) {
      projection =
        error === retirement &&
        completed !== undefined &&
        (completed.kind === "accepted" || completed.kind === "ready" || completed.kind === "blocked") &&
        isOperationalFailure(error)
          ? completed
          : { kind: "failed", contract: this.id, error };
    }
    const projected = project<Answer>(operation, accumulator.snapshot(), projection, scope.signal);
    if (projected.kind === "failed") throw projected.error;
    return projected.outcome;
  }

  private async conclude<Value, Public extends ContractConclusion>(
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
    accumulator.extendConclusions(this.id, value);
    await reconcileAffectedContracts(accumulator, this.id, input.scope, input.channel, input.hooks);
    return value;
  }
}

function changedHistoryTerms(before: ContractTerms | undefined, after: ContractTerms) {
  const sections = (terms: ContractTerms): ReadonlyMap<string, string> => {
    const document = parseToAST(terms.document.bytes);
    return new Map(
      indexedHeadings(indexDocument(document), { level: 2 })
        .filter((section) => section.type === "section")
        .map((section) => [section.title, sectionContent(document, section)]),
    );
  };
  const source = before === undefined ? new Map<string, string>() : sections(before);
  const amended = sections(after);
  const changedSections = [...new Set([...source.keys(), ...amended.keys()])].filter(
    (name) => source.get(name) !== amended.get(name),
  );
  const equal = (left: readonly string[] | undefined, right: readonly string[]): boolean =>
    left !== undefined && left.length === right.length && left.every((value, index) => value === right[index]);
  return {
    ...(changedSections.length === 0 ? {} : { changedSections }),
    ...(equal(before?.gates, after.gates) ? {} : { gates: after.gates }),
    ...(equal(before?.after, after.after) ? {} : { after: after.after }),
  };
}

function attestationHistory(entry: Extract<JournalEntry, { kind: "attestation" }>) {
  const { gate, requirement, subject, verdict, summary } = entry.data;
  return {
    kind: "attestation" as const,
    gate,
    requirement,
    verdict,
    subject,
    ...(summary === undefined ? {} : { summary }),
  };
}

function historyEvent(entry: JournalEntry, terms: ContractTerms | undefined, full: boolean): ContractHistoryEvent {
  const common = { id: entry.entry, at: entry.at, ...(entry.actor === undefined ? {} : { actor: entry.actor }) };
  switch (entry.kind) {
    case "bind": {
      const { coordinates, terms: bound } = entry.data;
      const target = coordinates.target;
      return {
        ...common,
        kind: "bind",
        start: coordinates.start,
        ...(target === undefined
          ? {}
          : {
              target:
                typeof target === "string" ? target : { kind: "contract" as const, contractId: target.contractId },
            }),
        ...(full
          ? {
              document: bound.document.bytes,
              gates: bound.gates,
              after: bound.after,
              ...(typeof target === "object" ? { targetIncarnation: target.worktree } : {}),
            }
          : {
              ...(bound.gates.length === 0 ? {} : { gates: bound.gates }),
              ...(bound.after.length === 0 ? {} : { after: bound.after }),
            }),
      };
    }
    case "amend":
      return {
        ...common,
        kind: "amend",
        ...changedHistoryTerms(terms, entry.data),
        ...(full ? { document: entry.data.document.bytes, gates: entry.data.gates, after: entry.data.after } : {}),
      };
    case "deliver": {
      const { tenderSnapshot, integration, note } = entry.data;
      return {
        ...common,
        kind: "deliver",
        candidate: tenderSnapshot,
        integration: integration.snapshot,
        contentId: integration.changeId,
        predecessor: integration.predecessor,
        ...(note === undefined ? {} : { note }),
        ...(full ? { requireBranchesToBeUpToDate: entry.data.policy.requireBranchesToBeUpToDate } : {}),
      };
    }
    case "reintegrated":
      return {
        ...common,
        kind: "reintegrated",
        predecessor: entry.data.predecessor,
        integration: entry.data.snapshot,
      };
    case "attestation":
      return { ...common, ...attestationHistory(entry) };
    case "claimed":
      return { ...common, kind: "claimed", deliveryId: entry.data.delivery };
    case "arc":
      return {
        ...common,
        kind: "arc",
        chapter: entry.data.seq,
        title: entry.data.title,
        ...(entry.data.body.length === 0 && !full ? {} : { body: entry.data.body }),
      };
    case "abandoned":
      return {
        ...common,
        kind: "abandoned",
        ...(entry.data.note === undefined ? {} : { note: entry.data.note }),
      };
  }
}

/** Internal constructor capability; callers select a Contract through Keis.of. */
export function createKeiHandle(
  id: ContractId,
  scope: RepositoryScope,
  composition: LocalContractCompositionCapture,
): Kei {
  return Reflect.construct(Kei, [KEIYAKU_HANDLE, id, scope, composition]) as Kei;
}

/** Internal package composition capability; not exported from the package root. */
export function seatForKei(value: unknown): HandleSeat | null {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? (KEIYAKU_SEATS.get(value) ?? null)
    : null;
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
  return documentDerivation(persistedDocument(state.terms.document.bytes));
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
): Promise<void> {
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
  if (result.kind !== "completed") return;
  accumulator.observe({ kind: "stage", contractId, stage: "continuation", state: "started" });
  await continueDeliveredDependents({
    scope,
    channel,
    progress: accumulator,
    completed: result,
    ...(composition.actor === undefined ? {} : { actor: composition.actor }),
    ...(signal === undefined ? {} : { signal }),
  });
  accumulator.observe({ kind: "stage", contractId, stage: "continuation", state: "finished" });
}

/** An accepted delivery's leading act must be the fact this invocation admitted. */
function requireMatchingDeliveryLeading(
  leading: DeliverLeading,
  accumulator: InvocationAccumulator,
  contractId: ContractId,
): void {
  const fact = accumulator.snapshot().facts.find((entry) => entry.contract === contractId && entry.kind === "deliver");
  const witnessed = fact === undefined ? accumulator.checkpoint(contractId)?.state.delivery?.entry : fact.entry;
  if (witnessed === undefined) throw new Error("confirmed delivery requires its own receipt");
  if (leading.fact !== witnessed || leading.kind !== (fact === undefined ? "already-admitted" : "admitted-now"))
    throw new Error("accepted delivery leading disagrees with its admitted fact");
}
