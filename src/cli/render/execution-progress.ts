import type { ExecutionObservation } from "../../protocol/execution-observation.js";
import { StatusLine, type StatusLineOptions, type StatusLineStream } from "./status-line.js";
import { exactIndentedLines, safeText } from "./terminal.js";

type VerificationObservation = Extract<ExecutionObservation, { kind: "verification" }>["observation"];
type Phase = Extract<VerificationObservation, { kind: "phase" }>;
type OutputBuffer = { text: string; bytes: number; observed: boolean; omittedBytes: number };

function emptyBuffer(): OutputBuffer {
  return { text: "", bytes: 0, observed: false, omittedBytes: 0 };
}

function append(buffer: OutputBuffer, text: string): void {
  buffer.observed = true;
  for (const character of text) {
    buffer.bytes += Buffer.byteLength(character);
    buffer.text += character;
    while (buffer.bytes > 4 * 1024) {
      const length = buffer.text.codePointAt(0)! > 0xffff ? 2 : 1;
      const removedBytes = Buffer.byteLength(buffer.text.slice(0, length));
      buffer.text = buffer.text.slice(length);
      buffer.bytes -= removedBytes;
      buffer.omittedBytes += removedBytes;
    }
  }
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function phaseDetail(observation: Phase): string {
  return observation.phase === "declaration"
    ? `declaration ${observation.index}/${observation.total}`
    : `${observation.phase} · check ${observation.index}/${observation.total}${observation.name === undefined ? "" : ` · ${safeText(observation.name)}`}`;
}

function phaseFinishLine(observation: Phase): string {
  const outcome = observation.outcome;
  const mark = outcome === undefined ? "?" : outcome === "ok" || outcome === "exit 0" ? "✓" : "×";
  const facts = [phaseDetail(observation)];
  if (observation.elapsedMs !== undefined) facts.push(elapsed(observation.elapsedMs));
  if (outcome !== undefined && outcome !== "ok" && outcome !== "exit 0") facts.push(safeText(outcome));
  return `${mark} ${facts.join(" · ")}`;
}

export type ExecutionProgressOptions = StatusLineOptions & Readonly<{ stream: StatusLineStream }>;

/** One bounded phase observer; the native receipt alone concludes Verification. */
export function createExecutionProgressRenderer(
  input: ExecutionProgressOptions,
): Readonly<{ observe(event: ExecutionObservation): void; finish(): Promise<void> }> {
  let status: StatusLine | undefined;
  const destination = watchDestination(input.stream);
  let buffers = { stdout: emptyBuffer(), stderr: emptyBuffer() };
  let chain: Promise<void> = Promise.resolve();
  let finishing: Promise<void> | undefined;
  let retired = false;

  async function flush(): Promise<void> {
    if (retired) return;
    status?.finish();
    status = undefined;
    const captured = buffers;
    buffers = { stdout: emptyBuffer(), stderr: emptyBuffer() };
    for (const stream of ["stdout", "stderr"] as const) {
      const buffer = captured[stream];
      if (retired || !buffer.observed) continue;
      const lines: string[] = [stream];
      if (buffer.omittedBytes > 0) {
        const unit = buffer.omittedBytes === 1 ? "byte" : "bytes";
        lines.push(`  [earlier output omitted: ${buffer.omittedBytes} ${unit}]`);
      }
      lines.push(...exactIndentedLines(buffer.text, "  "));
      await writeChunk(input.stream, `${lines.join("\n")}\n`);
    }
  }

  async function consume(event: ExecutionObservation): Promise<void> {
    if (retired || event.kind !== "verification") return;
    const observation = event.observation;
    if (observation.kind === "output") {
      append(buffers[observation.stream], observation.text);
      return;
    }
    await flush();
    if (retired) return;
    if (observation.state === "started") {
      status = new StatusLine(input.stream, input);
      status.show((duration) => `verify ${elapsed(duration)} ${observation.phase}`);
    } else {
      await writeChunk(input.stream, `${phaseFinishLine(observation)}\n`);
    }
  }

  async function finish(): Promise<void> {
    try {
      await Promise.race([destination.promise, chain.then(flush)]);
    } finally {
      retired = true;
      try {
        status?.finish();
      } finally {
        destination.detach();
      }
    }
  }

  return {
    observe(event) {
      if (finishing !== undefined) return;
      chain = chain.then(() => consume(event));
      chain.catch(() => undefined);
    },
    finish() {
      finishing ??= finish();
      return finishing;
    },
  };
}

/** Reject when the destination dies while the producer is still owned. */
function watchDestination(stream: NodeJS.WritableStream): Readonly<{ promise: Promise<never>; detach(): void }> {
  let detach = () => undefined;
  const promise = new Promise<never>((_, reject) => {
    const onError = (error: Error) => reject(error);
    const onClose = () =>
      reject(
        Object.assign(new Error("write on prematurely closed destination"), { code: "ERR_STREAM_PREMATURE_CLOSE" }),
      );
    stream.once("error", onError);
    stream.once("close", onClose);
    detach = () => {
      stream.off("error", onError);
      stream.off("close", onClose);
    };
  });
  promise.catch(() => undefined);
  return { promise, detach };
}

/** Await one destination write: backpressure and error propagation in one callback. */
function writeChunk(stream: NodeJS.WritableStream, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(text, (error) => (error ? reject(error) : resolve()));
  });
}
