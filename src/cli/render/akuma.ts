import type { ActivityRow, ActivitySnapshotEntry, SnapshotRow } from "../../akuma/index.js";
import type { AkumaStatusView, DispatchStage } from "../../index.js";
import type { AkumaInvocationResult } from "../commands/akuma-invoke.js";
import type { ParsedCommand } from "../parse.js";
import { toolRepr } from "./akuma-tool.js";
import { displayColumns, renderBoundedTextBlock, safeText, truncateMiddleDisplayText, type TextRenderContext } from "./terminal.js";

const DEFAULT_CONTEXT: TextRenderContext = { columns: 80, color: false };
const OPENING_STROKE = "─────";
const TIME_WIDTH = 5;
const VERB_WIDTH = 6;

function identity(id: string, alias?: string): string {
  return `${id}${alias === undefined ? "" : ` (${alias})`}`;
}

function associatedIdentity(id: string, alias?: string, contractId?: string): string {
  return `${identity(id, alias)}${contractId === undefined ? "" : ` [${contractId}]`}`;
}

function snapshotHeading(id: string, alias?: string, contractId?: string): readonly string[] {
  return [
    OPENING_STROKE,
    identity(id, alias),
    ...(contractId === undefined ? [] : [`└─ ${contractId}`]),
  ];
}

function lifeLabel(life: AkumaStatusView["status"]["life"]): string {
  if (life === "running") return "● running";
  if (life === "asleep") return "○ asleep";
  if (life === "killed") return "× killed";
  return `? ${life}`;
}

function clock(at: string): string {
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}` : "unknown";
}

function label(row: ActivityRow | SnapshotRow): string {
  if (row.kind === "said") return "say";
  if (row.kind === "thought") return "think";
  if (row.kind === "note") return "note";
  if (row.kind === "call") return "call";
  if (row.kind === "tell") return "tell";
  if (row.kind === "outcome") return row.outcome.kind === "answered" ? "say" : "error";
  if (row.kind === "turn") return "call";
  return toolRepr(row).label;
}

function mark(row: ActivityRow | SnapshotRow): "·" | "✓" | "!" | "⧖" | "⧗" | "?" {
  if (row.kind === "outcome") return row.outcome.kind === "answered" ? "✓" : "!";
  if (row.kind === "tell" && row.state === "pending") return "⧗";
  if (row.kind === "tool") {
    if (row.state === "active") return "⧖";
    if (row.state === "unsettled") return "?";
    return row.state.status === "ok" ? "✓" : "!";
  }
  return "·";
}

function rowText(row: ActivityRow | SnapshotRow): Readonly<{ text: string; lines: number; middle?: true; suffix?: string }> {
  if (row.kind === "said" || row.kind === "thought" || row.kind === "note" || row.kind === "call" || row.kind === "tell") {
    return { text: row.text, lines: row.kind === "said" || row.kind === "thought" ? 2 : row.kind === "tell" || row.kind === "call" ? 1 : 2 };
  }
  if (row.kind === "outcome") return row.outcome.kind === "answered"
    ? { text: row.outcome.answer, lines: 3 }
    : { text: row.outcome.diagnostic, lines: 2 };
  if (row.kind === "turn") return { text: "", lines: 1 };
  const repr = toolRepr(row);
  return { text: repr.text, lines: 2, ...(repr.overflow === "middle-ellipsis" ? { middle: true as const } : {}), ...(repr.suffix === undefined ? {} : { suffix: repr.suffix }) };
}

function eventPrefix(glyph: string, verb: string, time?: string): string {
  const gutter = time === undefined ? " ".repeat(TIME_WIDTH) : time.padEnd(TIME_WIDTH);
  return `${gutter} ${glyph} ${verb.padEnd(VERB_WIDTH)} `;
}

function continuationPrefix(): string {
  return eventPrefix("│", "");
}

function quotedBody(row: ActivityRow | SnapshotRow): boolean {
  return row.kind === "said" || row.kind === "thought" || row.kind === "tell"
    || (row.kind === "outcome" && row.outcome.kind === "answered");
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

function renderRow(row: ActivityRow | SnapshotRow, context: TextRenderContext, history: boolean, first: string): readonly string[] {
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

type RenderEntry = ActivitySnapshotEntry | Readonly<{ kind: "row"; row: ActivityRow }>;

function groupedEntries(entries: readonly RenderEntry[], context: TextRenderContext, history = false): readonly string[] {
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

function groupedRows(rows: readonly ActivityRow[], context: TextRenderContext, history = false): readonly string[] {
  return groupedEntries(rows.filter((row) => row.kind !== "turn").map((row) => ({ kind: "row", row })), context, history);
}

function snapshotText(view: AkumaStatusView, context: TextRenderContext, options: Readonly<{ alias?: string; facts?: readonly string[]; showLife?: boolean }> = {}): string {
  const snapshot = view.status.timeline;
  const activity = snapshot.kind === "idle" && snapshot.outcome !== undefined
    ? groupedRows([
      ...snapshot.entries.filter((entry) => entry.kind === "row").map((entry) => entry.row),
      snapshot.outcome,
    ].sort((left, right) => left.sequence - right.sequence), context)
    : groupedEntries(snapshot.entries, context);
  const facts = [
    ...(view.status.readonly?.enforcement === "none" ? [`! ${safeText(view.status.readonly.diagnostic)}`] : []),
    ...(options.facts ?? []),
  ];
  const footer = options.showLife === false ? [] : [`  ${lifeLabel(view.status.life)}`];
  return [...snapshotHeading(view.status.id, options.alias, view.contractId), ...facts, ...activity, ...footer].join("\n");
}

function historyText(command: Extract<ParsedCommand, { command: "history" }>, result: Extract<AkumaInvocationResult, { action: "history" }>, context: TextRenderContext): string {
  if (command.last) return result.mode === "last" ? result.answer : "no answer retained";
  if (result.mode !== "page") throw new Error("history result lacks page");
  const contractId = result.historyResult.contractId;
  return [...snapshotHeading(result.akuma, result.alias, contractId), ...groupedRows(result.history.rows, context, true)].join("\n");
}

function tellText(result: Extract<AkumaInvocationResult, { action: "tell"; mode: "ordinary" }>, context: TextRenderContext): string {
  const facts = typeof result.result.tell.wake === "string" ? [] : [`! error ${safeText(result.result.tell.wake.diagnostic)}`];
  return snapshotText(result.result.observation, context, { ...(result.alias === undefined ? {} : { alias: result.alias }), facts, showLife: false });
}

function dispatchLines(stage: DispatchStage): readonly string[] {
  if (stage.kind === "none" || stage.kind === "dispatched") return [];
  if (stage.failure.kind === "conflict") return [`dispatch failed conflict ${stage.failure.current.contractId}`];
  if (stage.failure.kind === "contention") return ["dispatch failed contention"];
  return [`dispatch failed ${stage.failure.kind} ${safeText(stage.failure.diagnostic)}`];
}

function callText(result: Extract<AkumaInvocationResult, { action: "call" }>, context: TextRenderContext): string {
  const alias = result.result.alias.kind === "aliased" ? result.result.alias.alias.alias : undefined;
  const contractId = result.result.dispatch.kind === "dispatched" ? result.result.dispatch.dispatch.contractId : undefined;
  const facts = [...dispatchLines(result.result.dispatch)];
  const restraint = result.result.readonly?.enforcement === "none" ? [`! ${safeText(result.result.readonly.diagnostic)}`] : [];
  if (result.result.alias.kind === "failed") facts.push(`alias failed ${result.result.alias.failure.kind} ${safeText(result.result.alias.failure.diagnostic)}`);
  if (result.result.observation.kind === "detached") return [...snapshotHeading(result.result.akuma, alias, contractId), ...restraint, ...facts].join("\n");
  if (result.result.observation.kind === "failed") return [...snapshotHeading(result.result.akuma, alias, contractId), ...restraint, ...facts, `! error ${safeText(result.result.observation.failure.diagnostic)}`].join("\n");
  return snapshotText({ status: result.result.observation.status, ...(contractId === undefined ? {} : { contractId }) }, context, { ...(alias === undefined ? {} : { alias }), facts });
}

export function renderAkumaText(command: ParsedCommand, result: AkumaInvocationResult, context: TextRenderContext = DEFAULT_CONTEXT): string {
  switch (result.action) {
    case "call": return callText(result, context);
    case "status": return snapshotText(result.status, context, { ...(result.alias === undefined ? {} : { alias: result.alias }) });
    case "wait": return result.result.statuses.map((status) => snapshotText(status, context, { ...(result.alias === undefined ? {} : { alias: result.alias }) })).join("\n\n");
    case "tell": return result.mode === "ordinary" ? tellText(result, context) : snapshotText(result.result.observation, context, { ...(result.alias === undefined ? {} : { alias: result.alias }), showLife: false });
    case "history": return historyText(command as Extract<ParsedCommand, { command: "history" }>, result, context);
    case "fork": {
      if (result.receipt.kind !== "forked") return result.receipt.kind === "unknown-history" ? `${result.receipt.at} has no matching retained answered turn` : result.receipt.kind === "provider-cannot-fork" ? `${result.receipt.provider} cannot fork` : result.receipt.diagnostic;
      const contractId = result.receipt.dispatch.kind === "dispatched" ? result.receipt.dispatch.dispatch.contractId : undefined;
      return associatedIdentity(result.receipt.child, undefined, contractId);
    }
    case "kill": return result.result.results.map((member) => snapshotText(member.observation, context, { facts: [`kill ${member.evidence}`], ...(result.alias === undefined ? {} : { alias: result.alias }) })).join("\n\n");
  }
}

export function akumaExitCode(result: AkumaInvocationResult): number {
  if (result.action === "call" && (result.result.dispatch.kind === "failed" || result.result.alias.kind === "failed" || result.result.observation.kind === "failed")) return 2;
  if (result.action === "kill" && result.result.results.some((member) =>
    member.evidence === "unavailable" || member.evidence === "hung" || member.evidence === "untidy")) return 1;
  if (result.action === "tell" && result.mode === "ordinary" && typeof result.result.tell.wake !== "string") return 2;
  if (result.action === "tell" && result.mode === "interrupt" && result.result.receipt.kind !== "interrupted") return 1;
  if (result.action === "fork" && result.receipt.kind !== "forked") return result.receipt.kind === "upstream-forked" ? 2 : 1;
  return 0;
}

export function akumaJsonValue(command: ParsedCommand, result: AkumaInvocationResult): unknown {
  if (result.action === "call" || result.action === "fork" || result.action === "status" || result.action === "wait" || result.action === "tell" || result.action === "kill") return result.action === "status" ? result.status : result.action === "wait" ? result.result : result.action === "tell" ? result.result : result.action === "kill" ? result.result : result.action === "call" ? result.result : result.receipt;
  if (command.command !== "history") throw new Error("history result requires the history command");
  return result.historyResult;
}

export function renderAkumaJson(command: ParsedCommand, result: AkumaInvocationResult): string {
  return JSON.stringify(akumaJsonValue(command, result));
}
