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
  optionalBoolean,
  optionalNonblank,
  rejectUnknownFields,
  requireInput,
  requireMarkdown,
} from "./input.js";
import { observeRegion, type RegionObservation, type RegionOverlap } from "./region.js";
import { type Gate, type WorktreeHooks, worktreeHooksOption } from "./configuration.js";
import {
  contractId,
  type ChangeId,
  type ContractHead,
  type ContractId,
  type ContractState,
  type SnapshotId,
} from "../core/facts/types.js";
export { AuthorityCorruptionError } from "../core/facts/errors.js";
import {
  abandonOperation,
  amendOperation,
  arcOperation,
  auditOperation,
  bindOperation,
  contractObservationOperation,
  contractsOperation,
  deliveryDiffOperation,
  deliverOperation,
  deliveryOperation,
  readStateOperation,
  reconcileOperation,
  reviewOperation,
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
  type ReconcileReport as ProtocolReconcileReport,
  type RepositoryScope,
  type TimelineEntry,
} from "../protocol/operations.js";
import { deferredTaskHolderSettlement, settle, type SettlementReport } from "../settlement/settle.js";
import {
  claimTaskHolder,
  claimTaskHolderWithFence,
  releaseTaskHolder,
  releaseTaskHolderWithFence,
  type TaskHolderAdmission,
} from "../settlement/holder.js";
import { parseTaskId, type TaskId } from "../task/identity.js";
import { Repo, reconcileInput, scopeForRepo, type ReconcileInput } from "./repo.js";
import {
  deliveryHandle,
  KeiyakuRefused,
  KeiyakuRetry,
  type ActorId,
  type AttestationVerdict,
  type Delivery,
  type Fact,
  type KeiyakuRefusal,
  type MutationResult,
  type Review,
} from "./contract-values.js";
export { Delivery, KeiyakuRefused, KeiyakuRetry } from "./contract-values.js";
export type {
  ActorId,
  AttestationVerdict,
  Fact,
  KeiyakuRefusal,
  KeiyakuRetryReason,
  Lag,
  MutationResult,
  PlacementStop,
  Review,
  TopologyEffect,
  VerificationStop,
} from "./contract-values.js";
export { gatesFrom, requireBranchesToBeUpToDateFrom, SettingsError, worktreeHooksFrom } from "./configuration.js";
export type { Gate, GatesFromInput, HookCommand, RequireBranchesToBeUpToDateFromInput, WorktreeHooks, WorktreeHooksFromInput } from "./configuration.js";

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
export type { TaskId };
export type { RegionOverlap };

export type BindResult = Readonly<Omit<MutationResult<Keiyaku>, "value"> & { keiyaku: Keiyaku } & RegionObservation>;
export type AmendResult = Readonly<MutationResult<void> & RegionObservation & { documentDiff: string }>;
export type ReconcileReport = Readonly<ProtocolReconcileReport & { settlement: SettlementReport }>;
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
  markdown: string;
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
  message?: string;
  requireBranchesToBeUpToDate?: boolean;
  includeDirty?: boolean;
}>;
export type AuditInput = ActorOptions;

type AcceptedIntent<Value> = Readonly<{
  kind: "accepted";
  facts: readonly Fact[];
  head: ContractHead;
  value: Value;
  physical?: ProtocolReconcileReport;
}>;

function requireAccepted<Value, Refusal extends KeiyakuRefusal>(result: IntentOutcome<Value, Refusal>): AcceptedIntent<Value> {
  if (result.kind === "refused") throw new KeiyakuRefused(result.refusal);
  if (result.kind === "retry") throw new KeiyakuRetry(result.reason);
  return result;
}

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

function contractIdOption(value: unknown): ContractId {
  if (typeof value !== "string") throw new TypeError("contract ID must be a string");
  try {
    return contractId(value);
  } catch (error) {
    throw new TypeError(error instanceof Error ? error.message : "contract ID is invalid");
  }
}

async function mutationResult<Value, PublicValue>(
  scope: RepositoryScope,
  id: ContractId,
  accepted: AcceptedIntent<Value>,
  value: (result: Value) => PublicValue,
  hooks: WorktreeHooks,
): Promise<MutationResult<PublicValue>> {
  const reconciled = await reconcileOperation({ scope, contractId: id, hooks, retryHooks: false });
  const settlement = await settle({ repository: scope, state: reconciled.state, effects: reconciled.report.effects });
  return {
    facts: accepted.facts,
    head: accepted.head,
    value: value(accepted.value),
    effects: [...(accepted.physical?.effects ?? []), ...reconciled.report.effects],
    lags: [...(accepted.physical?.lag ?? []), ...reconciled.report.lag],
    settlement,
  };
}
async function holderMutationResult<Value, PublicValue, Refusal extends KeiyakuRefusal>(
  scope: RepositoryScope,
  id: ContractId,
  admission: TaskHolderAdmission<IntentOutcome<Value, Refusal>>,
  value: (result: Value) => PublicValue,
  hooks: WorktreeHooks,
): Promise<MutationResult<PublicValue>> {
  const accepted = requireAccepted(admission.result);
  if (admission.kind === "completed") return mutationResult(scope, id, accepted, value, hooks);
  return {
    facts: accepted.facts,
    head: accepted.head,
    value: value(accepted.value),
    effects: [...(accepted.physical?.effects ?? [])],
    lags: [...(accepted.physical?.lag ?? [])],
    settlement: deferredTaskHolderSettlement({ contractId: id, taskId: admission.taskId, diagnostic: admission.diagnostic }),
  };
}

export class KeiyakuHandle {
  constructor(
    private readonly id: ContractId,
    private readonly scope: RepositoryScope,
  ) {
    KEIYAKU_SEATS.set(this, { id, scope });
  }

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
    const hooks = worktreeHooksOption(values.hooks);
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
      ...await mutationResult(this.scope, this.id, accepted, () => undefined, hooks),
      documentDiff: documentDiff("before", "after", before, after),
      ...await observeRegion(this.scope, this.id, document.region),
    };
  }

  async deliver(input?: DeliverInput): Promise<MutationResult<Delivery>> {
    const values = input === undefined ? undefined : requireInput(input, "deliver input");
    const hooks = worktreeHooksOption(values?.hooks);
    const message = optionalNonblank(values?.message, "deliver message");
    const requireBranchesToBeUpToDate = optionalBoolean(values?.requireBranchesToBeUpToDate, "requireBranchesToBeUpToDate");
    const includeDirty = optionalBoolean(values?.includeDirty, "includeDirty");
    const actor = actorOption(values?.actor);
    const accepted = requireAccepted(
      await deliverOperation({
        scope: this.scope,
        contractId: this.id,
        ...actor,
        ...this.currentDerivationOption(),
        ...(message === undefined ? {} : { message }),
        requireBranchesToBeUpToDate: requireBranchesToBeUpToDate ?? false,
        includeDirty: includeDirty ?? false,
      }),
    );
    return mutationResult(this.scope, this.id, accepted, (delivery) => this.deliveryHandle(delivery), hooks);
  }

  async review(input: ReviewInput): Promise<MutationResult<Review>> {
    const values = requireInput(input, "review input");
    const hooks = worktreeHooksOption(values.hooks);
    const verdict = values.verdict;
    if (verdict !== "satisfied" && verdict !== "unsatisfied") {
      throw new TypeError("verdict must be satisfied or unsatisfied");
    }
    const summary = optionalNonblank(values.summary, "review summary");
    const accepted = requireAccepted(await reviewOperation({
      scope: this.scope,
      contractId: this.id,
      verdict,
      ...(summary === undefined ? {} : { summary }),
      ...actorOption(values.actor),
    }));
    return mutationResult(this.scope, this.id, accepted, (value) => value, hooks);
  }

  async abandon(input?: AbandonInput): Promise<MutationResult<void>> {
    const values = input === undefined ? undefined : requireInput(input, "abandon input");
    const hooks = worktreeHooksOption(values?.hooks);
    const note = optionalNonblank(values?.note, "abandon note");
    const admission = await releaseTaskHolderWithFence(this.scope, this.id, () => abandonOperation({
      scope: this.scope,
      contractId: this.id,
      ...actorOption(values?.actor),
      ...(note === undefined ? {} : { note }),
      decorateOffer: ({ repository, observation, contractId: owner }) => {
        const companion = releaseTaskHolder(repository, observation.admission.snapshot, owner);
        return companion === null ? [] : [companion];
      },
    }));
    return holderMutationResult(this.scope, this.id, admission, () => undefined, hooks);
  }

  async arc(input: ArcInput): Promise<MutationResult<void>> {
    const values = requireInput(input, "arc input");
    const hooks = worktreeHooksOption(values.hooks);
    const chapter = decodeArcDocument(requireMarkdown(values.markdown));
    const accepted = requireAccepted(arcOperation({
      scope: this.scope,
      contractId: this.id,
      ...actorOption(values.actor),
      chapter,
    }));
    return mutationResult(this.scope, this.id, accepted, () => undefined, hooks);
  }

  async audit(input?: AuditInput): Promise<MutationResult<AuditReport>> {
    const values = input === undefined ? undefined : requireInput(input, "audit input");
    const hooks = worktreeHooksOption(values?.hooks);
    const actor = actorOption(values?.actor);
    const accepted = requireAccepted(
      await auditOperation({
        scope: this.scope,
        contractId: this.id,
        ...this.currentDerivationOption(),
        ...actor,
      }),
    );
    return mutationResult(this.scope, this.id, accepted, (report) => report, hooks);
  }

  async reconcile(input?: ReconcileInput): Promise<ReconcileReport> {
    const options = reconcileInput(input);
    const reconciled = await reconcileOperation({ scope: this.scope, contractId: this.id, ...options });
    return {
      ...reconciled.report,
      settlement: await settle({ repository: this.scope, state: reconciled.state, effects: reconciled.report.effects }),
    };
  }

  private deliveryHandle(delivery: DeliverValue): Delivery {
    return deliveryHandle(
      delivery,
      () => deliveryDiffOperation({
        scope: this.scope,
        integrationPredecessor: delivery.integration.predecessor,
        integrationSnapshot: delivery.integration.snapshot,
      }),
      delivery,
    );
  }

  private currentDerivationOption(): Readonly<{ derivation?: ReturnType<typeof documentDerivation> }> {
    const state = readStateOperation({ scope: this.scope, contractId: this.id });
    return state === null
      ? {}
      : { derivation: documentDerivation(decodeContractDocument(state.terms.document.bytes), state.terms.gates, state.id) };
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
  return new KeiyakuHandle(contractIdOption(values.id), scope);
}

export async function listKeiyaku(input: ContractListInput): Promise<ContractBoard> {
  const values = requireInput(input, "Keiyaku.list input");
  rejectUnknownFields(values, ["repo"], "Keiyaku.list input");
  return await contractsOperation({ scope: scopeForRepo(values.repo) });
}

export async function observeKeiyaku(input: ContractObservationInput): Promise<ContractObservation> {
  const values = requireInput(input, "Keiyaku.observe input");
  rejectUnknownFields(values, ["repo", "id"], "Keiyaku.observe input");
  const scope = scopeForRepo(values.repo);
  return contractObservationOperation({ scope, contractId: contractIdOption(values.id) });
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
  const bind = () => bindOperation({
    scope,
    title: document.title,
    terms,
    verification: documentDerivation(document, terms.gates).verification,
    workspace,
    ...(target === undefined ? {} : { target }),
    ...(task === undefined ? {} : {
      decorateOffer: ({ contractId: owner }) => [claimTaskHolder(task, owner)],
    }),
    ...actor,
  });
  const admission = task === undefined ? null : await claimTaskHolderWithFence(scope, task, bind);
  const accepted = requireAccepted(admission === null ? bind() : admission.result);
  const id = accepted.value.contractId;
  const toHandle = ({ contractId: contract }: { contractId: ContractId }): Keiyaku => new KeiyakuHandle(contract, scope);
  const result = admission === null
    ? await mutationResult(scope, id, accepted, toHandle, hooks)
    : await holderMutationResult(scope, id, admission, toHandle, hooks);
  return {
    facts: result.facts,
    head: result.head,
    keiyaku: result.value,
    effects: result.effects,
    lags: result.lags,
    settlement: result.settlement,
    ...await observeRegion(scope, id, document.region),
  };
}
