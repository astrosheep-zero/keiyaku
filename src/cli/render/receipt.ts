import type {
  InvocationIssue,
  KeiyakuRefusal,
  PartialOutcomeEnvelope,
  Placement,
  RequirementProblem,
  VerificationCheck,
} from "../../index.js";
import type { FailureProjection } from "../../library/outcome.js";
import type { MeaningfulEffect } from "../../library/reconcile.js";
import { DEFAULT_CLI_COLUMNS, kindWords, quotedText, renderOpaqueBlock, safeText } from "./terminal.js";

/** Coordinates are copyable facts, independent of terminal width. */
export function fact(lines: string[], label: string, value: string | number | null | undefined): void {
  if (value !== undefined) lines.push(`  ${label}  ${value === null ? "absent" : safeText(String(value))}`);
}

export function payload(lines: string[], label: string, value: string | undefined): void {
  if (value !== undefined) lines.push(`  ${label}`, ...renderOpaqueBlock(value, "  ", DEFAULT_CLI_COLUMNS));
}

type PartialContract = Extract<PartialOutcomeEnvelope, { kind: "contract" }>;
type CheckStop = Extract<VerificationCheck, { kind: "stopped" }>["stop"];
type AdmissionStop = Exclude<Extract<VerificationCheck, { kind: "terminal" }>["admission"], string>;
type Evidence =
  | KeiyakuRefusal
  | Placement
  | CheckStop
  | AdmissionStop
  | InvocationIssue
  | Readonly<{ kind: "invalid-document"; diagnostic: string }>;

function ownerCoordinateLines(value: Evidence): string[] {
  const lines: string[] = [];
  if ("contractId" in value) fact(lines, "contract", value.contractId);
  if ("targetContractId" in value) fact(lines, "target Contract", value.targetContractId);
  if ("target" in value) fact(lines, "target", value.target);
  if ("targetHead" in value) fact(lines, "target head", value.targetHead);
  if ("worktreePath" in value) fact(lines, "workspace", value.worktreePath);
  if ("path" in value) fact(lines, "path", value.path);
  if ("snapshot" in value) fact(lines, "snapshot", value.snapshot);
  if ("requirement" in value) fact(lines, "requirement", value.requirement);
  if ("index" in value) fact(lines, "check", value.index);
  return lines;
}

function resultCoordinateLines(value: Evidence): string[] {
  const lines: string[] = [];
  if ("total" in value) fact(lines, "declarations", value.total);
  if ("expected" in value) fact(lines, "expected", value.expected);
  if ("observed" in value) fact(lines, "observed", value.observed);
  if ("integration" in value) fact(lines, "integration result", value.integration);
  if ("name" in value && value.name !== undefined) fact(lines, "name", quotedText(value.name));
  if ("phase" in value) fact(lines, "phase", value.phase);
  if ("debtId" in value) fact(lines, "debt", value.debtId);
  return lines;
}

/** Fixed native coordinates, never an object walker or another stop classifier. */
export function evidenceLines(value: Evidence, label = "reason"): string[] {
  const lines: string[] = [];
  fact(lines, label, kindWords(value.kind));
  lines.push(...ownerCoordinateLines(value), ...resultCoordinateLines(value));
  if ("reason" in value) {
    if (typeof value.reason === "string") fact(lines, "detail", kindWords(value.reason));
    else lines.push(...evidenceLines(value.reason));
  }
  if ("paths" in value) {
    for (const path of value.paths ?? []) fact(lines, "path", path);
  }
  if ("submodules" in value) {
    for (const path of value.submodules ?? []) fact(lines, "submodule", path);
  }
  if ("conflictPaths" in value) {
    for (const path of value.conflictPaths) fact(lines, "conflict", path);
  }
  if (value.kind === "gates-unsatisfied") lines.push(...requirementLines(value.unmet));
  if (value.kind === "prerequisites-unsatisfied") lines.push(...prerequisiteLines(value.unmet));
  if ("diagnostic" in value) payload(lines, "diagnostic", value.diagnostic);
  return lines;
}

export function requirementLines(problems: readonly RequirementProblem[]): string[] {
  const lines: string[] = [];
  for (const problem of problems) {
    fact(lines, "gate", problem.gate);
    fact(lines, "requirement", problem.requirement);
    fact(lines, "state", problem.state);
    if (problem.state === "stale") {
      if (problem.reason !== undefined) {
        fact(lines, "stale reason", kindWords(problem.reason.kind));
        fact(lines, "previous snapshot", problem.reason.previousSnapshot);
        fact(lines, "current snapshot", problem.reason.currentSnapshot);
      }
      fact(lines, "previous content identity", problem.previousContentId);
      fact(lines, "current content identity", problem.currentContentId);
    }
    if (problem.state === "unsatisfied") payload(lines, "summary", problem.summary);
  }
  return lines;
}

export function prerequisiteLines(
  prerequisites: Extract<Placement, { kind: "prerequisites-unsatisfied" }>["unmet"],
): string[] {
  const lines: string[] = [];
  for (const prerequisite of prerequisites) {
    fact(lines, "prerequisite", prerequisite.contractId);
    fact(lines, "state", prerequisite.state);
  }
  return lines;
}

export function issueLines(issues: readonly InvocationIssue[] | undefined): string[] {
  const lines: string[] = [];
  for (const issue of issues ?? []) {
    if (
      issue.severity === "required" ||
      "path" in issue ||
      "diagnostic" in issue ||
      "snapshot" in issue ||
      "targetContractId" in issue ||
      "requirement" in issue
    ) {
      lines.push(...evidenceLines(issue, "issue"));
    }
  }
  return lines;
}

export function checkLines(checks: readonly VerificationCheck[]): string[] {
  const lines: string[] = [];
  for (const check of checks) {
    fact(lines, "check", check.index);
    fact(lines, "requirement", check.requirement);
    if (check.kind === "stopped") {
      fact(lines, "execution", "stopped");
      lines.push(...evidenceLines(check.stop));
    } else {
      fact(lines, "verdict", check.verdict);
      fact(lines, "admission", typeof check.admission === "string" ? check.admission : "stopped");
      if (check.verdict === "unsatisfied") payload(lines, "summary", check.summary);
      if (typeof check.admission !== "string") lines.push(...evidenceLines(check.admission));
    }
    fact(lines, "scratch retained", check.retainedPath);
  }
  return lines;
}

export function placementLines(
  placement: Placement | Omit<Extract<Placement, { kind: "placed" }>, "integration">,
  integration?: string,
): string[] {
  if (placement.kind !== "placed") return evidenceLines(placement);
  const lines: string[] = [];
  fact(lines, "destination", placement.target);
  fact(lines, "before", placement.predecessor);
  fact(lines, "after", "integration" in placement ? placement.integration : integration);
  fact(lines, "placement", placement.kind);
  return lines;
}

type Effect = MeaningfulEffect | NonNullable<PartialContract["effects"]>[number];
export function effectLines(effect: Effect): string[] {
  const lines: string[] = [];
  fact(lines, "effect", kindWords(effect.kind));
  if ("contractId" in effect) fact(lines, "contract", effect.contractId);
  if (effect.kind === "placed") lines.push(...placementLines(effect));
  if ("name" in effect) fact(lines, "reference", effect.name);
  if ("before" in effect) fact(lines, "before", effect.before);
  if ("after" in effect) fact(lines, "after", effect.after);
  if ("path" in effect) fact(lines, "path", effect.path);
  if ("target" in effect && effect.kind !== "placed") fact(lines, "target", effect.target);
  if ("snapshot" in effect) fact(lines, "recovery snapshot", effect.snapshot);
  if ("debtId" in effect) fact(lines, "debt", effect.debtId);
  return lines;
}

export function admissionLines(admission: NonNullable<PartialContract["admitted"]>[number]): string[] {
  const lines: string[] = [];
  fact(lines, "admitted", admission.kind);
  fact(lines, "contract", admission.contractId);
  if ("candidate" in admission) fact(lines, "candidate", admission.candidate);
  if ("integration" in admission) fact(lines, "integration result", admission.integration);
  if ("contentId" in admission) fact(lines, "content identity", admission.contentId);
  if ("predecessor" in admission) fact(lines, "before", admission.predecessor);
  if ("requirement" in admission) fact(lines, "requirement", admission.requirement);
  if ("verdict" in admission) fact(lines, "verdict", admission.verdict);
  if ("chapter" in admission) fact(lines, "chapter", admission.chapter);
  return lines;
}

export function recoveryLines(
  recoveries: readonly (string | Readonly<{ snapshot: string; contractId?: string }>)[] | undefined,
): string[] {
  const lines: string[] = [];
  for (const recovery of recoveries ?? []) {
    if (typeof recovery === "string") fact(lines, "recovery snapshot", recovery);
    else {
      fact(lines, "contract", recovery.contractId);
      fact(lines, "recovery snapshot", recovery.snapshot);
    }
  }
  return lines;
}

export function resetFailureLines(
  operation: string,
  receipt: Extract<PartialOutcomeEnvelope, { kind: "world" }>,
  failure: FailureProjection,
): string[] {
  const lines = [`! ${operation} failed`, ...failureLines(failure)];
  fact(lines, "world", receipt.world);
  for (const [owner, count] of Object.entries(receipt.removed ?? {})) fact(lines, `${owner} removed`, count);
  for (const issue of receipt.issues ?? []) {
    fact(lines, "issue", kindWords(issue.kind));
    if (issue.kind === "reset-owner-stopped") fact(lines, "owner", issue.owner);
    payload(lines, "diagnostic", issue.diagnostic);
  }
  return lines;
}

export function failureLines(failure: FailureProjection): string[] {
  const lines: string[] = [];
  fact(lines, "category", failure.category);
  payload(lines, "diagnostic", failure.diagnostic);
  fact(lines, "cause", failure.causeClass);
  payload(lines, "cause diagnostic", failure.causeDiagnostic);
  return lines;
}
