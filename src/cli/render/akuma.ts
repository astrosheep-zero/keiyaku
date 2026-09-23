import type { CallWaitHead, DispatchStage } from "../../index.js";
import type { AkumaInvocationResult } from "../commands/akuma-invoke.js";
import type { ParsedCommand } from "../parse.js";
import {
  DEFAULT_CONTEXT,
  akumaRawAnswer as akumaActivityRawAnswer,
  associatedIdentity,
  historyText,
  inputWaitStream,
  killResultText,
  mutationObservationStageText,
  snapshotHeading,
  snapshotText,
  tellText,
  waitText,
  type ObservedCallHead,
} from "./akuma-activity.js";
import type { AkumaTellWaitResult } from "../../akuma/fleet-observation.js";
import type { AkuId } from "../../akuma/identity.js";
import type { LiveStatusObservation } from "../../akuma/akuma-observe.js";
import type { TellResult } from "../../akuma/akuma.js";
import { safeText, type TextRenderContext } from "./terminal.js";

export type TellWaitProgress = Readonly<{
  admitted: (tell: TellResult, id: AkuId) => readonly string[];
  observe: (observation: LiveStatusObservation) => readonly string[];
  conclude: (result: AkumaTellWaitResult) => readonly string[];
}>;

export function tellWaitProgressStream(
  akuma: AkuId | undefined,
  alias: string | undefined,
  context: TextRenderContext,
): TellWaitProgress {
  let target = akuma;
  const stream = inputWaitStream(
    context,
    () => {
      if (target === undefined) throw new Error("Tell progress used before admission");
      return { id: target, ...(alias === undefined ? {} : { alias }), contract: { kind: "none" }, facts: [] };
    },
    { cursor: "admission", answerSeparator: true },
  );
  return {
    admitted: (tell, id) => {
      target = id;
      return stream.admitted({
        at: tell.row.at,
        sequence: tell.row.sequence,
        rows: [
          tellText(
            {
              kind: "akuma",
              action: "tell",
              mode: "ordinary",
              result: { akuma: target, tell },
              body: "",
              ...(alias === undefined ? {} : { alias }),
            },
            context,
            { identity: false },
          ),
        ],
      });
    },
    observe: (observation) => stream.observe(observation),
    conclude: (result) => [
      stream.conclude({
        kind: "observed",
        observation: result.observation,
        ...(result.completedAt === undefined ? {} : { completedAt: result.completedAt }),
      }),
    ],
  };
}

export function waitedTellProgress(
  result: AkumaTellWaitResult,
  alias: string | undefined,
  context: TextRenderContext,
): string {
  const stream = tellWaitProgressStream(result.akuma, alias, context);
  return [...stream.admitted(result.tell, result.akuma), ...stream.conclude(result)].join("\n");
}

export function akumaRawAnswer(result: AkumaInvocationResult): string | undefined {
  return akumaActivityRawAnswer(result);
}

function dispatchLines(stage: DispatchStage): readonly string[] {
  if (stage.kind === "none") return [];
  if (stage.kind === "dispatched") {
    return (stage.seatClose ?? []).map((lag) => `dispatch lag ${lag.kind} ${safeText(lag.diagnostic)}`);
  }
  if (stage.failure.kind === "conflict") return [`dispatch failed conflict ${stage.failure.current.contractId}`];
  return [`dispatch failed ${stage.failure.kind} ${safeText(stage.failure.diagnostic)}`];
}

/** The shared identity frame for one admitted call input. */
export function callObservationHead(input: Readonly<{ akuma: string }> & CallWaitHead): ObservedCallHead {
  const alias = input.alias.kind === "aliased" ? input.alias.alias.alias : undefined;
  const contractId = input.dispatch.kind === "dispatched" ? input.dispatch.dispatch.contractId : undefined;
  const facts = [
    ...dispatchLines(input.dispatch),
    ...(input.alias.kind === "failed"
      ? [`alias failed ${input.alias.failure.kind} ${safeText(input.alias.failure.diagnostic)}`]
      : []),
  ];
  return {
    id: input.akuma,
    ...(alias === undefined ? {} : { alias }),
    contract: contractId === undefined ? { kind: "none" } : { kind: "associated", contractId },
    facts,
  };
}

function callText(result: Extract<AkumaInvocationResult, { action: "call" }>, context: TextRenderContext): string {
  if (result.streamed === true) return "";
  const head = callObservationHead({
    akuma: result.result.akuma,
    dispatch: result.result.dispatch,
    alias: result.result.alias,
  });
  if (result.result.observation.kind === "detached") {
    return [
      associatedIdentity(result.result.akuma, head.alias),
      ...(head.contract.kind === "associated" ? [`  -> ${safeText(head.contract.contractId)}`] : []),
      `  cwd  ${safeText(result.result.execution.cwd)}`,
      ...head.facts,
    ].join("\n");
  }
  if (result.result.observation.kind === "failed") {
    return [
      ...snapshotHeading(head.id, head.alias, head.contract),
      ...head.facts,
      `! error ${safeText(result.result.observation.failure.diagnostic)}`,
    ].join("\n");
  }
  const inputObservation = result.result.observation;
  const stream = inputWaitStream(context, () => head, { cursor: "empty" });
  stream.admitted({ at: inputObservation.tell.row.at, rows: [] });
  return stream.conclude({
    kind: "observed",
    observation: inputObservation.observation,
    ...(inputObservation.completedAt === undefined ? {} : { completedAt: inputObservation.completedAt }),
  });
}

export function renderAkumaText(
  command: ParsedCommand,
  result: AkumaInvocationResult,
  context: TextRenderContext = DEFAULT_CONTEXT,
): string {
  const answer = akumaRawAnswer(result);
  if (answer !== undefined) return answer;
  if (result.action === "tell" && result.mode === "schema") return JSON.stringify(result.result);
  switch (result.action) {
    case "call":
      return callText(result, context);
    case "status":
      return snapshotText(result.status, context, {
        ...(result.alias === undefined ? {} : { alias: result.alias }),
      });
    case "wait":
      return waitText(result, context);
    case "tell":
      if (result.mode === "wait") return "";
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
  return result.result.observation.observation.reason === "failed" ||
    result.result.observation.observation.reason === "invalid-output"
    ? 2
    : 0;
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
  if (result.mode === "wait")
    return result.result.observation.reason === "failed" || result.result.observation.reason === "invalid-output"
      ? 2
      : 0;
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
  if (result.action === "call") return result.result;
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
