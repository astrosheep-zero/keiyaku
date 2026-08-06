import { applyAmendOperations } from "../body/amend.js";
import { decodeArcDocument } from "../body/arc.js";
import { decodeContractDocument } from "../body/decode.js";
import { renderContractBody } from "../body/render.js";
import { validateContractBody } from "../core/facts/codec.js";
import { effectiveGates as resolveEffectiveGates } from "../core/facts/gate.js";
import {
  contractId,
  actorId,
  type ActorId as CoreActorId,
  type ArcData,
  type ChangeId,
  type ContractBody as ContractBodyValue,
  type ContractId,
  type ContractState,
  type Gate,
  type JournalEntry,
  type SnapshotId,
  type SubjectKey,
} from "../core/facts/types.js";
import {
  abandonOperation,
  amendOperation,
  arcOperation,
  auditOperation,
  bindOperation,
  deliveryDiffOperation,
  deliverOperation,
  deliveryOperation,
  readStateOperation,
  reconcileAllOperation,
  reconcileOperation,
  reviewOperation,
  scopeOperation,
  stateOperation,
  statusOperation,
  worktreePathOperation,
  type AuditReport,
  type ContractStatus,
  type FactKind,
  type IntentOutcome,
  type IntentRefusal,
  type IntentRetry,
  type RepoReconcileReport,
  type ReconcileReport as ProtocolReconcileReport,
  type RepositoryScope,
  type StatusReport,
  type TimelineEntry,
} from "../protocol/operations.js";

export type {
  AuditReport,
  ChangeId,
  ContractId,
  ContractState,
  ContractStatus,
  FactKind,
  Gate,
  RepoReconcileReport,
  SnapshotId,
  StatusReport,
  TimelineEntry,
};

export type ContractBody = ContractBodyValue;
export type Fact = JournalEntry;
export type ActorId = string;
export type AttestationVerdict = "satisfied" | "unsatisfied";
export type ArcChapter = ArcData;
export type TypedRefusal = IntentRefusal;
export type TypedRetry = IntentRetry;

export type Receipt = Readonly<{
  facts: readonly Fact[];
  prior: ContractState | null;
  snapshot: ContractState;
}>;

export type Outcome<A> =
  | Readonly<{ kind: "accepted"; receipt: Receipt; value: A }>
  | Readonly<{ kind: "refused"; refusal: TypedRefusal }>
  | Readonly<{ kind: "retry"; reason: TypedRetry }>;

export type BindResult = Outcome<Keiyaku>;
export type ReconcileReport = ProtocolReconcileReport;

export type BindInput = Readonly<{
  markdown: string;
  repo?: string;
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
export type KeiyakuOfInput = Readonly<{ id: ContractId; repo?: string }>;
export type RepoAtInput = Readonly<{ path?: string }>;
export type ContractBodyRenderInput = Readonly<{ body: ContractBody; currentArc?: ArcChapter }>;
export type ReviewInput = ActorOptions & Readonly<{ verdict: AttestationVerdict; summary?: string }>;
export type AbandonInput = ActorOptions & Readonly<{ note?: string }>;
export type DeliverInput = ActorOptions;
export type AuditInput = ActorOptions;

export const ContractBody = Object.freeze({
  render(input: ContractBodyRenderInput): string {
    const values = requireInput(input, "ContractBody.render input");
    return renderContractBody(values.body as ContractBody, values.currentArc as ArcChapter | undefined);
  },
});

function actorOption(actor: ActorId | undefined): Readonly<{ actor?: CoreActorId }> {
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

function requireInput(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalNonblank(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a nonblank string`);
  }
  return value;
}

function optionalRepository(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new TypeError("repository path must be a nonempty string");
  return value;
}

function normalizedAfter(values: readonly ContractId[] | undefined): readonly ContractId[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new TypeError("after must be an array");
  return values.map((value, index) => {
    if (typeof value !== "string") throw new TypeError(`after[${index}] must be a string`);
    try {
      return contractId(value);
    } catch (error) {
      throw new TypeError(error instanceof Error ? error.message : `after[${index}] is invalid`);
    }
  });
}

function normalizedGates(values: readonly Gate[] | undefined): readonly Gate[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) throw new TypeError("gates must be an array");
  return values.map((value, index) => {
    if (value !== "reviewed" && value !== "verified") {
      throw new TypeError(`gates[${index}] must be reviewed or verified`);
    }
    return value;
  });
}

function structuredBody(
  body: ContractBodyValue,
  gates: readonly Gate[] | undefined,
  after: readonly ContractId[] | undefined,
): ContractBodyValue {
  const declaredGates = normalizedGates(gates);
  const declaredBody: ContractBodyValue = {
    ...body,
    ...(declaredGates === undefined ? {} : { gates: declaredGates }),
  };
  return {
    ...declaredBody,
    gates: resolveEffectiveGates(declaredBody),
    after: after === undefined
      ? []
      : normalizedAfter(after),
  };
}

function mapOutcome<Value, PublicValue>(
  result: IntentOutcome<Value>,
  value: (result: Value) => PublicValue,
): Outcome<PublicValue> {
  if (result.kind === "refused") return { kind: "refused", refusal: result.refusal };
  if (result.kind === "retry") return { kind: "retry", reason: result.reason };
  return {
    kind: "accepted",
    receipt: Object.freeze({
      facts: Object.freeze([...result.receipt.facts]),
      prior: result.receipt.prior,
      snapshot: result.receipt.snapshot,
    }),
    value: value(result.value),
  };
}

type PinnedScope = RepositoryScope;

function resolvePinnedScope(path?: string): PinnedScope {
  const coordinate = path === undefined ? process.cwd() : path;
  if (typeof coordinate !== "string" || coordinate.length === 0) {
    throw new TypeError("repository path must be a nonempty string");
  }
  return scopeOperation({ coordinate });
}

class DeliveryHandle {
  readonly snapshotId: SnapshotId;
  readonly changeId: ChangeId;

  constructor(
    snapshotId: SnapshotId,
    changeId: ChangeId,
    private readonly readDiff: () => Promise<string | null>,
    private readonly reviewDelivery: (input: ReviewInput) => Promise<Outcome<void>>,
  ) {
    this.snapshotId = snapshotId;
    this.changeId = changeId;
  }

  review(input: ReviewInput): Promise<Outcome<void>> {
    const values = requireInput(input, "review input");
    const verdict = values.verdict as AttestationVerdict;
    if (verdict !== "satisfied" && verdict !== "unsatisfied") {
      throw new TypeError("verdict must be satisfied or unsatisfied");
    }
    return this.reviewDelivery({
      verdict,
      ...(values.actor === undefined ? {} : { actor: values.actor as ActorId }),
      ...(values.summary === undefined ? {} : { summary: values.summary as string }),
    });
  }

  diff(): Promise<string | null> {
    return this.readDiff();
  }
}

export type Delivery = DeliveryHandle;
type DeliveryObject = Readonly<{ prototype: DeliveryHandle }>;
export const Delivery: DeliveryObject = DeliveryHandle;

export class Keiyaku {
  private constructor(
    private readonly id: ContractId,
    private readonly scope: PinnedScope,
  ) {}

  static async bind(input: BindInput): Promise<BindResult> {
    const values = requireInput(input, "bind input");
    const markdown = requireMarkdown(values.markdown);
    const scope = resolvePinnedScope(optionalRepository(values.repo));
    const body = decodeContractDocument(markdown);
    const workspace = values.workspace === undefined ? "worktree" : values.workspace;
    if (workspace !== "worktree" && workspace !== "here") throw new TypeError("workspace must be worktree or here");
    const target = optionalNonblank(values.target as string | undefined, "target");
    const actor = actorOption(values.actor as ActorId | undefined);
    const structured = structuredBody(body, values.gates as readonly Gate[] | undefined, values.after as readonly ContractId[] | undefined);
    return mapOutcome(
      bindOperation({
        scope,
        body: validateContractBody(structured),
        workspace,
        ...(target === undefined ? {} : { target }),
        ...actor,
      }),
      ({ contractId: id }) => Keiyaku.#create(id, scope),
    );
  }

  static of(input: KeiyakuOfInput): Keiyaku {
    const values = requireInput(input, "Keiyaku.of input");
    if (typeof values.id !== "string") throw new TypeError("contract ID must be a string");
    const identity = contractId(values.id);
    const scope = resolvePinnedScope(optionalRepository(values?.repo));
    return Keiyaku.#create(identity, scope);
  }

  get worktreePath(): string | null {
    return worktreePathOperation({ scope: this.scope, contractId: this.id });
  }

  async state(): Promise<ContractState> {
    return stateOperation({ scope: this.scope, contractId: this.id });
  }

  async delivery(): Promise<Delivery | null> {
    const delivery = deliveryOperation({ scope: this.scope, contractId: this.id });
    return delivery === null
      ? null
      : this.deliveryHandle(delivery.snapshotId, delivery.changeId, delivery.expectedPredecessor, delivery.reviewSubject);
  }

  async amend(input: AmendInput): Promise<Outcome<void>> {
    const values = requireInput(input, "amend input");
    const markdown = requireMarkdown(values.markdown);
    const current = readStateOperation({ scope: this.scope, contractId: this.id });
    if (current === null) return { kind: "refused", refusal: { kind: "contract-missing", contractId: this.id } };
    if (current.body === null) throw new Error(`contract body is absent: ${this.id}`);
    const body = applyAmendOperations(markdown, current.body);
    const gates = values.gates === undefined ? current.body.gates : values.gates as readonly Gate[];
    const after = values.after === undefined ? current.body.after : values.after as readonly ContractId[];
    const amended = structuredBody(body, gates, after);
    return mapOutcome(amendOperation({
      scope: this.scope,
      contractId: this.id,
      ...actorOption(values.actor as ActorId | undefined),
      body: validateContractBody(amended),
    }), () => undefined);
  }

  async deliver(input?: DeliverInput): Promise<Outcome<Delivery>> {
    const values = input === undefined ? undefined : requireInput(input, "deliver input");
    return mapOutcome(
      await deliverOperation({ scope: this.scope, contractId: this.id, ...actorOption(values?.actor as ActorId | undefined) }),
      (delivery) => this.deliveryHandle(delivery.snapshotId, delivery.changeId, delivery.expectedPredecessor, delivery.reviewSubject),
    );
  }

  async abandon(input?: AbandonInput): Promise<Outcome<void>> {
    const values = input === undefined ? undefined : requireInput(input, "abandon input");
    const note = optionalNonblank(values?.note as string | undefined, "abandon note");
    return mapOutcome(abandonOperation({
      scope: this.scope,
      contractId: this.id,
      ...actorOption(values?.actor as ActorId | undefined),
      ...(note === undefined ? {} : { note }),
    }), () => undefined);
  }

  async arc(input: ArcInput): Promise<Outcome<void>> {
    const values = requireInput(input, "arc input");
    const chapter = decodeArcDocument(requireMarkdown(values.markdown));
    return mapOutcome(arcOperation({
      scope: this.scope,
      contractId: this.id,
      ...actorOption(values.actor as ActorId | undefined),
      chapter,
    }), () => undefined);
  }

  async audit(input?: AuditInput): Promise<Outcome<AuditReport>> {
    const values = input === undefined ? undefined : requireInput(input, "audit input");
    return mapOutcome(
      await auditOperation({ scope: this.scope, contractId: this.id, ...actorOption(values?.actor as ActorId | undefined) }),
      (report) => report,
    );
  }

  async reconcile(): Promise<ReconcileReport> {
    return reconcileOperation({ scope: this.scope, contractId: this.id });
  }

  private deliveryHandle(
    snapshotId: SnapshotId,
    changeId: ChangeId,
    expectedPredecessor: SnapshotId,
    reviewSubject: SubjectKey,
  ): Delivery {
    return new DeliveryHandle(
      snapshotId,
      changeId,
      () => deliveryDiffOperation({ scope: this.scope, expectedPredecessor, snapshotId }),
      (input) => this.review(reviewSubject, input),
    );
  }

  static #create(id: ContractId, scope: PinnedScope): Keiyaku {
    return new Keiyaku(id, scope);
  }

  private async review(subject: SubjectKey, input: ReviewInput): Promise<Outcome<void>> {
    const summary = optionalNonblank(input.summary, "review summary");
    return mapOutcome(reviewOperation({
      scope: this.scope,
      contractId: this.id,
      data: {
        gate: "reviewed",
        subject,
        verdict: input.verdict,
        ...(summary === undefined ? {} : { summary }),
      },
      ...actorOption(input.actor),
    }), () => undefined);
  }
}

export class Repo {
  readonly root: string;

  private constructor(private readonly scope: PinnedScope) {
    this.root = scope.primaryWorktree;
  }

  static at(input?: RepoAtInput): Repo {
    const values = input === undefined ? undefined : requireInput(input, "Repo.at input");
    const scope = resolvePinnedScope(optionalRepository(values?.path));
    return new Repo(scope);
  }

  async status(): Promise<StatusReport> {
    return statusOperation({ scope: this.scope });
  }

  async reconcile(): Promise<RepoReconcileReport> {
    return reconcileAllOperation({ scope: this.scope });
  }
}
