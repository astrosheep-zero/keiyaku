import { documentDiff } from "../markdown/diff.js";
import { applyAmendDocument } from "../body/amend.js";
import { decodeArcDocument } from "../body/arc.js";
import { decodeContractDocument, verificationDefinition } from "../body/decode.js";
import type { DecodedContractDocument } from "../body/types.js";
import { observeRegion, type RegionObservation, type RegionOverlap } from "./region.js";
import type { Gate } from "./gates.js";
import {
  prepareVerificationDeclaration,
  type VerificationDeclarationPreparation,
} from "../verification/declaration.js";
import {
  contractId,
  actorId,
  gate,
  gateWord,
  type ActorId as CoreActorId,
  type ChangeId,
  type ContractId,
  type ContractState,
  type ContractTerms,
  type Gate as CoreGate,
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
  type DocumentDerivation,
  type FactKind,
  type IntentOutcome,
  type IntentRefusal,
  type IntentRetry,
  type PlacementStop,
  type RepoReconcileReport,
  type ReconcileReport as ProtocolReconcileReport,
  type RepositoryScope,
  type ReviewValue,
  type TimelineEntry,
  type VerificationStop,
} from "../protocol/operations.js";
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
  RepoReconcileReport,
  SnapshotId,
  TimelineEntry,
};
export type { RegionOverlap };

export type Fact = JournalEntry;
export type ActorId = string;
export type AttestationVerdict = "satisfied" | "unsatisfied";
export type Review = ReviewValue;
export type TypedRefusal = IntentRefusal;
export type TypedRetry = IntentRetry;
export type { PlacementStop, VerificationStop };

export type Outcome<A, Observation extends object = Record<never, never>> =
  | (Extract<IntentOutcome<A>, { kind: "accepted" }> & Observation)
  | Exclude<IntentOutcome<A>, { kind: "accepted" }>;

export type BindResult = Outcome<Keiyaku, RegionObservation>;
export type AmendResult = Outcome<void, RegionObservation & Readonly<{ documentDiff: string }>>;
export type ReconcileReport = ProtocolReconcileReport;

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

function actorOption(actor: unknown): Readonly<{ actor?: CoreActorId }> {
  if (actor === undefined) return {};
  if (typeof actor !== "string" || actor.trim().length === 0) {
    throw new TypeError("actor must be a nonblank string");
  }
  return { actor: actorId(actor) };
}

function requireMarkdown(value: unknown, label = "markdown"): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireInput(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function optionalNonblank(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a nonblank string`);
  }
  return value;
}

function normalizedList<T>(
  values: unknown,
  label: string,
  brand: (value: string) => T,
): readonly T[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  return values.map((value, index) => {
    if (typeof value !== "string") throw new TypeError(`${label}[${index}] must be a string`);
    try {
      return brand(value);
    } catch (error) {
      throw new TypeError(error instanceof Error ? error.message : `${label}[${index}] is invalid`);
    }
  });
}

function normalizedGates(values: unknown): readonly CoreGate[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new TypeError("gates must be an array");
  const normalized = values.map((value, index) => {
    if (!gateWord(value)) {
      throw new TypeError(`gates[${index}] must match ^[a-z][a-z0-9-]{0,63}$`);
    }
    return gate(value);
  });
  if (new Set(normalized).size !== normalized.length) throw new TypeError("gates must not contain duplicates");
  return normalized;
}

function contractTerms(
  document: DecodedContractDocument,
  gates: readonly CoreGate[],
  after: readonly ContractId[],
): ContractTerms {
  return {
    document: document.document,
    segments: document.segments,
    gates,
    after,
  };
}

function documentDerivation(
  document: DecodedContractDocument,
  gates: readonly CoreGate[],
  contractId?: ContractId,
): DocumentDerivation {
  return {
    document: document.document.key,
    title: document.title,
    verification: prepareVerificationDeclaration({
      gates,
      definition: verificationDefinition(document),
      ...(contractId === undefined ? {} : { contractId }),
    }),
  };
}

function mapOutcome<Value, PublicValue>(
  result: IntentOutcome<Value>,
  value: (result: Value) => PublicValue,
): Outcome<PublicValue> {
  if (result.kind !== "accepted") return result;
  return { ...result, value: value(result.value) };
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
    let terms: ContractTerms | undefined;
    let verification: VerificationDeclarationPreparation | undefined;
    if (current !== null) {
      const before = current.terms.document.bytes;
      const currentDocument = decodeContractDocument(before);
      document = decodeContractDocument(applyAmendDocument(markdown, currentDocument));
      terms = contractTerms(
        document,
        gates ?? current.terms.gates,
        prerequisites ?? current.terms.after,
      );
      verification = prepareVerificationDeclaration({
        gates: terms.gates,
        definition: verificationDefinition(document),
        contractId: this.id,
      });
    }
    const outcome = mapOutcome(amendOperation({
      scope: this.scope,
      contractId: this.id,
      ...actor,
      ...(current === null || terms === undefined || verification === undefined
        ? {}
        : { amendment: { source: current.terms, terms, verification } }),
    }), () => undefined);
    if (outcome.kind !== "accepted") return outcome;
    if (document === undefined || current === null) {
      throw new Error("accepted amendment is missing its document derivation");
    }
    const before = current.terms.document.bytes;
    const after = document.document.bytes;
    return { ...outcome, documentDiff: documentDiff("before", "after", before, after), ...observeRegion(this.scope, this.id, document.region) };
  }

  async deliver(input?: DeliverInput): Promise<Outcome<Delivery>> {
    const values = input === undefined ? undefined : requireInput(input, "deliver input");
    const message = optionalNonblank(values?.message, "deliver message");
    const actor = actorOption(values?.actor);
    const state = readStateOperation({ scope: this.scope, contractId: this.id });
    const derivation = state === null
      ? undefined
      : documentDerivation(decodeContractDocument(state.terms.document.bytes), state.terms.gates, state.id);
    return mapOutcome(
      await deliverOperation({
        scope: this.scope,
        contractId: this.id,
        ...(derivation === undefined ? {} : { derivation }),
        ...actor,
        ...(message === undefined ? {} : { message }),
      }),
      (delivery) => this.deliveryHandle(delivery),
    );
  }

  async review(input: ReviewInput): Promise<Outcome<Review>> {
    const values = requireInput(input, "review input");
    const verdict = values.verdict;
    if (verdict !== "satisfied" && verdict !== "unsatisfied") {
      throw new TypeError("verdict must be satisfied or unsatisfied");
    }
    const summary = optionalNonblank(values.summary, "review summary");
    return mapOutcome(reviewOperation({
      scope: this.scope,
      contractId: this.id,
      verdict,
      ...(summary === undefined ? {} : { summary }),
      ...actorOption(values.actor),
    }), (value) => value);
  }

  async abandon(input?: AbandonInput): Promise<Outcome<void>> {
    const values = input === undefined ? undefined : requireInput(input, "abandon input");
    const note = optionalNonblank(values?.note, "abandon note");
    return mapOutcome(abandonOperation({
      scope: this.scope,
      contractId: this.id,
      ...actorOption(values?.actor),
      ...(note === undefined ? {} : { note }),
    }), () => undefined);
  }

  async arc(input: ArcInput): Promise<Outcome<void>> {
    const values = requireInput(input, "arc input");
    const chapter = decodeArcDocument(requireMarkdown(values.markdown));
    return mapOutcome(arcOperation({
      scope: this.scope,
      contractId: this.id,
      ...actorOption(values.actor),
      chapter,
    }), () => undefined);
  }

  async audit(input?: AuditInput): Promise<Outcome<AuditReport>> {
    const values = input === undefined ? undefined : requireInput(input, "audit input");
    const actor = actorOption(values?.actor);
    const state = readStateOperation({ scope: this.scope, contractId: this.id });
    const derivation = state === null
      ? undefined
      : documentDerivation(decodeContractDocument(state.terms.document.bytes), state.terms.gates, state.id);
    return mapOutcome(
      await auditOperation({
        scope: this.scope,
        contractId: this.id,
        ...(derivation === undefined ? {} : { derivation }),
        ...actor,
      }),
      (report) => report,
    );
  }

  async reconcile(): Promise<ReconcileReport> {
    return reconcileOperation({ scope: this.scope, contractId: this.id });
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

  async reconcile(): Promise<RepoReconcileReport> {
    return reconcileAllOperation({ scope: scopeForRepo(this) });
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
    verification: prepareVerificationDeclaration({
      gates: terms.gates,
      definition: verificationDefinition(document),
    }),
    workspace,
    ...(target === undefined ? {} : { target }),
    ...actor,
  });
  const outcome = mapOutcome(admitted, ({ contractId: id }) => new KeiyakuHandle(id, scope));
  if (outcome.kind !== "accepted") return outcome;
  if (admitted.kind !== "accepted") throw new Error("accepted bind is missing its contract identity");
  return { ...outcome, ...observeRegion(scope, admitted.value.contractId, document.region) };
}

export const Keiyaku = Object.freeze({
  ...handleType(KeiyakuHandle.prototype, (value) => value instanceof KeiyakuHandle),
  bind: bindKeiyaku,
  list: listKeiyaku,
  observe: observeKeiyaku,
  of: keiyakuOf,
});
