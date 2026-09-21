import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import type { ExecutionEvent } from "../src/library/execution.js";
import { ExecutionProgressRenderer } from "../src/cli/render/execution-progress.js";
import { writeExecutionProgress } from "../src/cli/runtime.js";

class CapturedStream extends Writable {
  readonly chunks: string[] = [];

  constructor(readonly isTTY: boolean) {
    super();
  }

  _write(chunk: Uint8Array, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk).toString("utf8"));
    callback();
  }

  get text(): string {
    return this.chunks.join("");
  }
}

function phase(
  state: "started" | "finished",
  values: Readonly<{
    phase: "setup" | "declaration" | "cleanup";
    name?: string;
    index?: number;
    total?: number;
    elapsedMs?: number;
    outcome?: string;
  }>,
): ExecutionEvent {
  return {
    kind: "verification",
    contractId: "kei/progress" as never,
    snapshot: "snapshot" as never,
    observation: { kind: "phase", cwd: "/scratch", state, ...values },
  } as ExecutionEvent;
}

function output(text: string): ExecutionEvent {
  return outputFor("stdout", text);
}

function outputFor(stream: "stdout" | "stderr", text: string): ExecutionEvent {
  return {
    kind: "verification",
    contractId: "kei/progress" as never,
    snapshot: "snapshot" as never,
    observation: { kind: "output", phase: "declaration", cwd: "/scratch", index: 1, total: 1, stream, text },
  } as ExecutionEvent;
}

async function renderDeclarationOutput(chunks: readonly string[]): Promise<string> {
  const stream = new CapturedStream(false);
  const renderer = new ExecutionProgressRenderer({ stream, context: { columns: 20, color: false } });
  await renderer.consume(phase("started", { phase: "declaration", index: 1, total: 1 }));
  for (const chunk of chunks) await renderer.consume(output(chunk));
  await renderer.consume(phase("finished", { phase: "declaration", index: 1, total: 1, outcome: "exit 0" }));
  return stream.text;
}

test("TTY progress refreshes one ticking line, returns after output, and persists the verification summary", async () => {
  const stream = new CapturedStream(true);
  let now = 0;
  let tick: (() => void) | undefined;
  const renderer = new ExecutionProgressRenderer({
    stream,
    context: { columns: 80, color: false },
    now: () => now,
    schedule: (next) => {
      tick = next;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    cancel: () => undefined,
  });

  await renderer.consume(phase("started", { phase: "setup", name: "npm ci" }));
  now = 42_000;
  tick?.();
  await renderer.consume(output("hello\n"));
  await renderer.consume(phase("started", { phase: "declaration", index: 1, total: 1 }));
  await renderer.consume(
    phase("finished", { phase: "declaration", index: 1, total: 1, outcome: "exit 0", elapsedMs: 2_000 }),
  );
  renderer.finish();

  assert.match(stream.text, /\r\x1b\[2Kverify  ● setup · npm ci · 0s/u);
  assert.match(stream.text, /\r\x1b\[2Kverify  ● setup · npm ci · 42s/u);
  assert.match(stream.text, /stdout\n  hello\n\r\x1b\[2Kverify/u);
  assert.match(stream.text, /verify  ✓ 1\/1 · 42s\n$/u);
});

test("non-TTY progress emits sparse boundaries, bounded output, and no key-value vocabulary", async () => {
  const stream = new CapturedStream(false);
  async function* events(): AsyncGenerator<ExecutionEvent> {
    yield phase("started", { phase: "setup", name: "npm ci" });
    yield output("x".repeat(5_000));
    yield phase("finished", { phase: "setup", name: "npm ci", outcome: "ok", elapsedMs: 42_000 });
    yield { kind: "progress-dropped", count: 2 };
  }

  await writeExecutionProgress(events(), stream);

  assert.match(stream.text, /^● setup · npm ci · \/scratch\n/u);
  assert.match(stream.text, /stdout\n  x/u);
  assert.match(stream.text, /\[live output truncated\]/u);
  assert.match(stream.text, /✓ setup · npm ci · 42s\n/u);
  assert.match(stream.text, /progress dropped 2 events\n$/u);
  assert.doesNotMatch(stream.text, /(?:cwd|hook|declaration|elapsed)=/u);
});

test("live output consolidates adjacent chunks by stream and resets at the next phase", async () => {
  const stream = new CapturedStream(false);
  const renderer = new ExecutionProgressRenderer({ stream, context: { columns: 80, color: false } });

  await renderer.consume(phase("started", { phase: "setup", name: "npm ci" }));
  await renderer.consume(output("stdout one"));
  await renderer.consume(output("stdout two"));
  await renderer.consume({
    kind: "verification",
    contractId: "kei/progress" as never,
    snapshot: "snapshot" as never,
    observation: {
      kind: "output",
      phase: "setup",
      cwd: "/scratch",
      name: "npm ci",
      stream: "stderr",
      text: "stderr one",
    },
  } as ExecutionEvent);
  await renderer.consume(output("stdout three"));
  await renderer.consume(phase("finished", { phase: "setup", name: "npm ci", outcome: "ok" }));
  await renderer.consume(phase("started", { phase: "declaration", index: 1, total: 1 }));
  await renderer.consume(output("stdout next"));
  await renderer.consume(phase("finished", { phase: "declaration", index: 1, total: 1, outcome: "exit 0" }));

  assert.equal((stream.text.match(/^stdout$/gmu) ?? []).length, 3);
  assert.equal((stream.text.match(/^stderr$/gmu) ?? []).length, 1);
  assert.match(stream.text, /stdout\n  stdout onestdout two\nstderr\n  stderr one\n/u);
  assert.match(stream.text, /stderr\n  stderr one\nstdout\n  stdout three\n/u);
  assert.match(stream.text, /● declaration 1\/1 · \/scratch\nstdout\n  stdout next\n/u);
});

test("live output applies one cumulative UTF-8-safe stream budget", async () => {
  const stream = new CapturedStream(false);
  const renderer = new ExecutionProgressRenderer({ stream, context: { columns: 120, color: false } });

  await renderer.consume(phase("started", { phase: "declaration", index: 1, total: 1 }));
  await renderer.consume(output("🙂".repeat(700)));
  await renderer.consume(outputFor("stderr", "between runs"));
  await renderer.consume(output("界".repeat(700)));
  const afterTruncation = stream.text;
  await renderer.consume(output("z"));
  await renderer.consume(output("ignored after truncation"));

  const payload = stream.text.match(/[🙂界]+/gu)?.join("") ?? "";
  assert.equal(Buffer.byteLength(payload), 4_096);
  assert.equal(payload, "🙂".repeat(700) + "界".repeat(432));
  assert.equal((stream.text.match(/^stdout$/gmu) ?? []).length, 2);
  assert.equal((stream.text.match(/^stderr$/gmu) ?? []).length, 1);
  assert.equal((stream.text.match(/^  \[live output truncated\]$/gmu) ?? []).length, 1);
  assert.equal(stream.text, afterTruncation);
});

test("logical live output is independent of mid-line and mid-newline chunk boundaries", async () => {
  const whole = "alpha line\nbeta line\ngamma line";
  const singleChunk = await renderDeclarationOutput([whole]);
  const splitChunks = await renderDeclarationOutput(["alpha l", "ine\nbe", "ta line\n", "gamma line"]);

  assert.equal(splitChunks, singleChunk);
});

test("live output emits complete lines before phase finish and retains a split line", async () => {
  const stream = new CapturedStream(false);
  const renderer = new ExecutionProgressRenderer({ stream, context: { columns: 80, color: false } });

  await renderer.consume(phase("started", { phase: "declaration", index: 1, total: 1 }));
  await renderer.consume(output("complete line\npartial"));

  assert.match(stream.text, /stdout\n  complete line\n/u);
  assert.doesNotMatch(stream.text, /partial/u);

  await renderer.consume(output(" line\n"));

  assert.match(stream.text, /    partial line\n/u);
  await renderer.consume(phase("finished", { phase: "declaration", index: 1, total: 1, outcome: "exit 0" }));
});
