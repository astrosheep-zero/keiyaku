import type { AkumaInvocationResult } from "../commands/akuma-invoke.js";
import type { ParsedCommand } from "../parse.js";

type AkumaStatus = Extract<AkumaInvocationResult, { action: "status" }>["status"];
type Confinement = AkumaStatus["confinement"];
type ActivityRow = AkumaStatus["activity"]["rows"][number];
type ToolCall = Extract<ActivityRow, { kind: "tool" }>["call"];
type TurnFact = Extract<AkumaInvocationResult, { action: "history" }>["turns"][number];
type AgentEvent = Extract<AkumaInvocationResult, { action: "follow" }>["events"][number];

function summary(input: Readonly<{
  id: string;
  persona?: string;
  description?: string;
  contract?: string;
  life: string;
  confinement?: Confinement;
  pending?: readonly string[];
}>): string {
  return [
    `${input.id} ${input.life}`,
    ...(input.persona === undefined ? [] : [`persona ${input.persona}`]),
    ...(input.description === undefined ? [] : [`description ${input.description}`]),
    ...(input.contract === undefined ? [] : [`contract ${input.contract}`]),
    ...(input.confinement === undefined ? [] : input.confinement.kind === "unconfined"
      ? ["confinement unconfined"]
      : [`confinement declared ${input.confinement.writableRoots.join(" ")}`]),
    ...(input.pending === undefined || input.pending.length === 0 ? [] : [`pending ${input.pending.join(" ")}`]),
  ].join("\n");
}

function toolCall(call: ToolCall): string {
  switch (call.kind) {
    case "run": return `run ${JSON.stringify(call.command)}`;
    case "read": return `read ${JSON.stringify(call.path)}`;
    case "search": return `search ${JSON.stringify(call.query)}`;
    case "fileChange": return `change ${call.paths.map((path) => JSON.stringify(path)).join(" ")}`;
    case "other": return `use ${JSON.stringify(call.display)}`;
  }
}

function activityRow(row: ActivityRow): string {
  if (row.kind === "said") return `said ${JSON.stringify(row.text)}`;
  if (row.kind === "note") return `note ${JSON.stringify(row.text)}`;
  const state = row.state === "running"
    ? "running"
    : row.state.message === undefined
      ? row.state.status
      : `${row.state.status} ${JSON.stringify(row.state.message)}`;
  return `tool ${JSON.stringify(row.name)} ${state} ${toolCall(row.call)}`;
}

function activity(status: AkumaStatus): string[] {
  const heading = status.activity.omitted === 0
    ? `activity ${status.activity.rows.length}`
    : `activity ${status.activity.rows.length} omitted ${status.activity.omitted}`;
  return [heading, ...status.activity.rows.map(activityRow)];
}

function outcome(status: AkumaStatus): string[] {
  if (status.answer !== undefined) return ["answer", status.answer];
  if (status.failure !== undefined) return [`failure ${status.failure}`];
  return [];
}

function status(status: AkumaStatus): string {
  return [summary(status), ...outcome(status), ...activity(status)].join("\n");
}

function turn(turn: TurnFact): string {
  return turn.outcome.kind === "answered"
    ? [
        `turn ${turn.sequence} answered ${turn.outcome.historyId} session ${turn.outcome.session.sessionId} at ${turn.completedAt}`,
        turn.outcome.answer,
      ].join("\n")
    : `turn ${turn.sequence} failed at ${turn.completedAt}\nfailure ${turn.outcome.diagnostic}`;
}

function lastAnswer(turns: readonly TurnFact[]): string {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const outcome = turns[index]!.outcome;
    if (outcome.kind === "answered") return outcome.answer;
  }
  return "";
}

function event(event: AgentEvent): string {
  switch (event.type) {
    case "assistant": return event.text;
    case "session": return `session ${event.coordinate.sessionId}`;
    case "tool": {
      const state = event.phase === "started"
        ? "started"
        : event.result.message === undefined
          ? `completed ${event.result.status}`
          : `completed ${event.result.status} ${JSON.stringify(event.result.message)}`;
      return `tool ${JSON.stringify(event.id)} ${JSON.stringify(event.name)} ${state} ${toolCall(event.call)}`;
    }
    case "note": return `note ${JSON.stringify(event.text)}`;
    case "unknown": return `unknown ${JSON.stringify(event.kind)}`;
  }
}

function waitResult(statusValue: AkumaStatus): string {
  if (statusValue.life === "running") return [summary(statusValue), ...activity(statusValue)].join("\n");
  if (statusValue.answer !== undefined) return statusValue.answer;
  if (statusValue.failure !== undefined) return `failure ${statusValue.failure}`;
  return summary(statusValue);
}

export function renderAkumaText(command: ParsedCommand, result: AkumaInvocationResult): string {
  switch (result.action) {
    case "call": return result.id;
    case "status": return status(result.status);
    case "follow": return result.events.map(event).join("\n");
    case "wait": return waitResult(result.status);
    case "tell": {
      const receipt = typeof result.receipt.wake === "string"
        ? `${result.akuma} tell ${result.receipt.id} recorded`
        : `${result.akuma} tell ${result.receipt.id} recorded\nwake failed ${result.receipt.wake.diagnostic}`;
      return `${receipt}\n${status(result.status)}`;
    }
    case "interrupt": {
      const receipt = result.receipt;
      if (receipt.kind === "dead") return `${result.akuma} interrupt dead`;
      if (receipt.kind === "unstoppable") return `${result.akuma} interrupt unstoppable ${receipt.evidence}`;
      if ("kind" in receipt.tell) return `${result.akuma} interrupted ${receipt.putDown}\ntell refused-dead`;
      return typeof receipt.tell.wake === "string"
        ? `${result.akuma} interrupted ${receipt.putDown}\ntell ${receipt.tell.id} recorded`
        : `${result.akuma} interrupted ${receipt.putDown}\ntell ${receipt.tell.id} recorded\nwake failed ${receipt.tell.wake.diagnostic}`;
    }
    case "history": return command.command === "history" && command.last
      ? lastAnswer(result.turns)
      : result.turns.map(turn).join("\n");
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
  if (result.action === "history") {
    return command.command === "history" && command.last ? lastAnswer(result.turns) : result.turns;
  }
  return result;
}

export function renderAkumaJson(command: ParsedCommand, result: AkumaInvocationResult): string {
  return result.action === "follow"
    ? result.events.map((item) => JSON.stringify(item)).join("\n")
    : JSON.stringify(akumaJsonValue(command, result));
}
