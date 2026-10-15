import { execFile } from "node:child_process";
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
export type CommandResult = { code: number; stdout: string; stderr: string };
export type CommandRunner = (world: string, args: string[], signal: AbortSignal, stdin?: string) => Promise<CommandResult>;

// Nonzero exits may still contain an admitted mutation receipt; callers interpret both.
export const runKeiyaku: CommandRunner = async (world, args, signal, stdin) => {
  signal.throwIfAborted();
  const env = { ...process.env };
  for (const key of identityKeys) delete env[key];
  return await new Promise<CommandResult>((resolve, reject) => {
    let completion: CommandResult | Error;
    const child = execFile("keiyaku", ["-C", world, ...args], {
      env, signal, timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, encoding: "utf8",
    }, (error, stdout, stderr) => {
      completion = error && (typeof error.code !== "number" || error.killed || error.signal)
        ? new Error(`Keiyaku command outcome is uncertain: ${stderr.trim() || error.message}`)
        : { code: typeof error?.code === "number" ? error.code : 0, stdout, stderr };
    });
    // Abort may call execFile's callback before the child physically retires.
    child.once("close", () => {
      if (completion instanceof Error) reject(completion);
      else resolve(completion);
    });
    // EPIPE can race with early CLI refusal; the exit callback owns its diagnostic.
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
  });
};
export const readKeiyaku: Reader = async (world, akuId, signal) => {
  const result = await runKeiyaku(world, ["history", akuId, "--json", "--limit", "200"], signal);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `Keiyaku history exited ${result.code}`);
  return history.parse(JSON.parse(result.stdout)).history.rows;
};
