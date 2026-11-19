/** @architectureCompositionRoot */
import { z } from "zod";
import { renderContractGuidance } from "../contract-guidance.js";
import { type ContractId, type ContractState, type ContractTerms, type JournalEntry } from "../core/facts/types.js";
import { normalizeTitle } from "../markdown/query.js";
import { readDispatchesAt, type Dispatch } from "../dispatch/index.js";
import { contractJournal, observeContractJournals } from "../git/observe.js";
import {
  withGitDecodeChannel,
  withGitReadObservation,
  type GitDecodeChannel,
  type GitReadObservation,
} from "../git/read-observation.js";
import {
  contractObservationOperation,
  deliveryOperation,
  stateOperation,
  type RepositoryScope,
  withScopeAbortSignal,
  type DocumentDerivation,
} from "../protocol/operations.js";
import {
  errorCategory,
  readContractValue,
  validated,
  KeiyakuError,
  project,
  type ContractVerb,
  type InvocationFailure,
} from "./outcome.js";
import {
  callerContractId,
  optionalBoolean,
  requireInput,
  amendInputSchema,
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
  derivedVerificationMode,
  gateNames,
} from "./contract-settings.js";
import {
  type AbandonInput,
  type AmendInput,
  type ArcInput,
  contractHistoryInputSchema,
  type ContractDispatchRow,
  type ContractHistory,
  type ContractHistoryEvent,
  type ContractHistoryInput,
  type ContractJournalRow,
  type DeliverInput,
  type ReviewInput,
  type VerifyInput,
} from "./contract-types.js";
import { selectHistoryPage, type HistoryCursor } from "../history.js";
import { admitDeliveryOperation, type DeliverLeading } from "../protocol/deliver.js";
import { compactDelivery } from "../protocol/result-leaves.js";
import { type Delivery } from "./delivery.js";
import {
  validateContractWaitHandle,
  waitContractLocal,
  type ContractWaitOptions,
  type ContractWaitResult,
} from "./contract-wait.js";
import { targetName } from "../core/facts/types.js";
import { prepareAmendDocument } from "../body/amend.js";
import { decodeArcDocument } from "../body/arc.js";
import { decodeContractDocument } from "../body/decode.js";
import { abandonOperation } from "../protocol/abandon.js";
import { amendOperation } from "../protocol/amend.js";
import { arcOperation } from "../protocol/arc.js";
import { previewDeliveryOperation } from "../protocol/delivery-preview.js";
import { completeCandidate } from "../protocol/completion.js";
import { type ExecutionObserver } from "../protocol/execution-observation.js";
import type { ContractCheckpoint } from "../protocol/progress.js";
import { admitReviewOperation } from "../protocol/review.js";
import { verifyOperation } from "../protocol/verify.js";
import { releaseDebtHolder, releaseDebtHolderWithFence, debtHolderObservationSelection } from "../settlement/holder.js";
import { continueDeliveredDependents } from "./continuation.js";
import { InvocationAccumulator } from "./invocation.js";
import { reconcileAffectedContracts } from "./reconcile.js";
import { observeChangedRegion } from "./region.js";
import { compactReason, compactRetry } from "../protocol/result-reasons.js";

/** An amendment's library conclusion: admitted terms, or the fact that no change was requested. */
type AmendConclusion = AmendOutcome | Readonly<{ kind: "unchanged"; contractId: ContractId }>;

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
    const request = historyRequest(input);
    return await readContractValue(() =>
      withGitDecodeChannel(this.scope, (channel) =>
        withGitReadObservation(this.scope, channel, async (observation) => {
          const record = contractJournal(await observeContractJournals(observation, [this.id]), this.id);
          if (record.state === null) return { kind: "contract-missing", contractId: this.id };
          const journal: ObservedJournal = {
            entries: record.entries,
            addresses: new Map(record.entries.map((entry, index) => [entry.entry, String(index + 1)])),
          };
          if ("item" in request) {
            const position = Number(request.item);
            const entry = journal.entries[position - 1];
            return entry === undefined
              ? { kind: "contract-unknown-history", contractId: this.id }
              : {
                  kind: "contract-exact",
                  contractId: this.id,
                  event: journalRecord(entry, position, journal.addresses),
                };
          }
          return await journalPage(observation, this.scope, this.id, journal, request);
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
      const parsed = amendInputSchema.safeParse(input);
      if (!parsed.success) throw new KeiyakuError("invalid-input", parsed.error.message, { cause: parsed.error });
      const values = parsed.data;
      const derived = values.gates === undefined ? undefined : derivedGates(this.composition, gateNames(values.gates));
      return {
        edits: values.edits,
        target: values.target,
        gates: derived,
        prerequisites: values.after === undefined ? undefined : normalizedList(values.after, "after", callerContractId),
      };
    });
  }
  async amend(input: AmendInput): Promise<AmendOutcome> {
    const { edits, target, gates, prerequisites } = this.amendInput(input);
    const hooks = derivedHooks(this.composition);
    const requestsChange =
      edits !== undefined || target !== undefined || gates !== undefined || prerequisites !== undefined;
    const amendmentPlan = edits === undefined ? undefined : validated(() => prepareAmendDocument(edits));
    let changedSections: ReadonlySet<string> | undefined;
    const concluded = await this.local<AmendConclusion>("amend", async (accumulator, channel, scope) => {
      const admission = await amendOperation({
        scope,
        channel,
        contractId: this.id,
        progress: accumulator,
        ...(target === undefined ? {} : { target }),
        ...(requestsChange
          ? {
              deriveAmendment: (source: ContractTerms) => {
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
            }
          : {}),
      });
      // No requested change is the same answer as before: an accepted amendment that changed nothing.
      if (admission.kind === "unchanged") return { kind: "unchanged", contractId: this.id };
      if (admission.kind !== "accepted")
        return admission.kind === "refused"
          ? { kind: "refused", contractId: this.id, reason: compactReason(admission.refusal) }
          : { contractId: this.id, ...compactRetry(admission.reason) };
      const changes = {
        ...changedAmendTerms(admission.value.source, admission.value.terms),
        ...(admission.value.target === undefined ? {} : { target: targetName(admission.value.target) }),
      };
      const sections =
        changedSections === undefined || changedSections.size === 0 ? {} : { changedSections: [...changedSections] };
      retainAdmission(accumulator, this.id, admission);
      const region = await observeChangedRegion(
        scope,
        this.id,
        changedSections,
        decodeContractDocument(admission.value.terms.document.bytes).region,
      );
      await reconcileAffectedContracts(accumulator, this.id, scope, channel, hooks);
      return { kind: "accepted", contractId: this.id, ...sections, ...changes, ...region };
    });
    return concluded.kind === "unchanged" ? { kind: "accepted", contractId: this.id } : concluded;
  }

  /** One promise with an optional observation callback; observation never delays custody. */
  async deliver(input?: DeliverInput, options?: MutationObservation): Promise<DeliverOutcome> {
    const values = validated(() => normalizeDeliverInput(input));
    const observer = validated(() => observationOptions(options));
    const { hooks, requireBranchesToBeUpToDate } = derivedContractPolicy(this.composition);
    return await this.local(
      "deliver",
      async (accumulator, localChannel, scope): Promise<DeliverOutcome> => {
        scope.signal?.throwIfAborted();
        const outcome = await admitDeliveryOperation({
          scope,
          channel: localChannel,
          contractId: this.id,
          progress: accumulator,
          ...(scope.signal === undefined ? {} : { signal: scope.signal }),
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
        const { leading, ...value } = outcome.value;
        requireMatchingDeliveryLeading(leading, accumulator, this.id);
        const { integration, tail } = await advanceAndContinue(accumulator, scope, localChannel, outcome);
        await reconcileAffectedContracts(accumulator, this.id, scope, localChannel, hooks);
        const { placement, ...continuation } = tail;
        const delivered =
          placement.kind === "placed" ? (({ integration: _integration, ...rest }) => rest)(placement) : placement;
        return {
          kind: "accepted",
          contractId: this.id,
          ...value,
          integration: integration ?? value.integration,
          placement: delivered,
          ...continuation,
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
        throw new KeiyakuError("invalid-input", "verification index must be a positive safe integer");
      return values.index;
    });
    const includeDirty = validated(() => optionalBoolean(values?.includeDirty, "includeDirty") ?? false);
    const signal = validated(() => optionalSignal(values?.signal));
    const observer = validated(() => observationOptions(options));
    const { hooks, requireBranchesToBeUpToDate } = derivedContractPolicy(this.composition);
    const verificationMode = derivedVerificationMode(this.composition);
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
          verificationMode,
          ...(index === undefined ? {} : { index }),
          ...(scope.signal === undefined ? {} : { signal: scope.signal }),
        });
        if (outcome.kind === "refused")
          return { kind: "refused", contractId: this.id, reason: compactReason(outcome.refusal) };
        const trailing =
          scope.signal?.aborted || outcome.checkpoint === undefined
            ? undefined
            : await advanceAndContinue(accumulator, scope, localChannel, outcome.checkpoint);
        if (outcome.checkpoint !== undefined)
          await reconcileAffectedContracts(accumulator, this.id, scope, localChannel, hooks);
        return { kind: "accepted", contractId: this.id, ...outcome.value, ...trailing?.tail };
      },
      signal,
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
    const summary = validated(() => {
      const value = optionalNonblank(values.summary, "review summary");
      if (value === undefined) throw new KeiyakuError("invalid-input", "review summary is required");
      return value;
    });
    const signal = validated(() => optionalSignal(values.signal));
    const observer = validated(() => observationOptions(options));
    const hooks = derivedHooks(this.composition);
    return await this.local(
      "review",
      async (accumulator, localChannel, scope): Promise<ReviewOutcome> => {
        scope.signal?.throwIfAborted();
        const outcome = await admitReviewOperation({
          scope,
          channel: localChannel,
          contractId: this.id,
          progress: accumulator,
          ...(scope.signal === undefined ? {} : { signal: scope.signal }),
          verdict,
          summary,
        });
        if (outcome.kind === "refused") return { kind: "refused", contractId: this.id, reason: outcome.refusal };
        if (outcome.kind !== "accepted") return { contractId: this.id, ...compactRetry(outcome.reason) };
        const trailing =
          verdict === "satisfied" ? await advanceAndContinue(accumulator, scope, localChannel, outcome) : undefined;
        await reconcileAffectedContracts(accumulator, this.id, scope, localChannel, hooks);
        return { kind: "accepted", contractId: this.id, ...outcome.value, ...trailing?.tail };
      },
      signal,
      observer,
    );
  }

  async abandon(input?: AbandonInput): Promise<AbandonOutcome> {
    const note = validated(() => {
      const values = input === undefined ? undefined : requireInput(input, "abandon input", ["note"]);
      return optionalNonblank(values?.note, "abandon note");
    });
    const hooks = derivedHooks(this.composition);
    return await this.local("abandon", async (accumulator, channel, scope): Promise<AbandonOutcome> => {
      const admission = (
        await releaseDebtHolderWithFence(scope, channel, this.id, () =>
          abandonOperation({
            scope,
            channel,
            contractId: this.id,
            ...(note === undefined ? {} : { note }),
            observationSelection: debtHolderObservationSelection(),
            progress: accumulator,
            decorateOffer: async ({ observation, contractId: owner }) => {
              const companion = await releaseDebtHolder(channel, observation.epoch, owner);
              return companion === null ? [] : [companion];
            },
          }),
        )
      ).result;
      if (admission.kind !== "accepted")
        return admission.kind === "refused"
          ? { kind: "refused", contractId: this.id, reason: compactReason(admission.refusal) }
          : { contractId: this.id, ...compactRetry(admission.reason) };
      retainAdmission(accumulator, this.id, admission);
      await reconcileAffectedContracts(accumulator, this.id, scope, channel, hooks);
      return { kind: "accepted", contractId: this.id };
    });
  }

  async arc(input: ArcInput): Promise<ArcOutcome> {
    const chapter = validated(() => {
      const values = requireInput(input, "arc input", ["body"]);
      return decodeArcDocument(requireMarkdown(values.body, "body"));
    });
    const hooks = derivedHooks(this.composition);
    return await this.local("arc", async (accumulator, channel, scope): Promise<ArcOutcome> => {
      const admission = await arcOperation({
        scope,
        channel,
        contractId: this.id,
        chapter,
        progress: accumulator,
      });
      if (admission.kind !== "accepted")
        return admission.kind === "refused"
          ? { kind: "refused", contractId: this.id, reason: compactReason(admission.refusal) }
          : { contractId: this.id, ...compactRetry(admission.reason) };
      retainAdmission(accumulator, this.id, admission);
      await reconcileAffectedContracts(accumulator, this.id, scope, channel, hooks);
      return { kind: "accepted", contractId: this.id, chapter: admission.value.chapter };
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
          ...(scope.signal === undefined ? {} : { signal: scope.signal }),
        });
        return admission.kind === "refused"
          ? { kind: "refused", contractId: this.id, reason: compactReason(admission.refusal) }
          : admission.value;
      },
      signal,
      observer,
    );
  }

  private async local<Answer extends Readonly<{ kind: string; contractId?: ContractId }>>(
    operation: ContractVerb,
    run: (accumulator: InvocationAccumulator, channel: GitDecodeChannel, scope: RepositoryScope) => Promise<Answer>,
    signal?: AbortSignal,
    observer?: ExecutionObserver,
  ): Promise<Answer> {
    const accumulator = new InvocationAccumulator(observer);
    const scope = withScopeAbortSignal(this.scope, signal);
    return await invokeContract(operation, scope, accumulator, (channel) => run(accumulator, channel, scope), this.id);
  }
}

/** Finish the owned observation before returning the direct answer or attaching confirmed evidence. */
export async function invokeContract<Answer extends Readonly<{ kind: string; contractId?: ContractId }>>(
  operation: ContractVerb,
  scope: RepositoryScope,
  accumulator: InvocationAccumulator,
  run: (channel: GitDecodeChannel) => Promise<Answer>,
  id?: ContractId,
): Promise<Answer> {
  let answer: Answer | InvocationFailure;
  try {
    answer = await withGitDecodeChannel(scope, async (channel) => {
      const result = await run(channel);
      if (
        result.kind === "accepted" &&
        (result.contractId === undefined || accumulator.head(result.contractId) === undefined)
      )
        throw new Error("missing leading admission receipt");
      return result;
    });
  } catch (error) {
    const contract = id ?? accumulator.firstFact("bind")?.contract;
    answer = { kind: "failed", ...(contract === undefined ? {} : { contract }), error };
  }
  const result = project(operation, accumulator.snapshot(), answer, scope.signal);
  if (result.kind === "failed") throw result.error;
  return result.outcome;
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

function historyTarget(target: ContractState["coordinates"]["target"]) {
  if (target === undefined) return {};
  if (typeof target === "string") return { target };
  return {
    target: { kind: "contract" as const, contractId: target.contractId },
    targetIncarnation: target.worktree,
  };
}

type ObservedJournal = Readonly<{
  entries: readonly JournalEntry[];
  addresses: ReadonlyMap<string, string>;
}>;

/** One exact address or one page window; the family's schema rejects contradictory intent. */
function historyRequest(input: ContractHistoryInput | undefined) {
  const parsed = contractHistoryInputSchema.safeParse(
    input === undefined ? {} : requireInput(input, "Contract history input"),
  );
  if (!parsed.success) throw new KeiyakuError("invalid-input", parsed.error.message, { cause: parsed.error });
  return parsed.data;
}

function journalRecord(
  entry: JournalEntry,
  position: number,
  addresses: ObservedJournal["addresses"],
): ContractJournalRow {
  const common = { id: String(position), at: entry.at };
  switch (entry.kind) {
    case "bind": {
      const { coordinates, terms: bound } = entry.data;
      return {
        ...common,
        kind: "bind",
        start: coordinates.start,
        ...historyTarget(coordinates.target),
        document: bound.document.bytes,
        gates: bound.gates,
        after: bound.after,
      };
    }
    case "amend":
      return {
        ...common,
        kind: "amend",
        ...historyTarget(entry.data.target),
        document: entry.data.document.bytes,
        gates: entry.data.gates,
        after: entry.data.after,
      };
    case "deliver": {
      const { tenderSnapshot, integration, note, policy } = entry.data;
      return {
        ...common,
        kind: "deliver",
        candidate: tenderSnapshot,
        integration: integration.snapshot,
        contentId: integration.changeId,
        predecessor: integration.predecessor,
        ...(note === undefined ? {} : { note }),
        requireBranchesToBeUpToDate: policy.requireBranchesToBeUpToDate,
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
    case "claimed": {
      const delivery = addresses.get(entry.data.delivery);
      if (delivery === undefined)
        throw new KeiyakuError(
          "authority-corruption",
          `claimed delivery is not a journal entry: ${entry.data.delivery}`,
        );
      return { ...common, kind: "claimed", deliveryId: delivery };
    }
    case "arc":
      return {
        ...common,
        kind: "arc",
        chapter: entry.data.seq,
        title: entry.data.title,
        body: entry.data.body,
      };
    case "abandoned":
      return {
        ...common,
        kind: "abandoned",
        ...(entry.data.note === undefined ? {} : { note: entry.data.note }),
      };
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Anchor each available Dispatch to the journal row it follows in the existing
 * chronological merge. Journal wins equal-time ties and sequence breaks its own;
 * a Dispatch earlier than the first journal row belongs to that first row.
 */
function associateDispatches(
  entries: readonly JournalEntry[],
  dispatches: readonly Dispatch[],
  contractId: ContractId,
): ReadonlyMap<number, readonly ContractDispatchRow[]> {
  const chronological = entries
    .map((entry, index) => ({ position: index + 1, at: entry.at }))
    .sort((left, right) => (left.at === right.at ? left.position - right.position : compareText(left.at, right.at)));
  const own = dispatches
    .filter((dispatch) => dispatch.contractId === contractId)
    .sort((left, right) =>
      left.dispatchedAt === right.dispatchedAt
        ? compareText(left.akumaId, right.akumaId)
        : compareText(left.dispatchedAt, right.dispatchedAt),
    );
  const grouped = new Map<number, ContractDispatchRow[]>();
  let nextJournal = 0;
  // Earlier than every journal timestamp belongs to the first appended row.
  let position = 1;
  for (const dispatch of own) {
    while (chronological[nextJournal] !== undefined && chronological[nextJournal]!.at <= dispatch.dispatchedAt) {
      position = chronological[nextJournal++]!.position;
    }
    const rows = grouped.get(position) ?? [];
    rows.push({ kind: "dispatch", at: dispatch.dispatchedAt, akumaId: dispatch.akumaId });
    grouped.set(position, rows);
  }
  return grouped;
}

/** One bounded journal page over the complete observation, with available enrichment. */
async function journalPage(
  observation: GitReadObservation,
  scope: RepositoryScope,
  contractId: ContractId,
  journal: ObservedJournal,
  request: HistoryCursor,
): Promise<ContractHistory> {
  const page = selectHistoryPage(
    journal.entries.map((_entry, index) => index + 1),
    (position) => position,
    request,
  );
  let associations: ReadonlyMap<number, readonly ContractDispatchRow[]> = new Map();
  let unavailable: Extract<ContractHistory, { kind: "contract" }>["dispatches"];
  try {
    associations = associateDispatches(journal.entries, await readDispatchesAt(observation), contractId);
  } catch (error) {
    const category = errorCategory(error);
    if (category === "aborted" || scope.signal?.aborted === true) throw error;
    unavailable = {
      kind: "unavailable",
      category: category === "authority-corruption" ? category : "internal",
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }
  const events: ContractHistoryEvent[] = [];
  for (const position of page.rows) {
    const row = journalRecord(journal.entries[position - 1]!, position, journal.addresses);
    events.push(row, ...(associations.get(position) ?? []));
  }
  return {
    kind: "contract",
    contractId,
    events,
    ...(page.omitted === 0 ? {} : { omitted: page.omitted }),
    lowestRetainedSequence: 1,
    highestSequence: journal.entries.length,
    ...(unavailable === undefined ? {} : { dispatches: unavailable }),
  };
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
    throw new KeiyakuError("invalid-input", "observe must be a function");
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

async function advanceAndContinue(
  accumulator: InvocationAccumulator,
  scope: RepositoryScope,
  channel: GitDecodeChannel,
  checkpoint: ContractCheckpoint,
) {
  const { signal } = scope;
  const contractId = checkpoint.state.id;
  const { checkpoint: completed, placement } = await completeCandidate({
    repository: scope,
    channel,
    checkpoint,
    progress: accumulator,
    ...(signal === undefined ? {} : { signal }),
  });
  const integration = completed.state.currentIntegration?.snapshot;
  if (placement.kind !== "placed") return { integration, tail: { placement } };
  accumulator.observe({ kind: "stage", contractId, stage: "continuation", state: "started" });
  const continuation = await continueDeliveredDependents({
    scope,
    channel,
    progress: accumulator,
    primary: contractId,
    placed: placement,
    ...(signal === undefined ? {} : { signal }),
  });
  accumulator.observe({ kind: "stage", contractId, stage: "continuation", state: "finished" });
  return {
    integration,
    tail: {
      placement,
      ...(continuation.claimed === undefined && continuation.stopped === undefined ? {} : { continuation }),
    },
  };
}

/** An accepted delivery's leading act must be the fact this invocation admitted. */
function requireMatchingDeliveryLeading(
  leading: DeliverLeading,
  accumulator: InvocationAccumulator,
  contractId: ContractId,
): void {
  const fact = accumulator.firstFact("deliver");
  const witnessed = fact === undefined ? accumulator.checkpoint(contractId)?.state.delivery?.entry : fact.entry;
  if (witnessed === undefined) throw new Error("confirmed delivery requires its own receipt");
  if (leading.fact !== witnessed || leading.kind !== (fact === undefined ? "already-admitted" : "admitted-now"))
    throw new Error("accepted delivery leading disagrees with its admitted fact");
}
