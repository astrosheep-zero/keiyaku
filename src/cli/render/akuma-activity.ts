import type { AkumaStatus } from "../../akuma/akuma.js";
import type { KillAdmission } from "../../akuma/akuma-errors.js";
import type { AddressedWork, CurrentWork } from "../../akuma/status-projection.js";
import type { SettledTurn } from "../../akuma/projection.js";
import { approvalLines, exactActivityText, renderDiffstat } from "../../akuma/timeline-text.js";
import type {
  AkumaAskResult,
  AkumaTellResult,
  AkumaWaitResult,
  AkumaWaitItem,
} from "../../akuma/selection-observation.js";
import type { AkumaObservation } from "../../index.js";
import type { SpawnResult } from "../../library/akuma-creation.js";
import type { AkumaHistoryResult } from "../../library/selection.js";
import {
  ageText,
  DEFAULT_CLI_COLUMNS,
  exactIndentedLines,
  omissionText,
  opaqueCoordinate,
  previewLines,
  safeText,
  type TextRenderContext,
} from "./terminal.js";

export const DEFAULT_CONTEXT: TextRenderContext = { columns: DEFAULT_CLI_COLUMNS, color: false };

function identity(id: string, alias?: string): string {
  return `${safeText(id)}${alias === undefined ? "" : ` (${safeText(alias)})`}`;
}

type DisplayAssociation =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "associated"; contractId: string }>
  | Readonly<{ kind: "failed"; diagnostic: string }>;

/** The one human-fact separator of this family. */
const FACT_SEPARATOR = " · ";

/** A supporting fact of an action receipt or an observation panel is one indent deep. */
const SUBORDINATE_INDENT = "  ";

/** Indent already-decided supporting lines one level, for every caller of this family. */
function subordinateLines(lines: readonly string[]): readonly string[] {
  return lines.map((line) => `${SUBORDINATE_INDENT}${line}`);
}

/**
 * The one observation identity line: complete Akuma identity, optional alias as a parenthetical
 * supplement, and a known associated Contract inline behind the shared separator.
 * The execution directory and any already-exposed effective actions belong above the content
 * boundary; an absent coordinate is an absent line.
 */
export function panelHead(
  id: string,
  alias: string | undefined,
  contract: DisplayAssociation | undefined,
  context: readonly string[] = [],
): readonly string[] {
  const contractId = contract?.kind === "associated" ? contract.contractId : undefined;
  const line = `${identity(id, alias)}${contractId === undefined ? "" : `${FACT_SEPARATOR}${contractId}`}`;
  return [line, ...subordinateLines(context)];
}

/**
 * One action receipt: the verdict and the complete subject on the first line, every supporting fact
 * indented beneath it. Identity and evidence are never merged into one punctuation run.
 */
export function actionReceipt(
  input: Readonly<{
    mark: "✓" | "⧗" | "!" | "○";
    verb: string;
    id: string;
    alias?: string;
    evidence?: readonly string[];
  }>,
): readonly string[] {
  return [`${input.mark} ${input.verb} ${identity(input.id, input.alias)}`, ...subordinateLines(input.evidence ?? [])];
}

function lifeConclusion(life: AkumaStatus["life"], pending: boolean): Readonly<{ mark: string; verb: string }> {
  if (life === "running") return { mark: "●", verb: "running" };
  if (life === "asleep") return pending ? { mark: "⧗", verb: "pending tell" } : { mark: "✓", verb: "completed" };
  if (life === "killed") return { mark: "×", verb: "killed" };
  if (life === "hung") return { mark: "?", verb: "hung" };
  return { mark: "!", verb: life };
}

function renderReportedChangeLines(view: AkumaObservation): readonly string[] {
  const changes = view.changes ?? [];
  if (changes.length === 0 && view.moreChanges !== true && view.outsideChanges === undefined) return [];
  return [
    "changes",
    ...changes.map((change) => `  ${renderDiffstat(change.diffstat)}  ${safeText(change.path)}`),
    ...(view.moreChanges === true ? [`  ${omissionText()}`] : []),
    ...(view.outsideChanges === undefined ? [] : [`  ${view.outsideChanges} outside worktree`]),
  ];
}

type SnapshotView = AkumaObservation;

export function currentWorkLines(work: CurrentWork | AddressedWork): readonly string[] {
  const { awaiting, summary, outcome } = work;
  return [
    ...(awaiting !== undefined
      ? [`${awaiting.id} approval`, ...subordinateLines(approvalLines(awaiting.requests, awaiting.clipped))]
      : summary === undefined
        ? []
        : [`${summary.id} ${safeText(summary.text)}`]),
    ...(work.pending === undefined ? [] : [`pending input ${work.pending.map((item) => item.id).join(" ")}`]),
    ...(outcome === undefined
      ? []
      : "state" in outcome
        ? outcome.state === "running"
          ? []
          : [
              `${outcome.state} ${outcome.turn}`,
              ...("reason" in outcome ? exactIndentedLines(outcome.reason, "  ") : []),
            ]
        : [`${outcome.verdict} ${outcome.historyId}`]),
  ];
}

function snapshotConclusion(status: AkumaObservation): string {
  const conclusion = lifeConclusion(status.life, status.work.pending !== undefined);
  const outcome = status.work.outcome;
  const turn = outcome?.state === "running" ? ` ${outcome.turn}` : "";
  return `${conclusion.mark} ${conclusion.verb}${turn}${status.strandedReason === undefined ? "" : ` · ${status.strandedReason}`}`;
}

export function snapshotText(
  view: SnapshotView,
  context: TextRenderContext,
  options: Readonly<{ alias?: string }> = {},
): string {
  // A source later than the observation reads as the whole word `now`, so the surface only appends
  // a unit suffix when the age actually names a unit.
  const activityAge =
    view.lastActivityAt === undefined
      ? undefined
      : ageText(view.lastActivityAt, new Date(context.now ?? Date.now()).toISOString());
  const head = panelHead(view.id, options.alias, view.contract, [
    safeText(view.cwd),
    ...(activityAge === undefined
      ? []
      : [`${view.life} · last activity ${activityAge === "now" ? activityAge : `${activityAge} ago`}`]),
  ]);
  const { surveillants } = view;
  return [
    ...head,
    ...currentWorkLines(view.work),
    snapshotConclusion(view),
    ...subordinateLines([
      ...renderReportedChangeLines(view),
      ...(surveillants === undefined
        ? []
        : surveillants.kind === "unavailable"
          ? diagnosticLines("surveillants", surveillants.diagnostic)
          : surveillants.owners.length === 0
            ? ["surveillants none"]
            : ["surveillants", ...subordinateLines(surveillants.owners.map(opaqueCoordinate))]),
      ...(view.contract?.kind === "failed" ? diagnosticLines("contract association", view.contract.diagnostic) : []),
    ]),
  ].join("\n");
}

function killResultLabel(
  evidence: KillAdmission["outcome"],
): Readonly<{ mark: "✓" | "!"; verb: string; evidence: readonly string[] }> {
  if (evidence === "killed") return { mark: "✓", verb: "killed", evidence: [] };
  if (evidence === "already-killed") return { mark: "✓", verb: "already killed", evidence: [] };
  if (evidence === "already-stopped") return { mark: "✓", verb: "already stopped", evidence: [] };
  if (evidence === "stop-admitted") return { mark: "!", verb: "stop admitted", evidence: [] };
  return { mark: "!", verb: "not killed", evidence: [evidence] };
}

export function killResultText(id: string, evidence: KillAdmission["outcome"], alias?: string): string {
  const label = killResultLabel(evidence);
  return actionReceipt({
    mark: label.mark,
    verb: label.verb,
    id,
    ...(alias === undefined ? {} : { alias }),
    evidence: label.evidence,
  }).join("\n");
}

/** Presentation-only state for one akuma invocation; it never reaches JSON. */
type AkumaPresentation = Readonly<{
  alias?: string;
}>;

export function askRawAnswer(result: AkumaAskResult): string | undefined {
  return result.kind === "answered" ? JSON.stringify(result.answer) : undefined;
}

export function waitStateMark(state: string): string {
  if (state === "running" || state === "waiting") return "⧗";
  if (state === "failed") return "✗";
  if (state === "canceled") return "⊘";
  if (state === "missing" || state === "unavailable") return "?";
  return "✓";
}

function turnOutcomeLines(outcome: SettledTurn, indent: string, label = ""): string[] {
  return [
    `${indent}${label}${outcome.state} ${outcome.turn}`,
    ...("answer" in outcome
      ? exactIndentedLines(outcome.answer, `${indent}  `)
      : "reason" in outcome
        ? exactIndentedLines(outcome.reason, `${indent}  `)
        : []),
  ];
}

export function akumaWaitMemberText(member: AkumaWaitItem, alias?: string): string {
  const { state } = member;
  const recent = state === "running" ? member.events : undefined;
  return [
    `${waitStateMark(state)} ${identity(member.akuma, alias)}  ${state}${"turn" in member && member.turn !== undefined ? ` ${member.turn}` : ""}`,
    ...("answer" in member
      ? exactIndentedLines(member.answer, "  ")
      : "reason" in member && member.reason !== undefined
        ? exactIndentedLines(member.reason, "  ")
        : []),
    ...("last" in member && member.last !== undefined ? turnOutcomeLines(member.last, "  ", "last ") : []),
    ...(recent === undefined
      ? []
      : "reason" in recent
        ? diagnosticLines("recent activity", recent.reason)
        : recent.map(({ text }) => text).filter(Boolean)),
  ].join("\n");
}

export function waitText(result: AkumaWaitResult, presentation: AkumaPresentation): string {
  const alias = result.results.length === 1 ? presentation.alias : undefined;
  return result.results.map((member) => akumaWaitMemberText(member, alias)).join("\n");
}

export function historyText(
  result: AkumaHistoryResult,
  presentation: AkumaPresentation & Readonly<{ id?: string; since?: number }>,
): string {
  if (result.kind === "akuma-activity") return exactActivityText(result.row);
  if (result.kind === "akuma-exact") {
    const { outcome } = result;
    return outcome.state === "done" ? outcome.answer : outcome.state === "failed" ? outcome.reason : "canceled";
  }
  if (result.kind === "akuma-answer") return result.answer;
  if (result.kind === "akuma-report") return result.text;
  if (result.kind === "akuma-no-answer") return "no answer retained";
  if (result.kind === "akuma-unknown-history") return `${presentation.id} has no matching retained history`;
  const omitted = result.omitted === undefined ? [] : [`  ${omissionText(result.omitted)}`];
  return [
    ...panelHead(result.akumaId, presentation.alias, undefined),
    ...(presentation.since === undefined ? omitted : []),
    ...result.events.map(({ text }) => text).filter(Boolean),
    ...(presentation.since === undefined ? [] : omitted),
  ].join("\n");
}

function diagnosticLines(subject: string, cause: string, status = "unavailable", suffix = ""): readonly string[] {
  return [`! ${subject} ${status}${safeText(suffix)}`, ...exactIndentedLines(cause, "  ")];
}

export function callFailureLines(
  failures: readonly Extract<SpawnResult, { kind: "failed" }>["failures"][number][],
): readonly string[] {
  return failures.flatMap((failure) => {
    if (failure.stage === "dispatch")
      return failure.failure.kind === "conflict"
        ? [`! dispatch failed conflict ${failure.failure.currentContractId}`]
        : exactIndentedLines(`! dispatch failed ${failure.failure.kind} ${failure.failure.diagnostic}`, "");
    if (failure.stage === "wake")
      return diagnosticLines(
        "tell delivery",
        failure.diagnostic,
        failure.reason === undefined ? "failed" : `failed · ${failure.reason}`,
        failure.logPath === undefined ? "" : ` · log ${failure.logPath}`,
      );
    return [
      ...exactIndentedLines(
        `! ${failure.stage} failed ${"kind" in failure ? `${failure.kind} ` : ""}${failure.diagnostic}`,
        "",
      ),
      ...("attemptedTellId" in failure && failure.attemptedTellId !== undefined
        ? [`attempted input ${safeText(failure.attemptedTellId)}`]
        : []),
    ];
  });
}

export function tellControlLines(
  result: Readonly<{
    action?: SpawnResult["action"];
    wake?: AkumaAskResult["wake"];
    interrupt?: Extract<AkumaTellResult, { result: "failed" }>["interrupt"];
    failures?: Extract<AkumaTellResult, { result: "failed" }>["failures"];
  }>,
): readonly string[] {
  const lines: string[] = [];
  if (result.action !== undefined) lines.push(`${result.action.kind} ${result.action.historyId}`);
  const wake = result.wake;
  if (wake?.kind === "failed") {
    lines.push(...callFailureLines([{ ...wake, stage: "wake" }]));
  } else if (wake?.kind === "pending") lines.push("wake pending");
  const interrupt = result.interrupt;
  if (interrupt !== undefined)
    lines.push(`interrupt ${interrupt.kind}${interrupt.kind === "unavailable" ? ` · ${interrupt.evidence}` : ""}`);
  return [...lines, ...callFailureLines(result.failures ?? [])];
}

export function tellText(
  result: AkumaTellResult,
  prompt: string,
  alias: string | undefined,
  exceptional = false,
): string {
  if ("result" in result) {
    const turn = result.turn === undefined ? "" : ` ${result.turn}`;
    if (result.result === "told" && !exceptional) return `▸ ${alias ?? result.akumaId}  told${turn}`;
    const head = `! ${result.akumaId}  tell${turn}`;
    const [preview] = previewLines(prompt, "", 1);
    return [
      preview ? `${head} — ${preview}` : head,
      ...(result.result === "failed" ? subordinateLines(tellControlLines(result)) : []),
      ...(result.result === "failed" && result.outcome !== undefined ? turnOutcomeLines(result.outcome, "  ") : []),
    ].join("\n");
  }
  return [
    `${waitStateMark(result.state)} ${alias ?? result.akumaId}  ${result.state}${"turn" in result ? ` ${result.turn}` : ""}`,
    ...("answer" in result
      ? exactIndentedLines(result.answer, "  ")
      : "reason" in result
        ? exactIndentedLines(result.reason, "  ")
        : []),
  ].join("\n");
}
