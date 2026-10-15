import type { ProviderEvent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import type { CommandRunner } from "./keiyaku.js";

const sequence = z.number().int().nonnegative();
const receipt = z.object({
  akuma: z.string(),
  tell: z.object({
    admission: z.object({ fact: z.literal("recorded"), tellId: z.string().min(1) }),
    row: z.object({ kind: z.literal("tell"), sequence, at: z.string(), tellId: z.string().min(1), text: z.string(),
      state: z.enum(["pending", "told"]), deliveries: z.array(z.object({
        route: z.enum(["live", "launch"]), turnSequence: sequence, deliveredAt: z.string(),
        receipt: z.enum(["unavailable", "required"]).optional(),
      })) }),
    wake: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("told") }), z.object({ kind: z.literal("held") }),
      z.object({ kind: z.literal("pursuing"), bodySequence: sequence }),
      z.object({ kind: z.literal("failed"), diagnostic: z.string() }),
    ]),
  }),
});
export type AdmittedMessage = z.infer<typeof receipt>["tell"]["row"];
type PromptResult = Extract<ProviderEvent, { type: "session.prompt_result" }>["result"];

export function messageText(prompt: ProviderPrompt): string {
  if (prompt.outputSchema !== undefined || prompt.clearPendingPermissions) {
    throw new Error("Keiyaku messages do not support output schemas or permission changes");
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

export async function sendMessage(command: CommandRunner, world: string, akuId: string, signal: AbortSignal, text: string, steerTurnId?: string):
Promise<{ row: AdmittedMessage; result: PromptResult }> {
  const output = await command(world, ["tell", akuId, "--json", "-"], signal, text);
  const decoded = receipt.safeParse((() => { try { return JSON.parse(output.stdout); } catch { return undefined; } })());
  if (!decoded.success || decoded.data.akuma !== akuId ||
      decoded.data.tell.admission.tellId !== decoded.data.tell.row.tellId || decoded.data.tell.row.text !== text) {
    throw new Error(`Keiyaku Tell outcome is uncertain (exit ${output.code}): ${output.stderr.trim() || "invalid admission receipt"}`);
  }
  const { row, wake } = decoded.data.tell;
  if (wake.kind === "failed") console.warn(`Keiyaku Tell ${row.tellId} recorded; wake failed: ${wake.diagnostic}`);
  else if (output.code !== 0) console.warn(`Keiyaku Tell ${row.tellId} recorded; exit ${output.code}: ${output.stderr.trim()}`);
  // Paseo steering acknowledges durable input acceptance, not native delivery.
  // The observed Turn is a host presentation correlation, never a Heart binding.
  if (steerTurnId !== undefined) return { row, result: { type: "steer", turnId: steerTurnId } };
  const delivery = row.deliveries.at(-1);
  if (delivery) return { row, result: { type: "turn", turnId: `turn/${delivery.turnSequence}` } };
  // The host may complete its send command; no Akuma outcome is manufactured.
  return { row, result: { type: "completed" } };
}
