import type { ActivityHistory, ActivityRow, AkumaStatus } from "../../akuma/index.js";
import { toolRepr } from "./akuma-tool.js";
import type { AkumaInvocationResult } from "../commands/akuma-invoke.js";
import type { ParsedCommand } from "../parse.js";

type SpineItem = Readonly<{ at?: string; index?: number; label: string; text: string }>;

const GUTTER_MS = 60_000;
const LABEL_WIDTH = 8;

function mark(life: AkumaStatus["life"]): string {
  switch (life) {
    case "running": return "●";
    case "dead": return "×";
    case "asleep": return "○";
    case "stranded":
    case "headless": return "!";
  }
}

function ruler(parts: readonly string[]): string {
  const prefix = `── ${parts.join(" ── ")} `;
  return `${prefix}${"─".repeat(Math.max(1, 64 - prefix.length))}`;
}

function clock(at: string | undefined): string {
  if (at === undefined) return "";
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function renderSpine(items: readonly SpineItem[]): string[] {
  let lastPrintedAt: number | undefined;
  return items.map((item) => {
    const timestamp = item.at === undefined ? undefined : Date.parse(item.at);
    const printable = timestamp !== undefined && Number.isFinite(timestamp)
      && (lastPrintedAt === undefined || timestamp - lastPrintedAt >= GUTTER_MS);
    if (printable) lastPrintedAt = timestamp;
    const time = printable ? clock(item.at) : "";
    const index = item.index === undefined ? "" : String(item.index).padStart(4, " ");
    const gutter = `${index}${index.length === 0 ? "" : " "}${time.padStart(5, " ")}`;
    return `${gutter} │ ${item.label.padEnd(LABEL_WIDTH, " ")} ${item.text}`.trimEnd();
  });
}

function activityItem(row: ActivityRow): SpineItem {
  if (row.kind === "said") return { at: row.at, label: "say", text: row.text };
  if (row.kind === "thought") return { at: row.at, label: "thought", text: row.text };
  if (row.kind === "note") return { at: row.at, label: "note", text: row.text };
  const repr = toolRepr(row);
  return {
    at: row.at,
    label: repr.label,
    text: repr.text,
  };
}

function pendingItems(status: AkumaStatus): readonly SpineItem[] {
  return status.activity.pendingTells.map((tell) => ({ label: "⧗ tell", text: JSON.stringify(tell.body) }));
}

function outcomeItems(status: AkumaStatus): readonly SpineItem[] {
  if (status.answer !== undefined) {
    return [{
      ...(status.outcomeAt === undefined ? {} : { at: status.outcomeAt }),
      label: "✓",
      text: `answered · keiyaku history ${status.answerHistoryId ?? ""} --last`.trim(),
    }];
  }
  if (status.failure !== undefined) {
    return [{
      ...(status.outcomeAt === undefined ? {} : { at: status.outcomeAt }),
      label: "!",
      text: `failed · ${status.failure}`,
    }];
  }
  return [];
}

function statusItems(status: AkumaStatus): readonly SpineItem[] {
  return [
    ...status.activity.rows.map(activityItem),
    ...pendingItems(status),
    ...outcomeItems(status),
  ];
}

function omission(id: string, status: AkumaStatus): string[] {
  return status.activity.omitted === 0
    ? []
    : [`   ⋮ earlier · keiyaku history ${id}`];
}

function statusText(status: AkumaStatus): string {
  return [
    ruler([`${mark(status.life)} ${status.id}`, ...(status.contract === undefined ? [] : [status.contract])]),
    ...omission(status.id, status),
    ...renderSpine(statusItems(status)),
  ].join("\n");
}

function historyItems(history: ActivityHistory): readonly SpineItem[] {
  const activity = history.rows.map((row) => ({ ...activityItem(row), index: row.sequence }));
  const boundaries = history.turns.map((turn) => turn.outcome.kind === "answered"
    ? { at: turn.completedAt, label: "✓", text: `answered · keiyaku history ${turn.outcome.historyId} --last` }
    : { at: turn.completedAt, label: "!", text: `failed · ${turn.outcome.diagnostic}` });
  return [...activity, ...boundaries].sort((left, right) => {
    const leftAt = left.at === undefined ? Number.POSITIVE_INFINITY : Date.parse(left.at);
    const rightAt = right.at === undefined ? Number.POSITIVE_INFINITY : Date.parse(right.at);
    return (Number.isFinite(leftAt) ? leftAt : Number.POSITIVE_INFINITY)
      - (Number.isFinite(rightAt) ? rightAt : Number.POSITIVE_INFINITY);
  });
}

function historyText(command: Extract<ParsedCommand, { command: "history" }>, result: Extract<AkumaInvocationResult, { action: "history" }>): string {
  if (command.last) return result.answer ?? "";
  const history = result.history;
  const scope = command.before === undefined && command.since === undefined
    ? "history"
    : `history ── ${command.before === undefined ? `since ${command.since}` : `before ${command.before}`}`;
  const lines = [ruler([result.akuma, scope])];
  const first = history.rows[0]?.sequence;
  const last = history.rows.at(-1)?.sequence;
  if (history.hasEarlier && first !== undefined) {
    lines.push(`   ⋮ ${history.omitted} earlier · keiyaku history ${result.akuma} --before ${first}`);
  } else if (history.historyLost) {
    lines.push("   ⋮ earlier history no longer kept");
  }
  if (history.hasLater && last !== undefined) {
    lines.push(`   ⋮ more · keiyaku history ${result.akuma} --since ${last}`);
  }
  if (command.since !== undefined && history.rows.length === 0) {
    lines.push(`   ⋮ no activity since ${command.since}`);
  }
  lines.push(...renderSpine(historyItems(history)));
  return lines.join("\n");
}

function waitText(status: AkumaStatus): string {
  if (status.life === "running") return statusText(status);
  if (status.answer !== undefined) return status.answer;
  if (status.failure !== undefined) return `failure ${status.failure}`;
  return statusText(status);
}

export function renderAkumaText(command: ParsedCommand, result: AkumaInvocationResult): string {
  switch (result.action) {
    case "call": return result.id;
    case "status": return statusText(result.status);
    case "wait": return waitText(result.status);
    case "tell": return statusText(result.status);
    case "interrupt": {
      const receipt = result.receipt;
      if (receipt.kind === "dead") return `${result.akuma} interrupt dead`;
      if (receipt.kind === "unstoppable") return `${result.akuma} interrupt unstoppable ${receipt.evidence}`;
      if ("kind" in receipt.tell) return `${result.akuma} interrupted ${receipt.putDown}`;
      const wake = typeof receipt.tell.wake === "string" ? "recorded" : `failed ${receipt.tell.wake.diagnostic}`;
      return `${result.akuma} interrupted ${receipt.putDown}\ntell ${receipt.tell.id} ${wake}`;
    }
    case "history": return historyText(command as Extract<ParsedCommand, { command: "history" }>, result);
    case "fork": {
      const receipt = result.receipt;
      if (receipt.kind === "forked") return receipt.child;
      if (receipt.kind === "provider-cannot-fork") return `${receipt.provider} cannot fork`;
      if (receipt.kind === "unknown-history") return `${receipt.at} has no matching retained answered turn`;
      if (receipt.kind === "fork-failed") return receipt.diagnostic;
      return `session ${receipt.childSession.sessionId}\n${receipt.diagnostic}`;
    }
    case "kill": return `${result.id} ${result.evidence}`;
  }
}

export function akumaExitCode(result: AkumaInvocationResult): number {
  if (result.action === "kill" && (result.evidence === "unavailable" || result.evidence === "alive-after-sigkill")) return 1;
  if (result.action === "tell" && typeof result.receipt.wake !== "string") return 2;
  if (result.action === "interrupt") {
    if (result.receipt.kind !== "interrupted" || "kind" in result.receipt.tell) return 1;
    if (typeof result.receipt.tell.wake !== "string") return 2;
  }
  if (result.action === "fork") {
    if (result.receipt.kind === "forked") return 0;
    return result.receipt.kind === "upstream-forked" ? 2 : 1;
  }
  return 0;
}

export function akumaJsonValue(command: ParsedCommand, result: AkumaInvocationResult): unknown {
  if (result.action === "fork") return result.receipt;
  if (result.action === "status" || result.action === "wait") return result.status;
  if (result.action === "tell") return { receipt: result.receipt, status: result.status };
  if (result.action === "history") return command.command === "history" && command.last ? result.answer ?? "" : result.history;
  return result;
}

export function renderAkumaJson(command: ParsedCommand, result: AkumaInvocationResult): string {
  return JSON.stringify(akumaJsonValue(command, result));
}
