import type { PartialOutcomeEnvelope } from "../../index.js";
import type { VerbCompletion, VerbDisposition, VerbInput, VerbOutput } from "../../library/keiyaku-verbs.js";
import { projectFailure } from "../../library/outcome.js";
import type { RepoReconcileReport } from "../../library/reconcile.js";
import { KeiyakuArcDocumentError } from "../../library/keiyaku-coordinates.js";
import {
  admissionLines,
  checkLines,
  effectLines,
  evidenceLines,
  fact,
  failureLines,
  issueLines,
  payload,
  placementLines,
  prerequisiteLines,
  recoveryLines,
  requirementLines,
} from "./receipt.js";
import { callLines, refusalRecoveryLines } from "./refusal.js";
import { exactIndentedLines, gitShortStat, kindWords, safeText, type TextRenderContext } from "./terminal.js";

export type ContractResultName = "bind" | "amend" | "arc" | "abandon" | "deliver" | "review" | "verify" | "reconcile";
type Answer = VerbOutput<ContractResultName>;
type PartialContract = Extract<PartialOutcomeEnvelope, { kind: "contract" }>;
type PreparedPreview = Extract<VerbOutput<"deliver">, { kind: "ready" }>;
type ContractEvidence = Answer | PartialContract | NonNullable<PartialContract["preview"]>;

function previewTargetLines(target: PreparedPreview["target"]): string[] {
  if (target === undefined) return [];
  const lines: string[] = [];
  fact(lines, "target", target.kind);
  if (target.kind === "placeable") {
    fact(lines, "reference", target.ref);
    fact(lines, "head", target.head);
    fact(lines, "behind", target.behind);
    for (const checkout of target.checkouts ?? []) {
      fact(lines, "checkout cannot follow", checkout.path);
      payload(lines, "diagnostic", checkout.diagnostic);
    }
  } else if (target.kind === "moved") {
    fact(lines, "reference", target.ref);
    fact(lines, "expected", target.expected);
    fact(lines, "observed", target.observed);
  } else if (target.kind === "failed") payload(lines, "diagnostic", target.diagnostic);
  else lines.push(...evidenceLines(target.reason));
  return lines;
}

function workspaceLines(value: ContractEvidence): string[] {
  const lines: string[] = [];
  if ("worktreePath" in value) fact(lines, "workspace", value.worktreePath);
  if ("target" in value) {
    if (typeof value.target === "object") lines.push(...previewTargetLines(value.target));
    else fact(lines, "target", value.target);
  }
  if ("targetHead" in value) fact(lines, "target head", value.targetHead);
  return lines;
}

function termLines(value: ContractEvidence, operation: ContractResultName): string[] {
  const lines: string[] = [];
  if ("changedSections" in value) {
    for (const section of value.changedSections ?? []) fact(lines, "changed section", section);
  }
  if ("gatesChanged" in value && value.gatesChanged) fact(lines, "gates", "changed");
  if ("afterChanged" in value && value.afterChanged) fact(lines, "after", "changed");
  if (operation === "amend" && value.kind === "accepted") {
    const changed =
      "changedSections" in value || "gatesChanged" in value || "afterChanged" in value || "target" in value;
    if (changed) fact(lines, "admitted", operation);
    else fact(lines, "terms", "unchanged");
  }
  return lines;
}

function identityLines(value: ContractEvidence): string[] {
  const lines: string[] = [];
  if ("chapter" in value) fact(lines, "chapter", value.chapter);
  if ("candidate" in value) fact(lines, "candidate", value.candidate);
  if ("integration" in value) fact(lines, "integration result", value.integration);
  if ("contentId" in value) fact(lines, "content identity", value.contentId);
  if ("previousContentId" in value) fact(lines, "previous content identity", value.previousContentId);
  if ("snapshot" in value) fact(lines, "snapshot", value.snapshot);
  if ("admission" in value) fact(lines, "admission", value.admission);
  return lines;
}

function leadingLines(
  value: ContractEvidence,
  operation: ContractResultName,
  input: VerbInput<ContractResultName>,
): string[] {
  const lines: string[] = [];
  if (value.kind === "accepted" && operation !== "verify" && operation !== "amend" && !("admission" in value))
    fact(lines, "admitted", operation);
  if (operation === "deliver" && value.kind === "accepted" && !("admission" in value) && "message" in input)
    payload(lines, "note", input.message);
  if (operation === "abandon" && "note" in input) payload(lines, "note", input.note);
  if ("admitted" in value) {
    for (const admission of value.admitted ?? []) lines.push(...admissionLines(admission));
  }
  return lines;
}

function checkEvidenceLines(value: ContractEvidence): string[] {
  const lines: string[] = [];
  if ("worktreeChanges" in value) {
    for (const field of ["staged", "unstaged", "untracked", "unmergedPaths"] as const) {
      for (const path of value.worktreeChanges?.[field] ?? [])
        fact(lines, field === "unmergedPaths" ? "unmerged" : field, path);
    }
  }
  if ("checks" in value) lines.push(...checkLines(value.checks ?? []));
  if ("unmetGates" in value) lines.push(...requirementLines(value.unmetGates ?? []));
  if ("unmetPrerequisites" in value) lines.push(...prerequisiteLines(value.unmetPrerequisites ?? []));
  return lines;
}

function placementEvidenceLines(value: ContractEvidence): string[] {
  const lines: string[] = [];
  if ("placement" in value && value.placement !== undefined) {
    lines.push(...placementLines(value.placement, "integration" in value ? value.integration : undefined));
  }
  if ("effects" in value) {
    for (const effect of value.effects ?? []) lines.push(...effectLines(effect));
  }
  if ("continuation" in value) {
    for (const contract of value.continuation?.claimed ?? []) fact(lines, "dependent placed", contract);
    for (const dependent of value.continuation?.stopped ?? []) {
      fact(lines, "dependent", dependent.contractId);
      lines.push(...evidenceLines(dependent.stop));
    }
  }
  return lines;
}

function overlapLines(value: ContractEvidence): string[] {
  const lines: string[] = [];
  if ("overlaps" in value) {
    for (const overlap of value.overlaps ?? []) {
      for (const pattern of overlap.patterns) {
        const relation = pattern.relation ?? (pattern.mine === pattern.theirs ? "identical" : "intersection");
        fact(lines, "overlap", `${overlap.contractId} · ${pattern.mine} · ${kindWords(relation)} · ${pattern.theirs}`);
      }
    }
  }
  if ("overlapError" in value && value.overlapError !== undefined) {
    fact(lines, "overlap", "unavailable");
    payload(lines, "diagnostic", value.overlapError);
  }
  return lines;
}

function diffLines(value: ContractEvidence): string[] {
  const lines: string[] = [];
  if ("scope" in value && value.scope !== undefined) {
    fact(
      lines,
      "scope",
      gitShortStat({
        filesChanged: value.scope.filesChanged ?? 0,
        insertions: value.scope.insertions ?? 0,
        deletions: value.scope.deletions ?? 0,
      }),
    );
    for (const path of value.scope.paths ?? []) fact(lines, "path", path);
  }
  if ("diff" in value && value.diff !== undefined) {
    if (value.diff.kind === "unavailable") fact(lines, "diff", "unavailable");
    else if (value.diff.text.length === 0) fact(lines, "diff", "empty");
    else lines.push("  diff", ...exactIndentedLines(value.diff.text, "  "));
  }
  return lines;
}

function stopEvidenceLines(value: ContractEvidence): string[] {
  const lines: string[] = [];
  if ("reason" in value) {
    if (value.kind === "retry") lines.push(...evidenceLines(value));
    else if (typeof value.reason === "object") lines.push(...evidenceLines(value.reason));
  }
  if (value.kind === "missing") lines.push(...evidenceLines({ kind: "contract-missing" }));
  if (value.kind === "world-observation-failed") payload(lines, "diagnostic", value.diagnostic);
  if (value.kind === "handoff") {
    fact(lines, "delivery", "none");
    for (const path of value.conflictPaths) fact(lines, "conflict", path);
    fact(lines, "handoff base", value.handoffBase);
  }
  return lines;
}

function contractRecoveryLines(
  value: ContractEvidence,
  operation: ContractResultName,
  input: VerbInput<ContractResultName>,
  context: TextRenderContext,
): string[] {
  const contract = "contractId" in value ? value.contractId : undefined;
  if (contract === undefined) return [];
  // Only the addressed operation carries replay intent. A dependent stop has its own subject and tender.
  const reason =
    "reason" in value && typeof value.reason === "object"
      ? value.reason
      : "placement" in value
        ? value.placement
        : undefined;
  const addressed = { ...input, contract };
  if (operation === "deliver") {
    const delivery = addressed as VerbInput<"deliver">;
    if (value.kind === "handoff") {
      const { materializeConflict: _, ...resolvedDelivery } = delivery;
      return callLines({ verb: operation, input: { ...resolvedDelivery, includeDirty: true } }, context);
    }
    if (reason !== undefined) return refusalRecoveryLines(reason, { verb: operation, input: delivery }, context);
  }
  if (operation === "verify" && reason !== undefined)
    return refusalRecoveryLines(reason, { verb: operation, input: addressed as VerbInput<"verify"> }, context);
  return [];
}

/** One ordered selection of native concepts, also used for retained exceptional evidence. */
function contractLines(
  value: ContractEvidence,
  operation: ContractResultName,
  input: VerbInput<ContractResultName>,
  context: TextRenderContext,
): string[] {
  const lines = [
    ...workspaceLines(value),
    ...termLines(value, operation),
    ...identityLines(value),
    ...leadingLines(value, operation, input),
    ...checkEvidenceLines(value),
    ...placementEvidenceLines(value),
    ...overlapLines(value),
    ...diffLines(value),
    ...stopEvidenceLines(value),
  ];
  if ("preview" in value && value.preview !== undefined)
    lines.push(...contractLines(value.preview, "deliver", { ...input, dryRun: true }, context));
  if ("issues" in value) lines.push(...issueLines(value.issues));
  if ("recoverySnapshots" in value) lines.push(...recoveryLines(value.recoverySnapshots));
  return [...lines, ...contractRecoveryLines(value, operation, input, context)];
}

function addressedIdentity(
  value: Answer | PartialOutcomeEnvelope | undefined,
  input: VerbInput<ContractResultName>,
  error: unknown,
): string | undefined {
  if (value !== undefined && "contractId" in value && value.contractId !== undefined) return value.contractId;
  if (error instanceof KeiyakuArcDocumentError) return error.contract;
  return "contract" in input ? input.contract : undefined;
}

function reconciliationLines(
  value: Extract<RepoReconcileReport | PartialOutcomeEnvelope, { kind: "world" }>,
): string[] {
  const lines: string[] = [];
  if ("world" in value) fact(lines, "world", value.world);
  for (const report of value.contracts ?? []) {
    fact(lines, "contract", report.contractId);
    for (const effect of report.effects ?? []) lines.push(...effectLines(effect));
    lines.push(...issueLines(report.issues));
  }
  return lines;
}

/** renderVerb supplies the sole invocation verdict, including reconciliation. */
export function renderContractResult(
  operation: ContractResultName,
  input: VerbInput<ContractResultName>,
  completion: VerbCompletion<Answer>,
  disposition: VerbDisposition,
  context: TextRenderContext,
): string {
  const error = completion.kind === "threw" ? completion.error : undefined;
  const failure = completion.kind === "threw" ? projectFailure(error) : undefined;
  const value = completion.kind === "returned" ? completion.value : failure?.outcome;
  const identity = addressedIdentity(value, input, error);
  const name = operation === "deliver" && "dryRun" in input && input.dryRun ? "deliver --dry-run" : operation;
  const handoff = value?.kind === "handoff" ? " · conflict handoff" : "";
  const verdict = operation === "review" && "verdict" in input ? ` · ${input.verdict}` : "";
  const lines = [
    `${name} ${disposition}${identity === undefined ? "" : `  ${safeText(identity)}`}${verdict}${handoff}`,
  ];
  if (error instanceof KeiyakuArcDocumentError)
    lines.push(...evidenceLines({ kind: "invalid-document", diagnostic: error.message }));
  else if (failure !== undefined) lines.push(...failureLines(failure));
  if (value !== undefined) {
    if (value.kind === "world") lines.push(...reconciliationLines(value));
    else lines.push(...contractLines(value, operation, input, context));
  }
  if (failure !== undefined) lines.push(...callLines(failure.next, context));
  return lines.join("\n");
}
