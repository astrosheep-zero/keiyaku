import type { ActivityRow, KillEvidence, ReportedFileChange } from "../../akuma/akuma.js";
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

/** Tool rows one observation cycle may print before the rest fold in place. */
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

function quotedBody(row: RenderRow): boolean {
  return (
    row.kind === "said" ||
    row.kind === "thought" ||
    row.kind === "tell" ||
    (row.kind === "outcome" && row.outcome.kind === "answered")
  );
}

function quoteLines(lines: readonly string[], prefix: string): readonly string[] {
  const prefixWidth = prefix.length;
  return lines.map((line) => {
    const body = line.slice(prefixWidth);
    if (body.length === 0) return line;
    return `${line.slice(0, prefixWidth)}“${body}”`;
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

function renderRow(row: RenderRow, context: TextRenderContext, history: boolean, first: string): readonly string[] {
  const value = rowText(row);
  const quoted = quotedBody(row);
  const quoteWidth = quoted ? 2 : 0;
  if (value.middle === true) {
    return [renderMiddleEllipsis(first, value.text, value.suffix ?? "", context.columns - quoteWidth)];
  }
  const lines = renderBoundedTextBlock(value.text, {
    first,
    continuation: continuationPrefix(),
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
): readonly string[] {
  const lines: string[] = [];
  let previousClock: string | undefined;
  for (const entry of entries) {
    if (entry.kind === "gap") {
      lines.push(`${" ".repeat(TIME_WIDTH)} ⋮ ${entry.count} omitted`);
      continue;
    }
    const row = entry.row;
    const at = clock(row.at);
    const changed = previousClock === undefined || at !== previousClock;
    lines.push(...renderRow(row, context, history, eventPrefix(mark(row), label(row), changed ? at : undefined)));
    previousClock = at;
  }
  return lines;
}

function groupedRows(rows: readonly RenderRow[], context: TextRenderContext, history = false): readonly string[] {
  return groupedEntries(
    rows.filter((row) => row.kind !== "turn").map((row) => ({ kind: "row", row })),
    context,
    history,
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
 * call reports the entries that settled since the previous call — never
 * re-rendering an earlier row — and folds each tool burst beyond the streaming
 * budget into one in-place omission marker, so a marker never grows.
 */
export function activityStream(context: TextRenderContext): (snapshot: RenderedSnapshot) => readonly string[] {
  let emitted = 0;
  let previousClock: string | undefined;
  return (snapshot) => {
    const entries = orderedSnapshotEntries(settledTimeline(snapshot));
    const delta = entries.slice(emitted);
    emitted = entries.length;
    if (delta.length === 0) return [];
    const lines: string[] = [];
    let budget = STREAM_TOOL_BUDGET;
    let omitted = 0;
    const flushOmitted = (): void => {
      if (omitted === 0) return;
      lines.push(`${" ".repeat(TIME_WIDTH)} ⋮ ${omitted} omitted`);
      omitted = 0;
    };
    for (const entry of delta) {
      if (entry.kind === "gap") {
        flushOmitted();
        lines.push(`${" ".repeat(TIME_WIDTH)} ⋮ ${entry.count} omitted`);
        continue;
      }
      const row = entry.row;
      if (row.kind === "tool" && budget === 0) {
        omitted += 1;
        continue;
      }
      flushOmitted();
      if (row.kind === "tool") budget -= 1;
      const at = clock(row.at);
      const changed = previousClock === undefined || at !== previousClock;
      lines.push(...renderRow(row, context, false, eventPrefix(mark(row), label(row), changed ? at : undefined)));
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

export type WaitObservationStream = Readonly<{
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
  const settledAt = new Map<string, number>();
  let opened = false;
  let observed = false;

  const observe = (round: readonly WaitObservedAkuma[]): readonly string[] => {
    observed = true;
    const lines: string[] = [];
    for (const { status, alias, contract } of round) {
      const known = streams.get(status.id);
      if (known === undefined) {
        if (opened) lines.push("");
        lines.push(...snapshotHeading(status.id, alias, contract));
        opened = true;
        attributed.set(status.id, alias);
        const stream = activityStream(context);
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
      const target = multi ? ` ${attributed.get(status.id) ?? status.id}` : "";
      return `${clockFromMs(at)} ${mark}${target} ${verb} — ${waited ? "waited " : ""}${durationText(durationMs)}`;
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

  return { observe, conclude, streamed: () => observed };
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
    if (answerCallFailed(result.result) || result.result.observation.kind !== "observed") return undefined;
    return statusAnswer({ status: parseAkumaStatus(result.result.observation.status) });
  }
  if (result.action === "wait") {
    if (result.streamed === true) {
      const single = result.result.observations.length === 1 ? result.result.observations[0] : undefined;
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
