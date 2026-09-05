from pathlib import Path
import re

changes = {}
def load(name):
    if name not in changes: changes[name] = Path(name).read_text()
    return changes[name]
def replace(name, before, after, count=1):
    text = load(name)
    found = text.count(before)
    if found != count: raise RuntimeError(f'{name}: expected {count} occurrences, found {found}: {before[:100]!r}')
    changes[name] = text.replace(before, after)
def cut(name, first, last, replacement=''):
    text = load(name)
    start, end = text.index(first), text.index(last, text.index(first))
    changes[name] = text[:start] + replacement + text[end:]
def write(name, text): changes[name] = text.strip() + '\n'

if 'export class ExecutionProgress' in Path('src/protocol/progress.ts').read_text():
    print('Receipt implementation already applied.'); raise SystemExit(0)

write('src/protocol/progress.ts', r'''
import { encodeEntry } from "../core/facts/codec.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import type { ContractId, ContractState, JournalEntry, SnapshotId } from "../core/facts/types.js";
import { GitPlumbingError } from "../git/process.js";
import { SqliteTransactionLockError } from "../coordination/sqlite-transaction-lock.js";
import type { ReconcileResult } from "../git/reconcile.js";
import type { WorktreeLeak } from "../git/scratch.js";
import type { PrivateStateSeatCloseLag } from "../git/private-state-seat.js";
import type { VerificationCleanupFailure } from "./intent.js";
import type { AcceptedProtocolStep, IntentOutcome } from "./outcome.js";

/** A captured interpretation is not an invocation's admission receipt. */
export type ContractCheckpoint = Readonly<{ state: ContractState; journal: readonly JournalEntry[] }>;

export function contractCheckpoint(input: ContractCheckpoint): ContractCheckpoint {
  return { state: input.state, journal: input.journal };
}

export type ExecutionCleanup =
  | Readonly<{ kind: "verification-cleanup"; contractId: ContractId; snapshot?: SnapshotId; failure: VerificationCleanupFailure }>
  | Readonly<{ kind: "worktree-leak"; contractId: ContractId; snapshot?: SnapshotId; leak: WorktreeLeak }>
  | Readonly<{ kind: "private-state-seat-close"; contractId: ContractId; failure: PrivateStateSeatCloseLag }>;

export type ExecutionStage = "admission" | "verification" | "placement" | "reintegration" | "continuation" | "reconciliation";
export type ExecutionStop = Readonly<{
  kind: "execution-stopped";
  contractId: ContractId;
  stage: ExecutionStage;
  reason: "cancelled" | "failed";
  diagnostic: string;
}>;

/** Classify operational failures only; programming errors and corrupt authority still throw. */
export function executionStop(contractId: ContractId, stage: ExecutionStage, error: unknown, signal?: AbortSignal): ExecutionStop {
  if (error instanceof AuthorityCorruptionError || error instanceof TypeError) throw error;
  const cancelled = signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
  const errno = error instanceof Error && "code" in error && typeof error.code === "string" && /^E[A-Z0-9]+$/u.test(error.code);
  if (!cancelled && !errno && !(error instanceof GitPlumbingError) && !(error instanceof SqliteTransactionLockError)) throw error;
  return {
    kind: "execution-stopped", contractId, stage, reason: cancelled ? "cancelled" : "failed",
    diagnostic: error instanceof Error ? error.message : String(error),
  };
}

export type ExecutionSnapshot = Readonly<{
  facts: readonly JournalEntry[];
  checkpoints: ReadonlyMap<ContractId, ContractCheckpoint>;
  affected: readonly ContractId[];
  physical: ReconcileResult;
  cleanup: readonly ExecutionCleanup[];
  stops: readonly ExecutionStop[];
}>;

type Residue = Readonly<{ physical?: ReconcileResult; seatClose?: readonly PrivateStateSeatCloseLag[] }>;

/** Invocation-local receipts only: no persistence, scheduling, callbacks, or authority reads. */
export class ExecutionProgress {
  private readonly entries = new Map<string, string>();
  private readonly admittedFacts: JournalEntry[] = [];
  private readonly admittedCheckpoints = new Map<ContractId, ContractCheckpoint>();
  private readonly affectedContracts = new Set<ContractId>();
  private readonly effects: ReconcileResult["effects"][number][] = [];
  private readonly lags: ReconcileResult["lag"][number][] = [];
  private readonly cleanupIssues: ExecutionCleanup[] = [];
  private readonly executionStops: ExecutionStop[] = [];
  private readonly reportedResidue = new WeakSet<object>();

  /** Called synchronously at the confirmed publication boundary, before trailing awaits. */
  recordAdmission(step: AcceptedProtocolStep): void {
    const incoming = step.facts.map((fact) => ({ fact, key: `${fact.contract}\0${fact.entry}`, bytes: encodeEntry(fact) }));
    for (const { key, bytes } of incoming) {
      const previous = this.entries.get(key);
      if (previous !== undefined && previous !== bytes) throw new AuthorityCorruptionError("conflicting invocation receipt");
    }
    let fresh = false;
    for (const { fact, key, bytes } of incoming) {
      if (this.entries.has(key)) continue;
      this.entries.set(key, bytes);
      this.admittedFacts.push(fact);
      this.affectedContracts.add(fact.contract);
      fresh = true;
    }
    if (fresh) this.admittedCheckpoints.set(step.state.id, contractCheckpoint(step));
    this.recordResidue(step.state.id, step);
  }

  recordResidue(contractId: ContractId, residue: Residue): void {
    if (residue.physical !== undefined) this.recordPhysical(contractId, residue.physical);
    for (const failure of residue.seatClose ?? []) {
      if (this.reportedResidue.has(failure)) continue;
      this.reportedResidue.add(failure);
      this.cleanupIssues.push({ kind: "private-state-seat-close", contractId, failure });
    }
  }

  recordPhysical(contractId: ContractId, physical: ReconcileResult): void {
    if (physical.effects.length > 0 || physical.lag.length > 0) this.affectedContracts.add(contractId);
    for (const effect of physical.effects) {
      if (this.reportedResidue.has(effect)) continue;
      this.reportedResidue.add(effect);
      this.effects.push(effect);
    }
    for (const lag of physical.lag) {
      if (this.reportedResidue.has(lag)) continue;
      this.reportedResidue.add(lag);
      this.lags.push(lag);
    }
  }

  recordVerification(contractId: ContractId, snapshot: SnapshotId, result: Readonly<{ cleanup?: VerificationCleanupFailure; leak?: WorktreeLeak }>): void {
    if (result.cleanup !== undefined) this.cleanupIssues.push({ kind: "verification-cleanup", contractId, snapshot, failure: result.cleanup });
    if (result.leak !== undefined) this.cleanupIssues.push({ kind: "worktree-leak", contractId, snapshot, leak: result.leak });
  }

  recordStop(stop: ExecutionStop): void { this.executionStops.push(stop); }

  checkpoint(contractId: ContractId): ContractCheckpoint | undefined { return this.admittedCheckpoints.get(contractId); }

  snapshot(): ExecutionSnapshot {
    return {
      facts: Object.freeze([...this.admittedFacts]), checkpoints: new Map(this.admittedCheckpoints),
      affected: Object.freeze([...this.affectedContracts]),
      physical: { effects: Object.freeze([...this.effects]), lag: Object.freeze([...this.lags]) },
      cleanup: Object.freeze([...this.cleanupIssues]), stops: Object.freeze([...this.executionStops]),
    };
  }

  /** One final assembly; a dependent's checkpoint can never replace the addressed head. */
  accepted<Value>(contractId: ContractId, value: Value): Extract<IntentOutcome<Value>, { kind: "accepted" }> {
    const checkpoint = this.checkpoint(contractId);
    if (checkpoint === undefined || checkpoint.state.head === null) throw new Error("missing leading admission receipt");
    const snapshot = this.snapshot();
    return { kind: "accepted", head: checkpoint.state.head, facts: snapshot.facts, value, physical: snapshot.physical };
  }
}
''')

replace('src/protocol/outcome.ts', 'export type AcceptedProtocolStep = AcceptedAdmission & Readonly<{ physical?: ReconcileResult }>;', '''export type AcceptedProtocolStep = AcceptedAdmission & Readonly<{ physical?: ReconcileResult }>;

export type LeadingOutcome<Value, Refusal> =
  | (AcceptedProtocolStep & Readonly<{ value: Value }>)
  | Readonly<{ kind: "refused"; refusal: Refusal }>
  | Readonly<{ kind: "retry"; reason: ProtocolTerminal }>;''')

# Record the exact accepted offer at its actual confirmation boundary.
name = 'src/protocol/attempt.ts'
changes[name] = 'import type { ExecutionProgress } from "./progress.js";\n' + load(name)
replace(name, '    validateAdmission?: (observation: GitDecisionObservation) => Refusal | undefined | Promise<Refusal | undefined>;', '    validateAdmission?: (observation: GitDecisionObservation) => Refusal | undefined | Promise<Refusal | undefined>;\n    progress?: ExecutionProgress;')
replace(name, '    return {\n      kind: "accepted",\n      facts: offerEntries(offer),\n      state: snapshotFor(primary, decisionObservation.journals, admission.heads[primary.contractId]!),\n      journal: journalFor(primary, decisionObservation.journals),\n    };', '''    const accepted: AcceptedAdmission = {
      kind: "accepted",
      facts: offerEntries(offer),
      state: snapshotFor(primary, decisionObservation.journals, admission.heads[primary.contractId]!),
      journal: journalFor(primary, decisionObservation.journals),
    };
    input.progress?.recordAdmission(accepted);
    return accepted;''')
replace(name, '  if (classification.kind === "accepted")\n    return confirmRecoveredAcceptance(input.seat, { contracts: recovered.journals }, offer, primaryContract);', '''  if (classification.kind === "accepted") {
    const accepted = confirmRecoveredAcceptance(input.seat, { contracts: recovered.journals }, offer, primaryContract);
    input.progress?.recordAdmission(accepted);
    return accepted;
  }''')
# Readback must remain possible after the caller cancels a publication.
replace(name, '  const recovered = await observeContractsForAdmissionAt(\n    repository,', '  const recovered = await observeContractsForAdmissionAt(\n    { ...repository, signal: AbortSignal.timeout(5_000) },')

name = 'src/protocol/operations.ts'
changes[name] = 'import type { ExecutionProgress } from "./progress.js";\n' + load(name)
replace(name, 'export type MutationOperationInput = OperationInput & Readonly<{ channel: GitDecodeChannel }>;', 'export type MutationOperationInput = OperationInput & Readonly<{ channel: GitDecodeChannel; progress?: ExecutionProgress }>;')

name = 'src/protocol/run.ts'
changes[name] = 'import type { ExecutionProgress } from "./progress.js";\n' + load(name)
replace(name, '  channel: GitDecodeChannel;\n  repository: GitRepository;\n  contracts:', '  channel: GitDecodeChannel;\n  repository: GitRepository;\n  progress?: ExecutionProgress;\n  contracts:')
replace(name, '    primaryContract: input.input.contractId,\n    assertions: decided.assertions,', '    primaryContract: input.input.contractId,\n    progress: input.progress,\n    assertions: decided.assertions,')

name = 'src/protocol/intent.ts'
changes[name] = 'import type { ExecutionProgress } from "./progress.js";\n' + load(name)
replace(name, 'type IntentAdmissionOptions<Input, Refusal, Seed> = Readonly<{', 'type IntentAdmissionOptions<Input, Refusal, Seed> = Readonly<{\n  progress?: ExecutionProgress;')
replace(name, '    decide,\n    ...(options.observe', '    decide,\n    progress: options.progress,\n    ...(options.observe')
replace(name, '  verification?: VerificationDefinition;\n}>;', '  verification?: VerificationDefinition;\n  progress?: ExecutionProgress;\n}>;')
replace(name, '  let step: VerificationStep;', '  input.progress?.recordVerification(input.contractId, snapshot, execution);\n  let step: VerificationStep;')
replace(name, '      decideAttestation,\n    );', '      decideAttestation,\n      { progress: input.progress },\n    );')
replace(name, '  return {\n    step,', '''  if (!("failure" in step) && step.kind === "accepted") input.progress?.recordResidue(input.contractId, step);
  return {
    step,''')

# Verb mechanics end at the leading admission. Library owns automatic completion.
name = 'src/protocol/deliver.ts'
replace(name, 'DeliverData, JournalEntry, SnapshotId', 'DeliverData, SnapshotId')
replace(name, 'import { admitted } from "./outcome.js";', 'import type { LeadingOutcome } from "./outcome.js";')
replace(name, 'import { completeCandidate, type CompletionEvidence, type CompletionResult } from "./completion.js";', 'import type { CompletionEvidence } from "./completion.js";')
replace(name, 'import { completeLeadingAdmission, contractCheckpoint } from "./progress.js";\n', '')
replace(name, '  IntentOutcome,\n', '')
replace(name, '    primaryContract: input.contractId,\n  });', '    primaryContract: input.contractId,\n    progress: input.progress,\n  });')
cut(name, 'async function completeDelivery(', 'function isIntegrationConflict(')
changes[name] = load(name).replace('IntentOutcome<DeliverValue>', 'LeadingOutcome<DeliveryIdentity, IntentRefusal>')
replace(name, 'export async function deliverOperation(', 'export async function admitDeliveryOperation(')
replace(name, '  return await completeDelivery(input, first);', '  input.progress?.recordResidue(input.contractId, first);\n  return { ...first, value: first.value.delivery };')

name = 'src/protocol/review.ts'
replace(name, 'import { admitted } from "./outcome.js";', 'import type { LeadingOutcome } from "./outcome.js";')
replace(name, 'import { completeCandidate, type CompletionEvidence } from "./completion.js";', 'import type { CompletionEvidence } from "./completion.js";')
replace(name, 'import { completeLeadingAdmission, contractCheckpoint } from "./progress.js";\n', '')
replace(name, '  IntentOutcome,\n', '')
replace(name, '    primaryContract: input.contractId,\n  });', '    primaryContract: input.contractId,\n    progress: input.progress,\n  });')
replace(name, 'export async function reviewOperation(input: ReviewOperationInput): Promise<IntentOutcome<ReviewValue, ReviewRefusal>> {', 'export async function admitReviewOperation(input: ReviewOperationInput): Promise<LeadingOutcome<ReviewValue, ReviewRefusal>> {')
replace(name, '  const git = input.scope;\n', '')
text = load(name)
start = text.index('  if (input.verdict !== "satisfied") return admitted(')
changes[name] = text[:start] + '  input.progress?.recordResidue(input.contractId, review);\n  return { ...review, value: reviewValue(review.value) };\n}\n'

name = 'src/protocol/placement.ts'
changes[name] = 'import type { ExecutionProgress } from "./progress.js";\n' + load(name)
replace(name, '  onDeliveryMissing?: () => Promise<PlacementProtocolResult<ExtraRefusal> | undefined>;', '  onDeliveryMissing?: () => Promise<PlacementProtocolResult<ExtraRefusal> | undefined>;\n  progress?: ExecutionProgress;')
replace(name, '          primaryContract: input.contractId,\n        });', '          primaryContract: input.contractId,\n          progress: protocol.progress,\n        });')
replace(name, '    decide: decidePlacement,', '    decide: decidePlacement,\n    progress: admission.progress,')

name = 'src/protocol/reintegrate.ts'
changes[name] = 'import type { ExecutionProgress } from "./progress.js";\n' + load(name)
replace(name, '  actor?: ActorId;\n}>;', '  actor?: ActorId;\n  progress?: ExecutionProgress;\n}>;')
replace(name, '          primaryContract: input.contractId,\n          assertions,', '          primaryContract: input.contractId,\n          progress: input.progress,\n          assertions,')

name = 'src/git/target-placement.ts'
replace(name, '    mode: "immediate",\n  });', '    mode: "immediate",\n    timeoutMs: 5_000,\n    ...(repository.signal === undefined ? {} : { signal: repository.signal }),\n  });')

# Keep a complete inventory for the next projection/CLI migration; do not alter unrelated owners.
for name, text in changes.items():
    Path(name).write_text(text)
    print('UPDATED ' + name)
for root in ['src/library', 'src/cli', 'tests']:
    for p in sorted(Path(root).rglob('*.ts')):
        for i, line in enumerate(p.read_text().splitlines(), 1):
            if re.search(r'completionInput\(|completeMutation\(|\.cleanup\b|\.leak\b|\.seatClose\b', line):
                print(f'REF {p}:{i}: {line}')
