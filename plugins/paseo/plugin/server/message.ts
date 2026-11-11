import type { ProviderEvent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import type { AkumaTellResult } from "@astrosheep/keiyaku";
/** The installed native owner validates this crossing value. */
export type TellAdmission = AkumaTellResult;
export type AdmittedMessage = Readonly<{ tellId: string; text: string; sequence?: number; at?: string }>;
/** Submit one plain-text Tell and return its admission receipt. */
export type Tell = (world: string, akuId: string, signal: AbortSignal, text: string) => Promise<TellAdmission>;
type PromptResult = Extract<ProviderEvent, { type: "session.prompt_result" }>["result"];

export function messageText(prompt: ProviderPrompt): string {
  // Paseo requests stale permission cleanup on ordinary steering. This mirror
  // owns no permission requests, so there is nothing to clear.
  if (prompt.outputSchema !== undefined) {
    throw new Error("Keiyaku messages do not support output schemas");
  }
  if (prompt.input.type !== "message") {
    throw new Error("Keiyaku messages support plain text only, not commands");
  }
  const parts: string[] = [];
  for (const part of prompt.input.content) {
    if (part.type !== "text" || "mimeType" in part) throw new Error("Keiyaku messages support plain text only, not attachments");
    parts.push(part.text);
  }
  const text = parts.join("\n");
  if (!text.trim()) throw new Error("Keiyaku messages require nonblank text");
  return text;
}

/**
 * Map one admitted Tell to its Paseo presentation. Paseo steering acknowledges
 * durable input acceptance, never native delivery: the observed Turn is a host
 * presentation correlation, never a Heart binding.
 */
export function tellPresentation(admitted: TellAdmission, text: string, steerTurnId?: string): { row: AdmittedMessage; result: PromptResult } {
  const row = { tellId: admitted.tellId, text };
  if (admitted.kind === "failed") for (const failure of admitted.failures)
    console.warn(`Keiyaku Tell ${admitted.tellId} recorded; ${failure.stage} failed: ${failure.diagnostic}`);
  return { row, result: steerTurnId === undefined ? { type: "completed" } : { type: "steer", turnId: steerTurnId } };
}
