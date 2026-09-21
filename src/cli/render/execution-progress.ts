import type { ExecutionEvent } from "../../library/execution.js";
import { renderOpaqueBlock, safeText, type TextRenderContext } from "./terminal.js";
import { StatusLine, type StatusLineOptions, type StatusLineStream } from "./status-line.js";

const LIVE_OUTPUT_BYTES = 4 * 1024;

function boundedUtf8Prefix(
  value: string,
  maximumBytes = LIVE_OUTPUT_BYTES,
): Readonly<{ text: string; truncated: boolean }> {
  let bytes = 0;
  let text = "";
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maximumBytes) return { text, truncated: true };
    bytes += size;
    text += character;
  }
  return { text, truncated: false };
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function phaseDetail(observation: Extract<ExecutionEvent, { kind: "verification" }>["observation"]): string {
  if (observation.phase === "declaration") return `declaration ${observation.index ?? "?"}/${observation.total ?? "?"}`;
  return observation.name === undefined ? observation.phase : `${observation.phase} · ${safeText(observation.name)}`;
}

function phaseStartLine(observation: Extract<ExecutionEvent, { kind: "verification" }>["observation"]): string {
  return `● ${[phaseDetail(observation), ...(observation.cwd === undefined ? [] : [safeText(observation.cwd)])].join(" · ")}`;
}

function phaseMark(outcome: string | undefined): "✓" | "×" | "?" {
  if (outcome === undefined) return "?";
  return outcome === "ok" || outcome === "exit 0" ? "✓" : "×";
}

function phaseFinishLine(
  observation: Extract<Extract<ExecutionEvent, { kind: "verification" }>["observation"], { kind: "phase" }>,
): string {
  const facts = [
    phaseDetail(observation),
    ...(observation.elapsedMs === undefined ? [] : [elapsed(observation.elapsedMs)]),
  ];
  if (observation.outcome !== undefined && observation.outcome !== "ok" && observation.outcome !== "exit 0")
    facts.push(safeText(observation.outcome));
  return `${phaseMark(observation.outcome)} ${facts.join(" · ")}`;
}

function outputLines(
  observation: Extract<ExecutionEvent, { kind: "verification" }>["observation"] & Readonly<{ kind: "output" }>,
  context: TextRenderContext,
): readonly string[] {
  const output = boundedUtf8Prefix(observation.text);
  return [
    observation.stream,
    ...renderOpaqueBlock(output.text, "  ", context.columns),
    ...(output.truncated ? ["  [live output truncated]"] : []),
  ];
}

type LiveOutputStream = "stdout" | "stderr";

type LiveOutputState = {
  bytes: number;
  truncated: boolean;
  pending: string;
  prefix: "  " | "    ";
};

class VerificationLiveOutput {
  private readonly streams = new Map<LiveOutputStream, LiveOutputState>();
  private activeStream: LiveOutputStream | undefined;

  reset(): void {
    this.streams.clear();
    this.activeStream = undefined;
  }

  lines(
    observation: Extract<ExecutionEvent, { kind: "verification" }>["observation"] & Readonly<{ kind: "output" }>,
    context: TextRenderContext,
  ): readonly string[] {
    const stream = observation.stream;
    const lines = this.flushOtherStreams(stream, context);
    const previous = this.streams.get(stream);
    const state = previous ?? ({ bytes: 0, truncated: false, pending: "", prefix: "  " } satisfies LiveOutputState);
    if (this.activeStream !== stream) {
      state.prefix = "  ";
      lines.push(stream);
      this.activeStream = stream;
    }
    this.streams.set(stream, state);
    if (state.truncated) return lines;

    const output = boundedUtf8Prefix(observation.text, LIVE_OUTPUT_BYTES - state.bytes);
    state.bytes += Buffer.byteLength(output.text);
    state.pending += output.text;
    lines.push(...this.drainCompleteLines(state, context));
    this.streams.set(stream, state);

    if (output.truncated) {
      lines.push(...this.drainPartialLine(state, context));
      state.truncated = true;
      lines.push("  [live output truncated]");
    }
    return lines;
  }

  finish(context: TextRenderContext): readonly string[] {
    const lines: string[] = [];
    for (const state of this.streams.values()) lines.push(...this.drainPartialLine(state, context));
    this.streams.clear();
    this.activeStream = undefined;
    return lines;
  }

  private flushOtherStreams(stream: LiveOutputStream, context: TextRenderContext): string[] {
    const lines: string[] = [];
    for (const [otherStream, state] of this.streams)
      if (otherStream !== stream) lines.push(...this.drainPartialLine(state, context));
    return lines;
  }

  private drainCompleteLines(state: LiveOutputState, context: TextRenderContext): readonly string[] {
    const lines: string[] = [];
    for (;;) {
      const newline = state.pending.indexOf("\n");
      if (newline < 0) break;
      const line = state.pending.slice(0, newline);
      state.pending = state.pending.slice(newline + 1);
      lines.push(...renderOpaqueBlock(line, state.prefix, context.columns));
      state.prefix = "    ";
    }
    return lines;
  }

  private drainPartialLine(state: LiveOutputState, context: TextRenderContext): readonly string[] {
    if (state.pending.length === 0) return [];
    const lines = renderOpaqueBlock(state.pending, state.prefix, context.columns);
    state.pending = "";
    return lines;
  }
}

/** Sparse rendering for consumers that do not own a live stream. */
export function executionProgressLines(event: ExecutionEvent, context: TextRenderContext): readonly string[] {
  switch (event.kind) {
    case "admitted":
      return [`✓ admitted ${event.fact.kind} · ${event.contractId}`];
    case "verification":
      return event.observation.kind === "output"
        ? outputLines(event.observation, context)
        : [
            event.observation.state === "started"
              ? phaseStartLine(event.observation)
              : phaseFinishLine(event.observation),
          ];
    case "stage":
      return [`${event.state === "started" ? "●" : "✓"} ${event.stage}`];
    case "progress-dropped":
      return [`progress dropped ${event.count} event${event.count === 1 ? "" : "s"}`];
  }
}

export type ExecutionProgressOptions = StatusLineOptions &
  Readonly<{
    stream: StatusLineStream;
    context: TextRenderContext;
  }>;

/** Consumes witnessed events into either a live TTY line or sparse text. */
export class ExecutionProgressRenderer {
  private readonly status: StatusLine;
  private verificationStartedAt: number | undefined;
  private declarations: Readonly<{ passed: number; total: number }> | undefined;
  private declarationFailed = false;
  private phaseFailed = false;
  private phaseUnknown = false;
  private readonly liveOutput = new VerificationLiveOutput();

  constructor(private readonly input: ExecutionProgressOptions) {
    this.status = new StatusLine(input.stream, input);
  }

  async consume(event: ExecutionEvent): Promise<void> {
    if (event.kind === "verification") {
      await this.consumeVerification(event);
      return;
    }
    await this.write(executionProgressLines(event, this.input.context));
  }

  finish(): void {
    if (!this.status.isTTY || this.verificationStartedAt === undefined) return;
    const now = this.input.now ?? (() => performance.now());
    const duration = elapsed(now() - this.verificationStartedAt);
    if (this.declarations !== undefined) {
      const { passed, total } = this.declarations;
      this.status.finish(`verify  ${this.finalMark()} ${passed}/${total} · ${duration}`);
      return;
    }
    this.status.finish(`verify  ${this.finalMark()} · ${duration}`);
  }

  private async consumeVerification(event: Extract<ExecutionEvent, { kind: "verification" }>): Promise<void> {
    const observation = event.observation;
    if (observation.kind === "output") {
      await this.write(this.liveOutput.lines(observation, this.input.context));
      return;
    }
    if (observation.state === "started") {
      await this.write(this.liveOutput.finish(this.input.context));
      this.liveOutput.reset();
      this.verificationStartedAt ??= (this.input.now ?? (() => performance.now()))();
      if (this.status.isTTY)
        this.status.show((duration) => `verify  ● ${phaseDetail(observation)} · ${elapsed(duration)}`);
      else await this.write([phaseStartLine(observation)]);
      return;
    }
    await this.write(this.liveOutput.finish(this.input.context));
    const mark = phaseMark(observation.outcome);
    this.phaseFailed ||= mark === "×";
    this.phaseUnknown ||= mark === "?";
    if (observation.phase === "declaration") {
      const total = observation.total ?? this.declarations?.total ?? 0;
      const passed = (this.declarations?.passed ?? 0) + (mark === "✓" ? 1 : 0);
      this.declarations = { passed, total };
      this.declarationFailed ||= mark !== "✓";
    }
    if (this.status.isTTY)
      this.status.show((duration) => `verify  ${mark} ${phaseDetail(observation)} · ${elapsed(duration)}`);
    else await this.write([phaseFinishLine(observation)]);
  }

  private write(lines: readonly string[]): Promise<void> {
    if (lines.length === 0) return Promise.resolve();
    if (this.status.isTTY) {
      this.status.writeBlock(lines);
      return Promise.resolve();
    }
    return writeChunk(this.input.stream, `${lines.join("\n")}\n`);
  }

  private finalMark(): "✓" | "×" | "?" {
    return this.phaseFailed || this.declarationFailed ? "×" : this.phaseUnknown ? "?" : "✓";
  }
}

export async function renderExecutionProgress(
  events: AsyncIterable<ExecutionEvent>,
  input: ExecutionProgressOptions,
): Promise<void> {
  const renderer = new ExecutionProgressRenderer(input);
  const destination = watchDestination(input.stream);
  const iterator = events[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), destination.promise]);
      if (next.done === true) break;
      await renderer.consume(next.value);
    }
    renderer.finish();
  } finally {
    destination.detach();
  }
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
