import type { AkumaStatus } from "../../akuma/akuma.js";
import type { KillAdmission } from "../../akuma/akuma-errors.js";
import type { ActivityRow } from "../../akuma/projection.js";
import { parseExactHistorySelector } from "../../akuma/identity.js";
import {
  permissionText,
  renderDiffstat,
  toolRepr,
  type ToolRepr,
  type CurrentWork,
} from "../../akuma/status-projection.js";
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
  diagnosticLines,
  displayColumns,
  padToDisplay,
  renderBoundedPayload,
  safeText,
  truncateDisplayText,
  type TextRenderContext,
} from "./terminal.js";

export const DEFAULT_CONTEXT: TextRenderContext = { columns: DEFAULT_CLI_COLUMNS, color: false };

/** The action family's fixed 3-cell state margin and minimum verb cell. */
const ACTION_MARGIN = "   ";
const ACTION_VERB_WIDTH = 6;
/** Top-level rows: one mark plus its separator, and two spaces beneath it. */
const TOP_SPEAK = "▎ ";
const TOP_INPUT = "▸ ";
const TOP_PENDING = "⧗ ";
const TOP_ANSWER = "✓ ";
const TOP_FAILURE = "! ";
const TOP_CONTINUATION = "  ";
/** The one row-omission glyph, in verb position. */
const OMISSION = "···";

/**
 * The one blessed ruler: a run of U+2500 as wide as the frame head's widest line,
 * never wider than the terminal, marking the boundary between an observation
 * frame and its content.
 */
export function frameRule(headLines: readonly string[], columns?: number): string {
  const widest = headLines.reduce((widest, line) => Math.max(widest, displayColumns(line)), 0);
  const width = columns === undefined ? widest : Math.min(widest, Math.max(0, columns));
  return "─".repeat(width);
}

type RenderRow = ActivityRow;

function identity(id: string, alias?: string): string {
  return `${id}${alias === undefined ? "" : ` (${alias})`}`;
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
export function subordinateLines(lines: readonly string[]): readonly string[] {
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

function contractFacts(contract: DisplayAssociation, columns: number): readonly string[] {
  return contract.kind === "failed" ? diagnosticLines("contract association", contract.diagnostic, columns) : [];
}

/** Frozen history never asserts continuing tool liveness. */
function toolMargin(row: Extract<RenderRow, { kind: "tool" }>): string {
  if (row.phase === "started") return "?  ";
  return row.result?.status === "ok" ? ACTION_MARGIN : "!  ";
}

function rowText(row: Exclude<RenderRow, { kind: "tool" }>): Readonly<{
  text: string;
  lines: number;
}> {
  if (
    row.kind === "report" ||
    row.kind === "said" ||
    row.kind === "thought" ||
    row.kind === "note" ||
    row.kind === "call" ||
    row.kind === "tell"
  ) {
    return {
      text: row.text,
      lines: row.kind === "said" || row.kind === "thought" ? 2 : row.kind === "tell" || row.kind === "call" ? 1 : 2,
    };
  }
  if (row.kind === "permission") return { text: permissionText(row), lines: 2 };
  if (row.kind === "outcome")
    return row.outcome.kind === "answered"
      ? { text: row.outcome.answer, lines: 3 }
      : { text: row.outcome.kind === "canceled" ? "canceled" : row.outcome.diagnostic, lines: 2 };
  return { text: "", lines: 1 };
}

/**
 * The action family's one prefix: a state margin, a verb cell at least six cells wide and as wide as a
 * longer name, then one space. Continuation lines align with the actual content start.
 */
function actionPrefix(
  margin: string,
  verb: string,
  columns: number,
): Readonly<{ first: string; continuation: string }> {
  const available = Math.max(0, columns - displayColumns(margin) - 1);
  const width = Math.min(Math.max(ACTION_VERB_WIDTH, displayColumns(verb)), available);
  const label = truncateDisplayText(verb, width);
  return {
    first: `${margin}${padToDisplay(label, width)} `,
    continuation: " ".repeat(displayColumns(margin) + width + 1),
  };
}

/** One row's shared prefix family and observation context. */
type RowView = Readonly<{
  /** History expands narrative payloads and complete diagnostics. */
  history?: true;
}>;

function rowPrefix(
  row: RenderRow,
  tool: ToolRepr | undefined,
  columns: number,
  view: RowView,
): Readonly<{ first: string; continuation: string }> {
  if (row.kind === "tool") return actionPrefix(toolMargin(row), tool!.label, columns);
  if (row.kind === "thought") return actionPrefix(ACTION_MARGIN, "think", columns);
  if (row.kind === "report") {
    if (view.history !== true) return actionPrefix(ACTION_MARGIN, "report", columns);
    const first = `${ACTION_MARGIN}report/${row.sequence} `;
    return { first, continuation: " ".repeat(displayColumns(first)) };
  }
  if (row.kind === "note") return actionPrefix(ACTION_MARGIN, "note", columns);
  if (row.kind === "permission") return actionPrefix(ACTION_MARGIN, "approval", columns);
  if (row.kind === "outcome")
    return {
      first: row.outcome.kind === "answered" ? TOP_ANSWER : row.outcome.kind === "canceled" ? "○ " : TOP_FAILURE,
      continuation: TOP_CONTINUATION,
    };
  if (row.kind === "said") return { first: TOP_SPEAK, continuation: TOP_SPEAK };
  if (row.kind === "tell" && row.state === "pending") return { first: TOP_PENDING, continuation: TOP_CONTINUATION };
  return { first: TOP_INPUT, continuation: TOP_CONTINUATION };
}

function omissionMarker(text: string, columns: number): string {
  return `${actionPrefix(ACTION_MARGIN, OMISSION, columns).first}${text}`;
}

/** Every selected timeline row renders through here: one prefix family per row class. */
function renderRow(row: RenderRow, context: TextRenderContext, view: RowView = {}): readonly string[] {
  const tool = row.kind === "tool" ? toolRepr(row) : undefined;
  const { first, continuation } = rowPrefix(row, tool, context.columns, view);
  const value = row.kind === "tool" ? undefined : rowText(row);
  const text = tool === undefined ? value!.text : tool.text;
  if (view.history === true && row.kind === "outcome") {
    const heading = `${first}turn/${row.turnSequence}`;
    if (row.outcome.kind === "canceled") return [`${heading} · canceled`];
    return [
      heading,
      ...(text === ""
        ? []
        : renderBoundedPayload({
            text,
            first: TOP_CONTINUATION,
            continuation: TOP_CONTINUATION,
            columns: context.columns,
            maxLines: Number.MAX_SAFE_INTEGER,
            quote: "",
            preserveLines: true,
            truncated: "truncated" in row && row.truncated === true,
          })),
    ];
  }
  const singleLine = tool !== undefined || row.kind === "call" || row.kind === "tell" || row.kind === "turn";
  return renderBoundedPayload({
    text,
    first,
    continuation,
    columns: context.columns,
    maxLines: singleLine ? 1 : view.history === true ? Number.MAX_SAFE_INTEGER : value!.lines,
    quote: "",
    truncated: "truncated" in row && row.truncated === true,
    ...(singleLine ? {} : { preserveLines: true as const }),
    ...(tool === undefined
      ? {}
      : {
          trailer: {
            text: tool.suffix,
            diagnostic: tool.diagnostic,
            complete: view.history === true,
          },
        }),
  });
}

function groupedRows(rows: readonly RenderRow[], context: TextRenderContext, view: RowView = {}): readonly string[] {
  return rows.filter((row) => row.kind !== "turn").flatMap((row) => renderRow(row, context, view));
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
  const width = changes.reduce((max, change) => Math.max(max, renderDiffstat(change.diffstat).length), 0);
  return [
    "changes",
    ...changes.map((change) => `  ${renderDiffstat(change.diffstat).padEnd(width)}  ${safeText(change.path)}`),
    ...(view.moreChanges === true ? [`  ${OMISSION} more files`] : []),
    ...(view.outsideChanges === undefined ? [] : [`  ${view.outsideChanges} outside worktree`]),
  ];
}

type SnapshotView = AkumaObservation;

export function currentWorkLines(work: CurrentWork, context: TextRenderContext): readonly string[] {
  const summary = work.summary;
  return [
    ...(summary === undefined
      ? []
      : renderBoundedPayload({
          text: summary.text,
          first: `${summary.id} `,
          continuation: "  ",
          columns: context.columns,
          maxLines: 1,
          quote: "",
          truncated: summary.clipped === true,
        })),
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
  const conclusion = snapshotConclusion(view);
  const content = [...currentWorkLines(view.work, context), ...(conclusion.length === 0 ? [] : [conclusion])];
  return [
    ...head,
    ...(content.length === 0 ? [] : [frameRule(head, context.columns), ...content]),
    ...subordinateLines([
      ...renderReportedChangeLines(view),
      ...contractFacts(view.contract ?? { kind: "none" }, context.columns - SUBORDINATE_INDENT.length),
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
    return `${kind}: ${rowText(row).text}`;
  }
  if (result.kind === "akuma-report") return result.text;
  if (result.kind !== "akuma-exact") return undefined;
  const outcome = result.outcome;
  return outcome.kind === "answered" ? outcome.answer : outcome.kind === "canceled" ? "canceled" : outcome.diagnostic;
}

/** One compact wait result line: an observed life mark, the complete identity, a bounded summary. */
const WAIT_SUMMARY_SEPARATOR = " — ";

function foldedSummary(value: string): string {
  return safeText(value).replace(/\s+/gu, " ").trim();
}

function waitLine(mark: string, subject: string, summary: string, columns: number): string {
  const head = `${mark} ${subject}`;
  const room = columns - displayColumns(head) - displayColumns(WAIT_SUMMARY_SEPARATOR);
  const folded = foldedSummary(summary);
  return room < 1 || folded.length === 0
    ? head
    : `${head}${WAIT_SUMMARY_SEPARATOR}${truncateDisplayText(folded, room)}`;
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
export function waitText(result: AkumaWaitResult, presentation: AkumaPresentation, context: TextRenderContext): string {
  const alias = result.results.length === 1 ? presentation.alias : undefined;
  return result.results
    .map((member) => {
      if (member.kind === "missing")
        return waitLine("!", identity(member.id, alias), "Akuma not found", context.columns);
      if (member.kind === "unobserved")
        return waitLine(
          "!",
          identity(member.id, alias),
          `observation failed${FACT_SEPARATOR}${member.diagnostic}`,
          context.columns,
        );
      const { mark, summary } = waitSummary(member);
      const outcome = member.outcome;
      const payload =
        outcome?.kind === "answered" ? outcome.answer : outcome?.kind === "failed" ? outcome.diagnostic : undefined;
      return [
        waitLine(mark, identity(member.id, alias), summary, context.columns),
        ...(member.lastActivityAt === undefined ? [] : [`  activity ${safeText(member.lastActivityAt)}`]),
        ...groupedRows(member.events ?? [], context),
        ...(member.eventsUnavailable === undefined
          ? []
          : diagnosticLines("recent activity", member.eventsUnavailable, context.columns, { state: "unavailable" })),
        ...(outcome === undefined ? [] : [`  ${outcome.historyId} · ${outcome.kind}`]),
        ...(payload === undefined
          ? []
          : renderBoundedPayload({
              text: payload,
              first: "  ",
              continuation: "  ",
              columns: context.columns,
              maxLines: Number.MAX_SAFE_INTEGER,
              quote: "",
              preserveLines: true,
              truncated: false,
            })),
      ].join("\n");
    })
    .join("\n");
}

export function historyText(
  result: AkumaHistoryResult,
  presentation: AkumaPresentation & Readonly<{ id?: string; answer?: boolean; since?: number }>,
  context: TextRenderContext,
): string {
  if (presentation.id !== undefined) {
    return historyRawAnswer(result, presentation.id) ?? `${presentation.id} has no matching retained history`;
  }
  if (presentation.answer === true) return result.kind === "akuma-answer" ? result.answer : "no answer retained";
  if (result.kind !== "akuma") throw new Error("history result lacks page");
  const rows = groupedRows(result.events, context, { history: true });
  const paging =
    result.omitted === undefined
      ? []
      : [
          omissionMarker(
            presentation.since !== undefined
              ? `${result.omitted} later events · showing first ${result.events.length}`
              : `${result.omitted} earlier events · showing last ${result.events.length}`,
            context.columns,
          ),
        ];
  // History is an immutable timeline, so it takes the shared heading and content boundary and
  // never gains a fabricated current-state conclusion or a live mark.
  const content = [...paging, ...rows];
  const head = panelHead(result.akumaId, presentation.alias, undefined);
  return [...head, ...(content.length === 0 ? [] : [frameRule(head, context.columns), ...content])].join("\n");
}

/** One bounded, quoted preview of a Tell an outer receipt already admitted, indented beneath it. */
export function tellPayloadLines(text: string, context: TextRenderContext): readonly string[] {
  return renderBoundedPayload({
    text,
    first: SUBORDINATE_INDENT,
    continuation: `${SUBORDINATE_INDENT}│ `,
    columns: context.columns,
    maxLines: 1,
    quote: '"',
    truncated: false,
  });
}

export function callFailureLines(
  failures: readonly Extract<SpawnResult, { kind: "failed" }>["failures"][number][],
  context: TextRenderContext,
): readonly string[] {
  return failures.flatMap((failure) => {
    if (failure.stage === "dispatch")
      return [
        failure.failure.kind === "conflict"
          ? `! dispatch failed conflict ${failure.failure.currentContractId}`
          : `! dispatch failed ${failure.failure.kind} ${safeText(failure.failure.diagnostic)}`,
      ];
    if (failure.stage === "wake")
      return diagnosticLines("tell delivery", failure.diagnostic, context.columns - SUBORDINATE_INDENT.length, {
        state: "failed",
        suffix: failure.logPath === undefined ? "" : ` · log ${failure.logPath}`,
      });
    return [
      `! ${failure.stage} failed ${"kind" in failure ? `${failure.kind} ` : ""}${safeText(failure.diagnostic)}`,
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
  context: TextRenderContext,
): readonly string[] {
  const lines: string[] = [];
  if (result.action !== undefined) lines.push(`${result.action.kind} ${result.action.historyId}`);
  const wake = result.wake;
  if (wake?.kind === "failed") {
    lines.push(...callFailureLines([{ ...wake, stage: "wake" }], context));
  } else if (wake?.kind === "pending") lines.push("wake pending");
  const interrupt = result.interrupt;
  if (interrupt !== undefined)
    lines.push(`interrupt ${interrupt.kind}${interrupt.kind === "unavailable" ? ` · ${interrupt.evidence}` : ""}`);
  return [...lines, ...callFailureLines(result.failures ?? [], context)];
}

/**
 * Only unresolved or failed Tell receipts need the submitted payload preview.
 */
export function tellText(
  result: AkumaTellResult,
  prompt: string,
  alias: string | undefined,
  context: TextRenderContext,
): string {
  const wake = result.wake;
  const mark = result.kind === "failed" ? "!" : wake?.kind === "pending" ? "⧗" : "✓";
  const verb = result.kind === "failed" || wake?.kind === "pending" || result.action !== undefined ? "tell" : "told";
  const head = actionReceipt({
    mark,
    verb,
    id: result.akumaId,
    ...(alias === undefined ? {} : { alias }),
  })[0]!;
  const preview = result.action === undefined ? safeText(prompt).replace(/\s+/gu, " ").trim() : "";
  const prefix = `${head} — `;
  // The verdict and identity never truncate, so an over-wide identity still keeps one visible
  // ellipsis for the input it could not show.
  const room = Math.max(1, context.columns - displayColumns(prefix));
  const verdict = preview.length === 0 ? head : `${prefix}${truncateDisplayText(preview, room)}`;
  return [verdict, ...subordinateLines(tellControlLines(result, context))].join("\n");
}
