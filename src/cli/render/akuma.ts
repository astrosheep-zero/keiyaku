import type { AkumaAskResult, AkumaKillResult } from "../../akuma/selection-observation.js";
import type { ForkResult, SpawnResult } from "../../library/akuma-creation.js";
import { actionReceipt, killResultText, callFailureLines, askRawAnswer, tellControlLines } from "./akuma-activity.js";
import { exactIndentedLines, previewLines, safeText } from "./terminal.js";
import type { AkumaStatus } from "../../akuma/akuma.js";
import type { AkumaId } from "../../akuma/identity.js";

/** A logical live row, encoded as single-cell ASCII for the existing one-row painter. */
export function askFrame(
  elapsedMs: number,
  id: AkumaId,
  alias: string | undefined,
  status?: Pick<AkumaStatus, "life" | "work">,
): string {
  const subject = alias === undefined ? id : `${id} (${alias})`;
  const clock = `ask ${Math.floor(elapsedMs / 1_000)}s`;
  const last = status === undefined ? "" : ` last ${status.life}`;
  const work = status?.work.summary;
  const frame = `${subject} ${clock}${last}${work === undefined ? "" : ` | activity ${work.id} ${work.text}`}`;
  return frame.replace(/[^ -~]|\\/gu, (character) =>
    character === "\\" ? "\\\\" : `\\u{${character.codePointAt(0)!.toString(16)}}`,
  );
}

/** Final native Ask facts, independent of any live observation or caller clock. */
export function askResultText(result: AkumaAskResult, alias: string | undefined): string {
  const mark =
    result.kind === "answered" ? "✓" : result.kind === "deadline" ? "⧗" : result.kind === "unanswered" ? "○" : "!";
  return actionReceipt({
    mark,
    verb: result.kind,
    id: result.akumaId,
    ...(alias === undefined ? {} : { alias }),
    evidence: [
      `input ${result.tellId}`,
      ...tellControlLines(result),
      ...(result.kind === "failed" || result.kind === "invalid-output"
        ? exactIndentedLines(result.diagnostic, "")
        : []),
      ...(result.kind === "invalid-output" ? ["invalid answer", ...exactIndentedLines(result.answer, "")] : []),
    ],
  }).join("\n");
}

/** Shared final text keeps the answer raw unless native controls require context. */
export function renderAskText(result: AkumaAskResult, alias: string | undefined): string {
  const answer = askRawAnswer(result);
  if (answer !== undefined && tellControlLines(result).length === 0) return answer;
  return [askResultText(result, alias), ...(answer === undefined ? [] : [answer])].join("\n");
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

function spawnEvidence(result: SpawnResult, input: SpawnPresentation, exceptional = false): readonly string[] {
  const head = spawnHead(result, input);
  const showInput = exceptional || result.kind === "failed" || result.action === undefined;
  return [
    ...(head.contract.kind === "associated" ? [safeText(head.contract.contractId)] : []),
    ...(head.cwd === undefined ? [] : [safeText(head.cwd)]),
    ...head.facts,
    ...tellControlLines({ action: result.action, wake: result.wake }),
    ...(result.tellId === undefined || !showInput ? [] : [`input ${result.tellId}`]),
    ...(result.tellId === undefined || input.prompt === undefined || !showInput
      ? []
      : previewLines(input.prompt, "", 1).filter(Boolean)),
    ...(result.kind === "failed" ? callFailureLines(result.failures) : []),
  ];
}

export function renderCallText(result: SpawnResult, input: SpawnPresentation = {}): string {
  const head = spawnHead(result, input);
  return actionReceipt({
    mark: result.kind === "failed" ? "!" : "✓",
    verb: "spawned",
    id: result.akumaId,
    ...(head.alias === undefined ? {} : { alias: head.alias }),
    evidence: spawnEvidence(result, input),
  }).join("\n");
}

export function renderSpawnFailure(result: SpawnResult, diagnostic: string, input: SpawnPresentation = {}): string {
  const head = spawnHead(result, input);
  return actionReceipt({
    mark: "!",
    verb: "spawn failed",
    id: result.akumaId,
    ...(head.alias === undefined ? {} : { alias: head.alias }),
    evidence: [...spawnEvidence(result, input, true), ...exactIndentedLines(`reason ${diagnostic}`, "")],
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
    return actionReceipt({
      mark: "!",
      verb: "fork",
      id: parent,
      evidence: [...exactIndentedLines(reason, ""), ...session],
    }).join("\n");
  }
  return actionReceipt({
    mark: receipt.kind === "forked" ? "✓" : "!",
    verb: "forked",
    id: receipt.childAkumaId,
    evidence: [
      `from ${parent}`,
      ...(receipt.kind === "failed"
        ? callFailureLines([receipt.failure])
        : receipt.dispatchWarning === undefined
          ? []
          : [`dispatch lag ${safeText(receipt.dispatchWarning)}`]),
    ],
  }).join("\n");
}

export function renderKillText(result: AkumaKillResult, alias: string | undefined): string {
  return result.results.map((member) => killResultText(member.id, member.outcome, alias)).join("\n");
}
