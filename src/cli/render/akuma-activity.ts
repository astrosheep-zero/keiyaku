import { defaultWaitComplete } from "../../akuma/akuma-observe.js";
import type { AkumaStatus } from "../../akuma/akuma.js";
import type { KillEvidence } from "../../akuma/heart/index.js";
import type { ActivityRow } from "../../akuma/projection.js";
import type {
  AkumaAskObservation,
  AkumaAskResult,
  AkumaTellResult,
  AkumaWaitResult,
} from "../../akuma/selection-observation.js";
import type { AkumaObservation, CreatedDebtObservation, DispatchAssociation } from "../../index.js";
import type { CallObservation, CallResult } from "../../library/akuma-creation.js";
import type { AkumaHistoryResult } from "../../library/selection.js";
import { renderDiffstat, toolContent, toolRepr, type ToolRepr } from "./akuma-tool.js";
import { dispositionText } from "./debt.js";
import { debtDispositionMark } from "./marks.js";
import {
  DEFAULT_CLI_COLUMNS,
  displayColumns,
  padToDisplay,
  renderBoundedPayload,
  renderBoundedTextBlock,
  safeText,
  takeDisplayColumns,
  takeDisplayColumnsFromEnd,
  truncateDisplayText,
  truncateMiddleDisplayText,
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

/** Tool rows an activity view prints after each say or Tell checkpoint; the surplus folds in place. */
const TOOL_BUDGET = 3;

type StatusTimeline = AkumaObservation["status"]["timeline"];
type StatusTimelineEntry = StatusTimeline["entries"][number];
type RenderRow = ActivityRow | Extract<StatusTimelineEntry, { kind: "row" }>["row"];
type RenderEntry = Readonly<{ kind: "gap"; count: number }> | Readonly<{ kind: "row"; row: RenderRow }>;
type RenderedSnapshot = StatusTimeline;
type RenderedActivity = Readonly<{ snapshot: RenderedSnapshot; rows: readonly ActivityRow[] }>;
type CurrentTurnBoundary = Readonly<{ row: RenderRow; turnSequence: number }>;

function identity(id: string, alias?: string): string {
  return `${id}${alias === undefined ? "" : ` (${alias})`}`;
}

function associatedContractId(contract: DispatchAssociation): string | undefined {
  return contract.kind === "associated" ? contract.contractId : undefined;
}

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
 */
function panelIdentity(id: string, alias?: string, contract?: DispatchAssociation): string {
  const contractId = contract === undefined ? undefined : associatedContractId(contract);
  return `${identity(id, alias)}${contractId === undefined ? "" : `${FACT_SEPARATOR}${contractId}`}`;
}

/**
 * Identity and its static coordinates. The execution directory and any already-exposed effective
 * actions belong above the content boundary; an absent coordinate is an absent line.
 */
export function panelHead(
  id: string,
  alias: string | undefined,
  contract: DispatchAssociation | undefined,
  context: readonly string[] = [],
): readonly string[] {
  return [panelIdentity(id, alias, contract), ...subordinateLines(context)];
}

/**
 * One action receipt: the verdict and the complete subject on the first line, every supporting fact
 * indented beneath it. Identity and evidence are never merged into one punctuation run.
 */
export function actionReceipt(
  input: Readonly<{
    mark: "✓" | "⧗" | "!";
    verb: string;
    id: string;
    alias?: string;
    evidence?: readonly string[];
  }>,
): readonly string[] {
  return [`${input.mark} ${input.verb} ${identity(input.id, input.alias)}`, ...subordinateLines(input.evidence ?? [])];
}

function contractFacts(contract: DispatchAssociation): readonly string[] {
  return contract.kind === "failed" ? [`! contract failed ${safeText(contract.diagnostic)}`] : [];
}

/** The action family's one mark cell: a settled success stays blank, and live is only a frame mark. */
function toolMargin(row: Extract<RenderRow, { kind: "tool" }>, live: boolean): string {
  if (row.state === "active") return live ? "●  " : "?  ";
  if (row.state === "unsettled") return "?  ";
  return row.state.status === "ok" ? ACTION_MARGIN : "!  ";
}

function rowText(
  row: RenderRow,
  tool?: ToolRepr,
): Readonly<{
  text: string;
  lines: number;
  suffix?: string;
}> {
  if (
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
  if (row.kind === "outcome")
    return row.outcome.kind === "answered"
      ? { text: row.outcome.answer, lines: 3 }
      : { text: row.outcome.diagnostic, lines: 2 };
  if (row.kind === "turn") return { text: "", lines: 1 };
  if (row.kind !== "tool") return { text: "", lines: 1 };
  if (row.call.kind === "other") return { text: "", lines: 1 };
  const repr = tool!;
  return {
    text: repr.text,
    lines: 1,
    ...(repr.suffix === undefined ? {} : { suffix: repr.suffix }),
  };
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
  return { first: `${margin}${padToDisplay(label, width)} `, continuation: `${margin}${" ".repeat(width + 1)}` };
}

/** One row's rendered view: the shared prefix family and the two compact callers. */
type RowView = Readonly<{
  /** Live frame: only an active tool asserts in-motion state. */
  live?: true;
  /** Single-line preview: whitespace folds. */
  compact?: true;
  /** World-board answer previews keep the conclusion at the tail. */
  tailAnswer?: true;
  /** History is expanded and folds a long command into one line. */
  history?: true;
}>;

function rowPrefix(
  row: RenderRow,
  tool: ToolRepr | undefined,
  columns: number,
  view: RowView,
): Readonly<{ first: string; continuation: string }> {
  if (row.kind === "tool") return actionPrefix(toolMargin(row, view.live === true), tool!.label, columns);
  if (row.kind === "thought") return actionPrefix(ACTION_MARGIN, "think", columns);
  if (row.kind === "note") return actionPrefix(ACTION_MARGIN, "note", columns);
  if (row.kind === "outcome")
    return { first: row.outcome.kind === "answered" ? TOP_ANSWER : TOP_FAILURE, continuation: TOP_CONTINUATION };
  if (row.kind === "said") return { first: TOP_SPEAK, continuation: TOP_SPEAK };
  if (row.kind === "tell" && row.state === "pending") return { first: TOP_PENDING, continuation: TOP_CONTINUATION };
  return { first: TOP_INPUT, continuation: TOP_CONTINUATION };
}

function pathTail(path: string, maximum: number): string {
  if (displayColumns(path) <= maximum) return path;
  if (maximum <= 1) return maximum === 1 ? "…" : "";
  const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const parts = path.split(/[\\/]/u);
  const basename = parts.pop() ?? path;
  let tail = basename;
  const marker = `…${separator}`;
  for (const parent of parts.reverse()) {
    if (parent.length === 0) continue;
    const candidate = `${parent}${separator}${tail}`;
    if (displayColumns(`${marker}${candidate}`) > maximum) break;
    tail = candidate;
  }
  if (displayColumns(`${marker}${tail}`) <= maximum) return `${marker}${tail}`;
  return `…${takeDisplayColumnsFromEnd(path, maximum - 1).text}`;
}

function renderPathPreview(
  first: string,
  text: string,
  pathPreview: NonNullable<ToolRepr["pathPreview"]>,
  columns: number,
): string {
  const available = Math.max(0, columns - displayColumns(first));
  if (displayColumns(text) <= available) return `${first}${text}`;
  const before = pathPreview.before;
  const detail = pathPreview.detail;
  const diagnostic = pathPreview.diagnostic ?? "";
  const descriptorWidth = displayColumns(before) + displayColumns(detail);
  let renderedDetail = detail;
  if (descriptorWidth >= available) {
    const detailBudget = Math.max(0, available - displayColumns(before) - 1);
    renderedDetail = truncateDisplayText(detail, detailBudget);
  }
  const pathWidth = Math.max(0, available - displayColumns(before) - displayColumns(renderedDetail));
  const renderedPath = pathTail(pathPreview.path, pathWidth);
  const base = `${before}${renderedPath}${renderedDetail}`;
  const remainder = Math.max(0, available - displayColumns(base));
  const renderedDiagnostic = remainder > 0 ? truncateDisplayText(diagnostic, remainder) : "";
  return `${first}${base}${renderedDiagnostic}`;
}

function renderRunCommand(
  first: string,
  continuation: string,
  text: string,
  suffix: string,
  columns: number,
): readonly string[] {
  const firstBudget = Math.max(0, columns - displayColumns(first));
  const secondBudget = Math.max(0, columns - displayColumns(continuation));
  if (displayColumns(`${text}${suffix}`) <= firstBudget) return [`${first}${text}${suffix}`];
  const command = text.startsWith("$ ") ? text.slice(2) : text;
  const firstPart = takeDisplayColumns(command, Math.max(0, firstBudget - 2));
  const restWidth = displayColumns(firstPart.rest) + displayColumns(suffix);
  if (restWidth <= secondBudget) {
    return [`${first}$ ${firstPart.text}`, `${continuation}${firstPart.rest}${suffix}`];
  }
  const suffixBudget = Math.min(displayColumns(suffix), Math.max(0, secondBudget - 8));
  const keptSuffix = suffixBudget > 0 ? truncateDisplayText(suffix, suffixBudget) : "";
  const tailBudget = Math.max(0, secondBudget - displayColumns(keptSuffix) - 1);
  const headBudget = Math.max(0, firstBudget - 3);
  const head = takeDisplayColumns(command, headBudget).text;
  const tail = takeDisplayColumnsFromEnd(command, tailBudget).text;
  return [`${first}$ ${head}…`, `${continuation}…${tail}${keptSuffix}`];
}

function omissionMarker(text: string, columns: number): string {
  return `${actionPrefix(ACTION_MARGIN, OMISSION, columns).first}${text}`;
}

function rowBody(row: RenderRow, text: string, columns: number): string {
  if (row.kind !== "tool" || row.call.kind !== "other") return text;
  return toolContent(row, columns);
}

function tailAnswerPreview(first: string, text: string, columns: number): readonly string[] {
  const readable = safeText(text).replace(/\s+/gu, " ").trim();
  const budget = Math.max(0, columns - displayColumns(first));
  const tail = takeDisplayColumnsFromEnd(readable, budget).text;
  const preview =
    tail.length === readable.length ? tail : `…${takeDisplayColumnsFromEnd(readable, Math.max(0, budget - 1)).text}`;
  return [`${first}${preview}`];
}

/** Every selected timeline row renders through here: one prefix family per row class. */
function renderRow(row: RenderRow, context: TextRenderContext, view: RowView = {}): readonly string[] {
  const tool = row.kind === "tool" ? toolRepr(row) : undefined;
  const value = rowText(row, tool);
  const { first, continuation } = rowPrefix(row, tool, context.columns, view);
  const compact = view.compact === true;
  if (tool?.overflow === "command") {
    const suffix = value.suffix ?? "";
    if (!compact && view.history !== true)
      return renderRunCommand(first, continuation, value.text, suffix, context.columns);
    const remaining = context.columns - displayColumns(first);
    const withSuffix = remaining - displayColumns(suffix);
    const showSuffix = suffix.length > 0 && withSuffix >= 6;
    return [
      `${first}${truncateMiddleDisplayText(value.text, Math.max(0, showSuffix ? withSuffix : remaining))}${showSuffix ? suffix : ""}`,
    ];
  }
  if (tool?.pathPreview !== undefined) return [renderPathPreview(first, value.text, tool.pathPreview, context.columns)];
  if (view.tailAnswer === true && row.kind === "outcome" && row.outcome.kind === "answered")
    return tailAnswerPreview(first, value.text, context.columns);
  const available = context.columns - displayColumns(first) - displayColumns(value.suffix ?? "");
  const singleLine = compact || row.kind === "call" || row.kind === "tell" || row.kind === "turn";
  return renderBoundedPayload({
    text: rowBody(row, value.text, available),
    first,
    continuation,
    columns: context.columns,
    maxLines: singleLine ? 1 : view.history === true ? Number.MAX_SAFE_INTEGER : value.lines,
    quote: "",
    truncated: "truncated" in row && row.truncated === true,
    ...(singleLine || row.kind === "tool" ? {} : { preserveLines: true as const }),
  });
}

function groupedEntries(
  entries: readonly RenderEntry[],
  context: TextRenderContext,
  view: RowView = {},
): readonly string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "gap") {
      lines.push(omissionMarker(`${entry.count} omitted`, context.columns));
      continue;
    }
    lines.push(...renderRow(entry.row, context, view));
  }
  return lines;
}

function groupedRows(rows: readonly RenderRow[], context: TextRenderContext, view: RowView = {}): readonly string[] {
  return groupedEntries(
    rows.filter((row) => row.kind !== "turn").map((row) => ({ kind: "row", row })),
    context,
    view,
  );
}

/** Ordered entry stream of one retained snapshot; an idle outcome keeps its sequence position. */
function orderedSnapshotEntries(snapshot: RenderedSnapshot): readonly RenderEntry[] {
  if (snapshot.kind !== "idle" || snapshot.outcome === undefined) return snapshot.entries;
  const entries: RenderEntry[] = [];
  let outcomeInserted = false;
  for (const entry of snapshot.entries) {
    if (!outcomeInserted && entry.kind === "row" && entry.row.sequence > snapshot.outcome.sequence) {
      entries.push({ kind: "row", row: snapshot.outcome });
      outcomeInserted = true;
    }
    entries.push(entry);
  }
  if (!outcomeInserted) entries.push({ kind: "row", row: snapshot.outcome });
  return entries;
}

function currentTurnBoundary(activity: RenderedActivity): CurrentTurnBoundary | undefined {
  const snapshot = activity.snapshot;
  if (snapshot.kind !== "open" || snapshot.openingSequence === undefined) return undefined;
  const row = activity.rows.find((candidate) => candidate.sequence === snapshot.openingSequence);
  if (row === undefined) return undefined;
  // The projector selects a typed opening: its call or delivered launch Tell.
  if (row.kind !== "call" && !(row.kind === "tell" && row.state === "told")) return undefined;
  return { row, turnSequence: snapshot.turn.turnSequence };
}

/** Open status hides internal thought narration without selecting a second activity window. */
function visibleOpenSnapshotEntries(snapshot: Extract<RenderedSnapshot, { kind: "open" }>): readonly RenderEntry[] {
  return snapshot.entries.filter((entry) => entry.kind !== "row" || entry.row.kind !== "thought");
}

/** Adjacent omitted spans are one continuous unknown portion of the retained timeline. */
function coalesceAdjacentGaps(entries: readonly RenderEntry[]): readonly RenderEntry[] {
  return entries.reduce<RenderEntry[]>((coalesced, entry) => {
    const previous = coalesced.at(-1);
    if (entry.kind === "gap" && previous?.kind === "gap") {
      coalesced[coalesced.length - 1] = { kind: "gap", count: previous.count + entry.count };
    } else {
      coalesced.push(entry);
    }
    return coalesced;
  }, []);
}

/**
 * Shared snapshot activity rendering. Full snapshots render the selected
 * activity evidence; an idle snapshot is settled evidence. `latest` preserves
 * compact callers' established newest-entry selection.
 */
export function snapshotActivityLines(
  snapshot: RenderedSnapshot,
  context: TextRenderContext,
  selection: Readonly<{ latest?: boolean; tailAnswer?: true }> = {},
): readonly string[] {
  const entries = orderedSnapshotEntries(snapshot);
  if (selection.latest !== true) {
    const full = snapshot.kind === "open" ? visibleOpenSnapshotEntries(snapshot) : entries;
    return groupedEntries(coalesceAdjacentGaps(full), context);
  }
  const latest = entries.filter((entry) => entry.kind === "row").at(-1);
  return latest === undefined
    ? []
    : groupedEntries([latest], context, {
        compact: true,
        ...(selection.tailAnswer === true ? { tailAnswer: true as const } : {}),
      });
}

/** One command's append-only activity view, with a baseline and a final tail flush. */
export type ActivityStream = ((activity: RenderedActivity) => readonly string[]) &
  Readonly<{
    /** Establish a live baseline without spending the command's live tool budget. */
    seed: (activity: RenderedActivity, alreadyRenderedSequence?: number) => readonly string[];
    /** Current live rows for the redrawable frame; never part of append-only output. */
    frame: () => readonly string[];
    /** Emit the pending omission count and unsettled rows once before the command's conclusion. */
    flush: () => readonly string[];
  }>;

/** One decided piece of append-only output: a settled row, or an untimed omission count. */
type StreamEmission = Readonly<{ kind: "gap"; count: number }> | Readonly<{ kind: "row"; row: RenderRow }>;

type ActivityStreamState = {
  newestSettledSequence: number | undefined;
  admissionSequence: number | undefined;
  pendingTellSequences: Set<number>;
  renderedBoundaries: Set<number>;
  admittedTellSequences: Set<number>;
  checkpointTools: number;
  omitted: number;
  liveRows: Map<number, RenderRow>;
};

function isSettledStreamRow(row: RenderRow): boolean {
  if (row.kind === "turn" || row.kind === "outcome") return false;
  if (row.kind === "tell") return row.state === "told";
  return row.kind !== "tool" || (row.state !== "active" && row.state !== "unsettled");
}

function sameTool(left: RenderRow, right: RenderRow): boolean {
  return (
    left.kind === "tool" &&
    right.kind === "tool" &&
    left.turnSequence === right.turnSequence &&
    left.name === right.name &&
    JSON.stringify(left.call) === JSON.stringify(right.call)
  );
}

function settledRows(activity: RenderedActivity): readonly RenderRow[] {
  return activity.rows.filter((row) => isSettledStreamRow(row) && !inFlightSay(activity, row));
}

function isBoundedStreamTool(row: RenderRow): boolean {
  return row.kind === "tool";
}

function rememberPendingTells(state: ActivityStreamState, activity: RenderedActivity): void {
  for (const row of activity.rows)
    if (
      row.kind === "tell" &&
      row.state === "pending" &&
      (state.admissionSequence === undefined || row.sequence >= state.admissionSequence)
    )
      state.pendingTellSequences.add(row.sequence);
}

/** Count skipped settled rows within the eligible part of a seeded baseline. */
function baselineOmissionCount(activity: RenderedActivity, after: number, before?: number): number {
  return activity.rows.filter(
    (row) => row.sequence > after && (before === undefined || row.sequence < before) && isSettledStreamRow(row),
  ).length;
}

/**
 * A say is in-flight only while it is the newest row of the open turn: it may still be streaming, so it
 * stays in the redrawable frame. A say with any successor row is settled evidence and renders on the rail.
 */
function inFlightSay(activity: RenderedActivity, row: RenderRow): boolean {
  if (activity.snapshot.kind !== "open" || row.kind !== "said") return false;
  let newest: RenderRow | undefined;
  for (const candidate of activity.rows) {
    if (newest === undefined || candidate.sequence > newest.sequence) newest = candidate;
  }
  return newest !== undefined && newest.sequence === row.sequence;
}

function rememberLiveRows(state: ActivityStreamState, activity: RenderedActivity): void {
  for (const row of activity.rows) {
    if (row.kind === "tool" && row.state === "active") state.liveRows.set(row.sequence, row);
    else if (row.kind === "said" && inFlightSay(activity, row)) state.liveRows.set(row.sequence, row);
    else if (row.kind === "tool" && isSettledStreamRow(row)) {
      for (const [sequence, live] of state.liveRows) {
        if (sameTool(live, row)) {
          state.liveRows.delete(sequence);
          break;
        }
      }
    } else if (isSettledStreamRow(row)) state.liveRows.delete(row.sequence);
  }
}

/** A visible row first releases the untimed omission count accumulated before it. */
function emitRow(state: ActivityStreamState, emissions: StreamEmission[], emission: StreamEmission): void {
  if (state.omitted > 0) emissions.push({ kind: "gap", count: state.omitted });
  state.omitted = 0;
  emissions.push(emission);
}

function emitCurrentTurnBoundary(
  state: ActivityStreamState,
  activity: RenderedActivity,
  emissions: StreamEmission[],
): void {
  const boundary = currentTurnBoundary(activity);
  if (boundary !== undefined && !state.renderedBoundaries.has(boundary.turnSequence)) {
    state.renderedBoundaries.add(boundary.turnSequence);
    if (boundary.row.kind !== "thought") emitRow(state, emissions, { kind: "row", row: boundary.row });
  }
}

/**
 * Decide each newly settled row once, when first observed: it prints now or
 * becomes part of an untimed omission count. No timestamped row is held for a
 * later observation, so concurrent streams merge without moving backward.
 */
function observeActivitySnapshot(state: ActivityStreamState, activity: RenderedActivity): readonly StreamEmission[] {
  const emissions: StreamEmission[] = [];
  const boundary = currentTurnBoundary(activity);
  rememberPendingTells(state, activity);
  // A row newly selected as this Turn's typed opening must still respect the
  // settled cursor, even if its earlier pending form was remembered.
  if (boundary !== undefined) state.pendingTellSequences.delete(boundary.row.sequence);
  const observedRows = settledRows(activity)
    .filter((row) => state.admissionSequence === undefined || row.sequence >= state.admissionSequence)
    .filter((row) => !state.admittedTellSequences.has(row.sequence))
    .filter(
      (row) =>
        boundary === undefined ||
        !state.renderedBoundaries.has(boundary.turnSequence) ||
        row.sequence !== boundary.row.sequence,
    )
    .filter(
      (row) =>
        state.pendingTellSequences.has(row.sequence) ||
        state.newestSettledSequence === undefined ||
        row.sequence > state.newestSettledSequence,
    );
  rememberLiveRows(state, activity);
  if (observedRows.length === 0) return emissions;
  for (const row of observedRows) state.pendingTellSequences.delete(row.sequence);
  state.newestSettledSequence = observedRows.reduce(
    (newest, row) => Math.max(newest, row.sequence),
    state.newestSettledSequence ?? observedRows[0]!.sequence,
  );
  for (const row of observedRows) {
    if (row.kind === "thought") continue;
    // A failed tool is evidence, not routine progress, so it always prints and spends no budget.
    const failed = row.kind === "tool" && typeof row.state === "object" && row.state.status === "error";
    if (isBoundedStreamTool(row) && !failed) {
      if (state.checkpointTools >= TOOL_BUDGET) {
        state.omitted += 1;
        continue;
      }
      state.checkpointTools += 1;
    } else if (row.kind === "said" || row.kind === "tell") state.checkpointTools = 0;
    emitRow(state, emissions, { kind: "row", row });
  }
  return emissions;
}

/**
 * Append-only live view over one command's successive settled snapshots.
 * After each say or Tell, the first three tools print as they settle; later
 * tools until the next checkpoint fold into one omission marker. Failed tools
 * always print.
 */
export function activityStream(context: TextRenderContext): ActivityStream {
  const state: ActivityStreamState = {
    newestSettledSequence: undefined,
    admissionSequence: undefined,
    pendingTellSequences: new Set(),
    renderedBoundaries: new Set(),
    admittedTellSequences: new Set(),
    checkpointTools: 0,
    omitted: 0,
    liveRows: new Map(),
  };
  const seed = (activity: RenderedActivity, alreadyRenderedSequence?: number): readonly StreamEmission[] => {
    const emissions: StreamEmission[] = [];
    if (alreadyRenderedSequence !== undefined) {
      state.admissionSequence = alreadyRenderedSequence;
      state.admittedTellSequences.add(alreadyRenderedSequence);
    }
    const boundary = currentTurnBoundary(activity);
    const unseenBoundary = boundary !== undefined && !state.renderedBoundaries.has(boundary.turnSequence);
    if (unseenBoundary) {
      if (alreadyRenderedSequence !== undefined && boundary.row.sequence > alreadyRenderedSequence) {
        const beforeBoundary = baselineOmissionCount(activity, alreadyRenderedSequence, boundary.row.sequence);
        if (beforeBoundary > 0) emissions.push({ kind: "gap", count: beforeBoundary });
      }
      if (alreadyRenderedSequence !== undefined && boundary.row.sequence <= alreadyRenderedSequence)
        state.renderedBoundaries.add(boundary.turnSequence);
      else emitCurrentTurnBoundary(state, activity, emissions);
      rememberLiveRows(state, activity);
      const omitted = baselineOmissionCount(
        activity,
        alreadyRenderedSequence === undefined
          ? boundary.row.sequence
          : Math.max(boundary.row.sequence, alreadyRenderedSequence),
      );
      if (omitted > 0) emissions.push({ kind: "gap", count: omitted });
    }
    rememberPendingTells(state, activity);
    rememberLiveRows(state, activity);
    const rows = settledRows(activity);
    if (rows.length > 0)
      state.newestSettledSequence = rows.reduce((newest, row) => Math.max(newest, row.sequence), rows[0]!.sequence);
    return emissions;
  };
  const flush = (): readonly StreamEmission[] => {
    const emissions: StreamEmission[] = [];
    if (state.omitted > 0) emissions.push({ kind: "gap", count: state.omitted });
    state.omitted = 0;
    for (const row of [...state.liveRows.values()].sort((left, right) => left.sequence - right.sequence)) {
      const unresolved = row.kind === "tool" && row.state === "active" ? { ...row, state: "unsettled" as const } : row;
      emissions.push({ kind: "row", row: unresolved });
    }
    state.liveRows.clear();
    return emissions;
  };
  const render = (emissions: readonly StreamEmission[]): readonly string[] => groupedEntries(emissions, context);
  const frame = (): readonly string[] =>
    groupedEntries(
      [...state.liveRows.values()]
        .sort((left, right) => left.sequence - right.sequence)
        .map((row) => ({ kind: "row", row })),
      context,
      { live: true },
    );
  const observe = (activity: RenderedActivity): readonly string[] => render(observeActivitySnapshot(state, activity));
  return Object.assign(observe, {
    seed: (activity: RenderedActivity, alreadyRenderedSequence?: number) =>
      render(seed(activity, alreadyRenderedSequence)),
    frame,
    flush: () => render(flush()),
  });
}

function conclusionMarkVerb(
  status: AkumaObservation["status"] | undefined,
  outcome: "answered" | "failed" | "unanswered" | "life",
): Readonly<{ mark: string; verb: string }> {
  if (outcome === "failed" || (status !== undefined && failedOutcomeDiagnostic(status) !== undefined))
    return { mark: "!", verb: "failed" };
  if (outcome === "answered") return { mark: "✓", verb: "answered" };
  if (outcome === "unanswered") return { mark: "○", verb: "unanswered" };
  if (status === undefined) return { mark: "⧗", verb: "pending tell" };
  if (status.life === "running") return { mark: "●", verb: "running" };
  if (!defaultWaitComplete(status)) {
    return { mark: "⧗", verb: "pending tell" };
  }
  if (status.life === "asleep") return { mark: "✓", verb: "completed" };
  if (status.life === "killed") return { mark: "×", verb: "killed" };
  if (status.life === "hung") return { mark: "?", verb: "hung" };
  if (status.life === "untidy") return { mark: "!", verb: "untidy" };
  return { mark: "!", verb: "stranded" };
}

function durationText(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60)}s`;
}

/**
 * One wait-style conclusion for every observer of an input-bound Tell. A target
 * that settled at or after this wait began keeps its duration, a target already
 * settled names no duration, and an unfinished target carries the elapsed wait.
 */
function waitConclusionRow(
  input: Readonly<{ at?: number; startedAt: number; complete: boolean; end: number; mark: string; verb: string }>,
): string {
  const duration = input.complete
    ? input.at !== undefined && input.at >= input.startedAt
      ? ` — ${durationText(Math.max(0, input.at - input.startedAt))}`
      : ""
    : ` — waited ${durationText(Math.max(0, input.end - input.startedAt))}`;
  return `${input.mark} ${input.verb}${duration}`;
}

export function inputWaitConclusion(
  observation: AkumaAskObservation,
  input: Readonly<{ startedAt: number; completedAt?: string | null; now?: number; status?: AkumaStatus }>,
): readonly string[] {
  const end = input.now ?? Date.now();
  const complete = observation.reason !== "deadline";
  const pinned = input.completedAt == null ? Number.NaN : Date.parse(input.completedAt);
  const at = complete ? (Number.isFinite(pinned) ? pinned : undefined) : end;
  const conclusion = conclusionMarkVerb(
    input.status,
    observation.reason === "answered"
      ? "answered"
      : observation.reason === "failed" || observation.reason === "invalid-output"
        ? "failed"
        : observation.reason === "unanswered"
          ? "unanswered"
          : "life",
  );
  return [
    waitConclusionRow({
      ...(at === undefined ? {} : { at }),
      startedAt: input.startedAt,
      complete,
      end,
      ...conclusion,
    }),
    ...(observation.reason === "failed" || observation.reason === "invalid-output"
      ? [`! ${safeText(observation.diagnostic)}`]
      : []),
  ];
}

/** The identity a streamed observing call's head frame renders from its resolved birth. */
export type ObservedCallHead = Readonly<{
  id: string;
  alias?: string;
  contract: DispatchAssociation;
  facts: readonly string[];
  /** A directory the invocation already resolved; never read here to fill the panel. */
  cwd?: string;
}>;

export type InputWaitConclusion =
  | Readonly<{
      kind: "failed";
      diagnostic: string;
      /** Already-decided evidence rows, such as a Tell admitted before the failure. */
      evidence?: readonly string[];
    }>
  | Readonly<{
      kind: "observed";
      observation: AkumaAskObservation;
      completedAt?: string | null;
    }>;

export type InputWaitStream = Readonly<{
  admitted: (input: Readonly<{ at?: string; sequence?: number; rows: readonly string[] }>) => readonly string[];
  observe: (observation: Readonly<{ status: AkumaStatus; rows: readonly ActivityRow[] }>) => readonly string[];
  /** Current live rows for the redrawable frame; never part of append-only output. */
  frame: () => readonly string[];
  /** In-flight rows with their unresolved marks, emitted by a close that never concluded. */
  flush: () => readonly string[];
  conclude: (result: InputWaitConclusion) => string;
  opened: () => boolean;
}>;

/**
 * The call-observation projection of one input wait: the same admitted/observe/frame/flush/opened
 * lifetime with the closing judgment translated from the native CallObservation.
 */
export type CallObservationStream = Readonly<
  Omit<InputWaitStream, "conclude"> & { conclude: (observation: CallObservation) => string }
>;

function failedOutcomeDiagnostic(status: AkumaStatus): string | undefined {
  const outcome = status.timeline.kind === "idle" ? status.timeline.outcome : undefined;
  return outcome !== undefined && outcome.outcome.kind === "failed" ? outcome.outcome.diagnostic : undefined;
}

/**
 * Live view over one observing input: its identity frame opens once, selected
 * activity follows, and the input-bound outcome supplies the closing row.
 */
export function inputWaitStream(
  context: TextRenderContext,
  head: () => ObservedCallHead,
  options: Readonly<{ cursor: "empty" | "admission"; now?: () => number; answerSeparator?: true }>,
): InputWaitStream {
  const now = options.now ?? ((): number => Date.now());
  const activity = activityStream(context);
  let startedAt = Number.NaN;
  let admitted = false;
  let admittedSequence: number | undefined;
  let opened = false;
  let cursorSeeded = false;
  /** The last observed life, so a caller deadline concludes on the target's status rather than naming the deadline. */
  let lastStatus: AkumaStatus | undefined;
  const admit: InputWaitStream["admitted"] = (input) => {
    if (admitted) throw new Error("input wait admitted more than once");
    const pinned = input.at === undefined ? Number.NaN : Date.parse(input.at);
    startedAt = Number.isFinite(pinned) ? pinned : now();
    admittedSequence = input.sequence;
    admitted = true;
    if (input.rows.length === 0) return [];
    const lines: string[] = [];
    open(lines);
    lines.push(...input.rows);
    return lines;
  };
  const open = (lines: string[], failedBeforeAdmission = false): void => {
    if (opened) return;
    if (!admitted && !failedBeforeAdmission) throw new Error("input wait observed before admission");
    opened = true;
    const identity = head();
    const headLines = panelHead(
      identity.id,
      identity.alias,
      identity.contract,
      identity.cwd === undefined ? [] : [safeText(identity.cwd)],
    );
    // A streamed panel always states an observed conclusion before it closes, so its rule opens here.
    lines.push(...headLines, frameRule(headLines, context.columns));
  };
  const observe: InputWaitStream["observe"] = (observation) => {
    const lines: string[] = [];
    lastStatus = observation.status;
    open(lines);
    const activityInput = { snapshot: observation.status.timeline, rows: observation.rows };
    if (!cursorSeeded && options.cursor === "admission") lines.push(...activity.seed(activityInput, admittedSequence));
    else lines.push(...activity(activityInput));
    cursorSeeded = true;
    return lines;
  };
  const frame: InputWaitStream["frame"] = () => activity.frame();
  const flush: InputWaitStream["flush"] = () => activity.flush();
  const conclude: InputWaitStream["conclude"] = (result) => {
    const lines: string[] = [];
    open(lines, result.kind === "failed");
    if (result.kind === "failed" && result.evidence !== undefined) lines.push(...result.evidence);
    lines.push(...activity.flush());
    if (result.kind === "failed") lines.push(`! ${safeText(result.diagnostic)}`);
    else
      lines.push(
        ...inputWaitConclusion(result.observation, {
          startedAt,
          ...(result.completedAt === undefined ? {} : { completedAt: result.completedAt }),
          now: now(),
          ...(lastStatus === undefined ? {} : { status: lastStatus }),
        }),
      );
    lines.push(...subordinateLines(head().facts));
    return `${lines.join("\n")}${options.answerSeparator === true ? "\n\n" : ""}`;
  };
  return { admitted: admit, observe, frame, flush, conclude, opened: () => opened };
}

export function callObservationStream(
  context: TextRenderContext,
  head: ObservedCallHead,
  options: Readonly<{ now?: () => number; admittedAt?: string }> = {},
): CallObservationStream {
  const stream = inputWaitStream(context, () => head, {
    cursor: "empty",
    answerSeparator: true,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  stream.admitted({ ...(options.admittedAt === undefined ? {} : { at: options.admittedAt }), rows: [] });
  /** Tell rows already settled on the timeline, so a failed close never replays one. */
  const settledTells = new Set<number>();
  return {
    ...stream,
    observe: (observation) => {
      for (const row of observation.rows)
        if (row.kind === "tell" && row.state === "told") settledTells.add(row.sequence);
      return stream.observe(observation);
    },
    conclude: (observation) => {
      if (observation.kind === "failed") {
        const tell = observation.tell;
        const evidence =
          tell === undefined || settledTells.has(tell.row.sequence) ? [] : [tellAdmissionRow(tell, context)];
        return stream.conclude({
          kind: "failed",
          diagnostic: observation.failure.diagnostic,
          ...(evidence.length === 0 ? {} : { evidence }),
        });
      }
      if (observation.kind !== "observed") return "";
      return stream.conclude({
        kind: "observed",
        observation: observation.observation,
        ...(observation.completedAt === undefined ? {} : { completedAt: observation.completedAt }),
      });
    },
  };
}

type CreatedDebtRow = Extract<CreatedDebtObservation, { kind: "present" }>["rows"][number];

function renderReportedChangeLines(snapshot: RenderedSnapshot): readonly string[] {
  if (snapshot.reportedChanges.length === 0 && snapshot.reportedChangesOmitted === 0) return [];
  const width = snapshot.reportedChanges.reduce(
    (max, change) => Math.max(max, renderDiffstat(change.diffstat).length),
    0,
  );
  return [
    `changes ${snapshot.reportedChanges.length + snapshot.reportedChangesOmitted}`,
    ...snapshot.reportedChanges.map(
      (change) => `  ${renderDiffstat(change.diffstat).padEnd(width)}  ${safeText(change.path)}`,
    ),
    ...(snapshot.reportedChangesOmitted > 0 ? [`  ${OMISSION} ${snapshot.reportedChangesOmitted} more files`] : []),
  ];
}

function renderDebtRow(row: CreatedDebtRow, columns: number): readonly string[] {
  const prefix = `  ${debtDispositionMark(row.disposition)} ${row.id} · `;
  const body = `${safeText(row.title)} · ${dispositionText(row.disposition)} · P${row.priority}`;
  const inline = `${prefix}${body}`;
  if (displayColumns(inline) <= columns) return [inline];
  return renderBoundedTextBlock(body, {
    first: prefix,
    continuation: "    ",
    columns,
    lines: Number.MAX_SAFE_INTEGER,
  });
}

function renderDebtContextLines(created: CreatedDebtObservation | undefined, columns: number): readonly string[] {
  if (created === undefined) return [];
  if (created.kind === "failed") return [`! debts failed ${safeText(created.diagnostic)}`];
  if (created.rows.length === 0) return [];
  return [`debts ${created.rows.length}`, ...created.rows.flatMap((row) => renderDebtRow(row, columns))];
}

type SnapshotView = Readonly<{
  status: AkumaObservation["status"];
  contract: DispatchAssociation;
  createdDebts?: CreatedDebtObservation;
}>;

type SnapshotCoreOptions = Readonly<{
  alias?: string;
  facts?: readonly string[];
  showAllowed?: boolean;
}>;

function snapshotCore(
  view: SnapshotView,
  context: TextRenderContext,
  options: SnapshotCoreOptions,
): Readonly<{ activity: readonly string[]; head: readonly string[]; facts: readonly string[] }> {
  const activity = snapshotActivityLines(view.status.timeline, context);
  // Static coordinates belong above the content boundary; a dynamic diagnostic stays below it.
  const contextFacts = [
    ...(options.showAllowed === true ? [`allowed  ${view.status.allowed.join(", ") || "none"}`] : []),
    ...(view.status.cwd === undefined ? [] : [safeText(view.status.cwd)]),
  ];
  const facts = [...contractFacts(view.contract), ...(options.facts ?? [])];
  return {
    activity,
    head: panelHead(view.status.id, options.alias, view.contract, contextFacts),
    facts,
  };
}

function snapshotConclusion(status: AkumaObservation["status"]): string {
  const timeline = status.timeline;
  // The outcome row (`✓` / `!`) is already the ending; a closer would be a second mark carrying no
  // new information, so it is absent exactly then.
  if (timeline.kind === "idle" && timeline.outcome !== undefined) return "";
  const { mark, verb } = conclusionMarkVerb(status, "life");
  return `${mark} ${verb}`;
}

export function snapshotText(
  view: SnapshotView,
  context: TextRenderContext,
  options: SnapshotCoreOptions = {},
): string {
  const core = snapshotCore(view, context, options);
  const conclusion = snapshotConclusion(view.status);
  const content = [...core.activity, ...(conclusion.length === 0 ? [] : [conclusion])];
  return [
    ...core.head,
    ...(content.length === 0 ? [] : [frameRule(core.head, context.columns), ...content]),
    ...subordinateLines([
      ...renderReportedChangeLines(view.status.timeline),
      ...renderDebtContextLines(view.createdDebts, context.columns - SUBORDINATE_INDENT.length),
      ...core.facts,
    ]),
  ].join("\n");
}

function killResultLabel(
  evidence: KillEvidence,
): Readonly<{ mark: "✓" | "!"; verb: string; evidence: readonly string[] }> {
  if (evidence === "killed") return { mark: "✓", verb: "killed", evidence: [] };
  if (evidence === "already-killed") return { mark: "✓", verb: "already killed", evidence: [] };
  if (evidence === "already-stopped") return { mark: "✓", verb: "already stopped", evidence: [] };
  return { mark: "!", verb: "not killed", evidence: [evidence] };
}

export function killResultText(id: string, evidence: KillEvidence, alias?: string): string {
  const label = killResultLabel(evidence);
  return actionReceipt({
    mark: label.mark,
    verb: label.verb,
    id,
    ...(alias === undefined ? {} : { alias }),
    evidence: label.evidence,
  }).join("\n");
}

function answerBytes(answer: unknown, structured: boolean): string | undefined {
  return !structured && typeof answer === "string" ? answer : JSON.stringify(answer);
}

/** Presentation-only state for one akuma invocation; it never reaches JSON. */
type AkumaPresentation = Readonly<{
  alias?: string;
}>;

export function askRawAnswer(result: AkumaAskResult, structured: boolean | undefined): string | undefined {
  if (result.observation.reason !== "answered") return "";
  return answerBytes(result.observation.answer, structured === true);
}

export function callRawAnswer(result: CallResult, streamed: boolean): string | undefined {
  const observation = result.observation;
  if (observation.kind !== "observed" || observation.observation.reason !== "answered")
    return streamed ? "" : undefined;
  return answerBytes(observation.observation.answer, result.structured === true);
}

export function historyRawAnswer(result: AkumaHistoryResult, historyId: string | undefined): string | undefined {
  if (historyId === undefined || result.kind !== "exact") return undefined;
  const outcome = result.outcome.outcome;
  return outcome.kind === "answered" ? outcome.answer : outcome.diagnostic;
}

/** One compact wait result line: an observed life mark, the complete identity, a bounded summary. */
const WAIT_SUMMARY_SEPARATOR = " — ";
type WaitState = Readonly<{ mark: string; state: string }>;
const WAIT_LIFE: Partial<Record<AkumaStatus["life"], WaitState>> = {
  running: { mark: "●", state: "running" },
  killed: { mark: "×", state: "killed" },
  hung: { mark: "?", state: "hung" },
  untidy: { mark: "!", state: "untidy" },
  stranded: { mark: "!", state: "stranded" },
};

function foldedSummary(value: string): string {
  return safeText(value).replace(/\s+/gu, " ").trim();
}

function preview(value: string, fallback: string): string {
  return foldedSummary(value) || fallback;
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
 * pending input shows its current answered preview or failed diagnostic, else completion. The
 * mark reports the observed life, never continuing liveness.
 */
function waitSummary(status: AkumaStatus): WaitState & Readonly<{ summary: string }> {
  const pending = status.timeline.entries.some(
    (entry) => entry.kind === "row" && entry.row.kind === "tell" && entry.row.state === "pending",
  );
  const outcome = status.timeline.kind === "idle" ? status.timeline.outcome?.outcome : undefined;
  const observed =
    WAIT_LIFE[status.life] ??
    (pending
      ? { mark: "⧗", state: "pending tell" }
      : outcome === undefined
        ? { mark: "✓", state: "completed" }
        : outcome.kind === "answered"
          ? { mark: "✓", state: preview(outcome.answer, "answered") }
          : { mark: "!", state: preview(outcome.diagnostic, "failed") });
  return {
    ...observed,
    summary: [
      observed.state,
      ...(pending && status.life !== "asleep" ? ["pending tell"] : []),
      ...(status.strandedReason === undefined ? [] : [status.strandedReason]),
    ].join(FACT_SEPARATOR),
  };
}

/**
 * One wait's final text: one compact line per observed member, then one failure line per member
 * the wait could not read. A wait opens no frame and extracts no separate answer, so an answer is
 * visible only as the snapshot's own bounded summary.
 */
export function waitText(result: AkumaWaitResult, presentation: AkumaPresentation, context: TextRenderContext): string {
  const alias = result.observations.length === 1 && result.unobserved.length === 0 ? presentation.alias : undefined;
  return [
    ...result.observations.map((observation) => {
      const { mark, summary } = waitSummary(observation.status);
      return waitLine(mark, identity(observation.status.id, alias), summary, context.columns);
    }),
    ...result.unobserved.map((member) =>
      waitLine("!", safeText(member.id), `observation failed${FACT_SEPARATOR}${member.diagnostic}`, context.columns),
    ),
  ].join("\n");
}

export function historyText(
  result: AkumaHistoryResult,
  presentation: AkumaPresentation & Readonly<{ id?: string; last?: boolean }>,
  context: TextRenderContext,
): string {
  if (presentation.id !== undefined) {
    if (result.kind !== "exact")
      return `${result.kind === "unknown-history" ? result.historyId : "unknown"} has no matching retained outcome`;
    return result.outcome.outcome.kind === "answered"
      ? result.outcome.outcome.answer
      : result.outcome.outcome.diagnostic;
  }
  if (presentation.last === true) return result.kind === "last" ? result.answer : "no answer retained";
  if (result.kind !== "history") throw new Error("history result lacks page");
  const rows = groupedRows(result.history.rows, context, { history: true });
  const paging =
    result.history.omitted > 0
      ? [
          omissionMarker(
            result.history.hasLater
              ? `${result.history.omitted} later events · showing first ${result.history.rows.length}`
              : `${result.history.omitted} earlier events · showing last ${result.history.rows.length}`,
            context.columns,
          ),
        ]
      : [];
  // History is an immutable timeline, so it takes the shared heading and content boundary and
  // never gains a fabricated current-state conclusion or a live mark.
  const content = [...paging, ...rows];
  const head = panelHead(result.id, presentation.alias, result.contract);
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

/** One admitted Tell as a timeline input row inside a shared panel; the panel owns the identity. */
export function tellAdmissionRow(tell: AkumaTellResult["tell"], context: TextRenderContext): string {
  const lead = tell.wake.kind === "failed" ? TOP_FAILURE : tell.wake.kind === "held" ? TOP_PENDING : TOP_INPUT;
  return renderBoundedPayload({
    text: tell.row.text,
    first: lead,
    continuation: TOP_CONTINUATION,
    columns: context.columns,
    maxLines: 1,
    quote: "",
    truncated: false,
  })[0]!;
}

/**
 * One Tell action receipt: the delivery verdict and complete subject stand whole on the first line
 * with the submitted payload folded onto that same line, bounded so only its preview truncates. A
 * held Tell keeps neutral vocabulary; a failed delivery keeps its concrete diagnosis and native log
 * coordinates as separate supporting facts.
 */
export function tellText(result: AkumaTellResult, alias: string | undefined, context: TextRenderContext): string {
  const wake = result.tell.wake;
  const mark = wake.kind === "failed" ? "!" : wake.kind === "held" ? "⧗" : "✓";
  const verb = wake.kind === "failed" || wake.kind === "held" ? "tell" : "told";
  const head = actionReceipt({
    mark,
    verb,
    id: result.akuma,
    ...(alias === undefined ? {} : { alias }),
  })[0]!;
  const preview = safeText(result.tell.row.text).replace(/\s+/gu, " ").trim();
  const prefix = `${head} — `;
  // The verdict and identity never truncate, so an over-wide identity still keeps one visible
  // ellipsis for the input it could not show.
  const room = Math.max(1, context.columns - displayColumns(prefix));
  const verdict = preview.length === 0 ? head : `${prefix}${truncateDisplayText(preview, room)}`;
  if (wake.kind !== "failed") return verdict;
  const child = "child" in wake ? wake.child : undefined;
  const failure = `! tell delivery failed · ${safeText(wake.diagnostic)}${child === undefined ? "" : ` · log ${child.log.path} ${child.log.from}..${child.log.to}`}`;
  return [
    verdict,
    ...subordinateLines(
      renderBoundedTextBlock(failure, {
        first: "",
        continuation: "",
        columns: context.columns - SUBORDINATE_INDENT.length,
        lines: Number.MAX_SAFE_INTEGER,
      }),
    ),
  ].join("\n");
}
