import type { ActivityRow, AkumaStatus, KillEvidence, ReportedFileChange } from "../../akuma/akuma.js";
import type { CallObservation } from "../../library/akuma-creation.js";
import type {
  AkumaObservation,
  AkumaObservationStage,
  CreatedTaskObservation,
  DispatchAssociation,
} from "../../index.js";
import { parseAkumaStatus } from "../../akuma/akuma.js";
import type { AkumaInvocationResult } from "../commands/akuma-invoke.js";
import type { WaitObservedAkuma } from "../../akuma/fleet-execution.js";
import type { ParsedCommand } from "../parse.js";
import { toolRepr } from "./akuma-tool.js";
import {
  displayColumns,
  renderBoundedTextBlock,
  safeText,
  takeDisplayColumns,
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

/** Newest tool rows one observation batch keeps; older ones fold in place. */
const STREAM_TOOL_BUDGET = 3;

type FleetTimeline = AkumaObservation["status"]["timeline"];
type FleetTimelineEntry = FleetTimeline["entries"][number];
type FleetReportedFileChange = FleetTimeline["reportedChanges"][number];
type RenderRow = ActivityRow | Extract<FleetTimelineEntry, { kind: "row" }>["row"];
type RenderEntry = Readonly<{ kind: "gap"; count: number }> | Readonly<{ kind: "row"; row: RenderRow }>;
type RenderedSnapshot = FleetTimeline;
type RenderedFileChange = ReportedFileChange | FleetReportedFileChange;

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
  const heading = `✓ came back ${identity(id, alias)}`;
  return [heading, frameRule([heading])];
}

function contractFacts(contract: DispatchAssociation): readonly string[] {
  return contract.kind === "failed" ? [`! contract failed ${safeText(contract.diagnostic)}`] : [];
}

function unobservedText(id: string, diagnostic: string): string {
  return `! ${id} unobserved: ${safeText(diagnostic)}`;
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

function label(row: RenderRow): string {
  if (row.kind === "said") return "say";
  if (row.kind === "thought") return "think";
  if (row.kind === "note") return "note";
  if (row.kind === "call") return "call";
  if (row.kind === "tell") return row.state === "told" ? "told" : "tell";
  if (row.kind === "outcome") return row.outcome.kind === "answered" ? "say" : "error";
  if (row.kind === "turn") return "call";
  if (row.kind !== "tool") return row.kind;
  return toolRepr(row).label;
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

/** Strip Markdown decoration from preview prose without rewriting the words. */
function undecorated(text: string): string {
  return (
    text
      .replace(/^ {0,3}#{1,6}[ \t]+/gmu, "")
      .replace(/^ {0,3}(?:[-*+]|\d+\.)[ \t]+/gmu, "")
      .replace(/\*\*([^*\n]+?)\*\*/gu, "$1")
      // A single pair of asterisks is emphasis only when it does not sit inside a word, path, or glob.
      .replace(/(?<![\w*/\\])\*([^\s*/\\](?:[^*/\\\n]*[^\s*/\\])?)\*(?![\w*/\\])/gu, "$1")
      .replace(/`([^`\n]+?)`/gu, "$1")
      .replace(/\s+/gu, " ")
      .trim()
  );
}

function rowText(row: RenderRow): Readonly<{ text: string; lines: number; middle?: true; suffix?: string }> {
  if (
    row.kind === "said" ||
    row.kind === "thought" ||
    row.kind === "note" ||
    row.kind === "call" ||
    row.kind === "tell"
  ) {
    return {
      text: undecorated(row.text),
      lines: row.kind === "said" || row.kind === "thought" ? 2 : row.kind === "tell" || row.kind === "call" ? 1 : 2,
    };
  }
  if (row.kind === "outcome")
    return row.outcome.kind === "answered"
      ? { text: undecorated(row.outcome.answer), lines: 3 }
      : { text: row.outcome.diagnostic, lines: 2 };
  if (row.kind === "turn") return { text: "", lines: 1 };
  if (row.kind !== "tool") return { text: "", lines: 1 };
  const repr = toolRepr(row);
  return {
    text: repr.text,
    lines: 2,
    ...(repr.overflow === "middle-ellipsis" ? { middle: true as const } : {}),
    ...(repr.suffix === undefined ? {} : { suffix: repr.suffix }),
  };
}

function eventPrefix(glyph: string, verb: string, time?: string): string {
  const gutter = time === undefined ? " ".repeat(TIME_WIDTH) : time.padEnd(TIME_WIDTH);
  return `${gutter} ${glyph} ${verb.padEnd(VERB_WIDTH)} `;
}

function continuationPrefix(): string {
  return eventPrefix("│", "");
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
  head: (time: string | undefined, glyph: string, verb: string) => string;
  continuation: () => string;
  marker: (count: number) => string;
}>;

function plainLayout(): RowLayout {
  return {
    head: (time, glyph, verb) => eventPrefix(glyph, verb, time),
    continuation: continuationPrefix,
    marker: (count) => `${" ".repeat(TIME_WIDTH)} ⋮ ${count} omitted`,
  };
}

function sourceLayout(source: string, width: () => number): RowLayout {
  const gutter = (): string => `${" ".repeat(TIME_WIDTH)} ${padToDisplay(source, width())} `;
  return {
    head: (time, glyph, verb) =>
      `${time === undefined ? " ".repeat(TIME_WIDTH) : time.padEnd(TIME_WIDTH)} ${padToDisplay(source, width())} ${glyph} ${verb.padEnd(VERB_WIDTH)} `,
    // Continuations blank the time and source columns and align under the mark.
    continuation: () => `${" ".repeat(TIME_WIDTH)} ${" ".repeat(width())} │ ${" ".repeat(VERB_WIDTH)} `,
    marker: (count) => `${gutter()}⋮ ${count} omitted`,
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

function renderRow(
  row: RenderRow,
  context: TextRenderContext,
  history: boolean,
  first: string,
  continuation: string,
): readonly string[] {
  const value = rowText(row);
  const quoted = quotedBody(row);
  const quoteWidth = quoted ? 2 : 0;
  if (value.middle === true) {
    return [renderMiddleEllipsis(first, value.text, value.suffix ?? "", context.columns - quoteWidth)];
  }
  const lines = renderBoundedTextBlock(value.text, {
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
    lines.push(
      ...renderRow(
        row,
        context,
        history,
        layout.head(changed ? at : undefined, mark(row), label(row)),
        layout.continuation(),
      ),
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
  if (snapshot.kind === "idle" && snapshot.outcome !== undefined) {
    return [...snapshot.entries.filter((entry) => entry.kind === "row").map((entry) => entry.row), snapshot.outcome]
      .sort((left, right) => left.sequence - right.sequence)
      .map((row) => ({ kind: "row" as const, row }));
  }
  return snapshot.entries;
}

/**
 * Shared snapshot activity rendering. `latest` bounds selection to the newest semantic entry,
 * so a compact caller reuses this renderer instead of reinterpreting the snapshot itself.
 */
export function snapshotActivityLines(
  snapshot: RenderedSnapshot,
  context: TextRenderContext,
  selection: Readonly<{ latest?: boolean }> = {},
): readonly string[] {
  const entries = orderedSnapshotEntries(snapshot);
  if (selection.latest !== true) return groupedEntries(entries, context);
  const latest = entries.filter((entry) => entry.kind === "row").at(-1);
  return latest === undefined ? [] : groupedEntries([latest], context);
}

/**
 * One status' timeline without its conclusion: the newest open entry is still
 * moving, and an idle outcome is the command's final result rather than a
 * settled row.
 */
function settledTimeline(snapshot: RenderedSnapshot): RenderedSnapshot {
  switch (snapshot.kind) {
    case "unborn":
      return snapshot;
    case "open":
      return { ...snapshot, entries: snapshot.entries.slice(0, -1) };
    case "idle": {
      const { outcome: _outcome, ...rest } = snapshot;
      return { ...rest, entries: snapshot.entries };
    }
  }
}

/**
 * Append-only live view over successive settled snapshots of one Akuma. Each
 * call reports the rows that settled since the previous call — never
 * re-rendering an earlier row — and, inside that batch, keeps the newest tool
 * rows while folding the older ones in place as omission markers, so bounded
 * live tool evidence favors recent work and a marker never grows. The
 * observation window slides over a busy Akuma, so a retained row's own sequence
 * — not its position in the window — is what says whether it is new; a row that
 * left the window before this call has already streamed.
 */
export function activityStream(
  context: TextRenderContext,
  layout: RowLayout = plainLayout(),
): (snapshot: RenderedSnapshot) => readonly string[] {
  let newestSequence: number | undefined;
  let previousClock: string | undefined;
  return (snapshot) => {
    const rows = orderedSnapshotEntries(settledTimeline(snapshot))
      .flatMap((entry) => (entry.kind === "row" ? [entry.row] : []))
      .filter((row) => newestSequence === undefined || row.sequence > newestSequence);
    if (rows.length === 0) return [];
    newestSequence = rows.reduce((newest, row) => Math.max(newest, row.sequence), newestSequence ?? rows[0]!.sequence);
    // Recency wins within a batch: the newest tool rows stream, older ones fold at their own position.
    const tools = rows.filter((row) => row.kind === "tool");
    const retainedTools = new Set(tools.slice(Math.max(0, tools.length - STREAM_TOOL_BUDGET)));
    const lines: string[] = [];
    let omitted = 0;
    const flushOmitted = (): void => {
      if (omitted === 0) return;
      lines.push(layout.marker(omitted));
      omitted = 0;
    };
    for (const row of rows) {
      if (row.kind === "tool" && !retainedTools.has(row)) {
        omitted += 1;
        continue;
      }
      flushOmitted();
      const at = clock(row.at);
      const changed = previousClock === undefined || at !== previousClock;
      lines.push(
        ...renderRow(
          row,
          context,
          false,
          layout.head(changed ? at : undefined, mark(row), label(row)),
          layout.continuation(),
        ),
      );
      previousClock = at;
    }
    flushOmitted();
    return lines;
  };
}

/** What a wait conclusion renders over: its observed and unobserved members. */
export type WaitConclusionResult = Readonly<{
  observations: readonly AkumaObservation[];
  unobserved: readonly Readonly<{ id: string; diagnostic: string }>[];
}>;

/** One selected Akuma's frozen identity, resolved before the first observation round. */
export type WaitSelectedIdentity = Readonly<{ id: string; alias?: string }>;

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
): Readonly<{ mark: string; verb: string; waited: boolean }> {
  if (status.life === "running") return { mark: "●", verb: "still running", waited: true };
  if (answered) return { mark: "✓", verb: "answered", waited: false };
  if (status.life === "asleep") return { mark: "!", verb: "failed", waited: false };
  if (status.life === "killed") return { mark: "×", verb: "killed", waited: false };
  if (status.life === "hung") return { mark: "?", verb: "hung", waited: false };
  if (status.life === "untidy") return { mark: "!", verb: "untidy", waited: false };
  return { mark: "!", verb: "stranded", waited: false };
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

/**
 * Live view over a wait's successive observation rounds, one append-only
 * stream per selected Akuma. Each Akuma's stream opens with its identity frame
 * — the identity and Contract association the observed facts carry — before any
 * row; an already settled Akuma prints that frame and never replays backlog
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
  const streams = new Map<string, (snapshot: RenderedSnapshot) => readonly string[]>();
  const attributed = new Map<string, string | undefined>();
  const sources = new Map<string, string>();
  const settledAt = new Map<string, number>();
  let sourceWidth = 0;
  let opened = false;
  let observed = false;

  const registerSource = (id: string, alias: string | undefined): void => {
    if (sources.has(id)) return;
    const label = alias ?? id;
    sources.set(id, label);
    sourceWidth = Math.max(sourceWidth, displayColumns(label));
  };

  const select = (selected: readonly WaitSelectedIdentity[]): void => {
    for (const member of selected) {
      const label = member.alias ?? member.id;
      if (sources.has(member.id)) continue;
      sources.set(member.id, label);
      sourceWidth = Math.max(sourceWidth, displayColumns(label));
    }
  };

  const observe = (round: readonly WaitObservedAkuma[]): readonly string[] => {
    observed = true;
    // Establish the whole round's sources before any row so widths stay aligned within it.
    for (const member of round) registerSource(member.status.id, member.alias);
    const lines: string[] = [];
    for (const { status, alias, contract } of round) {
      const known = streams.get(status.id);
      if (known === undefined) {
        if (opened) lines.push("");
        lines.push(...snapshotHeading(status.id, alias, contract));
        opened = true;
        attributed.set(status.id, alias);
        // Only a plural wait attributes its rows; a single-target stream keeps the plain row grammar.
        const stream = activityStream(
          context,
          sources.size > 1 ? sourceLayout(sources.get(status.id) ?? status.id, () => sourceWidth) : plainLayout(),
        );
        streams.set(status.id, stream);
        stream(status.timeline);
      } else {
        lines.push(...known(status.timeline));
      }
      if (!settledAt.has(status.id) && waitComplete(status)) settledAt.set(status.id, settleMoment(status) ?? now());
    }
    return lines;
  };

  const conclude = (result: WaitConclusionResult): string => {
    const end = now();
    const total = result.observations.length + result.unobserved.length;
    const multi = total > 1;
    const conclusions = result.observations.map((observation) => {
      const status = observation.status;
      const answered = statusAnswer(observation) !== undefined;
      const complete = waitComplete(status);
      const at = complete ? (settledAt.get(status.id) ?? end) : end;
      const durationMs = Math.max(0, at - startedAt);
      const { mark, verb, waited } = conclusionMarkVerb(status, answered);
      const target = multi ? ` ${padToDisplay(sources.get(status.id) ?? status.id, sourceWidth)}` : "";
      return `${clockFromMs(at)}${target} ${mark} ${verb} — ${waited ? "waited " : ""}${durationText(durationMs)}`;
    });
    const unobservedLines = result.unobserved.map((member) => unobservedText(member.id, member.diagnostic));
    const answeredSingle =
      !multi && result.observations.length === 1 && statusAnswer(result.observations[0]!) !== undefined;
    const blocks = [
      ...(unobservedLines.length > 0 ? [unobservedLines.join("\n")] : []),
      ...(conclusions.length > 0 ? [(multi ? [""] : []).concat(conclusions).join("\n")] : []),
    ];
    const body = blocks.join("\n");
    // One blank line keeps the bare stdout answer visually separate from the stream.
    return answeredSingle ? `${body}\n\n` : body;
  };

  return { select, observe, conclude, streamed: () => observed };
}

/** The identity a streamed observing call's head frame renders from its resolved birth. */
export type ObservedCallHead = Readonly<{
  id: string;
  alias?: string;
  contract: DispatchAssociation;
  facts: readonly string[];
}>;

export type CallObservationStream = Readonly<{
  observe: (status: AkumaStatus) => readonly string[];
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
  const observe = (status: AkumaStatus): readonly string[] => {
    const lines: string[] = [];
    open(lines);
    lines.push(...stream(status.timeline));
    return lines;
  };
  const conclude = (observation: CallObservation): string => {
    const lines: string[] = [];
    open(lines);
    if (observation.kind === "failed") {
      lines.push(`! error ${safeText(observation.failure.diagnostic)}`);
      return lines.join("\n");
    }
    if (observation.kind !== "observed") return lines.join("\n");
    const end = now();
    const status = observation.status;
    const answered = statusAnswer({ status }) !== undefined;
    const at = waitComplete(status) ? (settleMoment(status) ?? end) : end;
    const durationMs = Math.max(0, at - startedAt);
    const { mark, verb, waited } = conclusionMarkVerb(status, answered);
    lines.push(`${clockFromMs(at)} ${mark} ${verb} — ${waited ? "waited " : ""}${durationText(durationMs)}`);
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
  if (!waitComplete(view.status)) return undefined;
  if (view.status.life !== "asleep") return undefined;
  if (view.status.readonly?.enforcement === "none") return undefined;
  const timeline = view.status.timeline;
  if (timeline.kind !== "idle" || timeline.outcome?.outcome.kind !== "answered") return undefined;
  return timeline.outcome.outcome.answer;
}

function waitComplete(status: AkumaObservation["status"]): boolean {
  return (
    status.life !== "running" &&
    !status.timeline.entries.some(
      (entry) => entry.kind === "row" && entry.row.kind === "tell" && entry.row.state === "pending",
    )
  );
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
    if (result.result.observations.length === 1) return statusAnswer(result.result.observations[0]!);
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
  const total = result.result.observations.length + result.result.unobserved.length;
  const done = result.result.observations.filter((observation) => waitComplete(observation.status)).length;
  const blocks = [
    ...result.result.observations.map((observation) => {
      const answer = statusAnswer(observation);
      if (answer !== undefined) return answeredBlock(observation, answer, alias, context.columns);
      return snapshotText(observation, context, { ...(alias === undefined ? {} : { alias }) });
    }),
    ...result.result.unobserved.map((member) => unobservedText(member.id, member.diagnostic)),
  ];
  if (total <= 1) return blocks.join("\n\n");
  return [...blocks, `${done} of ${total} done`].join("\n\n");
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
