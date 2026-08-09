import type { AkumaInvocationResult } from "../commands/akuma-invoke.js";
import type { ParsedAkumaCommand } from "../commands/akuma.js";
type Status = Extract<AkumaInvocationResult, { action: "status" }>["status"];
type Confinement = Status["confinement"];
type Turn = Status["history"][number];
type AgentEvent = Extract<AkumaInvocationResult, { action: "follow" }>["events"][number];

function summary(input: Readonly<{
  id: string;
  persona?: string;
  description?: string;
  life: string;
  confinement?: Confinement;
  pending?: readonly string[];
}>): string {
  return [
    `${input.id} ${input.life}`,
    ...(input.persona === undefined ? [] : [`persona ${input.persona}`]),
    ...(input.description === undefined ? [] : [`description ${input.description}`]),
    ...(input.confinement === undefined ? [] : input.confinement.kind === "unconfined"
      ? ["confinement unconfined"]
      : [`confinement declared ${input.confinement.writableRoots.join(" ")}`]),
    ...(input.pending === undefined || input.pending.length === 0 ? [] : [`pending ${input.pending.join(" ")}`]),
  ].join("\n");
}

function turn(turn: Turn): string {
  return turn.outcome.kind === "answered"
    ? [
        `turn ${turn.sequence} answered ${turn.outcome.historyId} session ${turn.outcome.session.sessionId} at ${turn.completedAt}`,
        turn.outcome.answer,
      ].join("\n")
    : `turn ${turn.sequence} failed at ${turn.completedAt}\nfailure ${turn.outcome.diagnostic}`;
}

function status(input: Status): string {
  return [summary(input), `history ${input.history.length}`, ...input.history.map(turn)].join("\n");
}

function event(event: AgentEvent): string {
  switch (event.type) {
    case "assistant": return event.text;
    case "session": return `session: ${event.coordinate.sessionId}`;
    case "action": return `action: ${event.note}`;
    case "unknown": return `unknown: ${event.kind}`;
  }
}

export function renderAkumaText(_command: ParsedAkumaCommand, result: AkumaInvocationResult): string {
  switch (result.action) {
    case "call": return result.id;
    case "list": return result.report.rows.length === 0
      ? ["akuma 0", ...result.report.searched.map((path) => `searched ${path}`)].join("\n")
      : result.report.rows.map((row) => summary(row)).join("\n");
    case "status": return status(result.status);
    case "follow": return result.events.map(event).join("\n");
    case "wait": return status(result.status);
    case "tell": return typeof result.receipt.wake === "string"
      ? `${result.akuma} tell ${result.receipt.id} recorded`
      : `${result.akuma} tell ${result.receipt.id} recorded\nwake failed ${result.receipt.wake.diagnostic}`;
    case "interrupt": {
      const receipt = result.receipt;
      if (receipt.kind === "dead") return `${result.akuma} interrupt dead`;
      if (receipt.kind === "unstoppable") return `${result.akuma} interrupt unstoppable ${receipt.evidence}`;
      if ("kind" in receipt.tell) return `${result.akuma} interrupted ${receipt.putDown}\ntell refused-dead`;
      return typeof receipt.tell.wake === "string"
        ? `${result.akuma} interrupted ${receipt.putDown}\ntell ${receipt.tell.id} recorded`
        : `${result.akuma} interrupted ${receipt.putDown}\ntell ${receipt.tell.id} recorded\nwake failed ${receipt.tell.wake.diagnostic}`;
    }
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

export function akumaJsonValue(result: AkumaInvocationResult): unknown {
  return result.action === "fork" ? result.receipt : result;
}

export function renderAkumaJson(result: AkumaInvocationResult): string {
  return result.action === "follow"
    ? result.events.map((event) => JSON.stringify(event)).join("\n")
    : JSON.stringify(akumaJsonValue(result));
}
