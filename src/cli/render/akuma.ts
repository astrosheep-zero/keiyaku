import type { AkumaId } from "../../akuma/identity.js";
import type { AkumaAskResult, AkumaKillResult } from "../../akuma/selection-observation.js";
import type { ForkResult, SpawnResult } from "../../library/akuma-creation.js";
import {
  actionReceipt,
  killResultText,
  callFailureLines,
  askRawAnswer,
  tellControlLines,
  tellPayloadLines,
} from "./akuma-activity.js";
import { displayColumns, safeText, truncateDisplayText, type TextRenderContext } from "./terminal.js";
import type { AkumaStatus } from "../../akuma/akuma.js";
import type { CurrentWork } from "../../akuma/status-projection.js";

/** One current observation; only its work preview can truncate. */
export function askCurrentWorkLine(
  observed: Readonly<{ id: AkumaId; alias?: string; life?: AkumaStatus["life"]; summary?: CurrentWork["summary"] }>,
  elapsedMs: number,
  context: TextRenderContext,
): string {
  const identity = `${observed.id}${observed.alias === undefined ? "" : ` (${safeText(observed.alias)})`}`;
  const head = `${identity}${observed.life === undefined ? "" : ` · last observed ${observed.life}`}`;
  const clock = ` · observing ${Math.floor(elapsedMs / 1_000)}s`;
  const summary = observed.summary;
  if (summary === undefined) return `${head}${clock}`;
  const text = safeText(summary.text).replace(/\s+/gu, " ").trim();
  const preview = truncateDisplayText(
    summary.clipped === true ? `${text.replace(/…$/u, "")}…` : text,
    Math.max(1, context.columns - displayColumns(`${head} · ${clock}`)),
  );
  return `${head} · ${preview}${clock}`;
}

/** Final native Ask facts, independent of any live observation or caller clock. */
export function askResultText(result: AkumaAskResult, alias: string | undefined, context: TextRenderContext): string {
  const mark =
    result.kind === "answered" ? "✓" : result.kind === "deadline" ? "⧗" : result.kind === "unanswered" ? "○" : "!";
  return actionReceipt({
    mark,
    verb: result.kind,
    id: result.akumaId,
    ...(alias === undefined ? {} : { alias }),
    evidence: [
      `input ${result.tellId}`,
      ...tellControlLines(result, context),
      ...(result.kind === "failed" || result.kind === "invalid-output" ? [safeText(result.diagnostic)] : []),
      ...(result.kind === "invalid-output" ? ["invalid answer", ...result.answer.split("\n").map(safeText)] : []),
    ],
  }).join("\n");
}

/** Shared final text keeps the answer raw unless native controls require context. */
export function renderAskText(result: AkumaAskResult, alias: string | undefined, context: TextRenderContext): string {
  const answer = askRawAnswer(result);
  if (answer !== undefined && tellControlLines(result, context).length === 0) return answer;
  return [askResultText(result, alias, context), ...(answer === undefined ? [] : [answer])].join("\n");
}

type SpawnPresentation = Readonly<{ prompt?: string; cwd?: string; alias?: string; contractId?: string }>;
type SpawnHead = Readonly<{
  id: string;
  alias?: string;
  contract: Readonly<{ kind: "none" }> | Readonly<{ kind: "associated"; contractId: string }>;
  facts: readonly string[];
  cwd?: string;
}>;

function spawnHead(input: SpawnResult, presentation: SpawnPresentation = {}): SpawnHead {
  const alias = input.kind === "failed" ? input.aliasName : presentation.alias;
  const contractId = input.kind === "failed" ? input.contractId : presentation.contractId;
  const cwd = presentation.cwd;
  const facts = [
    ...(input.dispatchWarning === undefined ? [] : [`dispatch lag ${safeText(input.dispatchWarning)}`]),
    ...(input.alias === undefined ? [] : [`alias moved · previous ${input.alias.previousAkumaId}`]),
  ];
  return {
    id: input.akumaId,
    ...(alias === undefined ? {} : { alias }),
    contract: contractId === undefined ? { kind: "none" } : { kind: "associated", contractId },
    facts,
    ...(cwd === undefined ? {} : { cwd }),
  };
}

function spawnEvidence(
  result: SpawnResult,
  context: TextRenderContext,
  input: SpawnPresentation,
  exceptional = false,
): readonly string[] {
  const head = spawnHead(result, input);
  const showInput = exceptional || result.kind === "failed" || result.action === undefined;
  return [
    ...(head.contract.kind === "associated" ? [safeText(head.contract.contractId)] : []),
    ...(head.cwd === undefined ? [] : [safeText(head.cwd)]),
    ...head.facts,
    ...tellControlLines({ action: result.action, wake: result.wake }, context),
    ...(result.tellId === undefined || !showInput ? [] : [`input ${result.tellId}`]),
    ...(result.tellId === undefined || input.prompt === undefined || !showInput
      ? []
      : tellPayloadLines(input.prompt, context).map((line) => line.trimStart())),
    ...(result.kind === "failed" ? callFailureLines(result.failures, context) : []),
  ];
}

export function renderCallText(result: SpawnResult, context: TextRenderContext, input: SpawnPresentation = {}): string {
  const head = spawnHead(result, input);
  return actionReceipt({
    mark: result.kind === "failed" ? "!" : "✓",
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
  const head = spawnHead(result, input);
  return actionReceipt({
    mark: "!",
    verb: "spawn failed",
    id: result.akumaId,
    ...(head.alias === undefined ? {} : { alias: head.alias }),
    evidence: [...spawnEvidence(result, context, input, true), `reason ${safeText(diagnostic)}`],
  }).join("\n");
}

export function renderForkText(receipt: ForkResult, input: Readonly<{ akuma: string; at: string }>): string {
  const parent = receipt.parentAkumaId ?? input.akuma;
  if (receipt.kind !== "forked" && receipt.kind !== "failed") {
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
    mark: receipt.kind === "forked" ? "✓" : "!",
    verb: "forked",
    id: receipt.childAkumaId,
    evidence: [
      `from ${parent}`,
      ...(receipt.kind === "failed"
        ? callFailureLines([receipt.failure], { columns: 100, color: false })
        : receipt.dispatchWarning === undefined
          ? []
          : [`dispatch lag ${safeText(receipt.dispatchWarning)}`]),
    ],
  }).join("\n");
}

export function renderKillText(result: AkumaKillResult, alias: string | undefined, context: TextRenderContext): string {
  void context;
  return result.results.map((member) => killResultText(member.id, member.outcome, alias)).join("\n");
}
