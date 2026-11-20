import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { Keiyaku, type ExecutionObservation } from "../src/index.js";
import { StatusLine } from "../src/cli/render/status-line.js";
import { runAsk } from "../src/cli/commands/akuma.js";
import { cliExitCode } from "../src/cli/streams.js";
import { captureOutput } from "./support/cli-fixtures.js";
import { parseAkumaId } from "../src/akuma/identity.js";
import { liveStatusObservationSchema } from "../src/akuma/akuma-selection-execution.js";
import type { TellResult } from "../src/akuma/body.js";
import { startedTool, turnStarted, AKUMA_ACTIVITY_AT } from "./support/kanshi-activity.js";
import { projectCurrentWork } from "../src/akuma/status-projection.js";
import { withTellFailureReceipt } from "../src/akuma/akuma-errors.js";
import type { VerbInput, VerbName, VerbRunFor } from "../src/library/keiyaku-verbs.js";
import { renderVerb } from "../src/cli/render/verbs.js";
import { contractId, documentKey, entryUlid, snapshotId, type JournalEntry } from "../src/core/facts/types.js";
import { createExecutionProgressRenderer } from "../src/cli/render/execution-progress.js";
import { writeExecutionProgress } from "../src/cli/runtime.js";

const bindFact: JournalEntry = {
  v: 1,
  kind: "bind",
  contract: contractId("kei/progress"),
  entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
  at: "2026-01-01T00:00:00.000Z",
  data: {
    coordinates: { start: snapshotId("start"), workspace: "worktree" },
    terms: {
      document: { bytes: "# Progress\n", key: documentKey("progress") },
      segments: [],
      gates: [],
      requirements: {},
      after: [],
    },
  },
};

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

function writtenFrames(text: string): string[] {
  return Array.from(text.matchAll(/\r\x1b\[2K((?:\x1b\[\d+G[ -~])+)/gu), ([, frame]) =>
    Array.from(frame!.matchAll(/\x1b\[\d+G([ -~])/gu), ([, cell]) => cell).reverse().join(""),
  );
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
): ExecutionObservation {
  return {
    kind: "verification",
    contractId: contractId("kei/progress"),
    snapshot: snapshotId("snapshot"),
    observation: {
      kind: "phase",
      cwd: "/scratch",
      state,
      requirement: "check-one",
      snapshot: snapshotId("snapshot"),
      index: 1,
      total: 1,
      ...values,
    },
  };
}

function output(text: string, stream: "stdout" | "stderr" = "stdout"): ExecutionObservation {
  return {
    kind: "verification",
    contractId: contractId("kei/progress"),
    snapshot: snapshotId("snapshot"),
    observation: {
      kind: "output",
      phase: "declaration",
      cwd: "/scratch",
      index: 1,
      total: 1,
      requirement: "check-one",
      snapshot: snapshotId("snapshot"),
      stream,
      text,
    },
  };
}

for (const isTTY of [true, false]) {
  test(`phase output buffers complete blocks in stdout/stderr order (TTY ${isTTY})`, async () => {
    const stream = new CapturedStream(isTTY);
    const renderer = createExecutionProgressRenderer({ stream });
    renderer.observe(phase("started", { phase: "declaration" }));
    renderer.observe(output("error", "stderr"));
    renderer.observe(output("complete line\npartial"));
    await setImmediate();
    assert.doesNotMatch(stream.text, /stdout|stderr|complete line|partial|error/u);
    renderer.observe(output(" line\n"));
    renderer.observe(output(" tail", "stderr"));
    renderer.observe(phase("finished", { phase: "declaration", outcome: "exit 0", elapsedMs: 2_000 }));
    await renderer.finish();
    assert.match(stream.text, /stdout\n  complete line\n  partial line\n\nstderr\n  error tail\n✓ declaration 1\/1 · 2s\n$/u);
  });

  test(`admitted and stage observations produce no progress (TTY ${isTTY})`, async () => {
    const stream = new CapturedStream(isTTY);
    const renderer = createExecutionProgressRenderer({ stream });
    renderer.observe({ kind: "admitted", contractId: bindFact.contract, fact: bindFact });
    for (const stage of ["placement", "continuation", "reconciliation"] as const) {
      for (const state of ["started", "finished"] as const) {
        renderer.observe({ kind: "stage", contractId: bindFact.contract, stage, state });
      }
    }
    await renderer.finish();
    assert.equal(stream.text, "");
  });
}

test("TTY ticks the observed phase, resets its clock and erases without a summary", async () => {
  const stream = new CapturedStream(true);
  let now = 0;
  let tick: (() => void) | undefined;
  let cancelled = 0;
  const renderer = createExecutionProgressRenderer({
    stream,
    now: () => now,
    schedule: (next) => {
      tick = next;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    cancel: () => {
      cancelled++;
    },
  });
  renderer.observe(phase("started", { phase: "setup", name: "npm ci" }));
  await setImmediate();
  now = 42_000;
  tick?.();
  renderer.observe(output("hello\n"));
  renderer.observe(phase("started", { phase: "declaration" }));
  await setImmediate();
  assert.deepEqual(writtenFrames(stream.text), ["verify 0s setup", "verify 42s setup", "verify 0s declaration"]);
  assert.match(stream.text, /stdout\n  hello\n\n/u);
  renderer.observe(phase("finished", { phase: "declaration", outcome: "exit 0", elapsedMs: 2_000 }));
  await renderer.finish();
  const closed = stream.text;
  tick?.();
  await renderer.finish();
  assert.equal(stream.text, closed);
  assert.equal(cancelled, 2);
  assert.match(stream.text, /✓ declaration 1\/1 · 2s\n$/u);
});

test("cumulative UTF-8 suffixes retain late failures, count omissions and reset each phase", async () => {
  const stream = new CapturedStream(false);
  const renderer = createExecutionProgressRenderer({ stream });
  renderer.observe(phase("started", { phase: "declaration" }));
  renderer.observe(output("🙂".repeat(700)));
  renderer.observe(output("界".repeat(700)));
  renderer.observe(output("FAIL"));
  renderer.observe(output("e".repeat(4_097), "stderr"));
  renderer.observe(phase("finished", { phase: "declaration", outcome: "exit 1" }));
  renderer.observe(phase("started", { phase: "cleanup", name: "tidy" }));
  renderer.observe(output("next phase"));
  renderer.observe(output("s".repeat(4_096), "stderr"));
  renderer.observe(phase("finished", { phase: "cleanup", name: "tidy", outcome: "ok" }));
  await renderer.finish();
  const payload = stream.text.match(/[🙂界]+/gu)?.join("") ?? "";
  assert.equal(Buffer.byteLength(payload) + Buffer.byteLength("FAIL"), 4_096);
  assert.equal(payload, "🙂".repeat(498) + "界".repeat(700));
  const stdout = stream.text.split("stdout\n")[1]?.split("stderr\n")[0] ?? "";
  assert.equal(stdout.replace(/\s/gu, "").endsWith("FAIL"), true);
  assert.match(stdout, /^  … 808 bytes omitted\n/u);
  const stderr = stream.text.split("stderr\n")[1]?.split("× declaration")[0] ?? "";
  assert.match(stderr, /^  … 1 byte omitted\n/u);
  assert.equal(stderr.split("byte omitted\n")[1]?.replace(/\s/gu, ""), "e".repeat(4_096));
  assert.equal((stream.text.match(/… \d+ bytes? omitted/gu) ?? []).length, 2);
  assert.doesNotMatch(stream.text, /�/u);
  assert.match(stream.text, /stdout\n  next phase\nstderr\n/u);
  const cleanupOutput = stream.text.split("stdout\n  next phase\nstderr\n")[1]?.split("✓ cleanup")[0] ?? "";
  assert.equal(cleanupOutput.replace(/\s/gu, ""), "s".repeat(4_096));
});

test("suffix eviction removes whole code points and keeps subsequent output", async () => {
  const stream = new CapturedStream(false);
  const renderer = createExecutionProgressRenderer({ stream });
  renderer.observe(output("界".repeat(1_366)));
  renderer.observe(output("X"));
  await renderer.finish();
  assert.match(stream.text, /^stdout\n  … 3 bytes omitted\n/u);
  const payload = stream.text.split("bytes omitted\n")[1]?.replace(/\s/gu, "") ?? "";
  assert.equal(payload, "界".repeat(1_365) + "X");
  assert.equal(Buffer.byteLength(payload), 4_096);
});

test("empty observed streams differ from absent streams and unfinished phases flush once", async () => {
  const stream = new CapturedStream(false);
  const renderer = createExecutionProgressRenderer({ stream });
  renderer.observe(phase("started", { phase: "setup", name: "install" }));
  renderer.observe(output(""));
  await setImmediate();
  assert.equal(stream.text, "");
  renderer.observe(phase("started", { phase: "declaration" }));
  renderer.observe(output("unfinished", "stderr"));
  await renderer.finish();
  await renderer.finish();
  assert.equal(stream.text, "stdout\n\nstderr\n  unfinished\n");
});

test("chunk boundaries do not change rendered blocks", async () => {
  const results: string[] = [];
  for (const chunks of [["alpha line\nbeta line\ngamma line"], ["alpha l", "ine\nbe", "ta line\n", "gamma line"]]) {
    const stream = new CapturedStream(false);
    const renderer = createExecutionProgressRenderer({ stream });
    renderer.observe(phase("started", { phase: "declaration" }));
    for (const chunk of chunks) renderer.observe(output(chunk));
    await renderer.finish();
    results.push(stream.text);
  }
  assert.equal(results[0], results[1]);
});

test("runtime progress awaits destination backpressure before completing", async () => {
  let release: (() => void) | undefined;
  const chunks: string[] = [];
  const stream = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      release = callback;
    },
  });
  const progress = await writeExecutionProgress(stream);
  progress.observe(output("held"));
  let finished = false;
  const completion = progress.finish().then(() => {
    finished = true;
  });
  await setImmediate();
  assert.equal(finished, false);
  assert.deepEqual(chunks, ["stdout\n  held\n"]);
  release?.();
  await completion;
  assert.equal(stream.listenerCount("error"), 0);
  assert.equal(stream.listenerCount("close"), 0);
});

for (const failure of ["error", "close", "write"] as const) {
  test(`destination ${failure} failure releases the clock, queue and listeners`, async () => {
    const stream = new CapturedStream(true);
    let tick: (() => void) | undefined;
    let cancelled = 0;
    const renderer = createExecutionProgressRenderer({
      stream,
      schedule: (next) => {
        tick = next;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      cancel: () => {
        cancelled++;
      },
    });
    renderer.observe(phase("started", { phase: "declaration" }));
    await setImmediate();
    if (failure === "write") {
      stream._write = (_chunk, _encoding, callback) => callback(new Error("destination failed"));
      renderer.observe(output("failed block"));
    } else if (failure === "error") {
      stream.emit("error", new Error("destination failed"));
    } else {
      stream.emit("close");
    }
    await assert.rejects(renderer.finish(), failure === "close" ? /prematurely closed/u : /destination failed/u);
    const closed = stream.text;
    tick?.();
    assert.equal(stream.text, closed);
    assert.equal(cancelled, 1);
    assert.equal(stream.listenerCount("error"), 0);
    assert.equal(stream.listenerCount("close"), 0);
  });
}

test("StatusLine finish is erase-only and idempotent, retaining explicit final lines", () => {
  const stream = new CapturedStream(true);
  let cancelled = 0;
  const status = new StatusLine(stream, {
    schedule: () => 1 as unknown as ReturnType<typeof setInterval>,
    cancel: () => {
      cancelled++;
    },
  });
  status.show(() => "observed");
  status.finish();
  const erased = stream.text;
  status.finish("duplicate");
  assert.equal(stream.text, erased);
  assert.equal(cancelled, 1);
  const next = new StatusLine(stream, {
    schedule: () => 1 as unknown as ReturnType<typeof setInterval>,
    cancel: () => undefined,
  });
  next.show(() => "next");
  next.finish("explicit final");
  assert.match(stream.text, /\r\x1b\[2Kexplicit final\n$/u);
});

test("StatusLine retires its timer and formatter even if erase throws", () => {
  const stream = new CapturedStream(true);
  let tick: (() => void) | undefined;
  let cancelled = false;
  const status = new StatusLine(stream, {
    schedule: (next) => {
      tick = next;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    cancel: () => {
      cancelled = true;
    },
  });
  status.show(() => "observed");
  stream.write = () => {
    throw new Error("erase failed");
  };
  assert.throws(() => status.finish(), /erase failed/u);
  assert.equal(cancelled, true);
  assert.doesNotThrow(() => tick?.());
  assert.doesNotThrow(() => status.finish());
});

test("StatusLine erases once, retires its timer even on write failure, and cannot restart", () => {
  for (const throws of [false, true]) {
    const stream = new CapturedStream(true);
    let tick: (() => void) | undefined;
    let canceled = 0;
    let formats = 0;
    const status = new StatusLine(stream, {
      schedule: (callback) => {
        tick = callback;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      cancel: () => {
        canceled += 1;
      },
    });
    status.show(() => {
      formats += 1;
      return "current";
    });
    if (throws)
      stream.write = () => {
        throw new Error("terminal departed");
      };
    if (throws) assert.throws(() => status.finish(), /terminal departed/u);
    else status.finish();
    status.finish("must not print");
    status.show(() => {
      formats += 1;
      return "must not restart";
    });
    tick?.();
    assert.equal(canceled, 1);
    assert.equal(formats, 1);
    assert.doesNotMatch(stream.text, /must not/u);
  }
});

test("StatusLine finishing inside formatting cannot leave a timer running", () => {
  const stream = new CapturedStream(true);
  let scheduled = 0;
  const status = new StatusLine(stream, {
    schedule: () => {
      scheduled += 1;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
  });
  status.show(() => {
    status.finish();
    return "finished";
  });
  assert.equal(scheduled, 0);
  assert.doesNotMatch(stream.text, /finished/u);
});

test("Ask replaces one TTY observation and closes on return, failure and cancellation", async (t) => {
  const id = parseAkumaId("aku/worker/abcd1234").id;
  const tell: TellResult = {
    admission: { tellId: "tell/current" },
    row: { sequence: 2, at: AKUMA_ACTIVITY_AT, text: "question" },
    wake: { kind: "pending" },
  };
  const input = { akuma: "@delegate", prompt: "question", schema: {} };
  const command = `first work ${"a".repeat(170)} path-tail`;
  for (const mode of ["answered", "error", "cancel", "non-TTY", "json"] as const) {
    const controller = new AbortController();
    let tick: (() => void) | undefined;
    let scheduled = 0;
    let canceled = 0;
    const schedule = t.mock.method(globalThis, "setInterval", (callback: () => void) => {
      scheduled += 1;
      tick = callback;
      return 1 as unknown as ReturnType<typeof setInterval>;
    });
    const cancel = t.mock.method(globalThis, "clearInterval", () => {
      canceled += 1;
    });
    const result = {
      kind: "answered" as const,
      akumaId: id,
      tellId: "tell/current",
      answer: { ok: true },
      wake: { kind: "failed" as const, diagnostic: "historical wake refused" },
    };
    const diagnostic = mode === "cancel" ? "caller canceled" : "read failed";
    const reason = withTellFailureReceipt(new Error(diagnostic), {
      result: "failed",
      akumaId: id,
      tellId: "tell/current",
      failures: [{ stage: "observation", diagnostic }],
    });
    let now = 0;
    const clock = t.mock.method(performance, "now", () => now);
    const run = t.mock.method(
      Keiyaku.prototype,
      "run",
      async (_name: VerbName, _input: VerbInput<VerbName>, controls?: VerbRunFor<"ask">) => {
        const observe = controls?.observe;
        if (mode === "json") assert.equal(observe, undefined);
        observe?.({ kind: "admitted", tell, id });
        if (mode === "answered") assert.equal(process.stderr.isTTY, true);
        const status = liveStatusObservationSchema.unwrap().shape.status.parse({
          birth: { origin: { kind: "direct" }, caller: { kind: "unknown" } },
          id,
          life: "running",
          work: projectCurrentWork([turnStarted(), startedTool(3, "bash", { kind: "run", command })]),
        });
        observe?.({ kind: "live", observation: { status, rows: [] } });
        observe?.({
          kind: "live",
          observation: {
            status: { ...status, life: "asleep", work: { kind: "idle" } },
            rows: [],
          },
        });
        now = 42_000;
        tick?.();
        if (mode === "error" || mode === "cancel") {
          if (mode === "cancel") controller.abort(reason);
          throw reason;
        }
        return result;
      },
    );
    try {
      const captured = await captureOutput(async () => {
        Object.assign(process.stderr, { isTTY: mode !== "non-TTY" });
        const coordinates = { cwd: process.cwd() };
        const runtime = {
          environment: {},
          facet: Keiyaku.for({ ...coordinates, environment: {} }),
          recoveryCoordinates: coordinates,
          signal: controller.signal,
          readStdin: async () => "",
          draftWorld: async () => "",
          progress: async () => {
            throw new Error("unused");
          },
        };
        try {
          return cliExitCode(await runAsk({ name: "ask", input, output: mode === "json" ? "json" : "text" }, runtime));
        } catch (error) {
          assert.equal(error, reason, "the admitted native failure propagates unchanged");
          process.stderr.write(renderVerb("ask", input, { kind: "threw", error }, { columns: 200, color: false }));
          return 3;
        }
      });
      if (mode === "json") {
        assert.deepEqual(JSON.parse(captured.stdout), result);
        assert.equal(captured.stderr, "");
      } else if (mode === "error" || mode === "cancel") {
        assert.equal(captured.stdout, "");
        assert.match(captured.stderr, /tell\/current/u, "existing failure rendering retains admission evidence");
        assert.doesNotMatch(captured.stderr, /✓ answered/u);
      } else {
        assert.equal(captured.stdout, JSON.stringify(result.answer));
        assert.ok(
          captured.stderr.endsWith(
            `✓ answered ${id} (@delegate)\n  input tell/current\n  ! tell delivery failed\n    historical wake refused\n`,
          ),
        );
      }
      if (mode === "non-TTY" || mode === "json") {
        assert.equal(scheduled, 0);
        assert.doesNotMatch(captured.stderr, /first work|\x1b/u);
      } else {
        const frames = writtenFrames(captured.stderr);
        assert.equal(frames.length, 4);
        assert.ok(frames.every((frame) => frame.includes(id) && frame.includes("@delegate")));
        assert.doesNotMatch(frames[0]!, /last|first work/u, "admission is not a life or work observation");
        assert.ok(
          frames[1]?.includes(`last running | activity 3 run $ ${command}`),
          "the complete native summary and its coordinate are present once",
        );
        assert.equal(frames.filter((frame) => frame.includes("first work")).length, 1, "the next observation replaces work");
        assert.match(frames.at(-1)!, /42s last asleep/u);
        assert.equal(scheduled, 1);
        assert.equal(canceled, 1);
      }
    } finally {
      clock.mock.restore();
      run.mock.restore();
      schedule.mock.restore();
      cancel.mock.restore();
    }
  }
});
