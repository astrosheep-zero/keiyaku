import type { ActivityRow, ActivitySnapshotEntry } from "../../akuma/index.js";
import type { AkumaStatusView, ContractId, DispatchStage } from "../../index.js";
import type { AkumaInvocationResult } from "../commands/akuma-invoke.js";
import type { ParsedCommand } from "../parse.js";
import { toolRepr } from "./akuma-tool.js";
import { displayColumns, renderBoundedTextBlock, renderVoiceRuler, safeText, truncateMiddleDisplayText, type TextRenderContext } from "./terminal.js";

type SpineRow = Readonly<{ kind: "row"; at?: string; label: string; text: string; spine?: "normal" | "turn" | "frontier" | "pending" | "ok" | "error"; quoted?: true; truncated?: true; indivisible?: true; overflow?: "middle-ellipsis"; suffix?: string; snapshotLines?: number }>;
type SpineItem = SpineRow | Readonly<{ kind: "gap"; count: number }>;
const GUTTER_MS = 60_000;
const LABEL_WIDTH = 6;
const DEFAULT_CONTEXT: TextRenderContext = { columns: 80, color: false };

function identity(id: string, alias?: string): string { return `${id}${alias === undefined ? "" : ` (${alias})`}`; }
function ruler(left: string, columns: number, scope = ""): string {
  if (scope !== "") return renderVoiceRuler(left, scope, columns).trimEnd();
  const width = Math.max(20, Math.min(80, columns));
  return `${left} ${"─".repeat(Math.max(1, width - displayColumns(left) - 1))}`;
}
function clock(at: string | undefined): string {
  if (at === undefined) return "";
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}` : "";
}
function label(value: string): string { return `${value}${" ".repeat(Math.max(0, LABEL_WIDTH - displayColumns(value)))}`; }

function renderSpineRow(item: SpineRow, context: TextRenderContext, profile: "snapshot" | "history", lastAt: number | undefined): { lines: readonly string[]; lastAt: number | undefined } {
  const stamp = item.at === undefined ? undefined : Date.parse(item.at);
  const printTime = stamp !== undefined && Number.isFinite(stamp) && (lastAt === undefined || stamp - lastAt >= GUTTER_MS);
  const nextLastAt = printTime ? stamp : lastAt;
  const gutter = `${printTime ? clock(item.at) : ""}`.padStart(5, " ");
  const spine = item.spine === "turn" ? "┌│" : item.spine === "frontier" ? "┌⧖" : item.spine === "pending" ? " ⧗" : item.spine === "ok" ? " ✓" : item.spine === "error" ? " !" : " │";
  const quote = item.quoted === true ? "“" : "";
  const first = `${gutter}${spine} ${label(item.label)} ${quote}`;
  if (item.indivisible === true) return { lines: [`${first}${safeText(item.text)}`.trimEnd()], lastAt: nextLastAt };
  if (item.overflow === "middle-ellipsis") {
    const suffix = item.suffix ?? "";
    const budget = Math.max(1, context.columns - displayColumns(first) - displayColumns(suffix));
    return { lines: [`${first}${truncateMiddleDisplayText(item.text, budget)}${suffix}`.trimEnd()], lastAt: nextLastAt };
  }
  const continuation = `${"".padStart(gutter.length)}  │ ${"".padEnd(LABEL_WIDTH + 1, " ")}`;
  const lines = renderBoundedTextBlock(item.text, { first, continuation, columns: context.columns, lines: profile === "history" ? Number.MAX_SAFE_INTEGER : (item.snapshotLines ?? 2), ...(item.truncated === true ? { truncated: true } : {}) });
  return { lines: item.quoted === true ? lines.map((line, index) => index === lines.length - 1 ? `${line}”` : line) : lines, lastAt: nextLastAt };
}

function renderSpine(items: readonly SpineItem[], context: TextRenderContext, profile: "snapshot" | "history" = "snapshot"): string[] {
  let lastAt: number | undefined;
  const lines: string[] = [];
  for (const item of items) {
    if (item.kind === "gap") {
      if (item.count > 1) lines.push(`     ⋮ +${item.count}`);
      continue;
    }
    const rendered = renderSpineRow(item, context, profile, lastAt);
    lastAt = rendered.lastAt;
    lines.push(...rendered.lines);
  }
  return lines;
}

function activityLabel(row: ActivityRow): string {
  if (row.kind === "said") return "say";
  if (row.kind === "thought") return "think";
  if (row.kind === "note") return "note";
  if (row.kind === "call" || row.kind === "turn") return "call";
  if (row.kind === "tell") return "tell";
  if (row.kind === "outcome") return row.outcome.kind === "answered" ? "say" : "error";
  return toolRepr(row).label;
}

type SpineMark = NonNullable<SpineRow["spine"]>;
function rowSpine(row: ActivityRow, firstTurn: boolean, frontier: boolean): SpineMark {
  if (row.kind === "outcome") return row.outcome.kind === "answered" ? "ok" : "error";
  if (row.kind === "tell" && row.state === "pending") return "pending";
  if (frontier || (row.kind === "tool" && row.state === "running")) return "frontier";
  return firstTurn ? "turn" : "normal";
}

function rowText(row: ActivityRow): Pick<SpineRow, "text" | "quoted" | "snapshotLines" | "overflow" | "suffix"> {
  if (row.kind === "said" || row.kind === "thought") return { text: row.text, quoted: true, snapshotLines: row.kind === "said" ? 3 : 2 };
  if (row.kind === "note") return { text: row.text, snapshotLines: 2 };
  if (row.kind === "call") return { text: row.text, quoted: true, snapshotLines: 1 };
  if (row.kind === "turn") return { text: "", snapshotLines: 1 };
  if (row.kind === "tell") return { text: row.text, quoted: true, snapshotLines: 1 };
  if (row.kind === "outcome") return row.outcome.kind === "answered"
    ? { text: row.outcome.answer, quoted: true, snapshotLines: 3 }
    : { text: row.outcome.diagnostic, snapshotLines: 2 };
  const repr = toolRepr(row);
  return { text: repr.text, ...(repr.overflow === undefined ? {} : { overflow: repr.overflow }), ...(repr.suffix === undefined ? {} : { suffix: repr.suffix }), snapshotLines: 2 };
}

function rowItem(row: ActivityRow, firstTurn: boolean, frontier: boolean): SpineRow {
  const truncated = "truncated" in row && row.truncated === true ? { truncated: true as const } : {};
  return { kind: "row", at: row.at, label: activityLabel(row), spine: rowSpine(row, firstTurn, frontier), ...rowText(row), ...truncated };
}

function snapshotItems(entries: readonly ActivitySnapshotEntry[]): readonly SpineItem[] {
  const seen = new Set<number>();
  return entries.flatMap((entry): readonly SpineItem[] => {
    if (entry.kind === "gap") return [entry];
    const row = entry.row;
    if (row.kind === "turn") return [];
    const first = "turnSequence" in row && !seen.has(row.turnSequence);
    if ("turnSequence" in row) seen.add(row.turnSequence);
    return [rowItem(row, first, false)];
  });
}

function snapshotText(status: AkumaStatusView, context: TextRenderContext, options: Readonly<{ alias?: string; contractId?: ContractId; facts?: readonly string[]; tail?: readonly SpineItem[] }> = {}): string {
  const items = [...snapshotItems(status.timeline.entries), ...(options.tail ?? [])];
  if (items.length === 0) items.push({ kind: "row", label: "", text: "no activity", spine: status.life === "running" ? "frontier" : "normal", snapshotLines: 1 });
  return [ruler(identity(status.id, options.alias), context.columns, options.contractId ?? status.contractId), ...(options.facts ?? []), ...renderSpine(items, context), status.life === "running" ? "" : ""].filter(Boolean).join("\n");
}

function historyText(command: Extract<ParsedCommand, { command: "history" }>, result: Extract<AkumaInvocationResult, { action: "history" }>, context: TextRenderContext): string {
  if (command.last) return result.mode === "last" ? result.answer : "no answer retained";
  if (result.mode !== "page") throw new Error("history result lacks page");
  const history = result.history;
  const rows = history.rows.map((row) => rowItem(row, false, false));
  const scope = result.contractId === undefined ? "history" : `history · ${result.contractId}`;
  return [ruler(identity(result.akuma, result.alias), context.columns, scope), ...renderSpine(rows, context, "history")].join("\n");
}

function tellText(result: Extract<AkumaInvocationResult, { action: "tell"; mode: "ordinary" }>, context: TextRenderContext): string {
  const facts: string[] = typeof result.result.tell.wake === "string" ? [] : [`! error ${safeText(result.result.tell.wake.diagnostic)}`];
  return snapshotText(result.result.observation, context, { ...(result.alias === undefined ? {} : { alias: result.alias }), facts });
}
function dispatchLines(stage: DispatchStage): readonly string[] {
  if (stage.kind === "none") return [];
  if (stage.kind === "dispatched") return [];
  if (stage.failure.kind === "conflict") return [`dispatch failed conflict ${stage.failure.current.contractId}`];
  if (stage.failure.kind === "contention") return ["dispatch failed contention"];
  return [`dispatch failed ${stage.failure.kind} ${safeText(stage.failure.diagnostic)}`];
}
function callText(result: Extract<AkumaInvocationResult, { action: "call" }>, context: TextRenderContext): string {
  const alias = result.result.alias.kind === "aliased" ? result.result.alias.alias.alias : undefined;
  const facts = [...dispatchLines(result.result.dispatch)];
  const contractId = result.result.dispatch.kind === "dispatched" ? result.result.dispatch.dispatch.contractId : undefined;
  const head = contractId === undefined ? identity(result.result.akuma, alias) : ruler(identity(result.result.akuma, alias), context.columns, contractId);
  if (result.result.alias.kind === "failed") facts.push(`alias failed ${result.result.alias.failure.kind} ${safeText(result.result.alias.failure.diagnostic)}`);
  if (result.result.observation.kind === "detached") return [head, ...facts].join("\n");
  if (result.result.observation.kind === "failed") return [head, ...facts, `! error ${safeText(result.result.observation.failure.diagnostic)}`].join("\n");
  return snapshotText(result.result.observation.status, context, { ...(alias === undefined ? {} : { alias }), ...(contractId === undefined ? {} : { contractId }), facts });
}

export function renderAkumaText(command: ParsedCommand, result: AkumaInvocationResult, context: TextRenderContext = DEFAULT_CONTEXT): string {
  switch (result.action) {
    case "call": return callText(result, context);
    case "status": return snapshotText(result.status, context, { ...(result.alias === undefined ? {} : { alias: result.alias }) });
    case "wait": return result.result.statuses.map((status) => snapshotText(status, context, { ...(result.alias === undefined ? {} : { alias: result.alias }) })).join("\n\n");
    case "tell": return result.mode === "ordinary" ? tellText(result, context) : snapshotText(result.result.observation, context, { ...(result.alias === undefined ? {} : { alias: result.alias }), ...(result.result.contractId === undefined ? {} : { contractId: result.result.contractId }) });
    case "history": return historyText(command as Extract<ParsedCommand, { command: "history" }>, result, context);
    case "fork": {
      if (result.receipt.kind !== "forked") return result.receipt.kind === "unknown-history" ? `${result.receipt.at} has no matching retained answered turn` : result.receipt.kind === "provider-cannot-fork" ? `${result.receipt.provider} cannot fork` : result.receipt.kind === "fork-failed" ? result.receipt.diagnostic : result.receipt.diagnostic;
      const contractId = result.receipt.dispatch.kind === "dispatched" ? result.receipt.dispatch.dispatch.contractId : undefined;
      return contractId === undefined ? result.receipt.child : ruler(result.receipt.child, context.columns, contractId);
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
export function renderAkumaJson(command: ParsedCommand, result: AkumaInvocationResult): string { return JSON.stringify(akumaJsonValue(command, result)); }
