import type { ActivityHistory, ActivityRow, AkumaStatus, TellResult } from "../../akuma/index.js";
import { toolRepr } from "./akuma-tool.js";
import type { AkumaInvocationResult } from "../commands/akuma-invoke.js";
import type { ParsedCommand } from "../parse.js";
import { safeText } from "./terminal.js";
import type { DispatchStage } from "../../index.js";

type SpineItem = Readonly<{ at?: string; index?: number; label: string; text: string }>;

const GUTTER_MS = 60_000;
const LABEL_WIDTH = 8;

function mark(life: AkumaStatus["life"]): string {
  switch (life) {
    case "running": return "●";
    case "killed": return "×";
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
  if (row.kind === "tell") return {
    at: row.at,
    label: row.state === "pending" ? "⧗ tell" : "told",
    text: JSON.stringify(row.text),
  };
  const repr = toolRepr(row);
  return {
    at: row.at,
    label: repr.label,
    text: repr.text,
  };
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
    ...(status.strandedReason === "resume-unsupported"
      ? [{ label: "!", text: "resume unsupported" }]
      : []),
    ...outcomeItems(status),
  ];
}

function omission(status: AkumaStatus): string[] {
  return status.activity.omitted === 0
    ? []
    : [`      ⋮ +${status.activity.omitted}`];
}

function statusText(status: AkumaStatus, facts: readonly string[] = []): string {
  return [
    ruler([`${mark(status.life)} ${status.id}`]),
    ...facts,
    ...omission(status),
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
  if (history === undefined) throw new Error("history result lacks its activity page");
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

function wakeFailure(result: TellResult): string | null {
  return typeof result.wake === "string" ? null : `wake failed: ${safeText(result.wake.diagnostic)}`;
}

function tellText(result: Extract<AkumaInvocationResult, { action: "tell"; mode: "ordinary" }>): string {
  const { observation } = result.result;
  const tellId = result.result.tell.admission.tellId;
  const observed = observation.activity.rows.find((row) => row.kind === "tell" && row.tellId === tellId);
  const status = {
    ...observation,
    activity: {
      ...observation.activity,
      rows: observation.activity.rows.filter((row) => row.kind !== "tell" || row.tellId !== tellId),
    },
  };
  const current = observed === undefined
    ? { label: "⧗ tell", text: JSON.stringify(result.body) }
    : activityItem(observed);
  const lines = [
    ruler([`${mark(status.life)} ${status.id}`]),
    ...omission(status),
    ...renderSpine([...statusItems(status), current]),
  ];
  const failure = wakeFailure(result.result.tell);
  if (failure !== null) lines.push(failure);
  return lines.join("\n");
}

function dispatchLines(stage: DispatchStage): readonly string[] {
  if (stage.kind === "none") return [];
  if (stage.kind === "dispatched") return [`dispatch ${stage.dispatch.contractId}`];
  const failure = stage.failure;
  if (failure.kind === "conflict") {
    return [`dispatch failed conflict ${failure.current.contractId}`];
  }
  if (failure.kind === "contention") return ["dispatch failed contention"];
  return [`dispatch failed ${failure.kind} ${safeText(failure.diagnostic)}`];
}

function callText(result: Extract<AkumaInvocationResult, { action: "call" }>): string {
  const called = result.result;
  const stages = [...dispatchLines(called.dispatch)];
  if (called.alias.kind === "aliased") stages.push(`alias ${called.alias.alias.alias}`);
  else if (called.alias.kind === "failed") {
    stages.push(`alias failed ${called.alias.failure.kind} ${safeText(called.alias.failure.diagnostic)}`);
  }
  if (called.observation.kind === "detached") return [called.akuma, ...stages].join("\n");
  if (called.observation.kind === "failed") {
    return [
      called.akuma,
      ...stages,
      `wait failed ${called.observation.failure.kind} ${safeText(called.observation.failure.diagnostic)}`,
    ].join("\n");
  }
  const status = called.observation.status;
  if (status.answer !== undefined || status.failure !== undefined) {
    return [called.akuma, ...stages, waitText(status)].join("\n");
  }
  return statusText(status, stages);
}

export function renderAkumaText(command: ParsedCommand, result: AkumaInvocationResult): string {
  switch (result.action) {
    case "call": return callText(result);
    case "status": return statusText(result.status);
    case "wait": return result.result.statuses.map(waitText).join("\n\n");
    case "tell": {
      if (result.mode === "ordinary") return tellText(result);
      const receipt = result.result.receipt;
      if (receipt.kind === "unstoppable") return `${result.result.id} interrupt unstoppable ${receipt.evidence}`;
      const failure = wakeFailure(receipt.tell);
      return `${result.result.id} interrupted ${receipt.putDown}${failure === null ? "" : ` · ${failure}`}`;
    }
    case "history": return historyText(command as Extract<ParsedCommand, { command: "history" }>, result);
    case "fork": {
      const receipt = result.receipt;
      if (receipt.kind === "forked") return [receipt.child, ...dispatchLines(receipt.dispatch)].join("\n");
      if (receipt.kind === "provider-cannot-fork") return `${receipt.provider} cannot fork`;
      if (receipt.kind === "unknown-history") return `${receipt.at} has no matching retained answered turn`;
      if (receipt.kind === "fork-failed") return receipt.diagnostic;
      return `session ${receipt.childSession.sessionId}\n${receipt.diagnostic}`;
    }
    case "kill": return result.result.results.map((member) => `${member.id} ${member.evidence}`).join("\n");
  }
}

export function akumaExitCode(result: AkumaInvocationResult): number {
  if (result.action === "call"
    && (result.result.dispatch.kind === "failed"
      || result.result.alias.kind === "failed"
      || result.result.observation.kind === "failed")) return 2;
  if (result.action === "kill" && result.result.results.some((member) =>
    member.evidence === "unavailable" || member.evidence === "alive-after-sigkill")) return 1;
  if (result.action === "tell" && result.mode === "ordinary" && typeof result.result.tell.wake !== "string") return 2;
  if (result.action === "tell" && result.mode === "interrupt") {
    if (result.result.receipt.kind !== "interrupted") return 1;
    if (typeof result.result.receipt.tell.wake !== "string") return 2;
  }
  if (result.action === "fork") {
    if (result.receipt.kind === "forked") return result.receipt.dispatch.kind === "failed" ? 2 : 0;
    return result.receipt.kind === "upstream-forked" ? 2 : 1;
  }
  return 0;
}

export function akumaJsonValue(command: ParsedCommand, result: AkumaInvocationResult): unknown {
  if (result.action === "call") return result.result;
  if (result.action === "fork") return result.receipt;
  if (result.action === "status") return result.status;
  if (result.action === "wait") return result.result;
  if (result.action === "tell") return result.result;
  if (result.action === "history") return command.command === "history" && command.last ? result.answer ?? "" : result.history;
  return result;
}

export function renderAkumaJson(command: ParsedCommand, result: AkumaInvocationResult): string {
  return JSON.stringify(akumaJsonValue(command, result));
}
