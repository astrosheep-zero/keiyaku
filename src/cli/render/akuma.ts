import type { ActivityHistory, ActivityRow, ActivitySnapshotEntry, AkumaStatus, TellResult } from "../../akuma/index.js";
import type { DispatchStage } from "../../index.js";
import type { AkumaInvocationResult } from "../commands/akuma-invoke.js";
import type { ParsedCommand } from "../parse.js";
import { toolRepr } from "./akuma-tool.js";
import {
  displayColumns,
  renderBoundedTextBlock,
  renderVoiceRuler,
  safeText,
  truncateMiddleDisplayText,
  type TextRenderContext,
} from "./terminal.js";

type SpineRow = Readonly<{
  kind: "row";
  at?: string;
  index?: number;
  label: string;
  text: string;
  active?: true;
  quoted?: true;
  truncated?: true;
  indivisible?: true;
  overflow?: "middle-ellipsis";
  suffix?: string;
}>;
type SpineGap = Readonly<{ kind: "gap"; count: number }>;
type SpineItem = SpineRow | SpineGap;

const GUTTER_MS = 60_000;
const LABEL_WIDTH = 6;
const RUN_IDENTITY_COLUMNS = 16;
const DEFAULT_CONTEXT: TextRenderContext = { columns: 80, color: false };

function mark(life: Exclude<AkumaStatus["life"], "running">): string {
  switch (life) {
    case "killed": return "×";
    case "asleep": return "○";
    case "stranded":
    case "headless": return "!";
  }
}

function identity(id: string, alias?: string): string {
  return `${id}${alias === undefined ? "" : ` (${alias})`}`;
}

function ruler(left: string, columns: number, scope = ""): string {
  if (scope.length > 0) return renderVoiceRuler(left, scope, columns).trimEnd();
  const width = Math.max(20, Math.min(80, columns));
  return `${left} ${"─".repeat(Math.max(1, width - displayColumns(left) - 1))}`;
}

function alignedLabel(value: string): string {
  return `${value}${" ".repeat(Math.max(0, LABEL_WIDTH - displayColumns(value)))}`;
}

function lifeFooter(status: AkumaStatus): readonly string[] {
  return status.life === "running" ? [] : [`     ${mark(status.life)} ${status.life}`];
}

function clock(at: string | undefined): string {
  if (at === undefined) return "";
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function renderSpine(
  items: readonly SpineItem[],
  context: TextRenderContext,
  profile: "snapshot" | "history" = "snapshot",
): string[] {
  let lastPrintedAt: number | undefined;
  return items.flatMap((item) => {
    if (item.kind === "gap") return [`     ⋮ +${item.count}`];
    const timestamp = item.at === undefined ? undefined : Date.parse(item.at);
    const printable = timestamp !== undefined && Number.isFinite(timestamp)
      && (lastPrintedAt === undefined || timestamp - lastPrintedAt >= GUTTER_MS);
    if (printable) lastPrintedAt = timestamp;
    const time = printable ? clock(item.at) : "";
    const index = item.index === undefined ? "" : String(item.index).padStart(4, " ");
    const gutter = `${index}${index.length === 0 ? "" : " "}${time.padStart(5, " ")}`;
    const spine = item.active === true ? "●" : "│";
    const quote = item.quoted === true ? "“" : "";
    const first = `${gutter}${spine} ${alignedLabel(item.label)} ${quote}`;
    if (item.indivisible === true) return [`${first}${safeText(item.text)}`.trimEnd()];
    if (item.overflow === "middle-ellipsis") {
      const rowBudget = Math.max(1, context.columns - displayColumns(first));
      const candidateSuffix = item.suffix ?? "";
      const suffix = rowBudget - displayColumns(candidateSuffix) >= RUN_IDENTITY_COLUMNS
        ? candidateSuffix
        : "";
      const budget = Math.max(1, rowBudget - displayColumns(suffix));
      const text = item.truncated === true ? `${item.text}…` : item.text;
      return [`${first}${truncateMiddleDisplayText(text, budget)}${suffix}`.trimEnd()];
    }
    const continuation = `${"".padStart(gutter.length)}│ ${"".padEnd(LABEL_WIDTH + 1, " ")}`;
    const lines = renderBoundedTextBlock(item.text, {
      first,
      continuation,
      columns: context.columns - displayColumns(quote),
      lines: profile === "snapshot" ? 3 : Number.MAX_SAFE_INTEGER,
      ...(item.truncated === true ? { truncated: true } : {}),
    });
    return item.quoted === true
      ? lines.map((line, index) => index === lines.length - 1 ? `${line}”` : line)
      : lines;
  });
}

function activityItem(row: ActivityRow): SpineRow {
  const truncated = "truncated" in row && row.truncated === true ? { truncated: true as const } : {};
  if (row.kind === "said") return { kind: "row", at: row.at, label: "say", text: row.text, quoted: true, ...truncated };
  if (row.kind === "thought") return { kind: "row", at: row.at, label: "think", text: row.text, quoted: true, ...truncated };
  if (row.kind === "note") return { kind: "row", at: row.at, label: "note", text: row.text, ...truncated };
  if (row.kind === "tell") return {
    kind: "row",
    at: row.at,
    label: row.state === "pending" ? "⧗ tell" : "told",
    text: row.text,
    quoted: true,
  };
  const repr = toolRepr(row);
  return {
    kind: "row",
    at: row.at,
    label: repr.label,
    text: repr.text,
    ...(repr.overflow === undefined ? {} : { overflow: repr.overflow }),
    ...(repr.suffix === undefined ? {} : { suffix: repr.suffix }),
    ...(row.state === "running" ? { active: true } : {}),
    ...truncated,
  };
}

function snapshotItems(entries: readonly ActivitySnapshotEntry[], exceptTell?: string): readonly SpineItem[] {
  return entries.flatMap((entry): readonly SpineItem[] => {
    if (entry.kind === "gap") return [entry];
    if (entry.row.kind === "tell" && entry.row.tellId === exceptTell) return [];
    return [activityItem(entry.row)];
  });
}

function outcomeItems(status: AkumaStatus): readonly SpineRow[] {
  if (status.answer !== undefined) return [{
    kind: "row",
    ...(status.outcomeAt === undefined ? {} : { at: status.outcomeAt }),
    label: "✓",
    text: `answered · keiyaku history ${status.id} --last`,
    indivisible: true,
  }];
  if (status.failure !== undefined) return [{
    kind: "row",
    ...(status.outcomeAt === undefined ? {} : { at: status.outcomeAt }),
    label: "!",
    text: `failed · ${status.failure}`,
  }];
  return [];
}

function statusItems(status: AkumaStatus, exceptTell?: string, tail: readonly SpineItem[] = []): readonly SpineItem[] {
  return [
    ...snapshotItems(status.activity.entries, exceptTell),
    ...(status.strandedReason === "resume-unsupported"
      ? [{ kind: "row" as const, label: "!", text: "resume unsupported" }]
      : []),
    ...outcomeItems(status),
    ...tail,
  ];
}

type StatusTextOptions = Readonly<{
  facts?: readonly string[];
  alias?: string;
  exceptTell?: string;
  tail?: readonly SpineItem[];
}>;

function statusText(status: AkumaStatus, context: TextRenderContext, options: StatusTextOptions = {}): string {
  return [
    ruler(identity(status.id, options.alias), context.columns),
    ...(options.facts ?? []),
    ...renderSpine(statusItems(status, options.exceptTell, options.tail), context),
    ...lifeFooter(status),
  ].join("\n");
}

function historyItems(history: ActivityHistory, akuma: string): readonly SpineRow[] {
  const activity = history.rows.map((row) => ({ ...activityItem(row), index: row.sequence }));
  const boundaries = history.turns.map((turn) => turn.outcome.kind === "answered"
    ? { kind: "row" as const, at: turn.completedAt, label: "✓", text: `answered · keiyaku history ${akuma} --last`, indivisible: true as const }
    : { kind: "row" as const, at: turn.completedAt, label: "!", text: `failed · ${turn.outcome.diagnostic}` });
  return [...activity, ...boundaries].sort((left, right) => {
    const leftAt = left.at === undefined ? Number.POSITIVE_INFINITY : Date.parse(left.at);
    const rightAt = right.at === undefined ? Number.POSITIVE_INFINITY : Date.parse(right.at);
    return (Number.isFinite(leftAt) ? leftAt : Number.POSITIVE_INFINITY)
      - (Number.isFinite(rightAt) ? rightAt : Number.POSITIVE_INFINITY);
  });
}

function historyText(
  command: Extract<ParsedCommand, { command: "history" }>,
  result: Extract<AkumaInvocationResult, { action: "history" }>,
  context: TextRenderContext,
): string {
  if (command.last) {
    if (result.mode === "no-answer") return "no answer retained";
    if (result.mode !== "last") throw new Error("history last result lacks its typed outcome");
    return result.answer;
  }
  if (result.mode !== "page") throw new Error("history result lacks its activity page");
  const history = result.history;
  const scope = command.before === undefined && command.since === undefined
    ? "history"
    : `history ── ${command.before === undefined ? `since ${command.since}` : `before ${command.before}`}`;
  const lines = [ruler(identity(result.akuma, result.alias), context.columns, scope)];
  const first = history.rows[0]?.sequence;
  const last = history.rows.at(-1)?.sequence;
  if (history.hasEarlier && first !== undefined) {
    lines.push(`   ⋮ ${history.omitted} earlier · keiyaku history ${result.akuma} --before ${first}`);
  } else if (history.historyLost) lines.push("   ⋮ earlier history no longer kept");
  if (history.hasLater && last !== undefined) {
    lines.push(`   ⋮ more · keiyaku history ${result.akuma} --since ${last}`);
  }
  if (command.since !== undefined && history.rows.length === 0) lines.push(`   ⋮ no activity since ${command.since}`);
  lines.push(...renderSpine(historyItems(history, result.akuma), context, "history"));
  return lines.join("\n");
}

function waitText(status: AkumaStatus, context: TextRenderContext): string {
  if (status.life === "running") return statusText(status, context);
  if (status.answer !== undefined) return status.answer;
  if (status.failure !== undefined) return `failure ${status.failure}`;
  return statusText(status, context);
}

function wakeFailure(result: TellResult): string | null {
  return typeof result.wake === "string" ? null : `wake failed: ${safeText(result.wake.diagnostic)}`;
}

function tellText(
  result: Extract<AkumaInvocationResult, { action: "tell"; mode: "ordinary" }>,
  context: TextRenderContext,
): string {
  const tellId = result.result.tell.admission.tellId;
  const observed = result.result.observation.activity.entries.find((entry) =>
    entry.kind === "row" && entry.row.kind === "tell" && entry.row.tellId === tellId);
  const current = observed?.kind === "row"
    ? activityItem(observed.row)
    : { kind: "row" as const, label: "⧗ tell", text: result.body, quoted: true as const };
  const status = statusText(result.result.observation, context, {
    ...(result.alias === undefined ? {} : { alias: result.alias }),
    exceptTell: tellId,
    tail: [current],
  });
  const failure = wakeFailure(result.result.tell);
  return failure === null ? status : `${status}\n${failure}`;
}

function dispatchLines(stage: DispatchStage): readonly string[] {
  if (stage.kind === "none") return [];
  if (stage.kind === "dispatched") return [`dispatch ${stage.dispatch.contractId}`];
  if (stage.failure.kind === "conflict") return [`dispatch failed conflict ${stage.failure.current.contractId}`];
  if (stage.failure.kind === "contention") return ["dispatch failed contention"];
  return [`dispatch failed ${stage.failure.kind} ${safeText(stage.failure.diagnostic)}`];
}

function callText(result: Extract<AkumaInvocationResult, { action: "call" }>, context: TextRenderContext): string {
  const called = result.result;
  const stages = [...dispatchLines(called.dispatch)];
  const alias = called.alias.kind === "aliased" ? called.alias.alias.alias : undefined;
  if (called.alias.kind === "failed") stages.push(`alias failed ${called.alias.failure.kind} ${safeText(called.alias.failure.diagnostic)}`);
  if (called.observation.kind === "detached") return [identity(called.akuma, alias), ...stages].join("\n");
  if (called.observation.kind === "failed") {
    return [identity(called.akuma, alias), ...stages, `wait failed ${called.observation.failure.kind} ${safeText(called.observation.failure.diagnostic)}`].join("\n");
  }
  const status = called.observation.status;
  if (status.answer !== undefined || status.failure !== undefined) return [identity(called.akuma, alias), ...stages, waitText(status, context)].join("\n");
  return statusText(status, context, { facts: stages, ...(alias === undefined ? {} : { alias }) });
}

export function renderAkumaText(
  command: ParsedCommand,
  result: AkumaInvocationResult,
  context: TextRenderContext = DEFAULT_CONTEXT,
): string {
  switch (result.action) {
    case "call": return callText(result, context);
    case "status": return statusText(result.status, context, result.alias === undefined ? {} : { alias: result.alias });
    case "wait": return result.result.statuses.map((status) => status.life === "running"
      ? statusText(status, context, result.alias === undefined ? {} : { alias: result.alias })
      : waitText(status, context)).join("\n\n");
    case "tell": {
      if (result.mode === "ordinary") return tellText(result, context);
      const receipt = result.result.receipt;
      const name = identity(result.result.id, result.alias);
      if (receipt.kind === "unstoppable") return `${name} interrupt unstoppable ${receipt.evidence}`;
      const failure = wakeFailure(receipt.tell);
      return `${name} interrupted ${receipt.putDown}${failure === null ? "" : ` · ${failure}`}`;
    }
    case "history": return historyText(command as Extract<ParsedCommand, { command: "history" }>, result, context);
    case "fork": {
      const receipt = result.receipt;
      if (receipt.kind === "forked") return [receipt.child, ...dispatchLines(receipt.dispatch)].join("\n");
      if (receipt.kind === "provider-cannot-fork") return `${receipt.provider} cannot fork`;
      if (receipt.kind === "unknown-history") return `${receipt.at} has no matching retained answered turn`;
      if (receipt.kind === "fork-failed") return receipt.diagnostic;
      return `session ${receipt.childSession.sessionId}\n${receipt.diagnostic}`;
    }
    case "kill": return result.result.results.map((member) => statusText(member.observation, context, {
      facts: [`kill ${member.evidence}`],
      ...(result.alias === undefined ? {} : { alias: result.alias }),
    })).join("\n\n");
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
  if (result.action === "history") {
    if (command.command === "history" && command.last) {
      if (result.mode === "no-answer") return { kind: "no-answer", id: result.akuma };
      if (result.mode !== "last") throw new Error("history last result lacks its typed outcome");
      return { kind: "last", id: result.akuma, answer: result.answer };
    }
    if (result.mode !== "page") throw new Error("history result lacks its activity page");
    return result.history;
  }
  return result;
}

export function renderAkumaJson(command: ParsedCommand, result: AkumaInvocationResult): string {
  return JSON.stringify(akumaJsonValue(command, result));
}
