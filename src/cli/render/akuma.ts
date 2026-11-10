import type { LiveStatusObservation } from "../../akuma/akuma-observe.js";
import type { TellResult } from "../../akuma/body.js";
import type { AkumaId } from "../../akuma/identity.js";
import type { AkumaAskResult, AkumaTellResult, AkumaKillResult } from "../../akuma/selection-observation.js";
import type { ForkResult, SpawnResult, SpawnWaitHead } from "../../library/akuma-creation.js";
import {
  actionReceipt,
  callObservationStream,
  inputWaitStream,
  killResultText,
  subordinateLines,
  tellAdmissionRow,
  tellControlLines,
  tellPayloadLines,
  type ObservedCallHead,
} from "./akuma-activity.js";
import { safeText, type TextRenderContext } from "./terminal.js";

type AskProgress = Readonly<{
  admitted: (tell: TellResult, id: AkumaId) => readonly string[];
  observe: (observation: LiveStatusObservation) => readonly string[];
  frame: () => readonly string[];
  flush: () => readonly string[];
  conclude: (result: AkumaAskResult | AkumaTellResult) => readonly string[];
}>;

export function askProgressStream(
  akuma: AkumaId | undefined,
  alias: string | undefined,
  context: TextRenderContext,
  now?: () => number | undefined,
): AskProgress {
  let target = akuma;
  const stream = inputWaitStream(
    context,
    () => {
      if (target === undefined) throw new Error("Tell progress used before admission");
      return { id: target, ...(alias === undefined ? {} : { alias }), contract: { kind: "none" }, facts: [] };
    },
    { cursor: "admission", answerSeparator: true, ...(now === undefined ? {} : { now }) },
  );
  return {
    admitted: (tell, id) => {
      target = id;
      return stream.admitted({
        at: tell.row.at,
        sequence: tell.row.sequence,
        rows: [tellAdmissionRow(tell.row.text, context, tell.wake)],
      });
    },
    observe: (observation) => stream.observe(observation),
    frame: () => stream.frame(),
    flush: () => stream.flush(),
    conclude: (result) => [
      stream.conclude({
        kind: "observed",
        observation: "kind" in result ? result : (result.input ?? { kind: "unanswered" }),
      }),
      ...subordinateLines(tellControlLines(result, context)),
    ],
  };
}

export function waitedTellProgress(
  result: AkumaAskResult | AkumaTellResult,
  input: Readonly<{ prompt: string; alias?: string }>,
  context: TextRenderContext,
): string {
  const stream = inputWaitStream(
    context,
    () => ({
      id: result.akumaId,
      ...(input.alias === undefined ? {} : { alias: input.alias }),
      contract: { kind: "none" },
      facts: [],
    }),
    { cursor: "admission", answerSeparator: true, now: () => context.now },
  );
  const admitted = stream.admitted({ rows: [tellAdmissionRow(input.prompt, context, result.wake)] });
  return [
    ...admitted,
    stream.conclude({
      kind: "observed",
      observation: "kind" in result ? result : (result.input ?? { kind: "unanswered" }),
    }),
    ...subordinateLines(tellControlLines(result, context)),
  ].join("\n");
}

function dispatchFailureLine(failure: NonNullable<SpawnResult["dispatchFailure"]>): string {
  return failure.kind === "conflict"
    ? `! dispatch failed conflict ${failure.currentContractId}`
    : `! dispatch failed ${failure.kind} ${safeText(failure.diagnostic)}`;
}

type SpawnPresentation = Readonly<{ prompt?: string; cwd?: string; alias?: string; contractId?: string }>;
/** The shared frame consumes owner evidence and explicit invocation context. */
export function callObservationHead(
  input: SpawnResult | (SpawnWaitHead & Readonly<{ akumaId: string }>),
  presentation: SpawnPresentation = {},
): ObservedCallHead {
  const alias =
    input.alias !== undefined && input.alias.kind !== "moved"
      ? undefined
      : "aliasName" in input
        ? input.aliasName
        : presentation.alias;
  const contractId =
    input.dispatchFailure !== undefined
      ? undefined
      : "contractId" in input
        ? input.contractId
        : presentation.contractId;
  const cwd = "cwd" in input ? input.cwd : presentation.cwd;
  const facts = [
    ...(input.dispatchFailure === undefined ? [] : [dispatchFailureLine(input.dispatchFailure)]),
    ...(input.dispatchWarning === undefined ? [] : [`dispatch lag ${safeText(input.dispatchWarning)}`]),
    ...(input.alias !== undefined && input.alias.kind !== "moved"
      ? [`! alias failed ${input.alias.kind} ${safeText(input.alias.diagnostic)}`]
      : []),
    ...(input.alias?.kind === "moved" ? [`alias moved · previous ${input.alias.previousAkumaId}`] : []),
  ];
  return {
    id: input.akumaId,
    ...(alias === undefined ? {} : { alias }),
    contract: contractId === undefined ? { kind: "none" } : { kind: "associated", contractId },
    facts,
    ...(cwd === undefined ? {} : { cwd }),
  };
}

function spawnEvidence(result: SpawnResult, context: TextRenderContext, input: SpawnPresentation): readonly string[] {
  const head = callObservationHead(result, input);
  return [
    ...(head.contract.kind === "associated" ? [safeText(head.contract.contractId)] : []),
    ...(head.cwd === undefined ? [] : [safeText(head.cwd)]),
    ...head.facts,
    ...tellControlLines(result, context),
    ...(result.tellId === undefined || input.prompt === undefined
      ? []
      : tellPayloadLines(input.prompt, context).map((line) => line.trimStart())),
    ...(result.failure === undefined
      ? []
      : [
          `! ${result.failure.kind} · ${safeText(result.failure.diagnostic)}`,
          ...(result.failure.attemptedTellId === undefined
            ? []
            : [`attempted input ${safeText(result.failure.attemptedTellId)}`]),
        ]),
  ];
}

export function renderCallText(
  result: SpawnResult,
  streamed: boolean,
  context: TextRenderContext,
  input: SpawnPresentation = {},
): string {
  if (streamed) return "";
  const head = callObservationHead(result, input);
  if (result.input !== undefined && result.failure === undefined) {
    const stream = inputWaitStream(context, () => head, { cursor: "empty", now: () => context.now });
    stream.admitted({ rows: [] });
    return [
      stream.conclude({ kind: "observed", observation: result.input }),
      ...subordinateLines(tellControlLines(result, context)),
    ].join("\n");
  }
  const failed =
    result.failure !== undefined ||
    result.dispatchFailure !== undefined ||
    (result.alias !== undefined && result.alias.kind !== "moved");
  return actionReceipt({
    mark: failed ? "!" : "✓",
    verb: "spawned",
    id: result.akumaId,
    ...(head.alias === undefined ? {} : { alias: head.alias }),
    evidence: spawnEvidence(result, context, input),
  }).join("\n");
}

export function renderSpawnFailure(
  result: SpawnResult,
  diagnostic: string,
  context: TextRenderContext,
  input: SpawnPresentation = {},
): string {
  const head = callObservationHead(result, input);
  return actionReceipt({
    mark: "!",
    verb: "spawn failed",
    id: result.akumaId,
    ...(head.alias === undefined ? {} : { alias: head.alias }),
    evidence: [...spawnEvidence(result, context, input), `reason ${safeText(diagnostic)}`],
  }).join("\n");
}

export function renderFailedCallObservation(
  result: SpawnResult,
  context: TextRenderContext,
  input: SpawnPresentation = {},
): string {
  const failure = callObservationStream(context, callObservationHead(result, input), input);
  return failure.conclude(result);
}

export function renderForkText(receipt: ForkResult, input: Readonly<{ akuma: string; at: string }>): string {
  const parent = receipt.parentAkumaId ?? input.akuma;
  if (receipt.kind !== "forked") {
    const reason =
      receipt.kind === "unknown-history"
        ? `${input.at} has no matching retained answered turn`
        : receipt.kind === "provider-cannot-fork"
          ? "provider cannot fork"
          : receipt.diagnostic;
    const session =
      receipt.kind === "provider-forked-local-birth-failed" ? [`session ${JSON.stringify(receipt.session)}`] : [];
    return actionReceipt({ mark: "!", verb: "fork", id: parent, evidence: [reason, ...session] }).join("\n");
  }
  return actionReceipt({
    mark: receipt.dispatchFailure === undefined ? "✓" : "!",
    verb: "forked",
    id: receipt.childAkumaId,
    evidence: [
      `from ${parent}`,
      ...(receipt.dispatchFailure === undefined ? [] : [dispatchFailureLine(receipt.dispatchFailure)]),
      ...(receipt.dispatchWarning === undefined ? [] : [`dispatch lag ${safeText(receipt.dispatchWarning)}`]),
    ],
  }).join("\n");
}

export function renderKillText(result: AkumaKillResult, alias: string | undefined, context: TextRenderContext): string {
  void context;
  return result.results.map((member) => killResultText(member.id, member.outcome, alias)).join("\n");
}
