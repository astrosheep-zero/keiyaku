/** @architectureCompositionRoot */
import { z } from "zod";
import { contractFileLagSchema } from "../contract-worktree.js";
import type { ContractId, JournalEntry, SnapshotId } from "../core/facts/types.js";
import { decodeJournal, encodeEntry } from "../core/facts/codec.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { reconcileEffectSchema, gitReconcileLagSchema } from "../git/reconcile.js";
import { contractIdSchema, snapshotIdSchema } from "../git/identity.js";
import { placementOutcome, placedSchema, placementSchema } from "../protocol/completion.js";
import { compactDelivery, deliveryIdentitySchema } from "../protocol/result-leaves.js";
import { verificationAdmissionOutcome } from "../protocol/verify.js";
import { publicationKey } from "../protocol/progress.js";

import type { WorldRoot } from "../world.js";
import type { ResetCounts, ResetIssue } from "./nuke.js";
import type { ContinuationReport } from "./continuation.js";
import type { ReviewOutcome, VerifyOutcome } from "./contract-outcomes.js";
import type { SpawnResult } from "./akuma-creation.js";
import { KeiyakuError, errorCategory, type KeiyakuErrorCategory, type NextCall } from "../errors.js";
import { SettingsError } from "../settings.js";
export { KeiyakuError, errorCategory } from "../errors.js";
import type { AkumaTellResult } from "../akuma/selection-observation.js";
import type { InvocationSnapshot } from "./invocation.js";
import { retrySchema, executionIssueSchema } from "../protocol/result-reasons.js";
export { executionIssueSchema } from "../protocol/result-reasons.js";

export type ContractVerb = "bind" | "amend" | "deliver" | "verify" | "review" | "deliver-preview" | "arc" | "abandon";

// Raw physical reports stay in the invocation's private custody. Only actionable leaves cross
// the result boundary; the same owner classification is used by reconcile and mutation results.
export type ReconciliationEffect = z.output<typeof reconcileEffectSchema>;
export const reconciliationLagSchema = z.union([gitReconcileLagSchema, contractFileLagSchema]);
export type ReconciliationLag = z.output<typeof reconciliationLagSchema>;
export type ReconcileLagScope = "none" | "reconciliation" | "placement" | "continuation";
function classifyReconcileLag(
  kind: ReconciliationLag["kind"],
): Readonly<{ scope: ReconcileLagScope; failure: boolean }> {
  switch (kind) {
    case "worktree-retained":
    case "unsealed-bytes":
      return { scope: "none", failure: false };
    case "worktree-follow-retained":
      return { scope: "continuation", failure: false };
    case "target-checkout-retained":
    case "target-workspace-retained":
      return { scope: "placement", failure: true };
    case "worktree-hook-failed":
    case "reconcile-failed":
    case "contract-file-failed":
      return { scope: "reconciliation", failure: true };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
export function reconcileLagScope(lag: ReconciliationLag): ReconcileLagScope {
  return classifyReconcileLag(lag.kind).scope;
}
export function reconcileLagIsFailure(lag: ReconciliationLag): boolean {
  return classifyReconcileLag(lag.kind).failure;
}

const scoped = { contractId: contractIdSchema.exactOptional() };
const diagnostic = z.string().min(1);
const path = z.string().min(1);
const severity = z.enum(["required", "optional"]);
export const reconcileIssueSchema = z.union([
  ...gitReconcileLagSchema.options.map((schema) =>
    schema
      .unwrap()
      .extend({ ...scoped, severity })
      .readonly(),
  ),
  contractFileLagSchema
    .unwrap()
    .extend({ ...scoped, severity })
    .readonly(),
]);
const resourceDiagnosticSchema = z
  .strictObject({
    ...scoped,
    kind: z.literal("diagnostic"),
    severity,
    diagnostic,
    snapshot: snapshotIdSchema.exactOptional(),
    requirement: z.string().min(1).exactOptional(),
    index: z.number().int().positive().exactOptional(),
    name: diagnostic.exactOptional(),
    path: path.exactOptional(),
  })
  .readonly();

const settlementIssueSchema = z
  .strictObject({
    ...scoped,
    kind: z.literal("settlement-failed"),
    severity: z.literal("required"),
    debtId: z.string().min(1).exactOptional(),
    diagnostic,
  })
  .readonly();
const executionIssue = executionIssueSchema
  .unwrap()
  .extend({ ...scoped, severity: z.literal("required") })
  .readonly();
const localReconcileLeaves = reconcileIssueSchema.options.filter(
  (schema): schema is Exclude<typeof schema, z.ZodType<{ kind: "worktree-follow-retained" }>> =>
    schema.unwrap().shape.kind.value !== "worktree-follow-retained",
);
export const invocationIssueSchema = z
  .union([...reconcileIssueSchema.options, resourceDiagnosticSchema, executionIssue, settlementIssueSchema])
  .meta({ id: "contractIssue" });
export type InvocationIssue = z.output<typeof invocationIssueSchema>;
export const localIssueSchema = z.union([
  ...localReconcileLeaves,
  resourceDiagnosticSchema,
  executionIssue,
  settlementIssueSchema,
]);
const optionalSeverity = { severity: z.literal("optional") };
const optionalResourceIssue = resourceDiagnosticSchema.unwrap().extend(optionalSeverity).readonly();
export const optionalInvocationIssueSchema = z.union([
  ...reconcileIssueSchema.options
    .filter((schema) => !reconcileLagIsFailure({ kind: schema.unwrap().shape.kind.value } as ReconciliationLag))
    .map((schema) => schema.unwrap().extend(optionalSeverity).readonly()),
  optionalResourceIssue,
]);
export const optionalLocalIssueSchema = z.union([
  ...localReconcileLeaves
    .filter((schema) => !reconcileLagIsFailure({ kind: schema.unwrap().shape.kind.value } as ReconciliationLag))
    .map((schema) => schema.unwrap().extend(optionalSeverity).readonly()),
  optionalResourceIssue,
]);
export const previewIssueSchema = resourceDiagnosticSchema.unwrap().omit({ contractId: true }).readonly();
export const reconcilePublicIssueSchema = z
  .union([...localReconcileLeaves, resourceDiagnosticSchema, settlementIssueSchema])
  .meta({ id: "reconcileIssue" });

export function invocationIssueIsFailure(issue: InvocationIssue): boolean {
  return issue.severity === "required";
}

/** Invocation classification consumes owner conclusions, never a fresh authority read. */
export function contractOutcomeDisposition(
  result: Readonly<{
    kind: string;
    issues?: readonly InvocationIssue[];
    placement?: z.output<typeof placementSchema> | Omit<z.output<typeof placedSchema>, "integration">;
    checks?: readonly import("../protocol/verify.js").VerificationCheck[];
    continuation?: ContinuationReport;
  }>,
): "accepted" | "unsatisfied" | "refused" | "retryable" | "failed" {
  if (result.kind === "refused") return "refused";
  if (result.kind === "retry") return "retryable";
  let retry = false;
  let unsatisfied = false;
  const stopped = (outcome: "benign" | "retry" | "failed"): boolean => {
    if (outcome === "retry") retry = true;
    return outcome === "failed";
  };
  if (result.issues?.some(invocationIssueIsFailure)) return "failed";
  if (result.placement !== undefined && stopped(placementOutcome(result.placement))) return "failed";
  for (const check of result.checks ?? []) {
    if (check.kind !== "terminal") return "failed";
    if (stopped(verificationAdmissionOutcome(check.admission))) return "failed";
    if (check.verdict === "unsatisfied") unsatisfied = true;
  }
  for (const { stop } of result.continuation?.stopped ?? []) if (stopped(placementOutcome(stop))) return "failed";
  return retry ? "retryable" : unsatisfied ? "unsatisfied" : "accepted";
}

/** Internal accumulator carrier, not a published operation answer. */
export type InvocationEffect =
  | Readonly<{ kind: "issue"; contract: ContractId; issue: InvocationIssue }>
  | Readonly<{ kind: "movement"; contract: ContractId; effect: MovementEffect }>;

export const admittedEvidenceSchema = z.union([
  z.strictObject({ kind: z.enum(["bind", "amend", "claimed", "abandoned"]), ...scoped }).readonly(),
  z
    .strictObject({
      kind: z.literal("deliver"),
      ...scoped,
      ...deliveryIdentitySchema.unwrap().pick({ candidate: true, integration: true, admission: true }).shape,
      contentId: z.string().min(1),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("reintegrated"),
      ...scoped,
      integration: snapshotIdSchema,
      predecessor: snapshotIdSchema,
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("attestation"),
      ...scoped,
      requirement: z.string().exactOptional(),
      verdict: z.enum(["satisfied", "unsatisfied"]).exactOptional(),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("arc"),
      ...scoped,
      chapter: z.number().int().positive(),
    })
    .readonly(),
]);
export const meaningfulEffectSchema = z.union([
  z.strictObject({ kind: z.enum(["worktree-created", "worktree-removed"]), path }).readonly(),
  z
    .strictObject({ kind: z.literal("worktree-followed"), path, before: snapshotIdSchema, after: snapshotIdSchema })
    .readonly(),
  z.strictObject({ kind: z.literal("recovery-snapshot"), snapshot: snapshotIdSchema }).readonly(),
  z.strictObject({ kind: z.literal("target-checkout"), path, target: z.string().min(1) }).readonly(),
  z
    .strictObject({
      kind: z.literal("ref"),
      name: z.string().min(1),
      before: z.string().nullable(),
      after: z.string().nullable(),
    })
    .readonly(),
  z.strictObject({ kind: z.literal("debt-settled"), debtId: z.string().min(1) }).readonly(),
]);
export type MovementEffect = z.output<typeof meaningfulEffectSchema>;
export function compactEffect(effect: ReconciliationEffect): MovementEffect | undefined {
  switch (effect.kind) {
    case "worktree":
      if (effect.action === "unchanged") return undefined;
      if (effect.action === "followed")
        return { kind: "worktree-followed", path: effect.path, before: effect.before, after: effect.after };
      return { kind: effect.action === "created" ? "worktree-created" : "worktree-removed", path: effect.path };
    case "ref":
      return effect.before === effect.after
        ? undefined
        : { kind: "ref", name: effect.name, before: effect.before, after: effect.after };
    case "target-checkout":
      return { kind: effect.kind, path: effect.path, target: effect.target };
    case "recovery-snapshot":
      return { kind: effect.kind, snapshot: effect.snapshot };
  }
}
export const recoverySnapshotSchema = z.strictObject({ ...scoped, snapshot: snapshotIdSchema }).readonly();
const exceptionalEffectSchema = z.union([
  ...meaningfulEffectSchema.options.map((schema) => schema.unwrap().extend(scoped).readonly()),
  placedSchema.unwrap().extend(scoped).readonly(),
]);
type AdmissionEvidence = z.output<typeof admittedEvidenceSchema>;

export function acceptedOutcomeSchema<Fields extends z.ZodRawShape, Issues extends z.ZodType>(
  fields: Fields,
  issues: Issues,
) {
  return z
    .strictObject({
      kind: z.literal("accepted"),
      contractId: contractIdSchema,
      issues: z.array(issues).min(1).readonly().exactOptional(),
      recoverySnapshots: z.array(recoverySnapshotSchema).min(1).readonly().exactOptional(),
      ...fields,
    })
    .readonly();
}
export function operationOutcomeSchema<
  Fields extends z.ZodRawShape,
  Refusal extends z.ZodType,
  Issues extends z.ZodType,
>(fields: Fields, refusal: Refusal, issues: Issues) {
  return z.union([
    acceptedOutcomeSchema(fields, issues),
    z.strictObject({ kind: z.literal("refused"), contractId: contractIdSchema, reason: refusal }).readonly(),
    retrySchema.options[0].unwrap().extend({ contractId: contractIdSchema }).readonly(),
    retrySchema.options[1].unwrap().extend({ contractId: contractIdSchema }).readonly(),
  ]);
}

export const handoffOutcomeSchema = z
  .strictObject({
    kind: z.literal("handoff"),
    contractId: contractIdSchema,
    worktreePath: z.string().min(1),
    targetHead: snapshotIdSchema,
    conflictPaths: z.array(z.string().min(1)).min(1).readonly(),
    handoffBase: snapshotIdSchema,
  })
  .readonly();
export type HandoffOutcome = z.output<typeof handoffOutcomeSchema>;

export type Verify = Omit<
  Extract<VerifyOutcome, { kind: "accepted" }>,
  "kind" | "contractId" | "issues" | "recoverySnapshots"
>;
export type Review = Omit<
  Extract<ReviewOutcome, { kind: "accepted" }>,
  "kind" | "contractId" | "issues" | "recoverySnapshots"
>;
type PartialContractEnvelope = Readonly<{
  kind: "contract";
  contractId?: ContractId;
  admitted?: readonly AdmissionEvidence[];
  placement?: z.output<typeof placementSchema>;
  continuation?: ContinuationReport & Readonly<{ claimed?: never }>;
  effects?: readonly z.output<typeof exceptionalEffectSchema>[];
  issues?: readonly InvocationIssue[];
  snapshot?: SnapshotId;
  checks?: readonly import("../protocol/verify.js").VerificationCheck[];
}>;
type WorldFailureReceipt = Readonly<{
  kind: "world";
  world?: WorldRoot;
  removed?: Partial<ResetCounts>;
  issues?: readonly ResetIssue[];
  contracts?: readonly import("./reconcile.js").RepoContractReconcileReport[];
}>;
export type PartialOutcomeEnvelope = PartialContractEnvelope | WorldFailureReceipt;

type ContractReceiptInput = Omit<PartialContractEnvelope, "admitted"> &
  Readonly<{ facts?: readonly JournalEntry[]; reused?: string }>;
const publicationWitness = Symbol("canonical admission witness");
type NativeAdmissionEvidence = AdmissionEvidence & Readonly<{ [publicationWitness]?: string }>;

export type InvocationFailure = Readonly<{ kind: "failed"; contract?: ContractId; error: unknown }>;

export function invocationIssues(
  effects: readonly InvocationEffect[],
  primary?: ContractId,
  snapshot?: string,
): readonly InvocationIssue[] {
  const issues: InvocationIssue[] = [];
  for (const effect of effects) {
    if (effect.kind !== "issue") continue;
    const owner = ownerScope(effect.contract, primary);
    const issue = effect.issue;
    if (
      issue.kind === "diagnostic" &&
      effect.contract === primary &&
      issue.snapshot !== undefined &&
      issue.snapshot === snapshot
    ) {
      const { snapshot: _snapshot, ...rest } = issue;
      issues.push({ ...rest, ...owner });
    } else issues.push({ ...issue, ...owner });
  }
  return uniqueIssues(issues);
}

function uniqueIssues(issues: readonly InvocationIssue[]): readonly InvocationIssue[] {
  const diagnosedRetentions = new Set(
    issues.flatMap((issue) =>
      issue.kind === "worktree-retained" && issue.diagnostic !== undefined
        ? [JSON.stringify([issue.contractId, issue.path])]
        : [],
    ),
  );
  return uniqueLeaves(issues).filter(
    (issue) =>
      issue.kind !== "worktree-retained" ||
      issue.diagnostic !== undefined ||
      !diagnosedRetentions.has(JSON.stringify([issue.contractId, issue.path])),
  );
}

function leafKey(leaf: object): string {
  return JSON.stringify(Object.entries(leaf).sort(([left], [right]) => left.localeCompare(right)));
}

function uniqueLeaves<Leaf extends object>(leaves: readonly Leaf[]): Leaf[] {
  return [...new Map(leaves.map((leaf) => [leafKey(leaf), leaf])).values()];
}

function ownerScope(owner: ContractId | undefined, addressed: ContractId | undefined) {
  return owner === addressed || owner === undefined ? {} : { contractId: owner };
}

function admissionEvidence(fact: JournalEntry, primary: ContractId | undefined, reused: boolean): AdmissionEvidence {
  const base = ownerScope(fact.contract, primary);
  switch (fact.kind) {
    case "deliver":
      return { ...base, kind: fact.kind, ...compactDelivery(fact.data, reused) };
    case "reintegrated":
      return { ...base, kind: fact.kind, integration: fact.data.snapshot, predecessor: fact.data.predecessor };
    case "attestation":
      return {
        ...base,
        kind: fact.kind,
        ...(fact.data.gate === "verified" ? { requirement: fact.data.requirement, verdict: fact.data.verdict } : {}),
      };
    case "arc":
      return { ...base, kind: fact.kind, chapter: fact.data.seq };
    default:
      return { ...base, kind: fact.kind };
  }
}

function confirmedEvidence(snapshot: InvocationSnapshot, primary: ContractId | undefined) {
  const effects: NonNullable<PartialContractEnvelope["effects"]>[number][] = snapshot.effects.flatMap((record) =>
    record.kind === "movement" ? [{ ...record.effect, ...ownerScope(record.contract, primary) }] : [],
  );
  const stopped: NonNullable<ContinuationReport["stopped"]>[number][] = [];
  for (const [contractId, placement] of snapshot.placements) {
    if (contractId === primary) continue;
    if (placement.kind === "placed") effects.push({ ...placement, contractId });
    else stopped.push({ contractId, stop: placement });
  }
  const placement = primary === undefined ? undefined : snapshot.placements.get(primary);
  return {
    ...(effects.length === 0 ? {} : { effects }),
    ...(placement === undefined ? {} : { placement }),
    ...(stopped.length === 0 ? {} : { continuation: { stopped } }),
    ...(primary === undefined ? {} : snapshot.verification.get(primary)),
  };
}

function acceptedRecoveries(operation: ContractVerb, snapshot: InvocationSnapshot, contract: ContractId) {
  const recoveries = snapshot.effects.flatMap((record) =>
    record.kind === "movement" && record.effect.kind === "recovery-snapshot"
      ? [{ snapshot: record.effect.snapshot, ...(record.contract === contract ? {} : { contractId: record.contract }) }]
      : [],
  );
  if (recoveries.length === 0) return {};
  const unique = uniqueLeaves(recoveries);
  const local = operation === "bind" || operation === "amend" || operation === "arc" || operation === "abandon";
  return { recoverySnapshots: local ? unique.map((recovery) => recovery.snapshot) : unique };
}

export function project<Answer extends Readonly<{ kind: string; contractId?: ContractId }>>(
  operation: ContractVerb,
  snapshot: InvocationSnapshot,
  conclusion: Answer | InvocationFailure,
  signal?: AbortSignal,
): Readonly<{ kind: "returned"; outcome: Answer }> | InvocationFailure {
  const contract = "error" in conclusion ? conclusion.contract : conclusion.contractId;
  const verifiedSnapshot = contract === undefined ? undefined : snapshot.verification.get(contract)?.snapshot;
  const issues = invocationIssues(snapshot.effects, contract, verifiedSnapshot);
  if ("error" in conclusion || conclusion.kind === "refused" || conclusion.kind === "retry") {
    const evidence = { ...confirmedEvidence(snapshot, contract), ...(issues.length === 0 ? {} : { issues }) };
    const { facts, reused } = snapshot;
    const empty = facts.length === 0 && reused === undefined && Object.keys(evidence).length === 0;
    const receipt = { ...contractReceipt(contract, evidence), facts, ...(reused === undefined ? {} : { reused }) };
    if ("error" in conclusion) {
      const { error } = conclusion;
      const cancelled = signal?.aborted ? error === signal.reason : errorCategory(error) === "aborted";
      return {
        kind: "failed",
        error: cancelled && empty ? error : withOutcomeReceipt(error, receipt, signal),
      };
    }
    if (!empty) throw withOutcomeReceipt(new Error("non-admission followed confirmed invocation effects"), receipt);
  }
  const recoveries =
    conclusion.kind === "accepted" && contract !== undefined ? acceptedRecoveries(operation, snapshot, contract) : {};
  return {
    kind: "returned",
    outcome: Object.assign(conclusion, recoveries, issues.length === 0 ? {} : { issues }),
  };
}

function contractReceipt(
  contractId: ContractId | undefined,
  evidence: Omit<PartialContractEnvelope, "kind" | "contractId">,
): PartialContractEnvelope {
  return { kind: "contract", ...(contractId === undefined ? {} : { contractId }), ...evidence };
}

declare module "../errors.js" {
  interface KeiyakuError {
    readonly outcome?: PartialOutcomeEnvelope;
    readonly spawn?: SpawnResult;
    readonly tell?: AkumaTellResult;
  }
  interface KeiyakuErrorOptions {
    readonly outcome?: PartialOutcomeEnvelope | undefined;
    readonly spawn?: SpawnResult | undefined;
    readonly tell?: AkumaTellResult | undefined;
  }
}
function crossesBoundary(error: unknown): boolean {
  return (
    error instanceof KeiyakuError && !(error instanceof AuthorityCorruptionError) && !(error instanceof SettingsError)
  );
}

export function validated<Value>(phase: () => Value): Value {
  try {
    return phase();
  } catch (error) {
    if (crossesBoundary(error)) throw error;
    throw new KeiyakuError(errorCategory(error), errorDiagnostic(error), { cause: error });
  }
}
export async function readContractValue<Value>(operation: () => Promise<Value>): Promise<Value> {
  try {
    return await operation();
  } catch (error) {
    if (crossesBoundary(error)) throw error;
    throw new KeiyakuError(errorCategory(error), errorDiagnostic(error), { cause: error });
  }
}
function errorDiagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function scopeLeaves<Leaf extends Readonly<{ contractId?: ContractId }>>(
  leaves: readonly Leaf[] | undefined,
  owner: ContractId | undefined,
  addressed: ContractId | undefined,
): Leaf[] {
  return (leaves ?? []).map(
    ({ contractId, ...leaf }) => ({ ...leaf, ...ownerScope(contractId ?? owner, addressed) }) as Leaf,
  );
}

function mergeAdmissions(
  previous: PartialContractEnvelope,
  incoming: ContractReceiptInput,
  addressed: ContractId | undefined,
) {
  const facts = new Map<string, Readonly<{ fact: JournalEntry; bytes: string; reused: boolean }>>();
  const opaque: AdmissionEvidence[] = [];
  let conflict = false;
  const retain = (bytes: string, reused: boolean) => {
    const fact = decodeJournal(bytes)[0]!;
    const key = publicationKey(fact);
    const known = facts.get(key);
    if (known !== undefined && known.bytes !== bytes) conflict = true;
    else if (known === undefined || (known.reused && !reused)) facts.set(key, { fact, bytes, reused });
  };
  for (const leaf of previous.admitted ?? []) {
    const bytes = (leaf as NativeAdmissionEvidence)[publicationWitness];
    if (bytes !== undefined) retain(bytes, leaf.kind === "deliver" && leaf.admission === "reused");
    else {
      // Caller-supplied wire evidence has no native identity.
      const { contractId, ...value } = leaf;
      opaque.push({ ...value, ...ownerScope(contractId ?? previous.contractId, addressed) });
    }
  }
  if (incoming.reused !== undefined) retain(incoming.reused, true);
  for (const fact of incoming.facts ?? []) retain(encodeEntry(fact), false);
  const admitted = Object.freeze([
    ...opaque,
    ...Array.from(facts.values(), ({ fact, bytes, reused }) =>
      Object.freeze(
        Object.defineProperty(admissionEvidence(fact, addressed, reused), publicationWitness, { value: bytes }),
      ),
    ),
  ]);
  return { admitted, conflict };
}

function mergePlacementEvidence(
  previous: PartialContractEnvelope,
  current: PartialContractEnvelope,
  addressed: ContractId | undefined,
  peer: ContractId | undefined,
) {
  const stopped = [...(previous.continuation?.stopped ?? [])];
  const effects = scopeLeaves(previous.effects, previous.contractId, addressed);
  const placement = previous.placement;
  if (peer !== undefined && placement !== undefined) {
    if (placement.kind === "placed") effects.push({ ...placement, contractId: peer });
    else stopped.push({ contractId: peer, stop: placement });
  }
  effects.push(...scopeLeaves(current.effects, current.contractId, addressed));
  stopped.push(...(current.continuation?.stopped ?? []));
  return { effects: uniqueLeaves(effects), stopped: uniqueLeaves(stopped) };
}

function mergeContractReceipts(previous: PartialContractEnvelope, current: ContractReceiptInput) {
  const addressed = current.contractId ?? previous.contractId;
  const { admitted, conflict } = mergeAdmissions(previous, current, addressed);
  const peer = ownerScope(previous.contractId, addressed).contractId;
  const prior = peer === undefined ? previous : undefined;
  const { effects, stopped } = mergePlacementEvidence(previous, current, addressed, peer);
  const issues = uniqueIssues([
    ...scopeLeaves(previous.issues, previous.contractId, addressed),
    ...scopeLeaves(current.issues, current.contractId, addressed),
  ]);
  const placement = current.placement ?? prior?.placement;
  const { snapshot, checks } = current.snapshot !== undefined ? current : (prior ?? current);
  return {
    conflict,
    outcome: contractReceipt(addressed, {
      ...(admitted.length === 0 ? {} : { admitted }),
      ...(effects.length === 0 ? {} : { effects }),
      ...(issues.length === 0 ? {} : { issues }),
      ...(placement === undefined ? {} : { placement }),
      ...(stopped.length === 0 ? {} : { continuation: { stopped } }),
      ...(snapshot === undefined ? {} : { snapshot }),
      ...(checks === undefined ? {} : { checks }),
    }),
  };
}

export function withOutcomeReceipt(
  error: unknown,
  receipt: ContractReceiptInput | WorldFailureReceipt,
  signal?: AbortSignal,
): KeiyakuError {
  const previous = error instanceof KeiyakuError ? error.outcome : undefined;
  const { conflict, outcome } =
    receipt.kind === "contract"
      ? mergeContractReceipts(previous?.kind === "contract" ? previous : { kind: "contract" }, receipt)
      : { conflict: false, outcome: receipt };
  const options = {
    ...(error instanceof KeiyakuError
      ? { spawn: error.spawn, tell: error.tell, ...(error.next === undefined ? {} : { next: error.next }) }
      : {}),
    cause: error,
    outcome,
  };
  return conflict
    ? new AuthorityCorruptionError("conflicting invocation receipt", options)
    : new KeiyakuError(errorCategory(error, signal), errorDiagnostic(error), options);
}

/** Confirmed birth is attached without mutating a shared or frozen native failure. */
export function withSpawnFailureReceipt(reason: unknown, spawn: SpawnResult, signal?: AbortSignal): KeiyakuError {
  return new KeiyakuError(errorCategory(reason, signal), errorDiagnostic(reason), {
    ...(reason instanceof KeiyakuError
      ? { outcome: reason.outcome, tell: reason.tell, ...(reason.next === undefined ? {} : { next: reason.next }) }
      : {}),
    cause: reason,
    spawn,
  });
}

export type FailureProjection = Readonly<{
  kind: "failed";
  category: KeiyakuErrorCategory;
  diagnostic: string;
  next?: NextCall;
  causeClass?: string;
  causeDiagnostic?: string;
  outcome?: PartialOutcomeEnvelope;
  spawn?: SpawnResult;
  tell?: AkumaTellResult;
  kill?: NonNullable<KeiyakuError["kill"]>;
  frozenWorkdir?: NonNullable<KeiyakuError["frozenWorkdir"]>;
}>;
export function projectFailure(error: unknown): FailureProjection {
  let cause = error;
  while (cause instanceof KeiyakuError && (cause.constructor === KeiyakuError || cause.kill !== undefined))
    cause = cause.cause;
  return {
    kind: "failed",
    category: errorCategory(error),
    diagnostic: errorDiagnostic(error),
    ...(error instanceof KeiyakuError && error.next !== undefined ? { next: error.next } : {}),
    ...(cause instanceof Error ? { causeClass: cause.name, causeDiagnostic: cause.message } : {}),
    ...(error instanceof KeiyakuError && error.spawn !== undefined ? { spawn: error.spawn } : {}),
    ...(error instanceof KeiyakuError && error.tell !== undefined ? { tell: error.tell } : {}),
    ...(error instanceof KeiyakuError && error.kill !== undefined ? { kill: error.kill } : {}),
    ...(error instanceof KeiyakuError && error.frozenWorkdir !== undefined
      ? { frozenWorkdir: error.frozenWorkdir }
      : {}),
    ...(error instanceof KeiyakuError && error.outcome !== undefined ? { outcome: error.outcome } : {}),
  };
}
