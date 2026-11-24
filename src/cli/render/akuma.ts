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

type SpawnPresentation = Readonly<{
  prompt?: string;
  showCwd?: boolean;
  alias?: string;
  contractId?: string;
  surface?: "cli" | "mcp";
}>;
type PartialSpawn = Extract<SpawnResult, { kind: "failed" }>;

function spawnRecovery(result: PartialSpawn, { prompt, surface }: SpawnPresentation): string[] {
  if (result.tellId !== undefined) return [];
  const birth = result.failures.find((stage) => stage.stage === "birth" && stage.tellNotAttemptedIn !== undefined);
  if (birth?.stage !== "birth" || birth.tellNotAttemptedIn === undefined) return [];
  const world = birth.tellNotAttemptedIn;
  const evidence = [`initial input not attempted · World ${safeText(world)}`];
  if (surface === "mcp" || prompt === undefined || prompt.trim() === "") return evidence;
  const quote = (arg: string) => `'${arg.replaceAll("'", "'\"'\"'")}'`;
  const call = `printf '%s' ${quote(prompt)} | keiyaku -C ${quote(world)} tell ${result.akumaId} -`;
  return safeText(call) === call ? [...evidence, `available ${call}`] : evidence;
}

function spawnEvidence(result: SpawnResult, input: SpawnPresentation): readonly string[] {
  const contractId = result.kind === "failed" ? result.contractId : input.contractId;
  const showInput = result.tellId !== undefined && (result.kind === "failed" || result.action === undefined);
  return [
    ...(contractId === undefined ? [] : [safeText(contractId)]),
    ...(input.showCwd === true ? [safeText(result.cwd)] : []),
    ...(result.dispatchWarning === undefined ? [] : [`dispatch lag ${safeText(result.dispatchWarning)}`]),
    ...(result.alias === undefined ? [] : [`alias moved · previous ${result.alias.previousAkumaId}`]),
    ...(result.aliasWarning === undefined ? [] : [`alias lag ${safeText(result.aliasWarning)}`]),
    ...tellControlLines({ action: result.action, wake: result.wake }),
    ...(showInput ? [`input ${result.tellId}${result.kind === "failed" ? " admitted" : ""}`] : []),
    ...(showInput && input.prompt !== undefined ? previewLines(input.prompt, "", 1).filter(Boolean) : []),
  ];
}

export function renderCallText(result: SpawnResult, input: SpawnPresentation = {}, diagnostic?: string): string {
  const evidence = spawnEvidence(result, input);
  if (result.kind === "spawned") {
    return actionReceipt({
      mark: "✓",
      verb: "spawned",
      id: result.akumaId,
      ...(input.alias === undefined ? {} : { alias: input.alias }),
      evidence,
    }).join("\n");
  }
  const stopped = [
    ...(result.aliasName === undefined ? [] : [`alias ${result.aliasName}`]),
    ...(result.requestedContractId === undefined ? [] : [`requested Contract ${result.requestedContractId}`]),
    ...(result.requestedAlias === undefined ? [] : [`requested Alias ${result.requestedAlias}`]),
    ...evidence,
    ...callFailureLines(result.failures),
    ...(diagnostic === undefined ? [] : exactIndentedLines(`reason ${diagnostic}`, "")),
    ...spawnRecovery(result, input),
  ];
  return [
    `! ${result.akumaId} born · ${result.failures[0].stage} failed · do not respawn`,
    ...stopped.map((line) => (line === "" ? "" : `  ${line}`)),
  ].join("\n");
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
