import type { AkumaStatus } from "../../akuma/akuma.js";
import type { KillAdmission } from "../../akuma/akuma-errors.js";
import type { ActivityRow, PermissionRow } from "../../akuma/projection.js";
import { parseExactHistorySelector } from "../../akuma/identity.js";
import { permissionText, renderDiffstat, toolRepr, type CurrentWork } from "../../akuma/status-projection.js";
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

function rowText(row: Exclude<ActivityRow, { kind: "tool" }>): string {
  if (
    row.kind === "report" ||
    row.kind === "said" ||
    row.kind === "thought" ||
    row.kind === "note" ||
    row.kind === "call" ||
    row.kind === "tell"
  ) {
    return row.text;
  }
  if (row.kind === "permission") return permissionText(row);
  if (row.kind === "outcome")
    return row.outcome.kind === "answered"
      ? row.outcome.answer
      : row.outcome.kind === "canceled"
        ? "canceled"
        : row.outcome.diagnostic;
  return "";
}

function toolLines(row: Extract<ActivityRow, { kind: "tool" }>): readonly string[] {
  const { call, result } = row;
  const tool = toolRepr(row);
  const mark = row.phase === "started" ? "?" : result?.status === "ok" ? " " : "!";
  const label = tool.label === row.name ? tool.label : `${tool.label} (${row.name})`;
  const lines = [`${mark} ${safeText(label)} ${row.sequence}`];
  let path: string | undefined;
  let text = tool.text;
  let clipped = row.truncated;
  switch (call.kind) {
    case "read":
      path = call.path;
      text = "";
      break;
    case "fileChange": {
      const [first, second] = call.changes;
      if (first !== undefined) {
        path = first.path;
        text = second === undefined ? "" : `${call.changes.length} files`;
      }
      break;
    }
    case "search":
      if (call.path !== undefined) {
        path = call.path;
        text = [call.query, call.glob].filter(Boolean).join(FACT_SEPARATOR);
      }
      break;
    case "other":
      if (call.input !== undefined) {
        text = call.input.json;
        clipped ||= call.input.truncated;
      }
      break;
  }
  const clauses = tool.suffix.trimStart().replace(/^(?:· |— )/u, "");
  const detail = [clauses, result?.exitCode === 0 ? "exit 0" : ""].filter(Boolean).join(FACT_SEPARATOR);
  if (path !== undefined) lines.push(`  path  ${safeText(path)}`);
  if (text !== "" || clipped) lines.push(...previewLines(text, "  ", 1, clipped));
  if (detail !== "") lines.push(`  detail  ${safeText(detail)}`);
  if (tool.diagnostic !== "") lines.push("  cause", ...previewLines(tool.diagnostic, "    "));
  return lines;
}

function approvalLines(requests: PermissionRow["requests"], clipped?: true): readonly string[] {
  const lines = requests.map(({ action, tool, resources }) =>
    [action, ...(tool === undefined ? [] : [tool]), ...resources].map(safeText).join(FACT_SEPARATOR),
  );
  if (lines.length === 0) lines.push("Approval wait cleared");
  else lines[0] = `Awaiting approval: ${lines[0]}`;
  return clipped ? [...lines, "…"] : lines;
}

function renderRow(row: Exclude<ActivityRow, { kind: "turn" }>): readonly string[] {
  if (row.kind === "tool") return toolLines(row);
  if (row.kind === "permission")
    return [`  approval ${row.sequence}`, ...subordinateLines(approvalLines(row.requests, row.truncated))];
  const lead = (() => {
    switch (row.kind) {
      case "report":
        return `  report/${row.sequence}`;
      case "outcome":
        return `${row.outcome.kind === "answered" ? "✓" : row.outcome.kind === "canceled" ? "○" : "!"} turn/${row.turnSequence}`;
      case "said":
        return `▎ ${row.sequence}`;
      case "tell":
        return `${row.state === "pending" ? "⧗" : "▸"} ${safeText(row.tellId)} · ${row.sequence}`;
      case "call":
        return `▸ ${row.sequence}`;
      case "thought":
        return `  think ${row.sequence}`;
      case "note":
        return `  note ${row.sequence}`;
    }
  })();
  if (row.kind === "outcome" && row.outcome.kind === "canceled") return [`${lead} · canceled`];
  const text = rowText(row);
  const clipped = "truncated" in row && row.truncated === true;
  return [
    lead,
    ...(text === "" && !clipped
      ? []
      : previewLines(text, "  ", row.kind === "call" || row.kind === "tell" ? 1 : 3, clipped)),
  ];
}

function activityLines(rows: readonly ActivityRow[]): readonly string[] {
  return rows.flatMap((row) => (row.kind === "turn" ? [] : renderRow(row)));
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
    ...(work.outcome === undefined
      ? []
      : [`${work.outcome.verdict} ${work.outcome.historyId} · activity ${work.outcome.activityId}`]),
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
  return [
    ...head,
    ...currentWorkLines(view.work),
    snapshotConclusion(view),
    ...subordinateLines([
      ...renderReportedChangeLines(view),
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

export function historyRawAnswer(result: AkumaHistoryResult, historyId: string | undefined): string | undefined {
  if (historyId === undefined) return undefined;
  const selector = parseExactHistorySelector(historyId);
  if (selector?.kind === "activity" && result.kind === "akuma" && result.events.length === 1) {
    const row = result.events[0]!;
    if (row.sequence !== selector.sequence || row.kind === "turn" || row.kind === "outcome") return undefined;
    if (row.kind === "tool") {
      const tool = toolRepr(row);
      const prefix = row.phase === "completed" && row.result?.status === "error" ? "error: " : "";
      return `${prefix}${tool.label} ${tool.text}${tool.suffix}${tool.diagnostic === "" ? "" : ` · ${tool.diagnostic}`}`;
    }
    const kind = row.kind === "tell" && row.state === "pending" ? "pending-tell" : row.kind;
    return `${kind}: ${rowText(row)}`;
  }
  if (result.kind === "akuma-report") return result.text;
  if (result.kind !== "akuma-exact") return undefined;
  const outcome = result.outcome;
  return outcome.kind === "answered" ? outcome.answer : outcome.kind === "canceled" ? "canceled" : outcome.diagnostic;
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
        ...activityLines(member.events ?? []),
        ...(member.eventsUnavailable === undefined ? [] : diagnosticLines("recent activity", member.eventsUnavailable)),
        ...(outcome === undefined ? [] : [`  ${outcome.historyId} · ${outcome.kind}`]),
        ...(payload === undefined ? [] : exactIndentedLines(payload, "  ")),
      ].join("\n");
    })
    .join("\n");
}

export function historyText(
  result: AkumaHistoryResult,
  presentation: AkumaPresentation & Readonly<{ id?: string; answer?: boolean; since?: number }>,
): string {
  if (presentation.id !== undefined) {
    return historyRawAnswer(result, presentation.id) ?? `${presentation.id} has no matching retained history`;
  }
  if (presentation.answer === true) return result.kind === "akuma-answer" ? result.answer : "no answer retained";
  if (result.kind !== "akuma") throw new Error("history result lacks page");
  const paging = presentation.since !== undefined ? "later events · showing first" : "earlier events · showing last";
  return [
    ...panelHead(result.akumaId, presentation.alias, undefined),
    ...(result.omitted === undefined ? [] : [`  ${OMISSION} ${result.omitted} ${paging} ${result.events.length}`]),
    ...activityLines(result.events),
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
