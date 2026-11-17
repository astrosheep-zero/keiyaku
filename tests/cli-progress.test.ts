import assert from "node:assert/strict";
import { Writable } from "node:stream";
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
import { ExecutionProgressRenderer, executionProgressLines } from "../src/cli/render/execution-progress.js";
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

const claimedFact: JournalEntry = {
  v: 1,
  kind: "claimed",
  contract: contractId("kei/progress"),
  entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
  at: "2026-01-01T00:00:01.000Z",
  data: { delivery: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX") },
};

function admittedEvent(fact: JournalEntry): ExecutionObservation {
  return { kind: "admitted", contractId: fact.contract, fact };
}

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
): ExecutionObservation {
  return {
    kind: "verification",
    contractId: "kei/progress" as never,
    snapshot: "snapshot" as never,
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
  } as ExecutionObservation;
}

function output(text: string): ExecutionObservation {
  return outputFor("stdout", text);
}

function outputFor(stream: "stdout" | "stderr", text: string): ExecutionObservation {
  return {
    kind: "verification",
    contractId: "kei/progress" as never,
    snapshot: "snapshot" as never,
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
  } as ExecutionObservation;
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
    context: { columns: 160, color: false },
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

  assert.match(stream.text, /\r\x1b\[2Kverify  ● setup · check 1\/1 · npm ci · 0s/u);
  assert.match(stream.text, /\r\x1b\[2Kverify  ● setup · check 1\/1 · npm ci · 42s/u);
  assert.match(stream.text, /stdout\n  hello\n\r\x1b\[2Kverify/u);
  assert.match(stream.text, /verify  ✓ 1\/1 checks · 42s\n$/u);
});

test("admitted and stage progress never render outside a live frame", () => {
  const admitted = admittedEvent(bindFact);
  assert.deepEqual(executionProgressLines(admitted, { columns: 80, color: false }), []);
  for (const stage of ["placement", "continuation", "reconciliation"] as const) {
    for (const state of ["started", "finished"] as const) {
      const event = { kind: "stage", contractId: "kei/progress", stage, state } as ExecutionObservation;
      assert.deepEqual(executionProgressLines(event, { columns: 80, color: false }), []);
    }
  }
});

test("stage and admitted events never render on a TTY either", async () => {
  const stream = new CapturedStream(true);
  const renderer = new ExecutionProgressRenderer({ stream, context: { columns: 80, color: false } });
  await renderer.consume(admittedEvent(claimedFact));
  await renderer.consume({
    kind: "stage",
    contractId: "kei/progress",
    stage: "placement",
    state: "started",
  } as ExecutionObservation);
  await renderer.consume({
    kind: "stage",
    contractId: "kei/progress",
    stage: "placement",
    state: "finished",
  } as ExecutionObservation);
  renderer.finish();
  assert.equal(stream.text, "");
});

test("non-TTY progress does not repeat a phase coordinate and never prints a phase start", async () => {
  const stream = new CapturedStream(false);
  const renderer = new ExecutionProgressRenderer({ stream, context: { columns: 80, color: false } });
  await renderer.consume(phase("started", { phase: "declaration", index: 1, total: 1 }));
  await renderer.consume(phase("finished", { phase: "declaration", index: 1, total: 1, outcome: "exit 0" }));
  assert.equal(stream.text, "✓ declaration 1/1\n");
  assert.doesNotMatch(stream.text, /●/u);
});

test("non-TTY progress emits sparse boundaries, bounded output, and no key-value vocabulary", async () => {
  const stream = new CapturedStream(false);
  async function* events(): AsyncGenerator<ExecutionObservation> {
    yield phase("started", { phase: "setup", name: "npm ci" });
    yield output("x".repeat(5_000));
    yield phase("finished", { phase: "setup", name: "npm ci", outcome: "ok", elapsedMs: 42_000 });
  }

  const progress = await writeExecutionProgress(stream);
  for await (const event of events()) progress.observe(event);
  await progress.finish();

  assert.match(stream.text, /stdout\n  x/u);
  assert.match(stream.text, /\[live output truncated\]/u);
  assert.match(stream.text, /✓ setup · check 1\/1 · npm ci · 42s\n/u);
  assert.doesNotMatch(stream.text, /●/u);
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
      requirement: "check-one",
      snapshot: snapshotId("snapshot"),
      index: 1,
      total: 1,
      stream: "stderr",
      text: "stderr one",
    },
  } as ExecutionObservation);
  await renderer.consume(output("stdout three"));
  await renderer.consume(phase("finished", { phase: "setup", name: "npm ci", outcome: "ok" }));
  await renderer.consume(phase("started", { phase: "declaration", index: 1, total: 1 }));
  await renderer.consume(output("stdout next"));
  await renderer.consume(phase("finished", { phase: "declaration", index: 1, total: 1, outcome: "exit 0" }));

  assert.equal((stream.text.match(/^stdout$/gmu) ?? []).length, 3);
  assert.equal((stream.text.match(/^stderr$/gmu) ?? []).length, 1);
  assert.match(stream.text, /stdout\n  stdout onestdout two\nstderr\n  stderr one\n/u);
  assert.match(stream.text, /stderr\n  stderr one\nstdout\n  stdout three\n/u);
  assert.match(stream.text, /stdout\n  stdout next\n✓ declaration 1\/1\n/u);
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
    wake: { kind: "pursuing" },
  };
  const input = { akuma: id, prompt: "question", schema: {} };
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
    const reason = withTellFailureReceipt(new Error(mode === "cancel" ? "caller canceled" : "read failed"), {
      kind: "admitted",
      akumaId: id,
      tellId: "tell/current",
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
          work: projectCurrentWork([turnStarted(), startedTool(3, "bash", { kind: "run", command: "first work" })]),
        });
        observe?.({ kind: "live", observation: { status, rows: [] } });
        observe?.({
          kind: "live",
          observation: {
            status: { ...status, life: "asleep", work: projectCurrentWork([]) },
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
        Object.assign(process.stderr, { isTTY: mode !== "non-TTY", columns: 200 });
        const runtime = {
          environment: {},
          facet: Keiyaku.for({ cwd: process.cwd(), environment: {} }),
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
            `✓ answered ${id}\n  input tell/current\n  ! tell delivery failed\n    historical wake refused\n`,
          ),
        );
      }
      if (mode === "non-TTY" || mode === "json") {
        assert.equal(scheduled, 0);
        assert.doesNotMatch(captured.stderr, /observing|first work|last observed|\x1b/u);
      } else {
        const frames = captured.stderr.split("\r\x1b[2K").filter((line) => line.includes("observing"));
        assert.equal(frames[0], `${id} · observing 0s`, "admission has no invented life or summary");
        assert.match(frames[1]!, /last observed running · run \$ first work · observing/u);
        assert.equal(frames[2], `${id} · last observed asleep · observing 0s`, "the next callback clears old work");
        assert.equal(frames[3], `${id} · last observed asleep · observing 42s`, "the clock measures this observation");
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
