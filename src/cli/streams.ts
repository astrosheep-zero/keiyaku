import { DEFAULT_CLI_COLUMNS, type TextRenderContext } from "./render/terminal.js";

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

/** The product-result presentation context, measured from the stream that carries the result. */
export function displayContext(): TextRenderContext {
  return {
    columns:
      process.stdout.isTTY === true && Number.isInteger(process.stdout.columns)
        ? process.stdout.columns
        : DEFAULT_CLI_COLUMNS,
    color: process.stdout.isTTY === true && process.env.NO_COLOR === undefined,
  };
}

/** The live-progress context, measured from stderr where activity rows are written. */
export function resultContext(): TextRenderContext {
  const tty = process.stderr.isTTY === true;
  return {
    columns: tty && Number.isInteger(process.stderr.columns) ? process.stderr.columns : DEFAULT_CLI_COLUMNS,
    color: tty && process.env.NO_COLOR === undefined,
  };
}

/** One JSON product answer, verbatim from the native value. */
export function writeJson(value: unknown): void {
  writeStdout(JSON.stringify(value));
}
