import type { ProviderEvent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { z } from "zod";

const sequence = z.number().int().nonnegative();
export const tellReceiptSchema = z.object({
  akuma: z.string(),
  tell: z.object({
    admission: z.object({ fact: z.literal("recorded"), tellId: z.string().min(1) }),
    row: z.object({ kind: z.literal("tell"), sequence, at: z.string(), tellId: z.string().min(1), text: z.string(),
      state: z.enum(["pending", "told"]), deliveries: z.array(z.object({
        route: z.enum(["live", "launch"]), turnSequence: sequence, deliveredAt: z.string(),
        receipt: z.enum(["unavailable", "required"]).optional(),
      })).optional() }),
    wake: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("told") }), z.object({ kind: z.literal("held") }),
      z.object({ kind: z.literal("pursuing"), bodySequence: sequence }),
      z.object({ kind: z.literal("failed"), diagnostic: z.string() }),
    ]),
  }),
});
/** One durable Tell admission and the wake it observed, however that wake settled. */
export type TellAdmission = z.infer<typeof tellReceiptSchema>["tell"];
export type AdmittedMessage = TellAdmission["row"];
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
export function tellPresentation(admitted: TellAdmission, steerTurnId?: string): { row: AdmittedMessage; result: PromptResult } {
  const { row, wake } = admitted;
  if (wake.kind === "failed") console.warn(`Keiyaku Tell ${row.tellId} recorded; wake failed: ${wake.diagnostic}`);
  if (steerTurnId !== undefined) return { row, result: { type: "steer", turnId: steerTurnId } };
  const delivery = row.deliveries?.at(-1);
  if (delivery) return { row, result: { type: "turn", turnId: `turn/${delivery.turnSequence}` } };
  // The host may complete its send command; no Akuma outcome is manufactured.
  return { row, result: { type: "completed" } };
}
