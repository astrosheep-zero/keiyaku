import { runProcess } from "../runtime/proc/run.js";
import type { AttestationData } from "../core/facts/types.js";
import type { VerificationDeclaration } from "./declaration.js";

type VerificationVerdict = AttestationData["verdict"];
const SUMMARY_BYTES = 32 * 1024;

export type VerificationTerminalOutcome = Readonly<{
  readonly kind: "terminal";
  readonly verdict: VerificationVerdict;
  readonly summary?: string;
}>;

export type VerificationNonterminalOutcome = Readonly<{
  readonly kind: "timeout" | "unknown-exit";
}> | Readonly<{
  readonly kind: "spawn-error";
  readonly diagnostic: string;
}>;

export type VerificationOutcome =
  | VerificationTerminalOutcome
  | VerificationNonterminalOutcome;

export type ProduceVerificationInput = Readonly<{
  readonly declarations: readonly VerificationDeclaration[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv;
}>;

function argvFor(declaration: VerificationDeclaration): readonly string[] {
  const args = declaration.executor === "pwsh" ? ["-Command", declaration.script] : ["-c", declaration.script];
  return [declaration.executor, ...args];
}

function processDiagnostic(
  declaration: VerificationDeclaration,
  index: number,
  outcome: Readonly<{ code: number; stdout: string; stderr: string; truncated: boolean }>,
): string | null {
  if (outcome.code === 0 && outcome.stdout.length === 0 && outcome.stderr.length === 0 && !outcome.truncated) {
    return null;
  }
  return [
    `[${index + 1} ${declaration.executor} exit ${outcome.code}${outcome.truncated ? " output-truncated" : ""}]`,
    ...(outcome.stdout.length === 0 ? [] : [`stdout:\n${outcome.stdout}`]),
    ...(outcome.stderr.length === 0 ? [] : [`stderr:\n${outcome.stderr}`]),
  ].join("\n");
}

function appendSummary(current: string | undefined, diagnostic: string | null): string | undefined {
  if (diagnostic === null) return current;
  const combined = Buffer.from(current === undefined ? diagnostic : `${current}\n\n${diagnostic}`);
  if (combined.length <= SUMMARY_BYTES) return combined.toString("utf8");
  const marker = Buffer.from("[earlier output truncated]\n");
  let start = combined.length - (SUMMARY_BYTES - marker.length);
  while (start < combined.length && (combined[start]! & 0xc0) === 0x80) start += 1;
  return Buffer.concat([marker, combined.subarray(start)]).toString("utf8");
}

export async function produceVerification(input: ProduceVerificationInput): Promise<VerificationOutcome> {
  const deadline = performance.now() + input.timeoutMs;
  let verdict: VerificationVerdict = "satisfied";
  let summary: string | undefined;
  for (const [index, declaration] of input.declarations.entries()) {
    const timeoutMs = deadline - performance.now();
    if (timeoutMs <= 0) return { kind: "timeout" };
    const outcome = await runProcess({
      argv: argvFor(declaration),
      cwd: input.cwd,
      timeoutMs,
      ...(input.env === undefined ? {} : { env: input.env }),
    });
    if (outcome.kind === "timeout") return { kind: "timeout" };
    if (outcome.kind === "spawn-error") return { kind: "spawn-error", diagnostic: outcome.diagnostic };
    if (outcome.kind === "unknown-exit") return { kind: "unknown-exit" };
    if (outcome.code !== 0) verdict = "unsatisfied";
    summary = appendSummary(summary, processDiagnostic(declaration, index, outcome));
  }
  return { kind: "terminal", verdict, ...(summary === undefined ? {} : { summary }) };
}
