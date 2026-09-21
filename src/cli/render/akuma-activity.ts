import type { ActivityRow, AkumaStatus, KillEvidence, ReportedFileChange } from "../../akuma/akuma.js";
import type { CallObservation } from "../../library/akuma-creation.js";
import type {
  AkumaObservation,
  AkumaObservationStage,
  CreatedTaskObservation,
  DispatchAssociation,
} from "../../index.js";
import { parseAkumaStatus } from "../../akuma/akuma.js";
import { defaultWaitComplete } from "../../akuma/akuma-observe.js";
import type { AkumaInvocationResult } from "../commands/akuma-invoke.js";
import type { WaitObservedAkuma } from "../../akuma/fleet-execution.js";
import type { ParsedCommand } from "../parse.js";
import { toolContent, toolRepr, type ToolRepr } from "./akuma-tool.js";
import {
  displayColumns,
  renderBoundedTextBlock,
  safeText,
  takeDisplayColumns,
  truncateDisplayText,
  truncateMiddleDisplayText,
  type TextRenderContext,
} from "./terminal.js";

export const DEFAULT_CONTEXT: TextRenderContext = { columns: 80, color: false };
const TIME_WIDTH = 5;
const VERB_WIDTH = 6;

/**
 * The one blessed ruler: a run of U+2500 exactly as wide as the frame head's
 * widest line, marking the boundary between an observation frame and its content.
 */
export function frameRule(headLines: readonly string[]): string {
  const width = headLines.reduce((widest, line) => Math.max(widest, displayColumns(line)), 0);
  return "─".repeat(width);
}

/** Tool rows one focused activity view keeps at its opening and final end; the surplus folds in place. */
const OPENING_TOOL_BUDGET = 3;
const RECENT_TOOL_BUDGET = 2;

type FleetTimeline = AkumaObservation["status"]["timeline"];
type FleetTimelineEntry = FleetTimeline["entries"][number];
type FleetReportedFileChange = FleetTimeline["reportedChanges"][number];
type RenderRow = ActivityRow | Extract<FleetTimelineEntry, { kind: "row" }>["row"];
type RenderEntry = Readonly<{ kind: "gap"; count: number }> | Readonly<{ kind: "row"; row: RenderRow }>;
type RenderedSnapshot = FleetTimeline;
type RenderedActivity = Readonly<{ snapshot: RenderedSnapshot; rows: readonly ActivityRow[] }>;
type RenderedFileChange = ReportedFileChange | FleetReportedFileChange;
type CurrentTurnBoundary = Readonly<{ row: RenderRow; turnSequence: number }>;

function identity(id: string, alias?: string): string {
  return `${id}${alias === undefined ? "" : ` (${alias})`}`;
}

function associatedContractId(contract: DispatchAssociation): string | undefined {
  return contract.kind === "associated" ? contract.contractId : undefined;
}

export function associatedIdentity(id: string, alias?: string, _contract?: DispatchAssociation): string {
  return identity(id, alias);
}

export function snapshotHeading(
  id: string,
  alias: string | undefined,
  contract: DispatchAssociation | undefined,
): readonly string[] {
  const contractId = contract === undefined ? undefined : associatedContractId(contract);
  const head = [identity(id, alias), ...(contractId === undefined ? [] : [`└─ ${contractId}`])];
  return [...head, frameRule(head)];
}

function answeredHeading(id: string, alias: string | undefined): readonly string[] {
  const heading = `✓ answered ${identity(id, alias)}`;
  return [heading, frameRule([heading])];
}

function contractFacts(contract: DispatchAssociation): readonly string[] {
  return contract.kind === "failed" ? [`! contract failed ${safeText(contract.diagnostic)}`] : [];
}

function unobservedText(id: string, diagnostic: string): string {
  return `× Akuma observation failed  ${safeText(id)} — ${safeText(diagnostic)}`;
}

function lifeLabel(life: AkumaObservation["status"]["life"]): string {
  if (life === "running") return "● running";
  if (life === "asleep") return "✓ came back";
  if (life === "killed") return "× killed";
  if (life === "hung") return "? hung";
  return "! stranded";
}

function clock(at: string): string {
  const date = new Date(at);
  return Number.isFinite(date.getTime())
    ? `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
    : "unknown";
}

function label(row: RenderRow, tool?: ToolRepr): string {
  if (row.kind === "said") return "say";
  if (row.kind === "thought") return "think";
  if (row.kind === "note") return "note";
  if (row.kind === "call") return "call";
  if (row.kind === "tell") return row.state === "told" ? "told" : "tell";
  if (row.kind === "outcome") return row.outcome.kind === "answered" ? "answer" : "error";
  if (row.kind === "turn") return "call";
  if (row.kind !== "tool") return row.kind;
  return tool!.label;
}

function mark(row: RenderRow): "│" | "⧖" | "⧗" | "✓" | "!" | "?" {
  if (row.kind === "outcome") return row.outcome.kind === "answered" ? "✓" : "!";
  if (row.kind === "tell" && row.state === "told") return "✓";
  if (row.kind === "tell" && row.state === "pending") return "⧗";
  if (row.kind === "tool") {
    if (row.state === "active") return "⧖";
    if (row.state === "unsettled") return "?";
    return row.state.status === "ok" ? "✓" : "!";
  }
  return "│";
}

function rowText(
  row: RenderRow,
  tool?: ToolRepr,
): Readonly<{ text: string; lines: number; middle?: true; suffix?: string }> {
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
    ...(repr.overflow === "middle-ellipsis" ? { middle: true as const } : {}),
    ...(repr.suffix === undefined ? {} : { suffix: repr.suffix }),
  };
}

function eventPrefix(glyph: string, verb: string, time: string | undefined, columns: number): string {
  const gutter = time === undefined ? " ".repeat(TIME_WIDTH) : time.padEnd(TIME_WIDTH);
  return actionCell(`${gutter} ${glyph}`, verb, columns);
}

/** The action column one row spends: six cells by default, or the name's own width when longer. */
function verbColumn(verb: string): number {
  return Math.max(VERB_WIDTH, displayColumns(verb));
}

/**
 * Attach the action cell after one row prefix. A name wider than the row's
 * remaining columns truncates grapheme-safely, spending every column the row
 * leaves after the separator so an exact-fit name stays whole and args trim first.
 */
function actionCell(head: string, verb: string, columns: number): string {
  const prefix = `${head} `;
  const available = Math.max(0, columns - displayColumns(prefix) - 1);
  const width = Math.min(verbColumn(verb), available);
  return `${prefix}${padToDisplay(truncateDisplayText(verb, width), width)} `;
}

function continuationPrefix(): string {
  return " ".repeat(TIME_WIDTH) + " │ " + " ".repeat(VERB_WIDTH) + " ";
}

/** Pad to a terminal-column width; raw string length is never the measuring stick. */
function padToDisplay(text: string, width: number): string {
  const remaining = width - displayColumns(text);
  return remaining > 0 ? `${text}${" ".repeat(remaining)}` : text;
}

/**
 * The one place row prefixes live: time, optional source, mark, verb, content.
 * A plain layout is the single-target grammar; a source layout adds the frozen
 * source column a plural wait aligns across its selected set.
 */
type RowLayout = Readonly<{
  head: (time: string | undefined, glyph: string, verb: string, columns: number) => string;
  continuation: () => string;
  marker: (count: number) => string;
  /** A plural wait shares one minute clock across all of its attributed rows. */
  clock?: { previous?: string };
  /** Plural wait rows spend their full remaining width on one terminal line. */
  singleLine?: true;
}>;

function plainLayout(): RowLayout {
  return {
    head: (time, glyph, verb, columns) => eventPrefix(glyph, verb, time, columns),
    continuation: continuationPrefix,
    marker: (count) => `${" ".repeat(TIME_WIDTH)} ⋮ ${count} omitted`,
  };
}

function sourceLayout(source: string, width: () => number, clock: { previous?: string }): RowLayout {
  const gutter = (): string => `${" ".repeat(TIME_WIDTH)} ${padToDisplay(source, width())} `;
  return {
    head: (time, glyph, verb, columns) =>
      actionCell(
        `${time === undefined ? " ".repeat(TIME_WIDTH) : time.padEnd(TIME_WIDTH)} ${padToDisplay(source, width())} ${glyph}`,
        verb,
        columns,
      ),
    // Continuations blank the time and source columns and align under the mark.
    continuation: () => `${" ".repeat(TIME_WIDTH)} ${" ".repeat(width())} │ ${" ".repeat(VERB_WIDTH)} `,
    marker: (count) => `${gutter()}⋮ ${count} omitted`,
    clock,
    singleLine: true,
  };
}

function quotedBody(row: RenderRow): boolean {
  return (
    row.kind === "said" ||
    row.kind === "thought" ||
    row.kind === "tell" ||
    (row.kind === "outcome" && row.outcome.kind === "answered")
  );
}

/** Quote every rendered body line, slicing each line's prefix by its display width. */
function quoteLines(lines: readonly string[], prefix: string): readonly string[] {
  const prefixWidth = displayColumns(prefix);
  return lines.map((line) => {
    const { text: head, rest: body } = takeDisplayColumns(line, prefixWidth);
    if (body.length === 0) return line;
    return `${head}“${body}”`;
  });
}

function renderMiddleEllipsis(first: string, text: string, suffix: string, columns: number): string {
  const prefixWidth = displayColumns(first);
  const remaining = columns - prefixWidth;
  const suffixWidth = displayColumns(suffix);
  const withSuffix = remaining - suffixWidth;
  // `$ ` + one head char + ellipsis + tail; cue and ellipsis alone are not a subject.
  const showSuffix = suffix.length > 0 && withSuffix >= 6;
  return `${first}${truncateMiddleDisplayText(text, Math.max(0, showSuffix ? withSuffix : remaining))}${showSuffix ? suffix : ""}`;
}

type RowRenderOptions = Readonly<{
  history: boolean;
  first: string;
  continuation: string;
  tool?: ToolRepr | undefined;
  singleLine?: boolean;
  inFlightSay?: boolean;
}>;

function rowBody(row: RenderRow, text: string, columns: number): string {
  if (row.kind !== "tool" || row.call.kind !== "other") return text;
  return toolContent(row, columns);
}

function renderRow(row: RenderRow, context: TextRenderContext, options: RowRenderOptions): readonly string[] {
  const { history, first, continuation, tool, singleLine = false, inFlightSay = false } = options;
  const value = rowText(row, tool);
  const quoted = quotedBody(row);
  if (singleLine) {
    const openQuote = row.kind === "said" && inFlightSay;
    const quoteWidth = quoted ? (openQuote ? 1 : 2) : 0;
    const remaining = context.columns - displayColumns(first) - quoteWidth;
    const bodyText = rowBody(row, value.text, remaining);
    const text = truncateDisplayText(bodyText, Math.max(0, remaining));
    if (!quoted) return [text.length === 0 ? first.trimEnd() : `${first}${text}`];
    return [`${first}"${text}${openQuote ? "" : '"'}`];
  }
  const quoteWidth = quoted ? 2 : 0;
  if (value.middle === true) {
    return [renderMiddleEllipsis(first, value.text, value.suffix ?? "", context.columns - quoteWidth)];
  }
  const remaining = context.columns - quoteWidth - displayColumns(first);
  // A name that already fills its row spends the width whole; its arguments trim away entirely.
  if (remaining <= 0) return [first.trimEnd()];
  const bodyText = rowBody(row, value.text, remaining - displayColumns(value.suffix ?? ""));
  const lines = renderBoundedTextBlock(bodyText, {
    first,
    continuation,
    columns: context.columns - quoteWidth,
    lines: history ? Number.MAX_SAFE_INTEGER : value.lines,
    ...("truncated" in row && row.truncated === true ? { truncated: true } : {}),
  });
  return quoted ? quoteLines(lines, first) : lines;
}

function groupedEntries(
  entries: readonly RenderEntry[],
  context: TextRenderContext,
  history = false,
  layout: RowLayout = plainLayout(),
): readonly string[] {
  const lines: string[] = [];
  let previousClock: string | undefined;
  for (const entry of entries) {
    if (entry.kind === "gap") {
      lines.push(layout.marker(entry.count));
      continue;
    }
    const row = entry.row;
    const at = clock(row.at);
    const changed = previousClock === undefined || at !== previousClock;
    const tool = row.kind === "tool" ? toolRepr(row) : undefined;
    lines.push(
      ...renderRow(row, context, {
        history,
        first: layout.head(changed ? at : undefined, mark(row), label(row, tool), context.columns),
        continuation: layout.continuation(),
        tool,
        singleLine: layout.singleLine === true,
      }),
    );
    previousClock = at;
  }
  return lines;
}

function groupedRows(
  rows: readonly RenderRow[],
  context: TextRenderContext,
  history = false,
  layout: RowLayout = plainLayout(),
): readonly string[] {
  return groupedEntries(
    rows.filter((row) => row.kind !== "turn").map((row) => ({ kind: "row", row })),
    context,
    history,
    layout,
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
  selection: Readonly<{ latest?: boolean }> = {},
): readonly string[] {
  const entries = orderedSnapshotEntries(snapshot);
  if (selection.latest !== true) {
    const full = snapshot.kind === "open" ? visibleOpenSnapshotEntries(snapshot) : entries;
    return groupedEntries(coalesceAdjacentGaps(full), context);
  }
  const latest = entries.filter((entry) => entry.kind === "row").at(-1);
  return latest === undefined ? [] : groupedEntries([latest], context);
}

/** One command's append-only activity view, with a baseline and a final tail flush. */
export type ActivityStream = ((activity: RenderedActivity) => readonly string[]) &
  Readonly<{
    /** Establish a wait baseline without spending the command's live tool budget. */
    seed: (activity: RenderedActivity) => readonly string[];
    /** Emit the deferred tail exactly once before the command's conclusion. */
    flush: () => readonly string[];
  }>;

type DeferredActivityEntry =
  | Readonly<{ kind: "gap"; count: number }>
  | Readonly<{ kind: "row"; row: RenderRow; inFlightSay: boolean }>;

type ActivityStreamState = {
  newestSettledSequence: number | undefined;
  mutableSequences: Set<number>;
  previousClock: string | undefined;
  renderedBoundaries: Set<number>;
  openingTools: number;
  deferred: DeferredActivityEntry[];
};

function isSettledStreamRow(row: RenderRow): boolean {
  if (row.kind === "turn" || row.kind === "outcome") return false;
  if (row.kind === "tell") return row.state === "told";
  return row.kind !== "tool" || (row.state !== "active" && row.state !== "unsettled");
}

/** A pending Tell or active tool retains its sequence when it later becomes eligible. */
function isMutableStreamRow(row: RenderRow): boolean {
  return (row.kind === "tell" && row.state === "pending") || (row.kind === "tool" && row.state === "active");
}

function settledRows(activity: RenderedActivity): readonly RenderRow[] {
  return activity.rows.filter(isSettledStreamRow);
}

function isProtectedStreamRow(row: RenderRow): boolean {
  return row.kind === "said" || (row.kind === "tool" && row.call.kind === "fileChange");
}

function isBoundedStreamTool(row: RenderRow): boolean {
  return row.kind === "tool" && !isProtectedStreamRow(row);
}

function rememberMutableRows(state: ActivityStreamState, activity: RenderedActivity): void {
  for (const row of activity.rows) if (isMutableStreamRow(row)) state.mutableSequences.add(row.sequence);
}

/** A seeded wait counts its skipped settled companion evidence after its typed opening. */
function baselineOmissionCount(activity: RenderedActivity, boundary: CurrentTurnBoundary): number {
  let afterBoundary = false;
  let count = 0;
  for (const row of activity.rows) {
    if (!afterBoundary) {
      if (row.sequence === boundary.row.sequence) afterBoundary = true;
      continue;
    }
    if (isSettledStreamRow(row)) count += 1;
  }
  return count;
}

type StreamRowRenderOptions = Readonly<{
  context: TextRenderContext;
  layout: RowLayout;
  inFlightSay?: boolean;
}>;

function renderStreamRow(
  state: ActivityStreamState,
  row: RenderRow,
  lines: string[],
  options: StreamRowRenderOptions,
): void {
  const { context, layout, inFlightSay = false } = options;
  const at = clock(row.at);
  const previousClock = layout.clock?.previous ?? state.previousClock;
  const changed = previousClock === undefined || at !== previousClock;
  const tool = row.kind === "tool" ? toolRepr(row) : undefined;
  lines.push(
    ...renderRow(row, context, {
      history: false,
      first: layout.head(
        changed ? at : undefined,
        inFlightSay ? "⧖" : mark(row),
        label(row, tool),
        context.columns,
      ),
      continuation: layout.continuation(),
      tool,
      singleLine: layout.singleLine === true,
      inFlightSay,
    }),
  );
  if (layout.clock !== undefined) layout.clock.previous = at;
  else state.previousClock = at;
}

function inFlightSay(activity: RenderedActivity, row: RenderRow): boolean {
  return activity.snapshot.kind === "open" && row.kind === "said";
}

function coalesceDeferredGaps(state: ActivityStreamState): void {
  state.deferred = state.deferred.reduce<DeferredActivityEntry[]>((entries, entry) => {
    const previous = entries.at(-1);
    if (entry.kind === "gap" && previous?.kind === "gap") {
      entries[entries.length - 1] = { kind: "gap", count: previous.count + entry.count };
    } else {
      entries.push(entry);
    }
    return entries;
  }, []);
}

function omitOldestDeferredTool(state: ActivityStreamState): void {
  const index = state.deferred.findIndex((entry) => entry.kind === "row" && isBoundedStreamTool(entry.row));
  if (index === -1) throw new Error("activity tail lost its pending tool");
  state.deferred[index] = { kind: "gap", count: 1 };
  coalesceDeferredGaps(state);
}

/** Emit only a prefix whose omission runs can no longer join an unresolved tail tool. */
function flushSafeActivityPrefix(
  state: ActivityStreamState,
  lines: string[],
  context: TextRenderContext,
  layout: RowLayout,
): void {
  for (;;) {
    const first = state.deferred[0];
    if (first === undefined || (first.kind === "row" && isBoundedStreamTool(first.row))) return;
    if (first.kind === "row") {
      state.deferred.shift();
      renderStreamRow(state, first.row, lines, { context, layout, inFlightSay: first.inFlightSay });
      continue;
    }
    const next = state.deferred[1];
    if (next === undefined || (next.kind === "row" && isBoundedStreamTool(next.row))) return;
    state.deferred.shift();
    lines.push(layout.marker(first.count));
  }
}

function renderCurrentTurnBoundary(
  state: ActivityStreamState,
  activity: RenderedActivity,
  lines: string[],
  context: TextRenderContext,
  layout: RowLayout,
): CurrentTurnBoundary | undefined {
  const boundary = currentTurnBoundary(activity);
  if (boundary !== undefined && !state.renderedBoundaries.has(boundary.turnSequence)) {
    state.renderedBoundaries.add(boundary.turnSequence);
    if (boundary.row.kind !== "thought") renderStreamRow(state, boundary.row, lines, { context, layout });
  }
  return boundary;
}

function observeActivitySnapshot(
  state: ActivityStreamState,
  activity: RenderedActivity,
  context: TextRenderContext,
  layout: RowLayout,
): readonly string[] {
  const lines: string[] = [];
  const boundary = currentTurnBoundary(activity);
  rememberMutableRows(state, activity);
  // A row newly selected as this Turn's typed opening must still respect the
  // settled cursor, even if its earlier pending form was remembered as mutable.
  if (boundary !== undefined) state.mutableSequences.delete(boundary.row.sequence);
  const observedRows = settledRows(activity)
    .filter(
      (row) =>
        boundary === undefined ||
        !state.renderedBoundaries.has(boundary.turnSequence) ||
        row.sequence !== boundary.row.sequence,
    )
    .filter(
      (row) =>
        state.mutableSequences.has(row.sequence) ||
        state.newestSettledSequence === undefined ||
        row.sequence > state.newestSettledSequence,
    );
  if (observedRows.length === 0) return lines;
  for (const row of observedRows) state.mutableSequences.delete(row.sequence);
  state.newestSettledSequence = observedRows.reduce(
    (newest, row) => Math.max(newest, row.sequence),
    state.newestSettledSequence ?? observedRows[0]!.sequence,
  );
  const rows = observedRows.filter((row) => row.kind !== "thought");
  for (const row of rows) {
    if (isBoundedStreamTool(row) && state.openingTools < OPENING_TOOL_BUDGET) {
      state.openingTools += 1;
      renderStreamRow(state, row, lines, { context, layout, inFlightSay: inFlightSay(activity, row) });
      continue;
    }
    if (!isBoundedStreamTool(row) && state.deferred.length === 0) {
      renderStreamRow(state, row, lines, { context, layout, inFlightSay: inFlightSay(activity, row) });
      continue;
    }
    state.deferred.push({ kind: "row", row, inFlightSay: inFlightSay(activity, row) });
    if (isBoundedStreamTool(row)) {
      const pendingTools = state.deferred.filter(
        (entry) => entry.kind === "row" && isBoundedStreamTool(entry.row),
      ).length;
      if (pendingTools > RECENT_TOOL_BUDGET) omitOldestDeferredTool(state);
    }
    flushSafeActivityPrefix(state, lines, context, layout);
  }
  return lines;
}

function flushActivityTail(
  state: ActivityStreamState,
  context: TextRenderContext,
  layout: RowLayout,
): readonly string[] {
  const lines: string[] = [];
  for (const entry of state.deferred) {
    if (entry.kind === "gap") lines.push(layout.marker(entry.count));
    else renderStreamRow(state, entry.row, lines, { context, layout, inFlightSay: entry.inFlightSay });
  }
  state.deferred = [];
  return lines;
}

/**
 * Append-only live view over one command's successive settled snapshots. The
 * first three tools stream immediately; later tools wait in a two-row tail
 * until the command ends. As a newer tool displaces an older tail candidate,
 * its body becomes an in-place omission count. Narrative waits only while a
 * preceding tail tool still decides its position.
 */
export function activityStream(context: TextRenderContext, layout: RowLayout = plainLayout()): ActivityStream {
  const state: ActivityStreamState = {
    newestSettledSequence: undefined,
    mutableSequences: new Set(),
    previousClock: undefined,
    renderedBoundaries: new Set(),
    openingTools: 0,
    deferred: [],
  };
  const seed = (activity: RenderedActivity): readonly string[] => {
    const lines: string[] = [];
    const boundary = currentTurnBoundary(activity);
    const unseenBoundary = boundary !== undefined && !state.renderedBoundaries.has(boundary.turnSequence);
    if (unseenBoundary) {
      renderCurrentTurnBoundary(state, activity, lines, context, layout);
      const omitted = baselineOmissionCount(activity, boundary!);
      if (omitted > 0) lines.push(layout.marker(omitted));
    }
    rememberMutableRows(state, activity);
    const rows = settledRows(activity);
    if (rows.length > 0)
      state.newestSettledSequence = rows.reduce((newest, row) => Math.max(newest, row.sequence), rows[0]!.sequence);
    return lines;
  };
  const observe = (activity: RenderedActivity): readonly string[] =>
    observeActivitySnapshot(state, activity, context, layout);
  const flush = (): readonly string[] => flushActivityTail(state, context, layout);
  return Object.assign(observe, { seed, flush });
}

/** What a wait conclusion renders over: its observed and unobserved members. */
export type WaitConclusionResult = Readonly<{
  reason: "completed" | "deadline";
  observations: readonly AkumaObservation[];
  unobserved: readonly Readonly<{ id: string; diagnostic: string }>[];
}>;

/** One selected Akuma's frozen identity, resolved before the first observation round. */
export type WaitSelectedIdentity = Readonly<{
  id: string;
  alias?: string;
  contract?: DispatchAssociation;
}>;

export type WaitObservationStream = Readonly<{
  /** Freeze the selected set's identities so the source column is stable before the first row. */
  select: (selected: readonly WaitSelectedIdentity[]) => void;
  /** One observation round; returns the head frames and newly settled rows to print. */
  observe: (observed: readonly WaitObservedAkuma[]) => readonly string[];
  /** The wait's closing scoreboard, or the empty string when there is nothing to print. */
  conclude: (result: WaitConclusionResult) => string;
  streamed: () => boolean;
}>;

function conclusionMarkVerb(
  status: AkumaObservation["status"],
  answered: boolean,
): Readonly<{ mark: string; verb: string }> {
  if (failedOutcomeDiagnostic(status) !== undefined) return { mark: "!", verb: "failed" };
  if (answered) return { mark: "✓", verb: "answered" };
  if (status.life === "running") return { mark: "●", verb: "still running" };
  if (!defaultWaitComplete(status)) {
    return { mark: "⧗", verb: "pending tell" };
  }
  if (status.life === "asleep") return { mark: "✓", verb: "completed" };
  if (status.life === "killed") return { mark: "×", verb: "killed" };
  if (status.life === "hung") return { mark: "?", verb: "hung" };
  if (status.life === "untidy") return { mark: "!", verb: "untidy" };
  return { mark: "!", verb: "stranded" };
}

/**
 * The durable moment an Akuma settled, read from the outcome row its own timeline
 * retained. Absent for an ending that leaves no outcome row, so the caller falls
 * back to the observation that noticed it.
 */
function settleMoment(status: AkumaObservation["status"]): number | undefined {
  const outcome = status.timeline.kind === "idle" ? status.timeline.outcome : undefined;
  if (outcome === undefined) return undefined;
  const at = new Date(outcome.at).getTime();
  return Number.isFinite(at) ? at : undefined;
}

function clockFromMs(at: number): string {
  return clock(new Date(at).toISOString());
}

function durationText(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60)}s`;
}

type WaitObservationStreamState = {
  streams: Map<string, ActivityStream>;
  /** Full frozen source labels are used only in the aggregate head. */
  sources: Map<string, string>;
  /** Compact identity tags attribute plural rows, diagnostics, and conclusions. */
  tags: Map<string, string>;
  contracts: Map<string, DispatchAssociation>;
  settledAt: Map<string, number>;
  sourceWidth: number;
  /** The plural stream's timestamp blanking spans every source. */
  clock: { previous?: string };
  /** Whether this wait observes a plural selected set; undefined until a selection or first round fixes it. */
  plural: boolean | undefined;
  headerEmitted: boolean;
  observed: boolean;
};

function createWaitObservationState(): WaitObservationStreamState {
  return {
    streams: new Map<string, ActivityStream>(),
    sources: new Map<string, string>(),
    tags: new Map<string, string>(),
    contracts: new Map<string, DispatchAssociation>(),
    settledAt: new Map<string, number>(),
    sourceWidth: 0,
    clock: {},
    plural: undefined,
    headerEmitted: false,
    observed: false,
  };
}

function shortestUniquePrefix(value: string, values: readonly string[]): string | undefined {
  for (let length = 4; length <= value.length; length += 1) {
    const tag = value.slice(0, length);
    if (values.filter((candidate) => candidate.slice(0, length) === tag).length === 1) return tag;
  }
  return undefined;
}

function shortestUniqueSegmentSuffix(id: string, ids: readonly string[]): string | undefined {
  const segments = id.split("/");
  for (let start = segments.length - 2; start >= 0; start -= 1) {
    const tag = segments.slice(start).join("/");
    if (ids.filter((candidate) => candidate.endsWith(`/${tag}`) || candidate === tag).length === 1) return tag;
  }
  return undefined;
}

function waitIdentityTag(id: string, ids: readonly string[]): string {
  const finals = ids.map((candidate) => candidate.slice(candidate.lastIndexOf("/") + 1));
  const index = ids.indexOf(id);
  const own = finals[index];
  if (own === undefined) return id;
  return (
    shortestUniquePrefix(own, finals) ?? shortestUniqueSegmentSuffix(id, ids) ?? shortestUniquePrefix(id, ids) ?? id
  );
}

/** The selected set fixes identity tags before its first attributed row. */
function freezeWaitTags(state: WaitObservationStreamState): void {
  const ids = [...state.sources.keys()];
  state.tags = new Map(ids.map((id) => [id, waitIdentityTag(id, ids)]));
  state.sourceWidth = Math.max(0, ...Array.from(state.tags.values(), displayColumns));
}

function sourceTag(state: WaitObservationStreamState, id: string): string {
  return state.tags.get(id) ?? waitIdentityTag(id, [...state.sources.keys()]);
}

/** Register one selected or newly observed source; the set freezes the column before the first row. */
function registerWaitSource(
  state: WaitObservationStreamState,
  id: string,
  alias: string | undefined,
  contract?: DispatchAssociation,
): void {
  if (state.sources.has(id)) return;
  const label = alias ?? id;
  state.sources.set(id, label);
  if (contract !== undefined) state.contracts.set(id, contract);
}

/**
 * The one aggregate head a plural wait prints before any activity row: the
 * selected set read as a list, each target on its own line named by the alias
 * addressing it, otherwise its complete identity, with its `· kei/<contract>`
 * association inline when one exists, all closed by the frame's single rule.
 */
function aggregateHeading(state: WaitObservationStreamState): readonly string[] {
  const head = [...state.sources].map(([id, label]) => {
    const contractId = associatedContractId(state.contracts.get(id) ?? { kind: "none" });
    const named = `${sourceTag(state, id)} ${label}`;
    return contractId === undefined ? named : `${named} · ${contractId}`;
  });
  return [...head, frameRule(head)];
}

function observeWaitRound(
  state: WaitObservationStreamState,
  round: readonly WaitObservedAkuma[],
  context: TextRenderContext,
  now: () => number,
): readonly string[] {
  state.observed = true;
  // Establish the whole round's sources before any row so widths stay aligned within it.
  for (const member of round) registerWaitSource(state, member.status.id, member.alias, member.contract);
  if (!state.headerEmitted) freezeWaitTags(state);
  const lines: string[] = [];
  // The observation subject opens once: an aggregate head for a plural set, the observed
  // identity frame for a single target. Every later round only appends attributed rows.
  if (!state.headerEmitted && round.length > 0) {
    state.headerEmitted = true;
    state.plural ??= state.sources.size > 1;
    if (state.plural) {
      lines.push(...aggregateHeading(state));
    } else {
      const sole = round[0]!;
      lines.push(...snapshotHeading(sole.status.id, sole.alias, sole.contract));
    }
  }
  for (const { status, rows } of round) {
    const known = state.streams.get(status.id);
    if (known !== undefined) {
      lines.push(...known({ snapshot: status.timeline, rows }));
    } else {
      // Only a plural wait attributes its rows; a single-target stream keeps the plain row grammar.
      const stream = activityStream(
        context,
        state.plural === true
          ? sourceLayout(sourceTag(state, status.id), () => state.sourceWidth, state.clock)
          : plainLayout(),
      );
      state.streams.set(status.id, stream);
      // Seed marks skipped retained evidence without spending this command's live tool budget.
      lines.push(...stream.seed({ snapshot: status.timeline, rows }));
    }
    if (!state.settledAt.has(status.id) && defaultWaitComplete(status))
      state.settledAt.set(status.id, settleMoment(status) ?? now());
  }
  return lines;
}

/**
 * A conclusion clause asserts real waiting: a target that settled at or after
 * this wait began keeps its duration, a target already settled names no
 * duration, and an unfinished target carries the elapsed wait.
 */
function conclusionClause(at: number, startedAt: number, complete: boolean, end: number): string {
  if (!complete) return ` — waited ${durationText(Math.max(0, end - startedAt))}`;
  return at >= startedAt ? ` — ${durationText(Math.max(0, at - startedAt))}` : "";
}

/** Present ids in frozen selection order, then any result member the selection never named. */
function orderedWaitIds(state: WaitObservationStreamState, result: WaitConclusionResult): readonly string[] {
  const ids = [...state.sources.keys()];
  const known = new Set(ids);
  for (const observation of result.observations) {
    if (!known.has(observation.status.id)) {
      known.add(observation.status.id);
      ids.push(observation.status.id);
    }
  }
  for (const member of result.unobserved) {
    if (!known.has(member.id)) {
      known.add(member.id);
      ids.push(member.id);
    }
  }
  return ids;
}

function concludeWaitStream(
  state: WaitObservationStreamState,
  result: WaitConclusionResult,
  startedAt: number,
  now: () => number,
): string {
  const tail: string[] = [];
  for (const stream of state.streams.values()) tail.push(...stream.flush());

  const end = now();
  for (const observation of result.observations)
    registerWaitSource(state, observation.status.id, undefined, observation.contract);
  for (const member of result.unobserved) registerWaitSource(state, member.id, undefined);
  if (!state.headerEmitted) freezeWaitTags(state);
  const order = orderedWaitIds(state, result);
  const multi = order.length > 1;
  const observationById = new Map<string, AkumaObservation>(
    result.observations.map((observation) => [observation.status.id, observation]),
  );
  const unobservedById = new Map<string, Readonly<{ id: string; diagnostic: string }>>(
    result.unobserved.map((member) => [member.id, member]),
  );
  // A failure fact keeps the complete identity even where the scoreboard attributes a target by its identity tag.
  const unobservedLines = order
    .filter((id) => unobservedById.has(id))
    .map((id) => unobservedText(id, unobservedById.get(id)!.diagnostic));
  const conclusions = order.flatMap((id) => {
    const observation = observationById.get(id);
    if (observation === undefined) return [];
    const status = observation.status;
    const complete = defaultWaitComplete(status);
    const at = complete ? (state.settledAt.get(id) ?? end) : end;
    const { mark, verb } = conclusionMarkVerb(status, statusAnswer(observation) !== undefined);
    const target = multi ? ` ${padToDisplay(sourceTag(state, id), state.sourceWidth)}` : "";
    return [`${clockFromMs(at)}${target} ${mark} ${verb}${conclusionClause(at, startedAt, complete, end)}`];
  });
  const answeredSingle =
    !multi && result.observations.length === 1 && statusAnswer(result.observations[0]!) !== undefined;
  const blocks = [
    ...(unobservedLines.length > 0 ? [unobservedLines.join("\n")] : []),
    ...(conclusions.length > 0 ? [(multi ? [""] : []).concat(conclusions).join("\n")] : []),
  ];
  const body = [...tail, ...blocks].join("\n");
  // One blank line keeps the bare stdout answer visually separate from the stream.
  return answeredSingle ? `${body}\n\n` : body;
}

/**
 * Live view over a wait's successive observation rounds, one append-only
 * stream per selected Akuma. A plural wait opens one aggregate frame naming
 * its selected set before any activity row and never opens a per-target frame
 * during observation; a single-target wait opens that Akuma's own identity
 * frame — the identity and Contract association the observed facts carry —
 * and an already settled Akuma prints that frame while replaying no backlog
 * rows. `conclude` renders the closing rows once the wait ends: one row per
 * observed Akuma in `<clock> <mark> <verb> — <duration>` grammar, with a target
 * named for a multi-target scoreboard and no activity replay.
 */
export function waitObservationStream(
  context: TextRenderContext,
  options: Readonly<{ now?: () => number }> = {},
): WaitObservationStream {
  const now = options.now ?? ((): number => Date.now());
  const startedAt = now();
  const state = createWaitObservationState();
  const select = (selected: readonly WaitSelectedIdentity[]): void => {
    for (const member of selected) registerWaitSource(state, member.id, member.alias, member.contract);
    state.plural ??= selected.length > 1;
    freezeWaitTags(state);
  };
  const observe = (round: readonly WaitObservedAkuma[]): readonly string[] =>
    observeWaitRound(state, round, context, now);
  const conclude = (result: WaitConclusionResult): string => concludeWaitStream(state, result, startedAt, now);
  return { select, observe, conclude, streamed: () => state.observed };
}

/** The identity a streamed observing call's head frame renders from its resolved birth. */
export type ObservedCallHead = Readonly<{
  id: string;
  alias?: string;
  contract: DispatchAssociation;
  facts: readonly string[];
}>;

export type CallObservationStream = Readonly<{
  observe: (observation: Readonly<{ status: AkumaStatus; rows: readonly ActivityRow[] }>) => readonly string[];
  conclude: (observation: CallObservation) => string;
  opened: () => boolean;
}>;

function failedOutcomeDiagnostic(status: AkumaStatus): string | undefined {
  const outcome = status.timeline.kind === "idle" ? status.timeline.outcome : undefined;
  return outcome !== undefined && outcome.outcome.kind === "failed" ? outcome.outcome.diagnostic : undefined;
}

/**
 * Live view over one observing call: its identity frame and birth diagnostics
 * open the stream once, settled rows follow as they arrive, and the return
 * appends one conclusion in single-target wait grammar. The stream never
 * replays its own activity as a final snapshot, and it never carries the
 * birth receipt's cwd row.
 */
export function callObservationStream(
  context: TextRenderContext,
  head: ObservedCallHead,
  options: Readonly<{ now?: () => number }> = {},
): CallObservationStream {
  const now = options.now ?? ((): number => Date.now());
  const startedAt = now();
  const stream = activityStream(context);
  let opened = false;
  const open = (lines: string[]): void => {
    if (opened) return;
    opened = true;
    lines.push(...snapshotHeading(head.id, head.alias, head.contract), ...head.facts);
  };
  const observe = (observation: Readonly<{ status: AkumaStatus; rows: readonly ActivityRow[] }>): readonly string[] => {
    const lines: string[] = [];
    open(lines);
    lines.push(...stream({ snapshot: observation.status.timeline, rows: observation.rows }));
    return lines;
  };
  const conclude = (observation: CallObservation): string => {
    const lines: string[] = [];
    open(lines);
    lines.push(...stream.flush());
    if (observation.kind === "failed") {
      lines.push(`! error ${safeText(observation.failure.diagnostic)}`);
      return lines.join("\n");
    }
    if (observation.kind !== "observed") return lines.join("\n");
    const end = now();
    const status = observation.status;
    const answered = statusAnswer({ status }) !== undefined;
    const complete = defaultWaitComplete(status);
    const at = complete ? (settleMoment(status) ?? end) : end;
    const { mark, verb } = conclusionMarkVerb(status, answered);
    lines.push(`${clockFromMs(at)} ${mark} ${verb}${conclusionClause(at, startedAt, complete, end)}`);
    const failure = failedOutcomeDiagnostic(status);
    if (failure !== undefined) lines.push(`! error ${safeText(failure)}`);
    return lines.join("\n");
  };
  return { observe, conclude, opened: () => opened };
}

type CreatedTaskRow = Extract<CreatedTaskObservation, { kind: "present" }>["rows"][number];

function taskDispositionMark(disposition: CreatedTaskRow["disposition"]): string {
  if (disposition === "done") return "✓";
  if (disposition === "drop") return "×";
  if (disposition === "on_hold") return "⧗";
  if (disposition === "in_progress") return "●";
  return disposition === "blocked" ? "‖" : "○";
}

function changeStat(change: RenderedFileChange): string {
  return change.diffstat === undefined ? "+? -?" : `+${change.diffstat.added} -${change.diffstat.removed}`;
}

function renderReportedChangeLines(snapshot: RenderedSnapshot): readonly string[] {
  if (snapshot.reportedChanges.length === 0 && snapshot.reportedChangesOmitted === 0) return [];
  const width = snapshot.reportedChanges.reduce((max, change) => Math.max(max, changeStat(change).length), 0);
  return [
    `changes ${snapshot.reportedChanges.length + snapshot.reportedChangesOmitted}`,
    ...snapshot.reportedChanges.map((change) => `  ${changeStat(change).padEnd(width)}  ${safeText(change.path)}`),
    ...(snapshot.reportedChangesOmitted > 0 ? [`  ⋮ ${snapshot.reportedChangesOmitted} more files`] : []),
  ];
}

function renderTaskRow(row: CreatedTaskRow, columns: number): readonly string[] {
  const prefix = `  ${taskDispositionMark(row.disposition)} ${row.id} · `;
  const body = `${safeText(row.title)} · ${row.disposition} · P${row.priority}`;
  const inline = `${prefix}${body}`;
  if (displayColumns(inline) <= columns) return [inline];
  return renderBoundedTextBlock(body, {
    first: prefix,
    continuation: "    ",
    columns,
    lines: Number.MAX_SAFE_INTEGER,
  });
}

function renderTaskContextLines(created: CreatedTaskObservation | undefined, columns: number): readonly string[] {
  if (created === undefined) return [];
  if (created.kind === "failed") return [`! tasks failed ${safeText(created.diagnostic)}`];
  if (created.rows.length === 0) return [];
  return [`tasks ${created.rows.length}`, ...created.rows.flatMap((row) => renderTaskRow(row, columns))];
}

function answerContextLines(observation: AkumaObservation, columns: number): readonly string[] {
  return [
    ...renderTaskContextLines(observation.createdTasks, columns),
    ...renderReportedChangeLines(observation.status.timeline),
  ];
}

function answeredBlock(
  observation: AkumaObservation,
  answer: string,
  alias: string | undefined,
  columns: number,
): string {
  const frame = answeredHeading(observation.status.id, alias).join("\n");
  const context = answerContextLines(observation, columns).join("\n");
  if (context.length === 0) return `${frame}\n${answer}`;
  const separator = answer.endsWith("\n") ? "\n" : "\n\n";
  return `${frame}\n${answer}${separator}${context}`;
}

type SnapshotView = Readonly<{
  status: AkumaObservation["status"];
  contract: DispatchAssociation;
  createdTasks?: CreatedTaskObservation;
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
): Readonly<{ activity: readonly string[]; lines: readonly string[] }> {
  const activity = snapshotActivityLines(view.status.timeline, context);
  const facts = [
    ...(options.showAllowed === true ? [`allowed  ${view.status.allowed.join(", ") || "none"}`] : []),
    ...(view.status.readonly?.enforcement === "none" ? [`! ${safeText(view.status.readonly.diagnostic)}`] : []),
    ...contractFacts(view.contract),
    ...(options.facts ?? []),
  ];
  return {
    activity,
    lines: [...snapshotHeading(view.status.id, options.alias, view.contract), ...facts, ...activity],
  };
}

export function snapshotText(
  view: SnapshotView,
  context: TextRenderContext,
  options: SnapshotCoreOptions = {},
): string {
  const core = snapshotCore(view, context, options);
  const taskContext = renderTaskContextLines(view.createdTasks, context.columns);
  return [
    ...core.lines,
    ...(core.activity.length > 0 && taskContext.length > 0 ? [""] : []),
    ...taskContext,
    ...renderReportedChangeLines(view.status.timeline),
    "",
    lifeLabel(view.status.life),
  ].join("\n");
}

function mutationSnapshotText(
  view: SnapshotView,
  context: TextRenderContext,
  options: SnapshotCoreOptions & Readonly<{ showLife?: boolean }> = {},
): string {
  const core = snapshotCore(view, context, options);
  return [...core.lines, ...(options.showLife === false ? [] : ["", lifeLabel(view.status.life)])].join("\n");
}

function killResultLabel(evidence: KillEvidence): string {
  if (evidence === "killed") return "✓ killed";
  if (evidence === "already-killed") return "✓ already killed";
  if (evidence === "already-stopped") return "✓ already stopped";
  return `! not killed · ${evidence}`;
}

export function killResultText(id: string, evidence: KillEvidence, alias?: string): string {
  return [...snapshotHeading(id, alias, undefined), "", killResultLabel(evidence)].join("\n");
}

export function mutationObservationStageText(
  id: string,
  observation: AkumaObservationStage,
  context: TextRenderContext,
  options: SnapshotCoreOptions & Readonly<{ showLife?: boolean }> = {},
): string {
  if (observation.kind === "unobserved") return unobservedText(id, observation.diagnostic);
  return mutationSnapshotText(observation, context, options);
}

export function statusAnswer(view: Readonly<{ status: AkumaObservation["status"] }>): string | undefined {
  if (!defaultWaitComplete(view.status)) return undefined;
  if (view.status.life !== "asleep") return undefined;
  if (view.status.readonly?.enforcement === "none") return undefined;
  const timeline = view.status.timeline;
  if (timeline.kind !== "idle" || timeline.outcome?.outcome.kind !== "answered") return undefined;
  return timeline.outcome.outcome.answer;
}

function answerCallFailed(result: Extract<AkumaInvocationResult, { action: "call" }>["result"]): boolean {
  return result.dispatch.kind === "failed" || result.alias.kind === "failed" || result.readonly?.enforcement === "none";
}

export function akumaRawAnswer(result: AkumaInvocationResult): string | undefined {
  if (result.action === "call") {
    if (result.streamed === true) {
      // A streamed call's stdout is its answer or nothing; diagnostics belong to stderr.
      if (answerCallFailed(result.result) || result.result.observation.kind !== "observed") return "";
      return statusAnswer({ status: parseAkumaStatus(result.result.observation.status) }) ?? "";
    }
    if (answerCallFailed(result.result) || result.result.observation.kind !== "observed") return undefined;
    return statusAnswer({ status: parseAkumaStatus(result.result.observation.status) });
  }
  if (result.action === "wait") {
    if (result.streamed === true) {
      // Plural waits leave stdout empty so one answer can never be mistaken for the whole result.
      const total = result.result.observations.length + result.result.unobserved.length;
      const single = total === 1 ? result.result.observations[0] : undefined;
      return single === undefined ? "" : (statusAnswer(single) ?? "");
    }
    const total = result.result.observations.length + result.result.unobserved.length;
    if (total === 1) return statusAnswer(result.result.observations[0]!);
  }
  if (result.action === "history" && result.mode === "exact" && result.historyResult.kind === "exact") {
    return result.historyResult.outcome.outcome.kind === "answered"
      ? result.historyResult.outcome.outcome.answer
      : result.historyResult.outcome.outcome.diagnostic;
  }
  return undefined;
}

export function waitText(
  result: Extract<AkumaInvocationResult, { action: "wait" }>,
  context: TextRenderContext,
): string {
  const alias = result.alias;
  const observations = result.result.observations;
  const unobserved = result.result.unobserved;
  const total = observations.length + unobserved.length;
  if (total <= 1) {
    const single = [
      ...observations.map((observation) => {
        const answer = statusAnswer(observation);
        if (answer !== undefined) return answeredBlock(observation, answer, alias, context.columns);
        return snapshotText(observation, context, { ...(alias === undefined ? {} : { alias }) });
      }),
      ...unobserved.map((member) => unobservedText(member.id, member.diagnostic)),
    ];
    return single.join("\n\n");
  }
  const end = Date.now();
  const startedAt = result.startedAt ?? end;
  const order: string[] = [];
  const remember = (id: string): void => {
    if (!order.includes(id)) order.push(id);
  };
  for (const member of result.selection ?? []) remember(member.id);
  for (const observation of observations) remember(observation.status.id);
  for (const member of unobserved) remember(member.id);
  const observationById = new Map<string, AkumaObservation>(
    observations.map((observation) => [observation.status.id, observation]),
  );
  const unobservedById = new Map<string, Readonly<{ id: string; diagnostic: string }>>(
    unobserved.map((member) => [member.id, member]),
  );
  const sourceWidth = Math.max(0, ...order.map((id) => displayColumns(waitIdentityTag(id, order))));
  const blocks = [
    ...order.flatMap((id) => {
      const observation = observationById.get(id);
      if (observation === undefined) return [];
      const answer = statusAnswer(observation);
      if (answer !== undefined) return [answeredBlock(observation, answer, undefined, context.columns)];
      return [snapshotText(observation, context)];
    }),
    ...(unobserved.length > 0
      ? [
          order
            .filter((id) => unobservedById.has(id))
            .map((id) => unobservedText(id, unobservedById.get(id)!.diagnostic))
            .join("\n"),
        ]
      : []),
  ];
  const rows = order.flatMap((id) => {
    const observation = observationById.get(id);
    if (observation === undefined) return [];
    const status = observation.status;
    const complete = defaultWaitComplete(status);
    const at = complete ? (settleMoment(status) ?? end) : end;
    const { mark, verb } = conclusionMarkVerb(status, statusAnswer(observation) !== undefined);
    return [
      `${clockFromMs(at)} ${padToDisplay(waitIdentityTag(id, order), sourceWidth)} ${mark} ${verb}${conclusionClause(at, startedAt, complete, end)}`,
    ];
  });
  return rows.length > 0 ? [...blocks, rows.join("\n")].join("\n\n") : blocks.join("\n\n");
}

export function historyText(
  command: Extract<ParsedCommand, { command: "history"; last: boolean }>,
  result: Extract<AkumaInvocationResult, { action: "history" }>,
  context: TextRenderContext,
): string {
  if (result.mode === "exact") {
    const exact = result.historyResult;
    if (exact.kind !== "exact")
      return `${exact.kind === "unknown-history" ? exact.historyId : "unknown"} has no matching retained outcome`;
    return exact.outcome.outcome.kind === "answered" ? exact.outcome.outcome.answer : exact.outcome.outcome.diagnostic;
  }
  if (command.last) return result.mode === "last" ? result.answer : "no answer retained";
  if (result.mode !== "page") throw new Error("history result lacks page");
  const rows = groupedRows(result.history.rows, context, true);
  const paging =
    result.history.omitted > 0
      ? [`  ⋮ ${result.history.omitted} earlier turns · showing last ${result.history.rows.length}`]
      : [];
  return [...snapshotHeading(result.akuma, result.alias, result.historyResult.contract), ...paging, ...rows].join("\n");
}

export function tellText(
  result: Extract<AkumaInvocationResult, { action: "tell"; mode: "ordinary" }>,
  context: TextRenderContext,
): string {
  const wake = result.result.tell.wake;
  const target = identity(result.result.akuma, result.alias);
  const row = groupedRows([result.result.tell.row], context).join("\n");
  if (wake.kind === "failed") {
    const child = "child" in wake ? wake.child : undefined;
    const failure = `! tell delivery failed · ${safeText(wake.diagnostic)}${child === undefined ? "" : ` · log ${child.log.path} ${child.log.from}..${child.log.to}`}`;
    return `${target}\n${row}\n${renderBoundedTextBlock(failure, { first: "", continuation: "  ", columns: context.columns, lines: Number.MAX_SAFE_INTEGER }).join("\n")}`;
  }
  return `${target}\n${row}`;
}
