import type { ActivityRow } from "../../akuma/index.js";
import type { SnapshotRow } from "../../akuma/index.js";
import type { AkumaStatusView, DispatchStage } from "../../index.js";
import type { AkumaInvocationResult } from "../commands/akuma-invoke.js";
import type { ParsedCommand } from "../parse.js";
import { toolRepr } from "./akuma-tool.js";
import { renderBoundedTextBlock, safeText, truncateMiddleDisplayText, type TextRenderContext } from "./terminal.js";

const DEFAULT_CONTEXT: TextRenderContext = { columns: 80, color: false };

function identity(id: string, alias?: string): string {
  return `${id}${alias === undefined ? "" : ` (${alias})`}`;
}

function lifeFooter(life: AkumaStatusView["status"]["life"]): string {
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
    return { text: row.text, lines: row.kind === "said" ? 3 : row.kind === "tell" || row.kind === "call" ? 1 : 2 };
  }
  if (row.kind === "outcome") return row.outcome.kind === "answered"
    ? { text: row.outcome.answer, lines: 3 }
    : { text: row.outcome.diagnostic, lines: 2 };
  if (row.kind === "turn") return { text: "", lines: 1 };
  const repr = toolRepr(row);
  return { text: repr.text, lines: 2, ...(repr.overflow === "middle-ellipsis" ? { middle: true as const } : {}), ...(repr.suffix === undefined ? {} : { suffix: repr.suffix }) };
}

function renderRow(row: ActivityRow | SnapshotRow, context: TextRenderContext, history: boolean): readonly string[] {
  const value = rowText(row);
  const first = `${mark(row)} ${label(row)}: `;
  if (value.middle === true) {
    const suffix = value.suffix ?? "";
    return [`${first}${truncateMiddleDisplayText(value.text, Math.max(1, context.columns - first.length - suffix.length))}${suffix}`];
  }
  return renderBoundedTextBlock(value.text, {
    first,
    continuation: " ".repeat(first.length),
    columns: context.columns,
    lines: history ? Number.MAX_SAFE_INTEGER : value.lines,
    ...("truncated" in row && row.truncated === true ? { truncated: true } : {}),
  });
}

function groupedRows(rows: readonly (ActivityRow | SnapshotRow)[], context: TextRenderContext, history = false): readonly string[] {
  const visible = rows.filter((row) => row.kind !== "turn");
  const lines: string[] = [];
  let previousClock: string | undefined;
  for (const row of visible) {
    const at = clock(row.at);
    if (previousClock !== undefined && at !== previousClock) lines.push("");
    if (at !== previousClock) lines.push(`── ${at} ──`);
    lines.push(...renderRow(row, context, history));
    previousClock = at;
  }
  return lines;
}

function snapshotText(view: AkumaStatusView, context: TextRenderContext, options: Readonly<{ alias?: string; facts?: readonly string[]; lifeFooter?: boolean }> = {}): string {
  const snapshot = view.status.timeline;
  const rows: readonly (ActivityRow | SnapshotRow)[] = snapshot.kind === "idle" && snapshot.outcome !== undefined
    ? [...snapshot.entries.map((entry) => entry.row), snapshot.outcome].sort((left, right) => left.sequence - right.sequence)
    : snapshot.entries.map((entry) => entry.row);
  const facts = [...(view.contractId === undefined ? [] : [`contract ${view.contractId}`]), ...(options.facts ?? [])];
  const activity = groupedRows(rows, context);
  const footer = options.lifeFooter === false ? [] : [...(activity.length === 0 ? [] : [""]), lifeFooter(view.status.life)];
  return [identity(view.status.id, options.alias), ...facts, ...activity, ...footer].join("\n");
}

function historyText(command: Extract<ParsedCommand, { command: "history" }>, result: Extract<AkumaInvocationResult, { action: "history" }>, context: TextRenderContext): string {
  if (command.last) return result.mode === "last" ? result.answer : "no answer retained";
  if (result.mode !== "page") throw new Error("history result lacks page");
  const contractId = result.historyResult.contractId;
  return [identity(result.akuma, result.alias), ...(contractId === undefined ? [] : [`contract ${contractId}`]), ...groupedRows(result.history.rows, context, true)].join("\n");
}

function tellText(result: Extract<AkumaInvocationResult, { action: "tell"; mode: "ordinary" }>, context: TextRenderContext): string {
  const facts = typeof result.result.tell.wake === "string" ? [] : [`! error ${safeText(result.result.tell.wake.diagnostic)}`];
  return snapshotText(result.result.observation, context, { ...(result.alias === undefined ? {} : { alias: result.alias }), facts, lifeFooter: false });
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
  const facts = [...(contractId === undefined ? [] : [`contract ${contractId}`]), ...dispatchLines(result.result.dispatch)];
  if (result.result.alias.kind === "failed") facts.push(`alias failed ${result.result.alias.failure.kind} ${safeText(result.result.alias.failure.diagnostic)}`);
  if (result.result.observation.kind === "detached") return [identity(result.result.akuma, alias), ...facts].join("\n");
  if (result.result.observation.kind === "failed") return [identity(result.result.akuma, alias), ...facts, `! error ${safeText(result.result.observation.failure.diagnostic)}`].join("\n");
  return snapshotText({ status: result.result.observation.status }, context, { ...(alias === undefined ? {} : { alias }), facts });
}

export function renderAkumaText(command: ParsedCommand, result: AkumaInvocationResult, context: TextRenderContext = DEFAULT_CONTEXT): string {
  switch (result.action) {
    case "call": return callText(result, context);
    case "status": return snapshotText(result.status, context, { ...(result.alias === undefined ? {} : { alias: result.alias }) });
    case "wait": return result.result.statuses.map((status) => snapshotText(status, context, { ...(result.alias === undefined ? {} : { alias: result.alias }) })).join("\n\n");
    case "tell": return result.mode === "ordinary" ? tellText(result, context) : snapshotText(result.result.observation, context, { ...(result.alias === undefined ? {} : { alias: result.alias }), lifeFooter: false });
    case "history": return historyText(command as Extract<ParsedCommand, { command: "history" }>, result, context);
    case "fork": {
      if (result.receipt.kind !== "forked") return result.receipt.kind === "unknown-history" ? `${result.receipt.at} has no matching retained answered turn` : result.receipt.kind === "provider-cannot-fork" ? `${result.receipt.provider} cannot fork` : result.receipt.diagnostic;
      const contractId = result.receipt.dispatch.kind === "dispatched" ? result.receipt.dispatch.dispatch.contractId : undefined;
      return [result.receipt.child, ...(contractId === undefined ? [] : [`contract ${contractId}`])].join("\n");
    }
    case "kill": return result.result.results.map((member) => snapshotText(member.observation, context, { facts: [`kill ${member.evidence}`], ...(result.alias === undefined ? {} : { alias: result.alias }) })).join("\n\n");
  }
}

export function akumaExitCode(result: AkumaInvocationResult): number {
  if (result.action === "call" && (result.result.dispatch.kind === "failed" || result.result.alias.kind === "failed" || result.result.observation.kind === "failed")) return 2;
  if (result.action === "kill" && result.result.results.some((member) => member.evidence === "unavailable" || member.evidence === "alive-after-sigkill")) return 1;
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
