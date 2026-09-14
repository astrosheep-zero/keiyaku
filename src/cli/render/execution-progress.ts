import type { ExecutionEvent } from "../../library/execution.js";
import { renderOpaqueBlock, safeText, type TextRenderContext } from "./terminal.js";
import { StatusLine, type StatusLineOptions, type StatusLineStream } from "./status-line.js";

const LIVE_OUTPUT_BYTES = 4 * 1024;

function boundedUtf8Prefix(value: string): Readonly<{ text: string; truncated: boolean }> {
  let bytes = 0;
  let text = "";
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > LIVE_OUTPUT_BYTES) return { text, truncated: true };
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

  constructor(private readonly input: ExecutionProgressOptions) {
    this.status = new StatusLine(input.stream, input);
  }

  consume(event: ExecutionEvent): void {
    if (event.kind === "verification") {
      this.consumeVerification(event);
      return;
    }
    this.write(executionProgressLines(event, this.input.context));
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

  private consumeVerification(event: Extract<ExecutionEvent, { kind: "verification" }>): void {
    const observation = event.observation;
    if (observation.kind === "output") {
      this.write(outputLines(observation, this.input.context));
      return;
    }
    if (observation.state === "started") {
      this.verificationStartedAt ??= (this.input.now ?? (() => performance.now()))();
      if (this.status.isTTY)
        this.status.show((duration) => `verify  ● ${phaseDetail(observation)} · ${elapsed(duration)}`);
      else this.write([phaseStartLine(observation)]);
      return;
    }
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
    else this.write([phaseFinishLine(observation)]);
  }

  private write(lines: readonly string[]): void {
    if (this.status.isTTY) this.status.writeBlock(lines);
    else this.input.stream.write(`${lines.join("\n")}\n`);
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
  for await (const event of events) renderer.consume(event);
  renderer.finish();
}
