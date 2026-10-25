import type { LiveStatusObservation } from "../../akuma/akuma-observe.js";
import type { TellResult } from "../../akuma/body.js";
import type { AkuId } from "../../akuma/identity.js";
import type { AkumaAskResult, AkumaKillResult, AkumaTellResult } from "../../akuma/selection-observation.js";
import type { CallWaitHead, DispatchStage, ForkResult } from "../../index.js";
import type { CallResult } from "../../library/akuma-creation.js";
import type { AkumaHistoryResult } from "../../library/selection.js";
import {
  actionReceipt,
  callObservationStream,
  inputWaitStream,
  killResultText,
  subordinateLines,
  tellAdmissionRow,
  tellPayloadLines,
  type ObservedCallHead,
} from "./akuma-activity.js";
import { safeText, type TextRenderContext } from "./terminal.js";

type AskProgress = Readonly<{
  admitted: (tell: TellResult, id: AkuId) => readonly string[];
  observe: (observation: LiveStatusObservation) => readonly string[];
  frame: () => readonly string[];
  flush: () => readonly string[];
  conclude: (result: AkumaAskResult) => readonly string[];
}>;

export function askProgressStream(
  akuma: AkuId | undefined,
  alias: string | undefined,
  context: TextRenderContext,
): AskProgress {
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
        rows: [tellAdmissionRow(tell, context)],
      });
    },
    observe: (observation) => stream.observe(observation),
    frame: () => stream.frame(),
    flush: () => stream.flush(),
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
  result: AkumaAskResult,
  alias: string | undefined,
  context: TextRenderContext,
): string {
  const stream = askProgressStream(result.akuma, alias, context);
  return [...stream.admitted(result.tell, result.akuma), ...stream.conclude(result)].join("\n");
}

function dispatchLines(stage: DispatchStage): readonly string[] {
  if (stage.kind === "none") return [];
  if (stage.kind === "dispatched") {
    return (stage.seatClose ?? []).map((lag) => `dispatch lag ${lag.kind} ${safeText(lag.diagnostic)}`);
  }
  if (stage.failure.kind === "conflict") return [`! dispatch failed conflict ${stage.failure.current.contractId}`];
  return [`! dispatch failed ${stage.failure.kind} ${safeText(stage.failure.diagnostic)}`];
}

/** The shared identity frame for one admitted call input. */
export function callObservationHead(input: Readonly<{ akuma: string; cwd?: string }> & CallWaitHead): ObservedCallHead {
  const alias = input.alias.kind === "aliased" ? input.alias.alias.alias : undefined;
  const contractId = input.dispatch.kind === "dispatched" ? input.dispatch.dispatch.contractId : undefined;
  const facts = [
    ...dispatchLines(input.dispatch),
    ...(input.alias.kind === "failed"
      ? [`! alias failed ${input.alias.failure.kind} ${safeText(input.alias.failure.diagnostic)}`]
      : []),
  ];
  return {
    id: input.akuma,
    ...(alias === undefined ? {} : { alias }),
    contract: contractId === undefined ? { kind: "none" } : { kind: "associated", contractId },
    facts,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  };
}

/** The admitted context a call action receipt can state without reading anything new. */
function callEvidence(result: CallResult, head: ObservedCallHead): readonly string[] {
  return [
    ...(head.contract.kind === "associated" ? [safeText(head.contract.contractId)] : []),
    safeText(result.execution.cwd),
    ...head.facts,
  ];
}

export function renderCallText(result: CallResult, streamed: boolean, context: TextRenderContext): string {
  if (streamed) return "";
  const head = callObservationHead({
    akuma: result.akuma,
    dispatch: result.dispatch,
    alias: result.alias,
    cwd: result.execution.cwd,
  });
  const receipt = (mark: "✓" | "!", extra: readonly string[] = []): string =>
    actionReceipt({
      mark,
      verb: "called",
      id: result.akuma,
      ...(head.alias === undefined ? {} : { alias: head.alias }),
      evidence: [...callEvidence(result, head), ...extra],
    }).join("\n");
  if (result.observation.kind === "detached" || result.observation.kind === "born") {
    // Birth and integration are admitted facts; a failed Dispatch/Alias stage marks the receipt
    // honestly instead of letting a successful action line stand over it.
    return receipt(result.dispatch.kind === "failed" || result.alias.kind === "failed" ? "!" : "✓");
  }
  if (result.observation.kind === "failed") {
    // The child, its admitted Tell input, and its context survive a failed stage; a detached failure
    // stays an action receipt rather than becoming an observation panel.
    const admittedTell = result.observation.tell;
    return [
      ...actionReceipt({
        mark: "!",
        verb: "called",
        id: result.akuma,
        ...(head.alias === undefined ? {} : { alias: head.alias }),
        evidence: callEvidence(result, head),
      }),
      ...(admittedTell === undefined ? [] : tellPayloadLines(admittedTell.row.text, context)),
      ...subordinateLines([`! error ${safeText(result.observation.failure.diagnostic)}`]),
    ].join("\n");
  }
  const inputObservation = result.observation;
  const stream = inputWaitStream(context, () => head, { cursor: "empty" });
  stream.admitted({ at: inputObservation.tell.row.at, rows: [] });
  return stream.conclude({
    kind: "observed",
    observation: inputObservation.observation,
    ...(inputObservation.completedAt === undefined ? {} : { completedAt: inputObservation.completedAt }),
  });
}

/**
 * The failure panel for an observing call whose stream never opened. It opens the same shared head
 * over the failure's own evidence, including a Tell the invocation had already admitted.
 */
export function renderFailedCallObservation(result: CallResult, context: TextRenderContext): string {
  const failure = callObservationStream(
    context,
    callObservationHead({
      akuma: result.akuma,
      dispatch: result.dispatch,
      alias: result.alias,
      cwd: result.execution.cwd,
    }),
  );
  return failure.conclude(result.observation);
}

export function renderForkText(receipt: ForkResult): string {
  if (receipt.kind !== "forked") {
    const reason =
      receipt.kind === "unknown-history"
        ? `${receipt.at} has no matching retained answered turn`
        : receipt.kind === "provider-cannot-fork"
          ? `${receipt.provider} cannot fork`
          : receipt.diagnostic;
    return actionReceipt({ mark: "!", verb: "fork", id: receipt.parent, evidence: [reason] }).join("\n");
  }
  const contractId = receipt.dispatch.kind === "dispatched" ? receipt.dispatch.dispatch.contractId : undefined;
  return actionReceipt({
    mark: receipt.dispatch.kind === "failed" ? "!" : "✓",
    verb: "forked",
    id: receipt.child,
    evidence: [
      `from ${receipt.parent}`,
      ...(contractId === undefined ? [] : [safeText(contractId)]),
      ...dispatchLines(receipt.dispatch),
    ],
  }).join("\n");
}

export function renderKillText(result: AkumaKillResult, alias: string | undefined, context: TextRenderContext): string {
  void context;
  return result.results.map((member) => killResultText(member.id, member.evidence, alias)).join("\n");
}

export function callExitCode(result: CallResult): number {
  if (result.dispatch.kind === "failed" || result.alias.kind === "failed" || result.observation.kind === "failed")
    return 2;
  if (result.observation.kind !== "observed") return 0;
  return result.observation.observation.reason === "failed" ||
    result.observation.observation.reason === "invalid-output"
    ? 2
    : 0;
}

export function killExitCode(result: AkumaKillResult): number {
  return result.results.some(
    (member) => member.evidence === "unavailable" || member.evidence === "hung" || member.evidence === "untidy",
  )
    ? 1
    : 0;
}

export function tellExitCode(result: AkumaTellResult): number {
  return result.tell.wake.kind === "failed" ? 2 : 0;
}

export function askExitCode(result: AkumaAskResult): number {
  return result.observation.reason === "failed" || result.observation.reason === "invalid-output" ? 2 : 0;
}

export function forkExitCode(receipt: ForkResult): number {
  return receipt.kind === "forked" ? 0 : receipt.kind === "upstream-forked" ? 2 : 1;
}

export function historyExitCode(result: AkumaHistoryResult, id: string | undefined): number {
  if (id === undefined) return 0;
  return result.kind === "exact" ? 0 : 1;
}
