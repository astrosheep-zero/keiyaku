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
  return {
    kind: "verification",
    contractId: "kei/progress" as never,
    snapshot: "snapshot" as never,
    observation: { kind: "output", phase: "declaration", cwd: "/scratch", index: 1, total: 1, stream: "stdout", text },
  } as ExecutionEvent;
}

test("TTY progress refreshes one ticking line, returns after output, and persists the verification summary", () => {
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

  renderer.consume(phase("started", { phase: "setup", name: "npm ci" }));
  now = 42_000;
  tick?.();
  renderer.consume(output("hello\n"));
  renderer.consume(phase("started", { phase: "declaration", index: 1, total: 1 }));
  renderer.consume(
    phase("finished", { phase: "declaration", index: 1, total: 1, outcome: "exit 0", elapsedMs: 2_000 }),
  );
  renderer.finish();

  assert.match(stream.text, /\r\x1b\[2Kverify  ● setup · npm ci · 0s/u);
  assert.match(stream.text, /\r\x1b\[2Kverify  ● setup · npm ci · 42s/u);
  assert.match(stream.text, /stdout\n  hello \n\r\x1b\[2Kverify/u);
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
