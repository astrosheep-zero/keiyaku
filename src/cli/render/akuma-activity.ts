import type { AkumaStatus } from "../../akuma/akuma.js";
import type { KillAdmission } from "../../akuma/akuma-errors.js";
import type { CurrentWork } from "../../akuma/status-projection.js";
import { approvalLines, exactActivityText, outcomeText, renderDiffstat } from "../../akuma/timeline-text.js";
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
  opaqueCoordinate,
  previewLines,
  safeText,
  type TextRenderContext,
} from "./terminal.js";

export const DEFAULT_CONTEXT: TextRenderContext = { columns: DEFAULT_CLI_COLUMNS, color: false };

const OMISSION = "···";

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
    ...(view.moreChanges === true ? [`  ${OMISSION} more files`] : []),
    ...(view.outsideChanges === undefined ? [] : [`  ${view.outsideChanges} outside worktree`]),
  ];
}

type SnapshotView = AkumaObservation;

export function currentWorkLines(work: CurrentWork): readonly string[] {
  const { awaiting, summary } = work;
  return [
    ...(awaiting !== undefined
      ? [`${awaiting.id} approval`, ...subordinateLines(approvalLines(awaiting.requests, awaiting.clipped))]
      : summary === undefined
        ? []
        : [`${summary.id} ${safeText(summary.text)}`]),
    ...(work.pending === undefined ? [] : [`pending input ${work.pending.map((item) => item.id).join(" ")}`]),
    ...(work.outcome === undefined ? [] : [`${work.outcome.verdict} ${work.outcome.historyId}`]),
  ];
}

function snapshotConclusion(status: AkumaObservation): string {
  const conclusion = lifeConclusion(status.life, status.work.pending !== undefined);
  return `${conclusion.mark} ${conclusion.verb}${status.strandedReason === undefined ? "" : ` · ${status.strandedReason}`}`;
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

/**
 * The final public snapshot as one wait summary. A stopped life stays explicit over any older
 * outcome; pending input stays visible beside the life it belongs to; a sleeping member without
 * pending input shows its settled outcome, else completion. The mark reports the observed life,
 * never continuing liveness.
 */
function waitSummary(
  member: Extract<AkumaWaitItem, { kind: "observed" }>,
): Readonly<{ mark: string; summary: string }> {
  const pending = member.pending !== undefined;
  const outcome = member.outcome;
  const observed =
    member.life === "asleep" && !pending && outcome !== undefined
      ? outcome.kind === "answered"
        ? { mark: "✓", verb: "answered" }
        : outcome.kind === "canceled"
          ? { mark: "○", verb: "canceled" }
          : { mark: "!", verb: "failed" }
      : lifeConclusion(member.life, pending);
  const stopped = member.life !== "asleep";
  return {
    mark: observed.mark,
    summary: [
      observed.verb,
      ...(pending && stopped ? ["pending tell"] : []),
      ...(outcome?.kind === "failed" && (stopped || pending) ? ["failed"] : []),
      ...(member.strandedReason === undefined ? [] : [member.strandedReason]),
    ].join(FACT_SEPARATOR),
  };
}

/** Compact final facts, actual recent events, and an exact-turn full outcome; never a live frame. */
export function waitText(result: AkumaWaitResult, presentation: AkumaPresentation): string {
  const alias = result.results.length === 1 ? presentation.alias : undefined;
  return result.results
    .map((member) => {
      const subject = identity(member.id, alias);
      if (member.kind === "missing") return `! ${subject} — Akuma not found`;
      if (member.kind === "unobserved") {
        const cause = `! ${subject} — observation failed${FACT_SEPARATOR}${member.diagnostic}`;
        return exactIndentedLines(cause, "").join("\n");
      }
      const { mark, summary } = waitSummary(member);
      const outcome = member.outcome;
      const payload =
        outcome?.kind === "answered" ? outcome.answer : outcome?.kind === "failed" ? outcome.diagnostic : undefined;
      return [
        `${mark} ${subject} — ${summary}`,
        ...(member.lastActivityAt === undefined ? [] : [`  activity ${safeText(member.lastActivityAt)}`]),
        ...(member.events ?? []).map(({ text }) => text).filter(Boolean),
        ...(member.eventsUnavailable === undefined ? [] : diagnosticLines("recent activity", member.eventsUnavailable)),
        ...(outcome === undefined ? [] : [`  ${outcome.historyId} · ${outcome.kind}`]),
        ...(payload === undefined ? [] : exactIndentedLines(payload, "  ")),
      ].join("\n");
    })
    .join("\n");
}

export function historyText(
  result: AkumaHistoryResult,
  presentation: AkumaPresentation & Readonly<{ id?: string; since?: number }>,
): string {
  if (result.kind === "akuma-activity") return exactActivityText(result.row);
  if (result.kind === "akuma-exact") return outcomeText(result.outcome);
  if (result.kind === "akuma-answer") return result.answer;
  if (result.kind === "akuma-report") return result.text;
  if (result.kind === "akuma-no-answer") return "no answer retained";
  if (result.kind === "akuma-unknown-history") return `${presentation.id} has no matching retained history`;
  const paging = presentation.since !== undefined ? "later events · showing first" : "earlier events · showing last";
  return [
    ...panelHead(result.akumaId, presentation.alias, undefined),
    ...(result.omitted === undefined ? [] : [`  ${OMISSION} ${result.omitted} ${paging} ${result.events.length}`]),
    ...result.events.map(({ text }) => text).filter(Boolean),
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
        "failed",
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
    action?: AkumaTellResult["action"];
    wake?: AkumaAskResult["wake"];
    interrupt?: AkumaTellResult["interrupt"];
    failures?: Extract<AkumaTellResult, { kind: "failed" }>["failures"];
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

/** A confirmed ordinary Tell names the caller's selector and settled action, without a payload preview. */
export function tellText(
  result: AkumaTellResult,
  prompt: string,
  alias: string | undefined,
  exceptional = false,
): string {
  const action =
    !exceptional &&
    result.kind === "admitted" &&
    result.wake === undefined &&
    result.input === undefined &&
    result.interrupt === undefined
      ? result.action
      : undefined;
  if (action !== undefined) {
    const selector = alias ?? result.akumaId;
    const settled = action.kind === "started" ? "started" : "steered";
    return `✓ ${selector} ${settled} ${action.historyId}`;
  }
  const wake = result.wake;
  const mark = result.kind === "failed" ? "!" : wake?.kind === "pending" ? "⧗" : "✓";
  const verb = result.kind === "failed" || wake?.kind === "pending" || result.action !== undefined ? "tell" : "told";
  const head = actionReceipt({
    mark,
    verb,
    id: result.akumaId,
    ...(alias === undefined ? {} : { alias }),
  })[0]!;
  const [preview] = result.action === undefined ? previewLines(prompt, "", 1) : [];
  const verdict = preview ? `${head} — ${preview}` : head;
  return [verdict, ...subordinateLines(tellControlLines(result))].join("\n");
}
