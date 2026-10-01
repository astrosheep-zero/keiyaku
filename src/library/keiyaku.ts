/* eslint-disable max-params */
/** @architectureCompositionRoot */
import { prepareAmendDocument } from "../body/amend.js";
import { decodeArcDocument } from "../body/arc.js";
import { decodeContractDocument } from "../body/decode.js";
import { regionWarnings } from "../body/region.js";
import { renderContractGuidance } from "../contract-guidance.js";
import {
  contractId,
  gate,
  gateWord,
  type ActorId,
  type ContractId,
  type ContractState,
  type Gate,
} from "../core/facts/types.js";
import { readDispatchesAt } from "../dispatch/index.js";
import { mintSnapshotId } from "../git/identity.js";
import { observeContractsForAdmissionInObservationAt } from "../git/observe.js";
import { documentDiff } from "../markdown/diff.js";
import { withGitDecodeChannel, withGitReadObservation, type GitDecodeChannel } from "../git/read-observation.js";
import {
  executionChannel,
  localExecutionContext,
  type ExecutionContext,
  type LibraryExecution,
} from "../akuma/requests.js";
import { AkumaBodyRequestError } from "../akuma/request-rendezvous.js";
import { abandonOperation } from "../protocol/abandon.js";
import { amendOperation } from "../protocol/amend.js";
import { arcOperation } from "../protocol/arc.js";
import { auditOperation, type AuditReport } from "../protocol/audit.js";
import { completeCandidate, type CompletionEvidence } from "../protocol/completion.js";
import { admitDeliveryOperation } from "../protocol/deliver.js";
import { admitReviewOperation } from "../protocol/review.js";
import {
  contractCatalogueOperation,
  contractObservationOperation,
  contractsOperation,
  deliveryDiffOperation,
  deliveryOperation,
  stateOperation,
  withScopeAbortSignal,
  type DocumentDerivation,
  type IntentOutcome,
  type IntentRetry,
  type RepositoryScope,
} from "../protocol/operations.js";
import type { AcceptedProtocolStep } from "../protocol/outcome.js";
import {
  executionStop,
  isOperationalStop,
  isOperationalFailure,
  type ContractCheckpoint,
} from "../protocol/progress.js";
import type { ExecutionObserver } from "../protocol/execution-observation.js";
import { releaseTaskHolder, releaseTaskHolderWithFence, taskHolderObservationSelection } from "../settlement/holder.js";
import { readManagedWorktreeAppointment, type ContractWorkspaceLocation } from "../workspace-place.js";
import { admitForkBindWithAppointment, prepareMarkdownBind } from "./bind.js";
import { EMPTY_WORKTREE_HOOKS, worktreeHooksFrom, type WorktreeHooks } from "../git/hooks.js";
import { continueDeliveredDependents } from "./continuation.js";
import { Delivery, deliveryHandle, type DeliveryValue } from "./delivery.js";
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
  taskOption,
} from "./input.js";
import {
  InvocationAccumulator,
  KeiyakuError,
  errorCategory,
  project,
  validated,
  type ContractVerb,
  type HandoffOutcome,
  type OperationOutcome,
  type OutcomeProjection,
  type ProjectedOutcome,
  type Projected,
  type Review,
} from "./outcome.js";
import type { OperationRefusals } from "./refusal.js";
import { gatesFrom, requireBranchesToBeUpToDateFrom, SettingsError, type Settings } from "../settings.js";
import {
  completeReconcile,
  completeRepoReconcile,
  type ReconcileCompletion,
  type RepoReconcileReport,
} from "./reconcile.js";
import { observeChangedRegion, observeRegion, type AmendRegionObservation, type RegionObservation } from "./region.js";
import { scopeForRepo, type Repo } from "./repo.js";
import type {
  AbandonInput,
  AmendInput,
  ArcInput,
  BindInput,
  ContractHistory,
  ContractHistoryEvent,
  ContractList,
  ContractListInput,
  ContractObservationInput,
  DeliverInput,
  KeiyakuSelectInput,
  LocalContractComposition,
  ReviewInput,
} from "./contract-types.js";
import type { ContractObservation } from "../protocol/read/status.js";
import { requestForwardedContractLive, type ContractRequest } from "./contract-operations.js";

type AcceptedIntent<Value> = Extract<IntentOutcome<Value>, { kind: "accepted" }>;

// ---------------------------------------------------------------------------
// Public operation values and outcomes
// ---------------------------------------------------------------------------

export type BindValue = Readonly<{
  keiyaku: Keiyaku;
  workspace?: ContractWorkspaceLocation;
  warnings?: readonly string[];
}> &
  RegionObservation;

export type AmendValue = Readonly<{
  documentDiff: string;
  changes: Readonly<{ gates?: readonly Gate[]; after?: readonly ContractId[] }>;
}> &
  AmendRegionObservation;

export { Delivery } from "./delivery.js";
export type { AuditReport } from "../protocol/audit.js";
export type { Review } from "./outcome.js";

// ---------------------------------------------------------------------------
// Public surface of the one Contract operation owner
// ---------------------------------------------------------------------------

export type {
  ContractHead,
  ContractId,
  ContractState,
  ChangeId,
  SnapshotId,
  FactKind,
  ActorId,
} from "../core/facts/types.js";
export type { JournalEntry as Fact } from "../core/facts/types.js";
export type { Gate } from "../settings.js";
export type { HookCommand, WorktreeHooks } from "../git/hooks.js";
export type { RepoAtInput } from "./repo.js";
export type { ReconcileCompletion, RepoContractReconcileReport, RepoReconcileReport } from "./reconcile.js";

/** One repair entry: an explicit Repo plus an optional addressed Contract and retry choice. */
export type ReconcileInput = Readonly<{ repo: Repo; contract?: string; retryHooks?: boolean }>;
export type {
  AbandonInput,
  AmendInput,
  ArcInput,
  BindInput,
  ContractHistory,
  ContractHistoryEvent,
  ContractList,
  ContractListInput,
  ContractObservationInput,
  DeliverInput,
  KeiyakuSelectInput,
  LocalContractComposition,
  ReconcileReport,
  ReviewInput,
  TopologyEffect,
} from "./contract-types.js";
export type {
  ContractAfterEdge,
  ContractBoard,
  ContractCatalogue,
  ContractDependent,
  ContractDisposition,
  ContractGateCurrent,
  ContractGateReport,
  ContractObservation,
  ContractPhase,
  ContractRow,
  ContractWorkspaceObservation,
} from "../protocol/read/status.js";
export type { RegionOverlap } from "./region.js";
export type { KeiyakuRefusal, KeiyakuRetryReason, OperationRetries } from "./refusal.js";
export type { PlacementStop, VerificationStop } from "../protocol/operations.js";
export type { VerificationReuse } from "../protocol/deliver.js";
export type { IntegrationConflictMaterialized } from "../protocol/deliver.js";
export type { ContinuationReport } from "./continuation.js";
export type {
  InvocationEffect,
  PendingSurface,
  ReconciliationLag,
  PartialOutcomeEnvelope,
  KeiyakuErrorCategory,
} from "./outcome.js";
export { KeiyakuError } from "./outcome.js";
export type { ExecutionCleanup, ExecutionStop } from "../protocol/progress.js";
export type { ExecutionObservation } from "../protocol/execution-observation.js";
export type { NukeInput, NukeResult } from "./nuke.js";
export type { NukeConfirmationRefusal, NukeConfirmationRequiredRefusal } from "./refusal.js";
export type { SettlementAction, SettlementLag, SettlementReport } from "../settlement/settle.js";

export type BindOutcome = OperationOutcome<"bind", BindValue, OperationRefusals["bind"]>;
export type AmendOutcome = OperationOutcome<"amend", AmendValue, OperationRefusals["amend"]>;
export type DeliverOutcome =
  | OperationOutcome<"deliver", Delivery & DeliveryValue, OperationRefusals["deliver"]>
  | HandoffOutcome;
export type ReviewOutcome = OperationOutcome<"review", Review, OperationRefusals["review"]>;
export type AuditOutcome = OperationOutcome<"audit", AuditReport, OperationRefusals["audit"]>;
export type ArcOutcome = OperationOutcome<"arc", void, OperationRefusals["arc"]>;
export type AbandonOutcome = OperationOutcome<"abandon", void, OperationRefusals["abandon"]>;

export type DeliveryObservation = Readonly<{ observe?: ExecutionObserver }>;
export type MutationObservation = Readonly<{ observe?: ExecutionObserver }>;

export type AuditInput = Readonly<{ includeDirty?: boolean; showDiff?: boolean; signal?: AbortSignal }>;
export type AuditOptions = Readonly<{ includeDirty: boolean; showDiff: boolean; signal?: AbortSignal }>;
export type { ExecutionObserver };
export { AuthorityCorruptionError } from "../core/facts/errors.js";
export { actorId } from "../core/facts/types.js";
export { NoGitWorldError, Repo } from "./repo.js";
export { nukeKeiyaku as nuke } from "./nuke.js";

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** The one immutable Contract-local composition captured at construction. */
export type LocalContractCompositionCapture = Readonly<{
  settings?: Settings;
  actor?: ActorId;
}>;

/** The public construction input: one already-loaded Settings value and an operation actor. */
export type KeiyakuWithInput = LocalContractComposition;

/** One scoped Settings lookup: its native failure stays the cause of caller-invalid input. */
function settingsScopedFailure(error: unknown): never {
  if (error instanceof SettingsError) throw new KeiyakuError("invalid-input", error.message, { cause: error });
  throw error;
}

/**
 * Hooks, freshness, and gate bundles are read from the captured Settings only at the operation
 * that consumes them. Bare core (omitted Settings) keeps empty hooks, false freshness, and
 * literal gate words; a broken selected namespace fails before any admission.
 */
function derivedHooks(composition: LocalContractCompositionCapture): WorktreeHooks {
  if (composition.settings === undefined) return EMPTY_WORKTREE_HOOKS;
  try {
    return worktreeHooksFrom({ settings: composition.settings });
  } catch (error) {
    return settingsScopedFailure(error);
  }
}

function derivedFreshness(composition: LocalContractCompositionCapture): boolean {
  if (composition.settings === undefined) return false;
  try {
    return requireBranchesToBeUpToDateFrom({ settings: composition.settings });
  } catch (error) {
    return settingsScopedFailure(error);
  }
}

/** The two Settings-derived Contract policies one mutating operation may consume. */
function derivedContractPolicy(composition: LocalContractCompositionCapture): Readonly<{
  hooks: WorktreeHooks;
  requireBranchesToBeUpToDate: boolean;
}> {
  return { hooks: derivedHooks(composition), requireBranchesToBeUpToDate: derivedFreshness(composition) };
}

function gateNames(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError("gates must be an array");
  return value.map((item, index) => {
    if (typeof item !== "string") throw new TypeError(`gates[${index}] must be a string`);
    return item;
  });
}

/** An explicit empty selection needs no bundle lookup; omitted names select the configured default. */
function derivedGates(
  composition: LocalContractCompositionCapture,
  names: readonly string[] | undefined,
): readonly Gate[] {
  if (names !== undefined && names.length === 0) return Object.freeze([]);
  if (composition.settings === undefined) return literalGates(names);
  try {
    return (
      names === undefined
        ? gatesFrom({ settings: composition.settings })
        : gatesFrom({ settings: composition.settings, names })
    ) as readonly Gate[];
  } catch (error) {
    return settingsScopedFailure(error);
  }
}

function literalGates(names: readonly string[] | undefined): readonly Gate[] {
  if (names === undefined) return Object.freeze([]);
  const selected: Gate[] = [];
  const seen = new Set<string>();
  for (const [index, name] of names.entries()) {
    if (!gateWord(name)) {
      const message = `gates[${index}] must match ^[a-z][a-z0-9-]{0,63}$`;
      throw new KeiyakuError("invalid-input", message, { cause: new TypeError(message) });
    }
    if (seen.has(name)) continue;
    seen.add(name);
    selected.push(gate(name));
  }
  return Object.freeze(selected);
}

export interface KeiyakuLibraryReconcile {
  (input: ReconcileInput & Readonly<{ contract: string }>): Promise<ReconcileCompletion>;
  (input: ReconcileInput & Readonly<{ contract?: undefined }>): Promise<RepoReconcileReport>;
  (input: ReconcileInput): Promise<ReconcileCompletion | RepoReconcileReport>;
}

export type KeiyakuLibrary = Readonly<{
  bind(input: BindInput): Promise<BindOutcome>;
  select(input: KeiyakuSelectInput): Keiyaku;
  list(input: ContractListInput): Promise<ContractList>;
  observe(input: ContractObservationInput): Promise<ContractObservation>;
  reconcile: KeiyakuLibraryReconcile;
}>;

export function captureLocalContractComposition(input?: LocalContractComposition): LocalContractCompositionCapture {
  const values = requireInput(input === undefined ? {} : input, "Keiyaku.with input", ["settings", "actor"]);
  const actor = actorOption(values.actor).actor;
  const settings = values.settings;
  if (settings !== undefined && (settings === null || typeof settings !== "object")) {
    throw new TypeError("Keiyaku.with settings must be a Settings value");
  }
  return Object.freeze({
    ...(actor === undefined ? {} : { actor }),
    ...(settings === undefined ? {} : { settings: settings as Settings }),
  });
}

/**
 * The one private Contract composition constructor. `Keiyaku.with` fixes local execution; CLI and
 * Body pass their captured internal channel explicitly here instead of a second constructor. The
 * carrier is a positional argument, never a field of the public construction input, so no runtime
 * value reaching the public surface can select a private channel.
 */
export function composeContractLibrary(
  execution: LibraryExecution,
  input?: LocalContractComposition,
  createHandle: typeof createKeiyakuHandle = createKeiyakuHandle,
): KeiyakuLibrary {
  const composition = captureLocalContractComposition(input);
  return Object.freeze({
    bind: (operation: BindInput) => bindKeiyaku(operation, createHandle, execution, composition),
    select: (operation: KeiyakuSelectInput) => selectKeiyaku(operation, createHandle, execution, composition),
    list: (operation: ContractListInput) => listKeiyaku(operation),
    observe: (operation: ContractObservationInput) => observeKeiyaku(operation),
    reconcile: reconcileOperation(composition),
  });
}

export function selectKeiyaku(
  input: KeiyakuSelectInput,
  createHandle: typeof createKeiyakuHandle = createKeiyakuHandle,
  execution: ExecutionContext = localExecutionContext(),
  composition: LocalContractCompositionCapture = captureLocalContractComposition(),
): Keiyaku {
  const values = requireInput(input, "Keiyaku.with().select input");
  const scope = scopeForRepo(values.repo);
  if (typeof values.id !== "string") throw new TypeError("contract ID must be a string");
  return createHandle(contractId(values.id), scope, execution, composition);
}

/**
 * The one public repair entry: an explicit Repo proves the Git world, the captured composition
 * supplies its Settings-derived hooks, and the same operation-local retryHooks choice stays
 * available. Omitted contract reconciles the complete world; a supplied one reconciles that
 * addressed Contract.
 */
function reconcileOperation(composition: LocalContractCompositionCapture): KeiyakuLibraryReconcile {
  function run(input: ReconcileInput & Readonly<{ contract: string }>): Promise<ReconcileCompletion>;
  function run(input: ReconcileInput & Readonly<{ contract?: undefined }>): Promise<RepoReconcileReport>;
  function run(input: ReconcileInput): Promise<ReconcileCompletion | RepoReconcileReport>;
  function run(input: ReconcileInput): Promise<ReconcileCompletion | RepoReconcileReport> {
    return reconcileKeiyaku(input, composition);
  }
  return run;
}

async function reconcileKeiyaku(
  input: ReconcileInput,
  composition: LocalContractCompositionCapture = captureLocalContractComposition(),
): Promise<ReconcileCompletion | RepoReconcileReport> {
  const values = requireInput(input, "Keiyaku.with().reconcile input", ["repo", "contract", "retryHooks"]);
  const scope = scopeForRepo(values.repo);
  const contract = values.contract;
  if (contract !== undefined && typeof contract !== "string") throw new TypeError("contract must be a string");
  if (values.retryHooks !== undefined && typeof values.retryHooks !== "boolean")
    throw new TypeError("retryHooks must be a boolean");
  const options = { scope, hooks: derivedHooks(composition), retryHooks: values.retryHooks ?? false };
  if (contract === undefined) {
    return await withGitDecodeChannel(scope, (channel) => completeRepoReconcile({ ...options, channel }));
  }
  const id = contractId(contract);
  return await readContractValue(() =>
    withGitDecodeChannel(scope, (channel) => completeReconcile({ ...options, channel, contractId: id })),
  );
}

export async function listKeiyaku(input: ContractListInput): Promise<ContractList> {
  const values = requireInput(input, "Keiyaku.with().list input");
  for (const key of Object.keys(values)) {
    if (key !== "repo" && key !== "limit") throw new TypeError(`Keiyaku.with().list input has unknown field: ${key}`);
  }
  const scope = scopeForRepo(values.repo);
  if (values.limit === undefined) {
    const board = await readContractValue(() =>
      withGitDecodeChannel(scope, (channel) => contractsOperation({ scope, channel })),
    );
    return { ...board, hasMore: false };
  }
  if (typeof values.limit !== "number") throw new TypeError("Contract list limit must be a number");
  return readContractValue(() =>
    withGitDecodeChannel(scope, (channel) =>
      contractCatalogueOperation({ scope, channel, limit: values.limit as number }),
    ),
  );
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
  return readContractValue(() =>
    withGitDecodeChannel(scope, (channel) => contractObservationOperation({ scope, channel, contractId: id })),
  );
}

// ---------------------------------------------------------------------------
// The Keiyaku handle
// ---------------------------------------------------------------------------

const KEIYAKU_HANDLE = Symbol("Keiyaku handle");

export type HandleSeat = Readonly<{ id: ContractId; scope: RepositoryScope }>;
const KEIYAKU_SEATS = new WeakMap<object, HandleSeat>();

export class Keiyaku {
  static with(input?: KeiyakuWithInput): KeiyakuLibrary {
    return composeContractLibrary(localExecutionContext(), input, createKeiyakuHandle);
  }

  private readonly id: ContractId;
  private readonly scope: RepositoryScope;
  private readonly execution: ExecutionContext;
  private readonly composition: LocalContractCompositionCapture;

  constructor(
    token: typeof KEIYAKU_HANDLE,
    id: ContractId,
    scope: RepositoryScope,
    execution: ExecutionContext = localExecutionContext(),
    composition: LocalContractCompositionCapture,
  ) {
    if (token !== KEIYAKU_HANDLE) throw new TypeError("Keiyaku handles are created by Keiyaku.with");
    this.id = id;
    this.scope = scope;
    this.execution = execution;
    this.composition = composition;
    // Process-local custody never serializes: identity-only JSON projection.
    Object.defineProperties(this, {
      id: { value: id, enumerable: false },
      scope: { value: scope, enumerable: false },
      execution: { value: execution, enumerable: false },
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
    return await this.read(() =>
      withGitDecodeChannel(this.scope, (channel) =>
        stateOperation({ scope: this.scope, channel, contractId: this.id }),
      ),
    );
  }

  async history(): Promise<ContractHistory | null> {
    return await this.read(() =>
      withGitDecodeChannel(this.scope, (channel) =>
        withGitReadObservation(this.scope, channel, async (observation) => {
          const [journals, dispatches] = await Promise.all([
            observeContractsForAdmissionInObservationAt(observation, [this.id]),
            readDispatchesAt(observation),
          ]);
          const record = journals.journals.get(this.id);
          if (record === undefined) throw new Error(`missing requested contract observation: ${this.id}`);
          if (record.state === null) return null;
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
          const workspace = await readManagedWorktreeAppointment(this.scope, this.id);
          return {
            id: this.id,
            state: mintSnapshotId(commit),
            ...(workspace.kind === "appointed"
              ? { workspace: { kind: "worktree" as const, path: workspace.path } }
              : {}),
            events,
          };
        }),
      ),
    );
  }

  async guidance(): Promise<string | null> {
    return await this.read(() =>
      withGitDecodeChannel(this.scope, async (channel) => {
        const observed = await contractObservationOperation({ scope: this.scope, channel, contractId: this.id });
        if (observed.kind === "missing") return null;
        const state = await stateOperation({ scope: this.scope, channel, contractId: this.id });
        return state === null ? null : renderContractGuidance(state);
      }),
    );
  }

  async delivery(): Promise<Delivery | null> {
    const delivery = await this.read(() =>
      withGitDecodeChannel(this.scope, (channel) =>
        deliveryOperation({ scope: this.scope, channel, contractId: this.id }),
      ),
    );
    return delivery === null ? null : this.deliveryAbility(delivery);
  }

  async amend(input: AmendInput): Promise<AmendOutcome> {
    const { markdown, gates, prerequisites, actor } = validated(() => {
      const values = requireInput(input, "amend input", ["actor", "markdown", "gates", "after"]);
      return {
        markdown: values.markdown === undefined ? undefined : requireMarkdown(values.markdown),
        gates: values.gates === undefined ? undefined : derivedGates(this.composition, gateNames(values.gates)),
        prerequisites: values.after === undefined ? undefined : normalizedList(values.after, "after", contractId),
        actor: actorOption(values.actor).actor,
      };
    });
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
          value: (): AmendValue => ({ documentDiff: diff, changes, ...region }),
        });
        return acceptedOutcome("amend", this.id, accumulator, value);
      },
    );
  }

  /** One promise with an optional observation callback; observation never delays custody. */
  async deliver(input?: DeliverInput, options?: DeliveryObservation): Promise<DeliverOutcome> {
    const values = validated(() => normalizeDeliverInput(input));
    const observer = validated(() => observationOptions(options));
    const channel = executionChannel(this.execution);
    if (channel.kind === "body-request")
      return await forwardedContractOutcome<"deliver", Delivery & DeliveryValue>({
        revive: (value) => this.deliveryAbility(value),
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
        return acceptedOutcome("deliver", this.id, accumulator, this.deliveryAbility(value));
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

  /**
   * Reads answer with a value or `null` for legitimate absence. Corrupt authority stays exceptional
   * and keeps its original native cause instead of being disguised as a raw native exception.
   */
  private async read<Value>(operation: () => Promise<Value>): Promise<Value> {
    return await readContractValue(operation);
  }

  // --- private plumbing -----------------------------------------------------

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

  private deliveryAbility(delivery: DeliveryValue): Delivery & DeliveryValue;
  private deliveryAbility(
    delivery: Pick<DeliveryValue, "tenderSnapshot" | "integration" | "method" | "policy">,
  ): Delivery;
  private deliveryAbility(
    delivery: Pick<DeliveryValue, "tenderSnapshot" | "integration" | "method" | "policy">,
  ): Delivery {
    return deliveryHandle(delivery, () =>
      deliveryDiffOperation({
        scope: this.scope,
        integrationPredecessor: delivery.integration.predecessor,
        integrationSnapshot: delivery.integration.snapshot,
      }),
    );
  }
}

type Admission<Value, Refusal> =
  | Readonly<{ kind: "accepted"; accepted: AcceptedIntent<Value> }>
  | Readonly<{ kind: "refused"; refusal: Refusal }>
  | Readonly<{ kind: "retry"; reason: IntentRetry }>;

function admissionOf<Value, Refusal>(outcome: IntentOutcome<Value, Refusal>): Admission<Value, Refusal> {
  if (outcome.kind === "accepted") return { kind: "accepted", accepted: outcome };
  return outcome.kind === "refused"
    ? { kind: "refused", refusal: outcome.refusal }
    : { kind: "retry", reason: outcome.reason };
}

/** The refused/retry arms are value-agnostic, so every operation can return them unchanged. */
type ExpectedProjection<Refusal> =
  | Readonly<{ kind: "refused"; contract?: ContractId; refusal: Refusal }>
  | Readonly<{ kind: "retry"; contract?: ContractId; reason: IntentRetry }>;

function expected<Refusal>(
  contract: ContractId | undefined,
  admission: Exclude<Admission<unknown, Refusal>, { kind: "accepted" }>,
): ExpectedProjection<Refusal> {
  return admission.kind === "refused"
    ? {
        kind: "refused",
        ...(contract === undefined ? {} : { contract }),
        refusal: admission.refusal,
      }
    : { kind: "retry", ...(contract === undefined ? {} : { contract }), reason: admission.reason };
}

function acceptedOutcome<Operation extends ContractVerb, Value>(
  operation: Operation,
  contract: ContractId,
  accumulator: InvocationAccumulator,
  value: Value,
): OutcomeProjection<Operation, Value, never> {
  void operation;
  const head = accumulator.head(contract);
  if (head === undefined) throw new Error("missing leading admission receipt");
  return { kind: "accepted", contract, head, value };
}

function conclusions(value: object): Readonly<Record<string, unknown>> {
  return value as Readonly<Record<string, unknown>>;
}

function retainAdmission<Value>(
  accumulator: InvocationAccumulator,
  contract: ContractId,
  leading: AcceptedIntent<Value>,
  verificationResidueRecorded: boolean,
): void {
  accumulator.recordPublication(contract, leading.head, leading.facts);
  accumulator.recordResidue(contract, leading);
  if (!verificationResidueRecorded) accumulator.recordVerification(contract, undefined, leading);
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

async function readContractValue<Value>(operation: () => Promise<Value>): Promise<Value> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof KeiyakuError) throw error;
    throw new KeiyakuError(errorCategory(error), errorMessage(error), { cause: error });
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

// ---------------------------------------------------------------------------
// Bind
// ---------------------------------------------------------------------------

export type BindResult = BindOutcome;

function bindInput(input: BindInput, composition: LocalContractCompositionCapture) {
  return validated(() => {
    const values = requireInput(input, "Keiyaku.bind input");
    const forkOf = values.forkOf;
    const allowed =
      forkOf === undefined
        ? ["repo", "markdown", "task", "target", "workspace", "actor", "after", "gates"]
        : ["repo", "forkOf", "target", "workspace", "actor"];
    requireInput(input, "Keiyaku.bind input", allowed);
    if ((values.workspace ?? "worktree") !== "worktree") throw new TypeError("workspace must be worktree");
    if (values.target !== undefined && typeof values.target !== "string")
      throw new TypeError("target must be a string");
    const actor = actorOption(values.actor);
    const document = forkOf === undefined ? parseMarkdown(requireMarkdown(values.markdown)) : undefined;
    if (forkOf !== undefined) {
      if (typeof forkOf !== "string") throw new TypeError("forkOf must be a ContractId");
    }
    return {
      forkOf: forkOf === undefined ? undefined : contractId(forkOf as string),
      scope: scopeForRepo(values.repo),
      document,
      actor,
      target: values.target as string | undefined,
      task: forkOf === undefined ? taskOption(values.task) : undefined,
      gates: forkOf === undefined ? derivedGates(composition, gateNames(values.gates)) : undefined,
      after: forkOf === undefined ? normalizedList(values.after, "after", contractId) : undefined,
    };
  });
}

export async function bindKeiyaku(
  input: BindInput,
  createHandle: typeof createKeiyakuHandle = createKeiyakuHandle,
  execution: ExecutionContext = localExecutionContext(),
  composition: LocalContractCompositionCapture = captureLocalContractComposition(),
): Promise<BindOutcome> {
  const prepared = bindInput(input, composition);
  const hooks = derivedHooks(composition);
  const { forkOf, scope, document, target, actor } = prepared;
  const handle = (id: ContractId) => createHandle(id, scope, execution, composition);
  const accumulator = new InvocationAccumulator();
  const projection = await (async (): Promise<OutcomeProjection<"bind", BindValue, OperationRefusals["bind"]>> => {
    let completed: OutcomeProjection<"bind", BindValue, OperationRefusals["bind"]> | undefined;
    let retirement: { error: unknown } | undefined;
    try {
      return await withGitDecodeChannel(
        scope,
        async (channel) => {
          completed = await (async (): Promise<OutcomeProjection<"bind", BindValue, OperationRefusals["bind"]>> => {
            if (forkOf !== undefined) {
              const fork = await admitForkBindWithAppointment({
                scope,
                channel,
                progress: accumulator,
                sourceId: forkOf,
                ...(target === undefined ? {} : { target }),
                ...actor,
              });
              if (fork.kind === "refused") return { kind: "refused", refusal: fork.refusal };
              const admission = fork.admission;
              if (admission.kind !== "accepted") return expected(undefined, admission);
              const id = admission.value.contractId;
              accumulator.extendConclusions(id, { keiyaku: handle(id) });
              const value = await bindComplete(accumulator, id, scope, channel, admission, hooks, () =>
                observeRegion(scope, channel, id, fork.document.region).then((region) =>
                  bindValue(handle(id), region, []),
                ),
              );
              return acceptedOutcome("bind", id, accumulator, value);
            }
            if (document === undefined) throw new Error("Markdown bind requires its prepared document");
            return await markdownBind(prepared, document, hooks, scope, channel, accumulator, handle);
          })();
          return completed;
        },
        (error) => {
          retirement = { error };
          const id = accumulator.snapshot().facts.find((fact) => fact.kind === "bind")?.contract;
          if (id !== undefined) accumulator.recordChannelRetirement(id, error);
        },
      );
    } catch (error) {
      if (
        retirement !== undefined &&
        error === retirement.error &&
        completed?.kind === "accepted" &&
        isOperationalFailure(error)
      )
        return completed;
      const contract = accumulator.snapshot().facts.find((fact) => fact.kind === "bind")?.contract;
      return { kind: "failed", ...(contract === undefined ? {} : { contract }), error };
    }
  })();
  const projected = project("bind", accumulator.snapshot(), projection);
  if (projected.kind === "failed") throw projected.error;
  return projected.outcome as BindOutcome;
}

function bindValue(
  keiyaku: Keiyaku,
  region: RegionObservation,
  warnings: readonly string[],
  workspace?: ContractWorkspaceLocation,
  appointmentLag?: readonly { path: string; diagnostic: string }[],
): BindValue {
  const base = {
    keiyaku,
    ...(workspace === undefined ? {} : { workspace }),
    ...(warnings.length === 0 ? {} : { warnings }),
    ...region,
  };
  void appointmentLag;
  return base;
}

async function bindComplete<Value>(
  accumulator: InvocationAccumulator,
  id: ContractId,
  scope: RepositoryScope,
  channel: GitDecodeChannel,
  leading: AcceptedIntent<Value>,
  hooks: WorktreeHooks,
  value: () => Promise<BindValue>,
): Promise<BindValue> {
  retainAdmission(accumulator, id, leading, false);
  await reconcileAll(accumulator, id, scope, channel, hooks);
  try {
    const appointment = await readManagedWorktreeAppointment(scope, id);
    if (appointment.kind === "appointed")
      accumulator.extendConclusions(id, {
        workspace: { kind: "worktree", path: appointment.path },
      });
  } catch (error) {
    if (!isOperationalStop(error, scope.signal)) throw error;
    accumulator.recordStop(executionStop(id, "reconciliation", error, scope.signal));
  }
  const built = { ...(await value()), ...accumulator.conclusions(id) } as BindValue;
  accumulator.extendConclusions(id, conclusions(built));
  return built;
}

async function reconcileAll(
  accumulator: InvocationAccumulator,
  id: ContractId,
  scope: RepositoryScope,
  channel: GitDecodeChannel,
  hooks: WorktreeHooks,
): Promise<void> {
  for (const contract of [...new Set([id, ...accumulator.snapshot().affected])]) {
    try {
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

async function markdownBind(
  prepared: ReturnType<typeof bindInput>,
  document: ReturnType<typeof parseMarkdown>,
  hooks: WorktreeHooks,
  scope: RepositoryScope,
  channel: GitDecodeChannel,
  accumulator: InvocationAccumulator,
  handle: (id: ContractId) => Keiyaku,
): Promise<OutcomeProjection<"bind", BindValue, OperationRefusals["bind"]>> {
  const { task, target, actor, gates, after } = prepared;
  if (gates === undefined || after === undefined) throw new Error("Markdown bind requires prepared terms");
  const targetSelection =
    target !== undefined ? { kind: "explicit" as const, target } : { kind: "targetless" as const };
  const admission = await prepareMarkdownBind({
    scope,
    channel,
    document,
    gates,
    progress: accumulator,
    after,
    workspace: "worktree",
    targetSelection,
    ...(task === undefined ? {} : { task }),
    ...actor,
  });
  const leading = admission.admission === null ? admission.result : admission.admission.result;
  if (leading.kind !== "accepted") return expected(undefined, leading);
  const id = leading.value.contractId;
  accumulator.extendConclusions(id, { keiyaku: handle(id), warnings: regionWarnings(document.region) });
  const value = await bindComplete(accumulator, id, scope, channel, leading, hooks, async () =>
    bindValue(handle(id), await observeRegion(scope, channel, id, document.region), regionWarnings(document.region)),
  );
  return acceptedOutcome("bind", id, accumulator, value);
}

function parseMarkdown(markdown: string) {
  return decodeContractDocument(markdown, { requireTimeout: true });
}

/** Internal constructor capability; callers select a Contract through Keiyaku.with. */
export function createKeiyakuHandle(
  id: ContractId,
  scope: RepositoryScope,
  execution: ExecutionContext,
  composition: LocalContractCompositionCapture,
): Keiyaku {
  return new Keiyaku(KEIYAKU_HANDLE, id, scope, execution, composition);
}

/** Internal package composition capability; not exported from the package root. */
export function seatForKeiyaku(value: unknown): HandleSeat | null {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? (KEIYAKU_SEATS.get(value) ?? null)
    : null;
}
