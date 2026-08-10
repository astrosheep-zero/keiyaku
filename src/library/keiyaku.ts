import { documentDiff } from "../markdown/diff.js";
import { applyAmendDocument } from "../body/amend.js";
import { decodeArcDocument } from "../body/arc.js";
import { decodeContractDocument } from "../body/decode.js";
import type { DecodedContractDocument } from "../body/types.js";
import {
  actorOption,
  contractTerms,
  documentDerivation,
  normalizedGates,
  normalizedList,
  optionalNonblank,
  requireInput,
  requireMarkdown,
} from "./input.js";
import { observeRegion, type RegionObservation, type RegionOverlap } from "./region.js";
import type { Gate } from "./gates.js";
import {
  contractId,
  type ChangeId,
  type ContractHead,
  type ContractId,
  type ContractState,
  type JournalEntry,
  type SnapshotId,
} from "../core/facts/types.js";
export { AuthorityCorruptionError } from "../core/facts/errors.js";
import {
  abandonOperation,
  amendOperation,
  arcOperation,
  auditOperation,
  bindOperation,
  NoGitWorldError,
  contractObservationOperation,
  contractsOperation,
  currentBranchOperation,
  deliveryDiffOperation,
  deliverOperation,
  deliveryOperation,
  readStateOperation,
  reconcileAllOperation,
  reconcileOperation,
  reviewOperation,
  scopeOperation,
  stateOperation,
  type AuditReport,
  type ContractBoard,
  type ContractDisposition,
  type ContractGateCurrent,
  type ContractGateReport,
  type ContractObservation,
  type ContractPhase,
  type ContractRow,
  type DeliverValue,
  type FactKind,
  type IntentOutcome,
  type IntentRefusal,
  type IntentRetry,
  type PlacementStop,
  type ReconcileReport as ProtocolReconcileReport,
  type RepositoryScope,
  type ReviewValue,
  type TimelineEntry,
  type VerificationStop,
} from "../protocol/operations.js";
import { settle, type SettlementReport } from "../settlement/settle.js";
export { NoGitWorldError };
export { gatesFrom, SettingsError } from "./gates.js";
export type { Gate, GatesFromInput } from "./gates.js";

export type {
  AuditReport,
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
  TimelineEntry,
};
export type { RegionOverlap };

export type Fact = JournalEntry;
export type ActorId = string;
export type AttestationVerdict = "satisfied" | "unsatisfied";
export type Review = ReviewValue;
export type KeiyakuRefusal = IntentRefusal;
export type KeiyakuRetryReason = IntentRetry;
export type { PlacementStop, VerificationStop };

export type TopologyEffect = ProtocolReconcileReport["effects"][number];
export type Lag = ProtocolReconcileReport["lag"][number];
export type MutationResult<Value> = Readonly<{
  facts: readonly Fact[];
  head: ContractHead;
  value: Value;
  effects: readonly TopologyEffect[];
  lags: readonly Lag[];
  settlement: SettlementReport;
}>;

export type BindResult = Readonly<Omit<MutationResult<Keiyaku>, "value"> & { keiyaku: Keiyaku } & RegionObservation>;
export type AmendResult = Readonly<MutationResult<void> & RegionObservation & { documentDiff: string }>;
export type ReconcileReport = Readonly<ProtocolReconcileReport & { settlement: SettlementReport }>;
export type RepoReconcileReport = Readonly<{
  contracts: readonly Readonly<{ contractId: ContractId; report: ReconcileReport }>[];
}>;
export type { SettlementAction, SettlementLag, SettlementReport } from "../settlement/settle.js";

export class KeiyakuRefused extends Error {
  constructor(readonly refusal: KeiyakuRefusal) {
    super(`Keiyaku refused: ${refusal.kind}`);
    this.name = "KeiyakuRefused";
  }

  get code(): KeiyakuRefusal["kind"] {
    return this.refusal.kind;
  }
}

export class KeiyakuRetry extends Error {
  constructor(readonly reason: KeiyakuRetryReason) {
    super(reason.kind === "publication-failed" ? reason.diagnostic : `Keiyaku retry required: ${reason.kind}`);
    this.name = "KeiyakuRetry";
  }

  get code(): KeiyakuRetryReason["kind"] {
    return this.reason.kind;
  }
}

export type BindInput = Readonly<{
  repo: Repo;
  markdown: string;
  target?: string;
  workspace?: "worktree" | "here";
  actor?: ActorId;
  after?: readonly ContractId[];
  gates?: readonly Gate[];
}>;

export type AmendInput = Readonly<{
  markdown: string;
  actor?: ActorId;
  after?: readonly ContractId[];
  gates?: readonly Gate[];
}>;

export type ArcInput = Readonly<{
  markdown: string;
  actor?: ActorId;
}>;

type ActorOptions = Readonly<{ actor?: ActorId }>;
export type RepoAtInput = Readonly<{ path?: string }>;
export type ContractListInput = Readonly<{ repo: Repo }>;
export type ContractObservationInput = Readonly<{ repo: Repo; id: ContractId }>;
export type KeiyakuOfInput = Readonly<{ repo: Repo; id: ContractId }>;
export type ReviewInput = ActorOptions & Readonly<{ verdict: AttestationVerdict; summary?: string }>;
export type AbandonInput = ActorOptions & Readonly<{ note?: string }>;
export type DeliverInput = ActorOptions & Readonly<{ message?: string }>;
export type AuditInput = ActorOptions;

type AcceptedIntent<Value> = Readonly<{
  kind: "accepted";
  facts: readonly Fact[];
  head: ContractHead;
  value: Value;
}>;

function requireAccepted<Value, Refusal extends KeiyakuRefusal>(result: IntentOutcome<Value, Refusal>): AcceptedIntent<Value> {
  if (result.kind === "refused") throw new KeiyakuRefused(result.refusal);
  if (result.kind === "retry") throw new KeiyakuRetry(result.reason);
  return result;
}

async function mutationResult<Value, PublicValue>(
  scope: RepositoryScope,
  id: ContractId,
  accepted: AcceptedIntent<Value>,
  value: (result: Value) => PublicValue,
): Promise<MutationResult<PublicValue>> {
  const reconciled = reconcileOperation({ scope, contractId: id });
  const settlement = await settle({ taskRoot: scope.primaryWorktree, state: reconciled.state, effects: reconciled.report.effects });
  return {
    facts: accepted.facts,
    head: accepted.head,
    value: value(accepted.value),
    effects: reconciled.report.effects,
    lags: reconciled.report.lag,
    settlement,
  };
}

function resolvePinnedScope(path?: string): RepositoryScope {
  const coordinate = path === undefined ? process.cwd() : path;
  return scopeOperation({ coordinate });
}

class DeliveryHandle {
  declare readonly verification?: DeliverValue["verification"];
  declare readonly placement?: DeliverValue["placement"];
  declare readonly leak?: DeliverValue["leak"];

  constructor(
    readonly snapshotId: SnapshotId,
    readonly changeId: ChangeId,
    readonly expectedPredecessor: SnapshotId,
    private readonly readDiff: () => Promise<string | null>,
    outcomes: Partial<Pick<DeliverValue, "verification" | "placement" | "leak">> = {},
  ) {
    Object.assign(this, outcomes);
  }

  diff(): Promise<string | null> {
    return this.readDiff();
  }
}

export type Delivery = DeliveryHandle;
type HandleType<T extends object> = Readonly<{
  prototype: T;
  [Symbol.hasInstance](value: unknown): boolean;
}>;
function handleType<T extends object>(prototype: T, hasInstance: (value: unknown) => boolean): HandleType<T> {
  return Object.freeze({ prototype, [Symbol.hasInstance]: hasInstance });
}
export const Delivery = handleType(DeliveryHandle.prototype, (value) => value instanceof DeliveryHandle);

class KeiyakuHandle {
  constructor(
    private readonly id: ContractId,
    private readonly scope: RepositoryScope,
  ) {}

  async state(): Promise<ContractState> {
    return stateOperation({ scope: this.scope, contractId: this.id });
  }

  async delivery(): Promise<Delivery | null> {
    const delivery = deliveryOperation({ scope: this.scope, contractId: this.id });
    return delivery === null
      ? null
      : this.deliveryHandle(delivery);
  }

  async amend(input: AmendInput): Promise<AmendResult> {
    const values = requireInput(input, "amend input");
    const markdown = requireMarkdown(values.markdown);
    const actor = actorOption(values.actor);
    const gates = values.gates === undefined ? undefined : normalizedGates(values.gates);
    const prerequisites = values.after === undefined
      ? undefined
      : normalizedList(values.after, "after", contractId);
    const current = readStateOperation({ scope: this.scope, contractId: this.id });
    let document: DecodedContractDocument | undefined;
    let terms: ReturnType<typeof contractTerms> | undefined;
    let verification: ReturnType<typeof documentDerivation>["verification"] | undefined;
    if (current !== null) {
      const before = current.terms.document.bytes;
      const currentDocument = decodeContractDocument(before);
      document = decodeContractDocument(applyAmendDocument(markdown, currentDocument));
      terms = contractTerms(
        document,
        gates ?? current.terms.gates,
        prerequisites ?? current.terms.after,
      );
      verification = documentDerivation(document, terms.gates, this.id).verification;
    }
    const accepted = requireAccepted(amendOperation({
      scope: this.scope,
      contractId: this.id,
      ...actor,
      ...(current === null || terms === undefined || verification === undefined
        ? {}
        : { amendment: { source: current.terms, terms, verification } }),
    }));
    if (document === undefined || current === null) {
      throw new Error("accepted amendment is missing its document derivation");
    }
    const before = current.terms.document.bytes;
    const after = document.document.bytes;
    return {
      ...await mutationResult(this.scope, this.id, accepted, () => undefined),
      documentDiff: documentDiff("before", "after", before, after),
      ...observeRegion(this.scope, this.id, document.region),
    };
  }

  async deliver(input?: DeliverInput): Promise<MutationResult<Delivery>> {
    const values = input === undefined ? undefined : requireInput(input, "deliver input");
    const message = optionalNonblank(values?.message, "deliver message");
    const actor = actorOption(values?.actor);
    const state = readStateOperation({ scope: this.scope, contractId: this.id });
    const derivation = state === null
      ? undefined
      : documentDerivation(decodeContractDocument(state.terms.document.bytes), state.terms.gates, state.id);
    const accepted = requireAccepted(
      await deliverOperation({
        scope: this.scope,
        contractId: this.id,
        ...(derivation === undefined ? {} : { derivation }),
        ...actor,
        ...(message === undefined ? {} : { message }),
      }),
    );
    return mutationResult(this.scope, this.id, accepted, (delivery) => this.deliveryHandle(delivery));
  }

  async review(input: ReviewInput): Promise<MutationResult<Review>> {
    const values = requireInput(input, "review input");
    const verdict = values.verdict;
    if (verdict !== "satisfied" && verdict !== "unsatisfied") {
      throw new TypeError("verdict must be satisfied or unsatisfied");
    }
    const summary = optionalNonblank(values.summary, "review summary");
    const accepted = requireAccepted(reviewOperation({
      scope: this.scope,
      contractId: this.id,
      verdict,
      ...(summary === undefined ? {} : { summary }),
      ...actorOption(values.actor),
    }));
    return mutationResult(this.scope, this.id, accepted, (value) => value);
  }

  async abandon(input?: AbandonInput): Promise<MutationResult<void>> {
    const values = input === undefined ? undefined : requireInput(input, "abandon input");
    const note = optionalNonblank(values?.note, "abandon note");
    const accepted = requireAccepted(abandonOperation({
      scope: this.scope,
      contractId: this.id,
      ...actorOption(values?.actor),
      ...(note === undefined ? {} : { note }),
    }));
    return mutationResult(this.scope, this.id, accepted, () => undefined);
  }

  async arc(input: ArcInput): Promise<MutationResult<void>> {
    const values = requireInput(input, "arc input");
    const chapter = decodeArcDocument(requireMarkdown(values.markdown));
    const accepted = requireAccepted(arcOperation({
      scope: this.scope,
      contractId: this.id,
      ...actorOption(values.actor),
      chapter,
    }));
    return mutationResult(this.scope, this.id, accepted, () => undefined);
  }

  async audit(input?: AuditInput): Promise<MutationResult<AuditReport>> {
    const values = input === undefined ? undefined : requireInput(input, "audit input");
    const actor = actorOption(values?.actor);
    const state = readStateOperation({ scope: this.scope, contractId: this.id });
    const derivation = state === null
      ? undefined
      : documentDerivation(decodeContractDocument(state.terms.document.bytes), state.terms.gates, state.id);
    const accepted = requireAccepted(
      await auditOperation({
        scope: this.scope,
        contractId: this.id,
        ...(derivation === undefined ? {} : { derivation }),
        ...actor,
      }),
    );
    return mutationResult(this.scope, this.id, accepted, (report) => report);
  }

  async reconcile(): Promise<ReconcileReport> {
    const reconciled = reconcileOperation({ scope: this.scope, contractId: this.id });
    return {
      ...reconciled.report,
      settlement: await settle({ taskRoot: this.scope.primaryWorktree, state: reconciled.state, effects: reconciled.report.effects }),
    };
  }

  private deliveryHandle(delivery: DeliverValue): Delivery {
    return new DeliveryHandle(
      delivery.snapshotId,
      delivery.changeId,
      delivery.expectedPredecessor,
      () => deliveryDiffOperation({
        scope: this.scope,
        expectedPredecessor: delivery.expectedPredecessor,
        snapshotId: delivery.snapshotId,
      }),
      delivery,
    );
  }

}

export type Keiyaku = KeiyakuHandle;

const REPO_SCOPES = new WeakMap<object, RepositoryScope>();

export class Repo {
  readonly root: string;

  private constructor(scope: RepositoryScope) {
    this.root = scope.primaryWorktree;
    REPO_SCOPES.set(this, scope);
  }

  static at(input?: RepoAtInput): Repo {
    const values = input === undefined ? undefined : requireInput(input, "Repo.at input");
    const scope = resolvePinnedScope(optionalNonblank(values?.path, "repository path"));
    return new Repo(scope);
  }

  async currentBranch(): Promise<string | null> {
    return currentBranchOperation({ scope: scopeForRepo(this) });
  }

  async reconcile(): Promise<RepoReconcileReport> {
    const scope = scopeForRepo(this);
    const reconciled = reconcileAllOperation({ scope });
    return {
      contracts: await Promise.all(reconciled.contracts.map(async (contract) => ({
        contractId: contract.contractId,
        report: {
          ...contract.report,
          settlement: await settle({ taskRoot: scope.primaryWorktree, state: contract.state, effects: contract.report.effects }),
        },
      }))),
    };
  }
}

function scopeForRepo(value: unknown): RepositoryScope {
  if (!(value instanceof Repo)) throw new TypeError("repo must be a Repo");
  const scope = REPO_SCOPES.get(value);
  if (scope === undefined) throw new TypeError("repo must be a Repo");
  return scope;
}

function keiyakuOf(input: KeiyakuOfInput): Keiyaku {
  const values = requireInput(input, "Keiyaku.of input");
  const scope = scopeForRepo(values.repo);
  if (typeof values.id !== "string") throw new TypeError("contract ID must be a string");
  return new KeiyakuHandle(contractId(values.id), scope);
}

async function listKeiyaku(input: ContractListInput): Promise<ContractBoard> {
  const values = requireInput(input, "Keiyaku.list input");
  for (const key of Object.keys(values)) if (key !== "repo") throw new TypeError(`Keiyaku.list input has unknown field: ${key}`);
  return contractsOperation({ scope: scopeForRepo(values.repo) });
}

async function observeKeiyaku(input: ContractObservationInput): Promise<ContractObservation> {
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
  return contractObservationOperation({ scope, contractId: id });
}

async function bindKeiyaku(input: BindInput): Promise<BindResult> {
  const values = requireInput(input, "Keiyaku.bind input");
  const scope = scopeForRepo(values.repo);
  const markdown = requireMarkdown(values.markdown);
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
  const admitted = bindOperation({
    scope,
    title: document.title,
    terms,
    verification: documentDerivation(document, terms.gates).verification,
    workspace,
    ...(target === undefined ? {} : { target }),
    ...actor,
  });
  const accepted = requireAccepted(admitted);
  const id = accepted.value.contractId;
  const result = await mutationResult(scope, id, accepted, ({ contractId: contract }) => new KeiyakuHandle(contract, scope));
  return {
    facts: result.facts,
    head: result.head,
    keiyaku: result.value,
    effects: result.effects,
    lags: result.lags,
    settlement: result.settlement,
    ...observeRegion(scope, id, document.region),
  };
}

export const Keiyaku = Object.freeze({
  ...handleType(KeiyakuHandle.prototype, (value) => value instanceof KeiyakuHandle),
  bind: bindKeiyaku,
  list: listKeiyaku,
  observe: observeKeiyaku,
  of: keiyakuOf,
});
