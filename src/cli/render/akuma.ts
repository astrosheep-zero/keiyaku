import type { DispatchStage } from "../../index.js";
import type { AkumaInvocationResult } from "../commands/akuma-invoke.js";
import type { ParsedCommand } from "../parse.js";
import { parseAkumaStatus } from "../../akuma/akuma.js";
import {
  DEFAULT_CONTEXT,
  akumaRawAnswer,
  associatedIdentity,
  historyText,
  killResultText,
  mutationObservationStageText,
  snapshotHeading,
  snapshotText,
  tellText,
  waitText,
} from "./akuma-activity.js";
import { safeText, type TextRenderContext } from "./terminal.js";

export { akumaRawAnswer } from "./akuma-activity.js";

function dispatchLines(stage: DispatchStage): readonly string[] {
  if (stage.kind === "none") return [];
  if (stage.kind === "dispatched") {
    return (stage.seatClose ?? []).map((lag) => `dispatch lag ${lag.kind} ${safeText(lag.diagnostic)}`);
  }
  if (stage.failure.kind === "conflict") return [`dispatch failed conflict ${stage.failure.current.contractId}`];
  return [`dispatch failed ${stage.failure.kind} ${safeText(stage.failure.diagnostic)}`];
}

function executionCwdLine(result: Extract<AkumaInvocationResult, { action: "call" }>["result"]): readonly string[] {
  return result.execution.source === "contract-worktree" ? [`cwd ${result.execution.cwd}`] : [];
}

function posixShellArgument(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function callText(result: Extract<AkumaInvocationResult, { action: "call" }>, context: TextRenderContext): string {
  if (result.schemaAnswer !== undefined) return JSON.stringify(result.schemaAnswer);
  const alias = result.result.alias.kind === "aliased" ? result.result.alias.alias.alias : undefined;
  const contractId =
    result.result.dispatch.kind === "dispatched" ? result.result.dispatch.dispatch.contractId : undefined;
  const facts = [...dispatchLines(result.result.dispatch)];
  const restraint =
    result.result.readonly?.enforcement === "none" ? [`! ${safeText(result.result.readonly.diagnostic)}`] : [];
  if (result.result.alias.kind === "failed")
    facts.push(`alias failed ${result.result.alias.failure.kind} ${safeText(result.result.alias.failure.diagnostic)}`);
  const cwd = executionCwdLine(result.result);
  if (result.result.observation.kind === "detached") {
    const lines = [
      ...snapshotHeading(
        result.result.akuma,
        alias,
        contractId === undefined ? { kind: "none" } : { kind: "associated", contractId },
      ),
      ...cwd,
      ...restraint,
      ...facts,
    ];
    if (
      !(
        result.result.dispatch.kind === "failed" ||
        result.result.alias.kind === "failed" ||
        result.result.readonly?.enforcement === "none"
      )
    ) {
      const selector = result.result.alias.kind === "aliased" ? result.result.alias.alias.alias : result.result.akuma;
      lines.push(`$ keiyaku -C ${posixShellArgument(result.world)} wait ${selector} --timeout 5m`);
    }
    return lines.join("\n");
  }
  if (result.result.observation.kind === "failed") {
    return [
      ...snapshotHeading(
        result.result.akuma,
        alias,
        contractId === undefined ? { kind: "none" } : { kind: "associated", contractId },
      ),
      ...cwd,
      ...restraint,
      ...facts,
      `! error ${safeText(result.result.observation.failure.diagnostic)}`,
    ].join("\n");
  }
  return snapshotText(
    {
      status: parseAkumaStatus(result.result.observation.status),
      contract: contractId === undefined ? { kind: "none" } : { kind: "associated", contractId },
    },
    context,
    { ...(alias === undefined ? {} : { alias }), facts: [...cwd, ...facts] },
  );
}

export function renderAkumaText(
  command: ParsedCommand,
  result: AkumaInvocationResult,
  context: TextRenderContext = DEFAULT_CONTEXT,
): string {
  const answer = akumaRawAnswer(result);
  if (answer !== undefined) {
    if (result.action !== "call") return answer;
    const cwd = executionCwdLine(result.result);
    return cwd.length === 0 ? answer : `${cwd.join("\n")}\n${answer}`;
  }
  if (result.action === "tell" && result.mode === "schema") return JSON.stringify(result.result);
  switch (result.action) {
    case "call":
      return callText(result, context);
    case "status":
      return snapshotText(result.status, context, { ...(result.alias === undefined ? {} : { alias: result.alias }) });
    case "wait":
      return waitText(result, context);
    case "tell":
      return result.mode === "ordinary"
        ? tellText(result, context)
        : mutationObservationStageText(result.result.id, result.result.observation, context, {
            ...(result.alias === undefined ? {} : { alias: result.alias }),
            showLife: false,
          });
    case "history":
      return historyText(command as Extract<ParsedCommand, { command: "history"; last: boolean }>, result, context);
    case "fork": {
      if (result.receipt.kind !== "forked")
        return result.receipt.kind === "unknown-history"
          ? `${result.receipt.at} has no matching retained answered turn`
          : result.receipt.kind === "provider-cannot-fork"
            ? `${result.receipt.provider} cannot fork`
            : result.receipt.diagnostic;
      const contractId =
        result.receipt.dispatch.kind === "dispatched" ? result.receipt.dispatch.dispatch.contractId : undefined;
      return associatedIdentity(
        result.receipt.child,
        undefined,
        contractId === undefined ? { kind: "none" } : { kind: "associated", contractId },
      );
    }
    case "kill":
      return result.result.results
        .map((member) => killResultText(member.id, member.evidence, result.alias))
        .join("\n\n");
  }
}

function callExitCode(result: Extract<AkumaInvocationResult, { action: "call" }>): number {
  if (
    result.result.dispatch.kind === "failed" ||
    result.result.alias.kind === "failed" ||
    result.result.observation.kind === "failed"
  )
    return 2;
  if (result.result.observation.kind !== "observed") return 0;
  const timeline = result.result.observation.status.timeline;
  return timeline.kind === "idle" && timeline.outcome?.outcome.kind === "failed" ? 2 : 0;
}
function killExitCode(result: Extract<AkumaInvocationResult, { action: "kill" }>): number {
  return result.result.results.some(
    (member) => member.evidence === "unavailable" || member.evidence === "hung" || member.evidence === "untidy",
  )
    ? 1
    : 0;
}
function tellExitCode(result: Extract<AkumaInvocationResult, { action: "tell" }>): number {
  if (result.mode === "schema") return 0;
  return result.mode === "ordinary"
    ? result.result.tell.wake.kind === "failed"
      ? 2
      : 0
    : result.result.receipt.kind === "interrupted"
      ? 0
      : 1;
}
function forkExitCode(result: Extract<AkumaInvocationResult, { action: "fork" }>): number {
  return result.receipt.kind === "forked" ? 0 : result.receipt.kind === "upstream-forked" ? 2 : 1;
}
function historyExitCode(result: Extract<AkumaInvocationResult, { action: "history" }>): number {
  if (result.mode !== "exact") return 0;
  return result.historyResult.kind === "exact" ? 0 : 1;
}

export function akumaExitCode(result: AkumaInvocationResult): number {
  switch (result.action) {
    case "call":
      return callExitCode(result);
    case "kill":
      return killExitCode(result);
    case "tell":
      return tellExitCode(result);
    case "fork":
      return forkExitCode(result);
    case "history":
      return historyExitCode(result);
    default:
      return 0;
  }
}
export function akumaJsonValue(result: AkumaInvocationResult): unknown {
  if (result.action === "call") return result.schemaAnswer === undefined ? result.result : result.schemaAnswer;
  if (result.action === "fork") return result.receipt;
  if (result.action === "status") return result.status;
  if (result.action === "wait") return result.result;
  if (result.action === "tell") return result.mode === "schema" ? result.result : result.result;
  if (result.action === "kill") return result.result;
  return result.historyResult;
}
export function renderAkumaJson(result: AkumaInvocationResult): string {
  return JSON.stringify(akumaJsonValue(result));
}
