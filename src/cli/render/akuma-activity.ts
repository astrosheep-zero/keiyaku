import type { ActivityRow, KillEvidence, ReportedFileChange } from "../../akuma/akuma.js";
import type {
  AkumaObservation,
  AkumaObservationStage,
  CreatedTaskObservation,
  DispatchAssociation,
} from "../../index.js";
import { parseAkumaStatus } from "../../akuma/akuma.js";
import type { AkumaInvocationResult } from "../commands/akuma-invoke.js";
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
const SNAPSHOT_RULER = "────────────";
const TIME_WIDTH = 5;
const VERB_WIDTH = 6;

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

export function associatedIdentity(id: string, alias?: string, contract?: DispatchAssociation): string {
  const contractId = contract === undefined ? undefined : associatedContractId(contract);
  return `${identity(id, alias)}${contractId === undefined ? "" : ` [${contractId}]`}`;
}

export function snapshotHeading(
  id: string,
  alias: string | undefined,
  contract: DispatchAssociation | undefined,
): readonly string[] {
  const contractId = contract === undefined ? undefined : associatedContractId(contract);
  return [identity(id, alias), SNAPSHOT_RULER, ...(contractId === undefined ? [] : [`└─ ${contractId}`])];
}

function answeredHeading(id: string, alias: string | undefined): string {
  return [`✓ came back ${identity(id, alias)}`, SNAPSHOT_RULER].join("\n");
}

function contractFacts(contract: DispatchAssociation): readonly string[] {
  return contract.kind === "failed" ? [`! contract failed ${safeText(contract.diagnostic)}`] : [];
}

function unobservedText(id: string, diagnostic: string): string {
  return `! ${id} unobserved: ${safeText(diagnostic)}`;
}

function lifeLabel(life: AkumaObservation["status"]["life"]): string {
  if (life === "running") return "● STILL RUNNING";
  if (life === "asleep") return "✓ came back";
  if (life === "killed") return "× killed";
  return `? ${life}`;
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

function mark(row: RenderRow): "│" | "✓" | "!" | "⧖" | "⧗" | "?" {
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

function rowText(row: RenderRow): Readonly<{ text: string; lines: number; middle?: true; suffix?: string }> {
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
  const context = answerContextLines(observation, columns).join("\n");
  if (context.length === 0) return `${answeredHeading(observation.status.id, alias)}\n${answer}`;
  const separator = answer.endsWith("\n") ? "\n" : "\n\n";
  return `${answeredHeading(observation.status.id, alias)}\n${answer}${separator}${context}`;
}

type SnapshotView = Readonly<{
  status: AkumaObservation["status"];
  contract: DispatchAssociation;
  createdTasks?: CreatedTaskObservation;
}>;

type SnapshotCoreOptions = Readonly<{
  alias?: string;
  facts?: readonly string[];
}>;

function snapshotCore(
  view: SnapshotView,
  context: TextRenderContext,
  options: SnapshotCoreOptions,
): Readonly<{ activity: readonly string[]; lines: readonly string[] }> {
  const snapshot = view.status.timeline;
  const activity =
    snapshot.kind === "idle" && snapshot.outcome !== undefined
      ? groupedRows(
          [
            ...snapshot.entries.filter((entry) => entry.kind === "row").map((entry) => entry.row),
            snapshot.outcome,
          ].sort((left, right) => left.sequence - right.sequence),
          context,
        )
      : groupedEntries(snapshot.entries, context);
  const facts = [
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
  if (result.action === "wait" && result.result.observations.length === 1)
    return statusAnswer(result.result.observations[0]!);
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
  return [
    ...snapshotHeading(result.akuma, result.alias, result.historyResult.contract),
    ...groupedRows(result.history.rows, context, true),
  ].join("\n");
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
    return `${target}\n${SNAPSHOT_RULER}\n${row}\n! tell delivery failed · ${safeText(wake.diagnostic)}${child === undefined ? "" : ` · log ${child.log.path} ${child.log.from}..${child.log.to}`}`;
  }
  return `${target}\n${SNAPSHOT_RULER}\n${row}`;
}
