import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

export const identityKeys = [
  "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDECODE", "CODEX_THREAD_ID",
  "OPENCODE_SESSION_ID", "PI_SESSION_ID", "PI_SESSION_FILE", "PASEO_AGENT_ID",
  "SQUARE_PARTICIPANT_NAME", "AKUMA_REQUESTS", "KEIYAKU_ACTOR_ID",
] as const;
const base = z.object({ sequence: z.number().int().nonnegative(), at: z.string() });
const row = z.union([
  base.extend({ kind: z.literal("turn"), turnSequence: z.number().int().nonnegative() }),
  base.extend({ kind: z.literal("tell"), tellId: z.string(), text: z.string(), state: z.enum(["pending", "told"]) }),
  base.extend({ kind: z.literal("outcome"), turnSequence: z.number().int().nonnegative(), outcome: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("answered"), answer: z.string() }),
    z.object({ kind: z.literal("failed"), diagnostic: z.string() }),
  ]) }),
  base.extend({ kind: z.enum(["tool", "said", "thought", "note", "call"]) }),
]);
const history = z.object({ kind: z.literal("history"), history: z.object({ rows: z.array(row) }) });
export type Row = z.infer<typeof row>;
export type Reader = (world: string, akuId: string, signal: AbortSignal) => Promise<Row[]>;
export const readKeiyaku: Reader = async (world, akuId, signal) => {
  const env = { ...process.env };
  for (const key of identityKeys) delete env[key];
  const { stdout } = await promisify(execFile)("keiyaku", ["-C", world, "history", akuId, "--json", "--limit", "200"], {
    env, signal, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8",
  });
  return history.parse(JSON.parse(stdout)).history.rows;
};
