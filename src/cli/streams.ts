import type { VerbDisposition } from "../library/keiyaku-verbs.js";
import { DEFAULT_CLI_COLUMNS, type TextRenderContext } from "./render/terminal.js";

const EXIT_CODES = {
  accepted: 0,
  refused: 1,
  retryable: 2,
  failed: 3,
  unsatisfied: 4,
  usage: 64,
} as const satisfies Record<VerbDisposition, number>;
export type CliOutcome = VerbDisposition;

export function cliExitCode(outcome: CliOutcome): number {
  return EXIT_CODES[outcome];
}

/** Append one complete line to a process stream unless the body already ends with a newline. */
export function writeCliStream(stream: NodeJS.WritableStream, body: string): void {
  stream.write(body.endsWith("\n") ? body : `${body}\n`);
}

export function writeStdout(body: string): void {
  writeCliStream(process.stdout, body);
}

export function writeStderr(body: string): void {
  writeCliStream(process.stderr, body);
}

/** Presentation context for the shared transport renderer. */
export function displayContext(): TextRenderContext {
  return {
    columns: DEFAULT_CLI_COLUMNS,
    color: process.stdout.isTTY === true && process.env.NO_COLOR === undefined,
    now: Date.now(),
  };
}

/** One JSON product answer, verbatim from the native value. */
export function writeJson(value: unknown): void {
  writeStdout(JSON.stringify(value));
}

/**
 * One product result: JSON writes the untouched native value, text writes the rendered projection,
 * and the native exit classifier's verdict follows.
 */
export function emit<Result>(
  output: "text" | "json",
  result: Result,
  text: () => string,
  outcome: CliOutcome,
): CliOutcome {
  if (output === "json") writeJson(result);
  else writeStdout(text());
  return outcome;
}
