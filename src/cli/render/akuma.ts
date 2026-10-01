import type { LiveStatusObservation } from "../../akuma/akuma-observe.js";
import type { TellResult } from "../../akuma/body.js";
import type { AkuId } from "../../akuma/identity.js";
import type {
  AkumaAskResult,
  AkumaKillResult,
  AkumaObservation,
  AkumaTellResult,
  AkumaWaitResult,
} from "../../akuma/selection-observation.js";
import type { CallWaitHead, DispatchStage, ForkResult } from "../../index.js";
import type { CallResult } from "../../library/akuma-creation.js";
import type { AkumaHistoryResult } from "../../library/selection.js";
import {
  DEFAULT_CONTEXT,
  associatedIdentity,
  historyText,
  inputWaitStream,
  killResultText,
  snapshotHeading,
  snapshotText,
  tellText,
  waitText,
  type ObservedCallHead,
} from "./akuma-activity.js";
import { safeText, type TextRenderContext } from "./terminal.js";

export type AskProgress = Readonly<{
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
        rows: [tellText({ akuma: target, tell }, alias, context, { identity: false })],
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

export function renderCallText(result: CallResult, streamed: boolean, context: TextRenderContext): string {
  if (streamed) return "";
  const head = callObservationHead({
    akuma: result.akuma,
    dispatch: result.dispatch,
    alias: result.alias,
  });
  if (result.observation.kind === "detached" || result.observation.kind === "born") {
    const branches = [
      ...(head.contract.kind === "associated" ? [safeText(head.contract.contractId)] : []),
      safeText(result.execution.cwd),
    ];
    return [
      associatedIdentity(result.akuma, head.alias),
      ...branches.map((fact, index) => `${index === branches.length - 1 ? "└─" : "├─"} ${fact}`),
      ...head.facts,
    ].join("\n");
  }
  if (result.observation.kind === "failed") {
    return [
      ...snapshotHeading(head.id, head.alias, head.contract),
      ...head.facts,
      `! error ${safeText(result.observation.failure.diagnostic)}`,
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

export function renderWaitText(
  result: AkumaWaitResult,
  presentation: Readonly<{
    alias?: string;
    startedAt?: number;
    selection?: readonly import("./akuma-activity.js").WaitSelectedIdentity[];
  }>,
  context: TextRenderContext = DEFAULT_CONTEXT,
): string {
  return waitText(result, presentation, context);
}

export function renderStatusText(
  status: AkumaObservation,
  alias: string | undefined,
  context: TextRenderContext = DEFAULT_CONTEXT,
): string {
  return snapshotText(status, context, ...(alias === undefined ? [{}] : [{ alias }]));
}

export function renderTellText(
  result: AkumaTellResult,
  alias: string | undefined,
  context: TextRenderContext = DEFAULT_CONTEXT,
  options: Readonly<{ identity?: boolean }> = {},
): string {
  return tellText(result, alias, context, options);
}

export function renderHistoryText(
  result: AkumaHistoryResult,
  presentation: Readonly<{ alias?: string; id?: string; last?: boolean }>,
  context: TextRenderContext = DEFAULT_CONTEXT,
): string {
  return historyText(result, presentation, context);
}

export function renderForkText(receipt: ForkResult): string {
  if (receipt.kind !== "forked") {
    if (receipt.kind === "unknown-history") return `${receipt.at} has no matching retained answered turn`;
    if (receipt.kind === "provider-cannot-fork") return `${receipt.provider} cannot fork`;
    return receipt.diagnostic;
  }
  const contractId = receipt.dispatch.kind === "dispatched" ? receipt.dispatch.dispatch.contractId : undefined;
  return associatedIdentity(
    receipt.child,
    undefined,
    contractId === undefined ? { kind: "none" } : { kind: "associated", contractId },
  );
}

export function renderKillText(result: AkumaKillResult, alias: string | undefined, context: TextRenderContext): string {
  void context;
  return result.results.map((member) => killResultText(member.id, member.evidence, alias)).join("\n\n");
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
