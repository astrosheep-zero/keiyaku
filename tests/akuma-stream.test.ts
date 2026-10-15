import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { renameSync, unlinkSync } from "node:fs";
import { Akuma, type AkumaStreamSnapshot } from "../src/index.js";
import { AkumaNotBornError } from "../src/akuma/akuma-errors.js";
import { AkumaOwner } from "../src/akuma/akuma-owner.js";
import {
  appendActivity,
  beginTurn,
  createTimelineReader,
  endTurn,
  HeartAbsentError,
  initializeHeart,
  recordTellDeliveries,
} from "../src/akuma/heart/index.js";
import { insertActivityFact } from "../src/akuma/heart/rows.js";
import { createHeartReader } from "../src/akuma/heart/storage.js";
import { insertTellFact } from "../src/akuma/heart/tells.js";
import { timelineDataVersion } from "../src/akuma/heart/timeline.js";
import { allocatedHeart, bornBody, recordTell } from "./support/akuma-fixtures.js";
import { temporaryDirectory } from "./support/process.js";
import { World } from "../src/world.js";

const AT = "2026-10-15T00:00:00.000Z";

/** A value or a named bounded failure; a stalled stream must fail the test, never hang it. */
async function settle<T>(promise: Promise<T>, what: string, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function pull(iterator: AsyncIterator<AkumaStreamSnapshot>, what: string): Promise<AkumaStreamSnapshot> {
  const result = await settle(iterator.next(), what);
  if (result.done === true) throw new Error(`the stream ended while waiting for ${what}`);
  return result.value;
}

/** Counts released connections from here on; the stream's own reader is the only one open. */
function countCloses(context: TestContext): () => number {
  const original = DatabaseSync.prototype.close;
  let closes = 0;
  context.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    closes += 1;
    return original.call(this);
  });
  return () => closes;
}

async function bornStreamFixture(root: string, suffix: string) {
  const born = await bornBody(root, suffix, AT);
  const turn = await beginTurn(born.allocated.paths, { bodySequence: born.body.sequence, startedAt: AT });
  return { ...born, turn, world: await World.at(root) };
}

/** One real second process commits a Tell into the same Heart the parent is observing. */
async function recordTellFromAnotherProcess(world: string, id: string): Promise<string> {
  const source = [
    "const { pathsForAkuId } = await import(process.env.KEIYAKU_IDENTITY_MODULE);",
    "const { recordTell } = await import(process.env.KEIYAKU_HEART_MODULE);",
    "const admitted = await recordTell(pathsForAkuId(process.env.KEIYAKU_WORLD, process.env.KEIYAKU_ID), {",
    "  kind: 'tell', id: 'tell-from-another-process', body: 'written elsewhere', recordedAt: process.env.KEIYAKU_AT,",
    "});",
    "if (admitted.kind !== 'recorded') { process.stderr.write('the Akuma is not born\\n'); process.exit(3); }",
    "process.stdout.write('recorded\\n');",
  ].join("\n");
  const child = spawn(
    process.execPath,
    [
      ...(import.meta.url.endsWith(".js") ? [] : ["--import", import.meta.resolve("tsx")]),
      "--input-type=module",
      "-e",
      source,
    ],
    {
      env: {
        ...process.env,
        KEIYAKU_IDENTITY_MODULE: new URL("../src/akuma/identity.js", import.meta.url).href,
        KEIYAKU_HEART_MODULE: new URL("../src/akuma/heart/index.js", import.meta.url).href,
        KEIYAKU_WORLD: world,
        KEIYAKU_ID: id,
        KEIYAKU_AT: AT,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (child.stdout === null || child.stderr === null) throw new Error("the writing child has no output streams");
  let output = "";
  let diagnostic = "";
  child.stdout.on("data", (bytes: Buffer) => {
    output += bytes.toString("utf8");
  });
  child.stderr.on("data", (bytes: Buffer) => {
    diagnostic += bytes.toString("utf8");
  });
  const status = await settle(
    new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    }),
    "the writing child",
  );
  if (status !== 0) throw new Error(`the writing child exited ${String(status)}: ${diagnostic}`);
  return output;
}

test("root-imported stream emits the initial window and each later semantic change", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-stream-changes-");
  const fixture = await bornStreamFixture(root, "c0000011");
  const controller = new AbortController();
  const akuma = Akuma.select(fixture.world, fixture.allocated.id);
  const iterator = akuma.stream({ signal: controller.signal })[Symbol.asyncIterator]();
  try {
    const initial = await pull(iterator, "the initial window");
    assert.deepEqual(
      initial.rows.map((row) => row.kind),
      ["turn"],
    );
    assert.equal(initial.hasEarlier, false);
    assert.equal(initial.historyLost, false);

    const recorded = await recordTell(fixture.allocated.paths, {
      id: "tell-stream",
      body: "from another connection",
      recordedAt: AT,
    });
    assert.equal(recorded.kind, "recorded");
    const withTell = await pull(iterator, "the recorded Tell");
    assert.deepEqual(
      withTell.rows.map((row) => row.kind),
      ["turn", "tell"],
    );
    const pending = withTell.rows.at(-1);
    assert.ok(pending?.kind === "tell");
    assert.equal(pending.state, "pending");

    // The same durable row changes in place: no new row, no new sequence.
    await recordTellDeliveries(fixture.allocated.paths, [
      {
        tellId: "tell-stream",
        turnSequence: fixture.turn.sequence,
        fence: "stream-fence",
        route: "launch",
        deliveredAt: AT,
      },
    ]);
    const delivered = await pull(iterator, "the delivered Tell");
    const told = delivered.rows.find((row) => row.kind === "tell");
    assert.ok(told?.kind === "tell");
    assert.equal(told.state, "told");
    assert.equal(told.sequence, pending.sequence);
    assert.equal(delivered.rows.length, withTell.rows.length);
  } finally {
    controller.abort(new Error("test finished"));
    fixture.holder.release();
  }
});

test("stream observes a commit made by another process", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-stream-process-");
  const fixture = await bornStreamFixture(root, "c0000012");
  const controller = new AbortController();
  const akuma = Akuma.select(fixture.world, fixture.allocated.id);
  const iterator = akuma.stream({ signal: controller.signal })[Symbol.asyncIterator]();
  try {
    const initial = await pull(iterator, "the initial window");
    assert.deepEqual(
      initial.rows.map((row) => row.kind),
      ["turn"],
    );
    assert.match(await recordTellFromAnotherProcess(root, fixture.allocated.id), /recorded/u);
    const observed = await pull(iterator, "the other process's Tell");
    const tell = observed.rows.find((row) => row.kind === "tell");
    assert.ok(tell?.kind === "tell");
    assert.equal(tell.tellId, "tell-from-another-process");
    assert.equal(tell.state, "pending");
  } finally {
    controller.abort(new Error("test finished"));
    fixture.holder.release();
  }
});

test("stream windows are complete, bounded, and keep retention metadata honest", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-stream-window-");
  const fixture = await bornStreamFixture(root, "c0000013");
  const controller = new AbortController();
  const akuma = Akuma.select(fixture.world, fixture.allocated.id);
  const iterator = akuma.stream({ signal: controller.signal })[Symbol.asyncIterator]();
  try {
    const database = new DatabaseSync(fixture.allocated.paths.heart);
    try {
      database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
      for (let index = 0; index < 510; index += 1) {
        insertActivityFact(database, {
          turnSequence: fixture.turn.sequence,
          event: { type: "assistant", text: `row ${index}` },
          at: AT,
        });
      }
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    const window = await pull(iterator, "the bounded window");
    assert.equal(window.rows.length, 500);
    assert.equal(window.omitted, 11);
    assert.equal(window.hasEarlier, true);
    assert.equal(window.hasLater, false);
    assert.equal(window.historyLost, false);
    assert.equal(window.lowestRetained, 1);
    assert.equal(window.highest, 511);
    const said = window.rows.at(-1);
    assert.ok(said?.kind === "said");
    assert.equal(said.text, "row 509");
  } finally {
    controller.abort(new Error("test finished"));
    fixture.holder.release();
  }
});

test("stream continues across idle into new work and announces outcomes once", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-stream-idle-");
  const fixture = await bornStreamFixture(root, "c0000014");
  const announced: (readonly [string, readonly string[]])[] = [];
  const owner = new AkumaOwner(fixture.allocated.id, fixture.world, async (id, historyIds) => {
    announced.push([id, [...historyIds]]);
  });
  const controller = new AbortController();
  const iterator = owner.stream({ signal: controller.signal })[Symbol.asyncIterator]();
  try {
    await pull(iterator, "the initial window");
    assert.deepEqual(announced, []);
    await endTurn(fixture.allocated.paths, {
      turnSequence: fixture.turn.sequence,
      outcome: { kind: "failed", diagnostic: "stopped by the driver" },
      completedAt: AT,
    });
    const closed = await pull(iterator, "the closed Turn");
    assert.deepEqual(
      closed.rows.map((row) => row.kind),
      ["turn", "outcome"],
    );
    assert.deepEqual(announced, [[fixture.allocated.id, [`turn/${fixture.turn.sequence}`]]]);

    const next = await beginTurn(fixture.allocated.paths, {
      bodySequence: fixture.body.sequence,
      startedAt: AT,
    });
    const continued = await pull(iterator, "work after idle");
    assert.deepEqual(
      continued.rows.map((row) => [row.kind, row.sequence]),
      [
        ["turn", fixture.turn.sequence],
        ["outcome", closed.rows.at(-1)!.sequence],
        ["turn", next.sequence],
      ],
    );
    assert.equal(announced.length, 1, "an already observed outcome is never announced twice");
  } finally {
    controller.abort(new Error("test finished"));
    fixture.holder.release();
  }
});

test("a suspended stream observes nothing until its consumer pulls again", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-stream-slow-");
  const fixture = await bornStreamFixture(root, "c0000015");
  const owner = new AkumaOwner(fixture.allocated.id, fixture.world);
  const controller = new AbortController();
  const iterator = owner.stream({ signal: controller.signal })[Symbol.asyncIterator]();
  try {
    await pull(iterator, "the initial window");
    const original = DatabaseSync.prototype.prepare;
    let statements = 0;
    context.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      statements += 1;
      return original.call(this, sql);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(statements, 0, "a suspended stream reads nothing and queues nothing");
    await recordTell(fixture.allocated.paths, { id: "tell-after-idle", body: "later", recordedAt: AT });
    const observed = await pull(iterator, "the change made while suspended");
    const tell = observed.rows.find((row) => row.kind === "tell");
    assert.ok(tell?.kind === "tell");
    assert.equal(tell.tellId, "tell-after-idle");
  } finally {
    controller.abort(new Error("test finished"));
    fixture.holder.release();
  }
});

test("abort while suspended after an emission releases the retained reader", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-stream-yield-abort-");
  const fixture = await bornStreamFixture(root, "c0000016");
  const owner = new AkumaOwner(fixture.allocated.id, fixture.world);
  const controller = new AbortController();
  const iterator = owner.stream({ signal: controller.signal })[Symbol.asyncIterator]();
  try {
    await pull(iterator, "the initial window");
    const closes = countCloses(context);
    controller.abort(new Error("caller stopped observing"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closes(), 1, "the suspended stream released its reader without another pull");
    await assert.rejects(
      pull(iterator, "the aborted pull"),
      (error: unknown) => error instanceof Error && error.message === "caller stopped observing",
    );
  } finally {
    fixture.holder.release();
  }
});

test("abort while waiting for a change rejects the pending pull and releases", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-stream-wait-abort-");
  const fixture = await bornStreamFixture(root, "c0000017");
  const owner = new AkumaOwner(fixture.allocated.id, fixture.world);
  const controller = new AbortController();
  const iterator = owner.stream({ signal: controller.signal })[Symbol.asyncIterator]();
  try {
    await pull(iterator, "the initial window");
    const closes = countCloses(context);
    const pending = settle(iterator.next(), "the aborted change");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const reason = new Error("caller stopped while waiting");
    controller.abort(reason);
    await assert.rejects(pending, (error: unknown) => error === reason);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closes(), 1);
  } finally {
    fixture.holder.release();
  }
});

test("return settles promptly while a pull is pending in the idle polling loop", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-stream-return-pending-");
  const fixture = await bornStreamFixture(root, "c0000022");
  const owner = new AkumaOwner(fixture.allocated.id, fixture.world);
  try {
    const iterator = owner.stream()[Symbol.asyncIterator]();
    await pull(iterator, "the initial window");
    const closes = countCloses(context);
    const pending = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const returned = await settle(iterator.return!(), "the return while a pull is pending", 1_000);
    assert.equal(returned.done, true);
    assert.equal(closes(), 1, "return released the retained reader");
    const overtaken = await settle(pending, "the pull that return overtook", 1_000);
    assert.equal(overtaken.done, true);
    assert.equal(closes(), 1, "the overtaken pull did not reopen the reader");
    const ended = await settle(iterator.next(), "the pull after return");
    assert.equal(ended.done, true);
  } finally {
    fixture.holder.release();
  }
});

test("abort during an in-flight read keeps the caller's reason and releases the reader", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-stream-read-abort-");
  const fixture = await bornStreamFixture(root, "c0000023");
  const owner = new AkumaOwner(fixture.allocated.id, fixture.world);
  const controller = new AbortController();
  const iterator = owner.stream({ signal: controller.signal })[Symbol.asyncIterator]();
  try {
    await pull(iterator, "the initial window");
    const closes = countCloses(context);
    const reason = new Error("caller aborted inside the read");
    let landed = false;
    const original = DatabaseSync.prototype.prepare;
    context.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      if (!landed && sql === "PRAGMA data_version") {
        landed = true;
        controller.abort(reason);
      }
      return original.call(this, sql);
    });
    await assert.rejects(pull(iterator, "the aborted read"), (error: unknown) => error === reason);
    assert.equal(landed, true, "the abort landed while the read was executing");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closes(), 1, "the reader that the interrupted read held was released, not reopened");
    const ended = await settle(iterator.next(), "the stream after an aborted read");
    assert.equal(ended.done, true);
  } finally {
    fixture.holder.release();
  }
});

test("a release issued while the reader is opening still closes the connection it opened", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-stream-open-release-");
  const fixture = await bornStreamFixture(root, "c0000024");
  const reader = createHeartReader(fixture.allocated.paths);
  const closes = countCloses(context);
  try {
    const opening = reader.read(() => "observed");
    reader.clear();
    assert.equal(await opening, "observed");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closes(), 1, "the connection the released read opened was closed");

    const reopened = await reader.read((heart) => timelineDataVersion(heart));
    assert.ok(reopened > 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closes(), 1, "a read after release keeps its own connection until it is released");
    reader.clear();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closes(), 2);
  } finally {
    reader.clear();
    fixture.holder.release();
  }
});

test("a replaced Heart invalidates the observation's change gate", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-stream-replaced-");
  const fixture = await bornStreamFixture(root, "c0000025");
  const paths = fixture.allocated.paths;
  const reader = createTimelineReader(paths);
  try {
    assert.equal((await reader.read()).changed, true);
    assert.equal((await reader.read()).changed, false, "the retained reader skips an unchanged timeline");
    // A Heart staged elsewhere and renamed into place is a new authority with its
    // own counter, so the retired connection's identity must not survive it.
    const staged = { ...paths, heart: `${paths.heart}.replacement`, leash: `${paths.leash}.replacement` };
    await initializeHeart(staged);
    renameSync(staged.heart, paths.heart);
    assert.equal((await reader.read()).changed, true, "a new Heart file is a new authority, never a skipped one");
  } finally {
    reader.clear();
    fixture.holder.release();
  }
});

test("an explicit return releases the retained reader", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-stream-return-");
  const fixture = await bornStreamFixture(root, "c0000018");
  const owner = new AkumaOwner(fixture.allocated.id, fixture.world);
  try {
    const iterator = owner.stream()[Symbol.asyncIterator]();
    await pull(iterator, "the initial window");
    const closes = countCloses(context);
    assert.equal(typeof iterator.return, "function");
    await iterator.return!();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closes(), 1);
  } finally {
    fixture.holder.release();
  }
});

test("leaving a for-await loop releases the retained reader", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-stream-break-");
  const fixture = await bornStreamFixture(root, "c000001c");
  const owner = new AkumaOwner(fixture.allocated.id, fixture.world);
  try {
    const closes = countCloses(context);
    for await (const snapshot of owner.stream()) {
      assert.ok(snapshot.rows.length > 0);
      break;
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closes(), 1);
  } finally {
    fixture.holder.release();
  }
});

test("a hard read failure ends the stream with its error", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-stream-failure-");
  const fixture = await bornStreamFixture(root, "c0000019");
  const owner = new AkumaOwner(fixture.allocated.id, fixture.world);
  const controller = new AbortController();
  const iterator = owner.stream({ signal: controller.signal })[Symbol.asyncIterator]();
  try {
    await pull(iterator, "the initial window");
    unlinkSync(fixture.allocated.paths.heart);
    await assert.rejects(pull(iterator, "the failed read"), (error: unknown) => error instanceof HeartAbsentError);
    const ended = await settle(iterator.next(), "the ended stream");
    assert.equal(ended.done, true);
  } finally {
    controller.abort(new Error("test finished"));
    fixture.holder.release();
  }
});

test("an unborn identity fails with the existing unborn error", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-stream-unborn-");
  const allocated = await allocatedHeart(root, "claude", "c000001a");
  const akuma = Akuma.select(await World.at(root), allocated.id);
  await assert.rejects(
    pull(akuma.stream()[Symbol.asyncIterator](), "the unborn refusal"),
    (error: unknown) => error instanceof AkumaNotBornError,
  );
});

test("stream follows one mutable tool row from its start to its witnessed completion", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-stream-tool-");
  const fixture = await bornStreamFixture(root, "c0000021");
  const owner = new AkumaOwner(fixture.allocated.id, fixture.world);
  const controller = new AbortController();
  const iterator = owner.stream({ signal: controller.signal })[Symbol.asyncIterator]();
  try {
    await pull(iterator, "the initial window");
    const call = { kind: "run", command: "npm test" } as const;
    const started = await appendActivity(fixture.allocated.paths, {
      turnSequence: fixture.turn.sequence,
      event: { type: "tool", phase: "started", id: "bash-stream", name: "Bash", call },
      at: AT,
    });
    const active = await pull(iterator, "the started tool");
    const activeRow = active.rows.find((row) => row.kind === "tool");
    assert.ok(activeRow?.kind === "tool");
    assert.equal(activeRow.state, "active");
    assert.equal(activeRow.sequence, started);

    await appendActivity(fixture.allocated.paths, {
      turnSequence: fixture.turn.sequence,
      event: { type: "tool", phase: "completed", id: "bash-stream", name: "Bash", call, result: { status: "ok" } },
      at: AT,
    });
    const completed = await pull(iterator, "the completed tool");
    const completedRow = completed.rows.find((row) => row.kind === "tool");
    assert.ok(completedRow?.kind === "tool");
    assert.deepEqual(completedRow.state, { status: "ok" });
    assert.notEqual(completedRow.sequence, activeRow.sequence);
    assert.equal(
      completed.rows.some((row) => row.kind === "tool" && row.sequence === started),
      false,
      "the retained window holds the completion rather than its earlier start",
    );
  } finally {
    controller.abort(new Error("test finished"));
    fixture.holder.release();
  }
});

test("a born Akuma with no Turn still emits its initial empty window", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-stream-empty-");
  const born = await bornBody(root, "c000001f", AT);
  const owner = new AkumaOwner(born.allocated.id, await World.at(root));
  const controller = new AbortController();
  const iterator = owner.stream({ signal: controller.signal })[Symbol.asyncIterator]();
  try {
    const initial = await pull(iterator, "the empty initial window");
    assert.deepEqual(initial.rows, []);
    assert.equal(initial.omitted, 0);
    assert.equal(initial.hasEarlier, false);
    assert.equal(initial.hasLater, false);
    assert.equal(initial.historyLost, false);
    assert.equal(initial.lowestRetained, null);
    assert.equal(initial.highest, null);
  } finally {
    controller.abort(new Error("test finished"));
    born.holder.release();
  }
});

test("a commit made during an observation is never skipped by the change gate", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-stream-gate-");
  const fixture = await bornStreamFixture(root, "c000001d");
  const reader = createHeartReader(fixture.allocated.paths);
  try {
    // The sampled counter names the read snapshot, so a commit landing after the
    // sample cannot be folded into the same identity and skipped forever.
    let sampled = -1;
    await reader.read((heart) => {
      sampled = timelineDataVersion(heart);
      const writer = new DatabaseSync(fixture.allocated.paths.heart);
      try {
        writer.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
        insertTellFact(writer, { kind: "tell", id: "gate-tell", body: "during the read", recordedAt: AT });
        writer.exec("COMMIT");
      } finally {
        writer.close();
      }
      assert.equal(
        timelineDataVersion(heart),
        sampled,
        "the observed snapshot does not advance when another connection commits mid-read",
      );
    });
    const advanced = await reader.read((heart) => timelineDataVersion(heart));
    assert.ok(advanced > sampled, "the next observation reports the commit that landed during the read");
  } finally {
    reader.clear();
    fixture.holder.release();
  }
});

test("stream options admit only a caller signal", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-stream-options-");
  const allocated = await allocatedHeart(root, "claude", "c000001b");
  const akuma = Akuma.select(await World.at(root), allocated.id);
  assert.throws(() => akuma.stream(null as never), /stream options must be an object/u);
  assert.throws(() => akuma.stream({ cursor: 1 } as never), /unknown field: cursor/u);
  assert.throws(() => akuma.stream({ signal: {} } as never), /signal must be an AbortSignal/u);
});
