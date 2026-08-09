import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Akuma, AkumaNotBornError, foldActivitySnapshot } from "../src/akuma/akuma.js";
import { AkumaPersonaError, loadPersona } from "../src/akuma/persona.js";
import { driveAkumaBody, type BodyLaunch } from "../src/akuma/body.js";
import {
  appendActivity,
  HeldAkumaLeash,
  initializeHeart,
  pauseRequested,
  readHeart,
  readHistory,
  recordBody,
} from "../src/akuma/heart/index.js";
import { akumaRunRoot, allocateAkumaDirectory, pathsForAkuId } from "../src/akuma/identity.js";
import type { ProviderAdapter } from "../src/akuma/provider.js";
import { claudeProvider } from "../src/akuma/providers/claude.js";
import { settings } from "../src/settings.js";

const CLAUDE_EXECUTION = { name: "claude", kind: "claude-agent-sdk" } as const;

const provider: ProviderAdapter = {
  confinement: () => ({ kind: "unconfined" }),
  admitOptions(options) { return { kind: "admitted", options }; },
  async start() {
    return {
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: "session" as const, coordinate: { sessionId: "public-session" } };
          yield { type: "assistant" as const, text: "working" };
        },
      },
      completion: Promise.resolve({ kind: "answered", answer: "public answer", historyId: "public-history" }),
      async abort() {},
    };
  },
};

async function answeredSource(root: string, suffix: string) {
  const allocated = allocateAkumaDirectory({ worldRoot: root, persona: "claude", draw: () => suffix });
  initializeHeart(allocated.paths);
  await driveAkumaBody({
    paths: allocated.paths,
    seed: {
      id: allocated.id,
      persona: "claude",
      description: "Fork source",
      provider: CLAUDE_EXECUTION,
      options: { model: "fixture-model" },
      origin: { kind: "direct" },
      confinement: { kind: "unconfined" },
      contract: "kei/fork-purpose",
      cwd: root,
    },
    initialBody: "work",
  }, provider, {
    collar: { pid: 999_979, processGroup: 999_979, spawnedAt: `fork-${suffix}` },
    now: () => "2026-08-08T00:00:00.000Z",
    async putDownOwnTree() {},
  });
  return allocated;
}

type MutableProvider = { -readonly [Key in keyof ProviderAdapter]: ProviderAdapter[Key] };

test("activity fold pairs tools and bounds settled rows without dropping in-flight tools", () => {
  assert.deepEqual(foldActivitySnapshot([
    { sequence: 1, event: { type: "tool", phase: "started", id: "run-1", name: "Bash", call: { kind: "run", command: "npm test" } } },
    { sequence: 2, event: { type: "note", text: "checking" } },
    { sequence: 3, event: { type: "tool", phase: "completed", id: "run-1", name: "Bash", call: { kind: "run", command: "npm test" }, result: { status: "ok" } } },
    { sequence: 4, event: { type: "tool", phase: "completed", id: "orphan", name: "Read", call: { kind: "read", path: "README.md" }, result: { status: "error", message: "missing" } } },
    { sequence: 5, event: { type: "tool", phase: "started", id: "open", name: "Search", call: { kind: "search", query: "TODO" } } },
  ]), {
    rows: [
      { kind: "tool", name: "Bash", call: { kind: "run", command: "npm test" }, state: { status: "ok" } },
      { kind: "note", text: "checking" },
      { kind: "tool", name: "Read", call: { kind: "read", path: "README.md" }, state: { status: "error", message: "missing" } },
      { kind: "tool", name: "Search", call: { kind: "search", query: "TODO" }, state: "running" },
    ],
    omitted: 0,
  });

  const bounded = foldActivitySnapshot([
    { sequence: 1, event: { type: "tool", phase: "started", id: "open", name: "Bash", call: { kind: "run", command: "long" } } },
    ...Array.from({ length: 10 }, (_, index) => ({
      sequence: index + 2,
      event: { type: "note", text: `note-${index + 1}` },
    })),
  ]);
  assert.equal(bounded.omitted, 2);
  assert.deepEqual(bounded.rows, [
    { kind: "tool", name: "Bash", call: { kind: "run", command: "long" }, state: "running" },
    ...Array.from({ length: 8 }, (_, index) => ({ kind: "note" as const, text: `note-${index + 3}` })),
  ]);
});

test("wait timeout returns the same running status carrier", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-wait-timeout-"));
  try {
    const source = await answeredSource(root, "de1ad100");
    const leash = HeldAkumaLeash.try(source.paths)!;
    try {
      const handle = Akuma.at({ path: root }).of({ id: source.id });
      const expected = handle.status();
      assert.equal(expected.life, "running");
      assert.deepEqual(await handle.wait(undefined, { timeoutMs: 0 }), expected);
    } finally {
      leash.release();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wait refuses invalid public timeoutMs values", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-wait-invalid-timeout-"));
  try {
    const source = await answeredSource(root, "de1ad101");
    const handle = Akuma.at({ path: root }).of({ id: source.id });
    for (const timeoutMs of [-1, Number.POSITIVE_INFINITY, Number.NaN]) {
      await assert.rejects(
        handle.wait(undefined, { timeoutMs }),
        /Akuma wait timeoutMs must be a nonnegative finite millisecond duration/u,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fork publishes a sleeping child with lineage and its native birth session", async () => {
  const root = mkdtempSync(join(process.cwd(), ".tmp-keiyaku-akuma-fork-"));
  const mutable = claudeProvider as MutableProvider;
  const originalFork = mutable.fork;
  try {
    const source = await answeredSource(root, "f0a10001");
    const world = Akuma.at({ path: root });
    assert.equal(await world.of({ id: source.id }).kill(), "killed");
    let nativeInput: Parameters<NonNullable<ProviderAdapter["fork"]>>[0] | undefined;
    mutable.fork = async (input) => {
      nativeInput = input;
      return { session: { sessionId: "fork-child-session" } };
    };

    const receipt = await world.of({ id: source.id }).fork({ at: "public-history" });
    assert.equal(receipt.kind, "forked", JSON.stringify(receipt));
    if (receipt.kind !== "forked") return;
    assert.deepEqual(nativeInput, {
      session: { sessionId: "public-session" },
      at: "public-history",
      cwd: root,
    });
    assert.match(receipt.child, /^aku\/claude\/[0-9a-f]{8}$/u);
    const child = world.of({ id: receipt.child });
    assert.equal(child.status().life, "asleep");
    const childPaths = pathsForAkuId(root, receipt.child);
    const snapshot = readHeart(childPaths);
    assert.deepEqual(snapshot.soul?.origin, { kind: "fork", parent: source.id, at: "public-history" });
    assert.equal(snapshot.soul?.description, "Fork source");
    assert.equal(snapshot.soul?.contract, "kei/fork-purpose");
    assert.deepEqual(snapshot.latestSession, {
      sequence: 1,
      provider: "claude",
      coordinate: { sessionId: "fork-child-session" },
      cwd: root,
      options: { model: "fixture-model" },
      admittedAt: snapshot.latestSession?.admittedAt,
    });
    assert.deepEqual(readHistory(childPaths), []);
  } finally {
    mutable.fork = originalFork;
    rmSync(root, { recursive: true, force: true });
  }
});

test("fork preserves categorical, exact-history, native, local, and not-born failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-fork-results-"));
  const mutable = claudeProvider as MutableProvider;
  const originalFork = mutable.fork;
  try {
    const source = await answeredSource(root, "f0a10002");
    const handle = Akuma.at({ path: root }).of({ id: source.id });

    mutable.fork = undefined;
    assert.deepEqual(await handle.fork({ at: "missing" }), { kind: "provider-cannot-fork", provider: "claude" });

    let nativeCalls = 0;
    mutable.fork = async () => {
      nativeCalls += 1;
      throw new Error("native refused");
    };
    assert.deepEqual(await handle.fork({ at: "missing" }), { kind: "unknown-history", at: "missing" });
    assert.equal(nativeCalls, 0);
    assert.deepEqual(await handle.fork({ at: "public-history" }), { kind: "fork-failed", diagnostic: "native refused" });

    mutable.fork = async () => {
      const runRoot = akumaRunRoot(root);
      rmSync(runRoot, { recursive: true, force: true });
      writeFileSync(runRoot, "blocked");
      return { session: { sessionId: "orphan-upstream-session" } };
    };
    const partial = await handle.fork({ at: "public-history" });
    assert.equal(partial.kind, "upstream-forked");
    if (partial.kind === "upstream-forked") {
      assert.deepEqual(partial.childSession, { sessionId: "orphan-upstream-session" });
      assert.match(partial.diagnostic, /exist|directory|not a directory/i);
    }

    const unbornRoot = mkdtempSync(join(tmpdir(), "keiyaku-akuma-fork-unborn-"));
    try {
      const unborn = allocateAkumaDirectory({ worldRoot: unbornRoot, persona: "claude", draw: () => "f0a10003" });
      await assert.rejects(
        Akuma.at({ path: unbornRoot }).of({ id: unborn.id }).fork({ at: "anything" }),
        AkumaNotBornError,
      );
    } finally { rmSync(unbornRoot, { recursive: true, force: true }); }
  } finally {
    mutable.fork = originalFork;
    rmSync(root, { recursive: true, force: true });
  }
});

test("public Akuma handles separate compact list rows from full status and wait", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-public-"));
  try {
    const world = Akuma.at({ path: root });
    assert.deepEqual(world.list().rows, []);
    const allocated = allocateAkumaDirectory({ worldRoot: root, persona: "claude", draw: () => "1234abcd" });
    initializeHeart(allocated.paths);
    assert.equal(world.list().rows[0]?.life, "unborn");

    const launch: BodyLaunch = {
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        persona: "claude",
        description: "Fixture akuma",
        provider: CLAUDE_EXECUTION,
        options: {},
        origin: { kind: "direct" },
        confinement: { kind: "unconfined" },
        contract: "kei/public-purpose",
        cwd: root,
      },
      initialBody: "work",
    };
    await driveAkumaBody(launch, provider, {
      collar: { pid: 999_997, processGroup: 999_997, spawnedAt: "public-fixture" },
      now: () => "2026-08-08T00:00:00.000Z",
      async putDownOwnTree() {},
    });

    const handle = world.of({ id: allocated.id });
    const listed = world.list().rows[0]!;
    assert.equal(listed.life, "asleep");
    assert.equal("history" in listed, false);
    assert.equal("answer" in listed, false);
    const status = handle.status();
    assert.equal(status.life, "asleep");
    assert.equal(status.persona, "claude");
    assert.equal(status.description, "Fixture akuma");
    assert.equal(listed.contract, "kei/public-purpose");
    assert.equal(status.contract, "kei/public-purpose");
    assert.deepEqual(status.confinement, { kind: "unconfined" });
    assert.equal(status.answer, "public answer");
    assert.deepEqual(status.pending, []);
    assert.equal("history" in status, false);
    assert.deepEqual(handle.history()[0]?.outcome, {
      kind: "answered",
      answer: "public answer",
      historyId: "public-history",
      session: { sessionId: "public-session" },
    });
    assert.deepEqual(status.activity, { rows: [{ kind: "said", text: "working" }], omitted: 0 });
    assert.deepEqual(await handle.wait((candidate) => candidate.answer === "public answer"), status);
    const events = [];
    for await (const event of handle.follow()) events.push(event);
    assert.deepEqual(events.slice(0, 2), [
      { type: "session", coordinate: { sessionId: "public-session" } },
      { type: "assistant", text: "working" },
    ]);
    assert.equal(await handle.kill(), "killed");
    assert.equal(handle.status().life, "dead");
    assert.equal(handle.status().answer, "public answer");
    assert.equal(await handle.kill(), "already-dead");
    assert.deepEqual(await handle.interrupt("late"), { kind: "dead" });
    assert.equal(pauseRequested(allocated.paths), false);
    assert.deepEqual(readHistory(allocated.paths)[0]?.outcome, {
      kind: "answered",
      answer: "public answer",
      historyId: "public-history",
      session: { sessionId: "public-session" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupt records a tell only after taking an idle leash", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-interrupt-idle-"));
  const seat = join(root, "seat");
  try {
    mkdirSync(seat);
    const allocated = allocateAkumaDirectory({ worldRoot: root, persona: "claude", draw: () => "1d1e0001" });
    initializeHeart(allocated.paths);
    await driveAkumaBody({
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        persona: "claude",
        provider: CLAUDE_EXECUTION,
        options: {},
        origin: { kind: "direct" },
        confinement: { kind: "unconfined" },
        cwd: seat,
      },
      initialBody: "first",
    }, provider, {
      collar: { pid: 999_988, processGroup: 999_988, spawnedAt: "interrupt-idle" },
      now: () => "2026-08-08T00:00:00.000Z",
      async putDownOwnTree() {},
    });
    rmSync(seat, { recursive: true, force: true });

    const receipt = await Akuma.at({ path: root }).of({ id: allocated.id }).interrupt("next");
    assert.equal(receipt.kind, "interrupted");
    if (receipt.kind !== "interrupted" || "kind" in receipt.tell) return;
    assert.equal(receipt.putDown, "was-idle");
    assert.equal(typeof receipt.tell.wake, "object");
    assert.equal(pauseRequested(allocated.paths), false);
    assert.deepEqual(readHeart(allocated.paths).pending.map((tell) => tell.id), [receipt.tell.id]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupt waits for a running body to self-abort before recording the tell", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-interrupt-running-"));
  const seat = join(root, "seat");
  try {
    mkdirSync(seat);
    const allocated = allocateAkumaDirectory({ worldRoot: root, persona: "claude", draw: () => "1d1e0002" });
    initializeHeart(allocated.paths);
    let aborted = false;
    let settle!: (result: { kind: "failed"; diagnostic: string }) => void;
    const completion = new Promise<{ kind: "failed"; diagnostic: string }>((resolve) => { settle = resolve; });
    const body = driveAkumaBody({
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        persona: "claude",
        provider: CLAUDE_EXECUTION,
        options: {},
        origin: { kind: "direct" },
        confinement: { kind: "unconfined" },
        cwd: seat,
      },
      initialBody: "work",
    }, {
      confinement: () => ({ kind: "unconfined" }),
      admitOptions(options) { return { kind: "admitted", options }; },
      async start() {
        return {
          events: {
            async *[Symbol.asyncIterator]() {
              while (!aborted) {
                yield { type: "action" as const, note: "Working" };
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            },
          },
          completion,
          async abort() {
            aborted = true;
            settle({ kind: "failed", diagnostic: "interrupted" });
          },
        };
      },
    }, {
      collar: { pid: 999_987, processGroup: 999_987, spawnedAt: "interrupt-running" },
      now: () => "2026-08-08T00:00:00.000Z",
      async putDownOwnTree() {},
    });
    while (readHeart(allocated.paths).latestBody === null) await new Promise((resolve) => setTimeout(resolve, 5));
    rmSync(seat, { recursive: true, force: true });

    const receipt = await Akuma.at({ path: root }).of({ id: allocated.id }).interrupt("replace it");
    await body;
    assert.equal(receipt.kind, "interrupted");
    if (receipt.kind !== "interrupted") return;
    assert.equal(receipt.putDown, "self-aborted");
    assert.equal(aborted, true);
    assert.equal(readHeart(allocated.paths).latestBody?.end, "put-down");
    assert.equal(pauseRequested(allocated.paths), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupt leaves pause behind and records no tell when a held leash has no collar", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-interrupt-unstoppable-"));
  try {
    const allocated = allocateAkumaDirectory({ worldRoot: root, persona: "claude", draw: () => "1d1e0003" });
    initializeHeart(allocated.paths);
    const holder = HeldAkumaLeash.try(allocated.paths)!;
    holder.birth(allocated.paths, {
      id: allocated.id,
      persona: "claude",
      provider: CLAUDE_EXECUTION,
      options: {},
      origin: { kind: "direct" },
      confinement: { kind: "unconfined" },
      cwd: root,
      createdAt: "2026-08-08T00:00:00.000Z",
    });
    try {
      assert.deepEqual(await Akuma.at({ path: root }).of({ id: allocated.id }).interrupt("never recorded"), {
        kind: "unstoppable",
        evidence: "no-collar",
      });
      assert.equal(pauseRequested(allocated.paths), true);
      assert.deepEqual(readHeart(allocated.paths).pending, []);
    } finally {
      holder.release();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("physical put-down evidence is not success while the leash remains held", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-interrupt-held-"));
  try {
    const allocated = allocateAkumaDirectory({ worldRoot: root, persona: "claude", draw: () => "1d1e0005" });
    initializeHeart(allocated.paths);
    const holder = HeldAkumaLeash.try(allocated.paths)!;
    holder.birth(allocated.paths, {
      id: allocated.id,
      persona: "claude",
      provider: CLAUDE_EXECUTION,
      options: {},
      origin: { kind: "direct" },
      confinement: { kind: "unconfined" },
      cwd: root,
      createdAt: "2026-08-08T00:00:00.000Z",
    });
    recordBody(allocated.paths, {
      collar: { pid: 999_985, processGroup: 999_985, spawnedAt: "already-gone" },
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    try {
      assert.deepEqual(await Akuma.at({ path: root }).of({ id: allocated.id }).interrupt("never recorded"), {
        kind: "unstoppable",
        evidence: "leash-held-after-put-down",
      });
      assert.equal(pauseRequested(allocated.paths), true);
      assert.deepEqual(readHeart(allocated.paths).pending, []);
    } finally {
      holder.release();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Persona Markdown is strict call-time input with a durable option shape", () => {
  const home = mkdtempSync(join(tmpdir(), "keiyaku-akuma-persona-"));
  try {
    mkdirSync(join(home, "akuma"));
    const settingsValue = settings({ home });
    writeFileSync(join(home, "akuma", "reviewer.md"), [
      "---",
      "provider: claude",
      "model: claude-sonnet-4-5",
      "effort: high",
      "access: read",
      "description: Careful reviewer",
      "---",
      "Review the change from first principles.",
      "",
    ].join("\n"));
    const loaded = loadPersona({ name: "reviewer", settings: settingsValue });
    const { adapter, ...definition } = loaded;
    assert.equal(typeof adapter.start, "function");
    assert.deepEqual(definition, {
      name: "reviewer",
      path: join(home, "akuma", "reviewer.md"),
      provider: CLAUDE_EXECUTION,
      description: "Careful reviewer",
      options: {
        model: "claude-sonnet-4-5",
        effort: "high",
        access: "read",
        systemPrompt: "Review the change from first principles.\n",
      },
    });
    writeFileSync(join(home, "akuma", "invalid.md"), "---\nprovider: claude\nextra: no\n---\n");
    assert.throws(
      () => loadPersona({ name: "invalid", settings: settingsValue }),
      (error: unknown) => error instanceof AkumaPersonaError
        && error.reason.includes("unknown Persona frontmatter key: extra")
        && error.searched[0] === join(home, "akuma", "invalid.md"),
    );
    writeFileSync(join(home, "akuma", "unknown.md"), "---\nprovider: missing\n---\n");
    assert.throws(
      () => loadPersona({ name: "unknown", settings: settingsValue }),
      (error: unknown) => error instanceof AkumaPersonaError
        && error.reason === "uses unknown provider missing"
        && error.searched[0] === join(home, "akuma", "unknown.md"),
    );
    assert.throws(
      () => loadPersona({ name: "missing", settings: settingsValue }),
      (error: unknown) => error instanceof AkumaPersonaError
        && error.kind === "akuma-persona"
        && error.searched[0] === join(home, "akuma", "missing.md"),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("call structurally refuses a non-Contract association before allocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-contract-boundary-"));
  try {
    await assert.rejects(
      Akuma.at({ path: root }).call({ persona: "worker", body: "build", contract: "task/not-a-contract" }),
      /identity must use kei\//u,
    );
    assert.equal(existsSync(akumaRunRoot(root)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("list distinguishes sealed residue from an unclaimed birth", () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-seal-"));
  try {
    const allocated = allocateAkumaDirectory({ worldRoot: root, persona: "claude", draw: () => "abcdef12" });
    initializeHeart(allocated.paths);
    const leash = HeldAkumaLeash.try(allocated.paths)!;
    assert.equal(leash.sealIfUnborn(allocated.paths, {
      evidence: "fixture-abandonment",
      at: "2026-08-08T00:00:00.000Z",
    }), "sealed");
    assert.deepEqual(Akuma.at({ path: root }).list().rows, [{
      id: allocated.id,
      life: "stillborn",
      seal: { evidence: "fixture-abandonment", at: "2026-08-08T00:00:00.000Z" },
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed turn is durable public evidence and never masquerades as provider activity", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-failed-turn-"));
  try {
    const allocated = allocateAkumaDirectory({ worldRoot: root, persona: "claude", draw: () => "fa11ed00" });
    initializeHeart(allocated.paths);
    await driveAkumaBody({
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        persona: "claude",
        provider: CLAUDE_EXECUTION,
        options: {},
        origin: { kind: "direct" },
        confinement: { kind: "unconfined" },
        cwd: root,
      },
      initialBody: "fail",
    }, {
      confinement: () => ({ kind: "unconfined" }),
      async start() {
        return {
          events: { async *[Symbol.asyncIterator]() {} },
          completion: Promise.resolve({ kind: "failed", diagnostic: "native failed" }),
          async abort() {},
        };
      },
    }, {
      collar: { pid: 999_995, processGroup: 999_995, spawnedAt: "failed-turn" },
      now: () => "2026-08-08T00:00:00.000Z",
      async putDownOwnTree() {},
    });
    const handle = Akuma.at({ path: root }).of({ id: allocated.id });
    assert.equal(handle.status().failure, "native failed");
    const settled = await handle.wait();
    assert.equal(settled.life, "stranded");
    assert.equal(settled.failure, "native failed");
    assert.deepEqual(settled.pending, []);
    assert.deepEqual(handle.history().map((turn) => turn.outcome), [
      { kind: "failed", diagnostic: "native failed" },
    ]);
    const events = [];
    for await (const event of handle.follow()) events.push(event);
    assert.deepEqual(events, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("activity is disposable narration and old raw events fail the public hard cut", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-activity-law-"));
  try {
    const source = await answeredSource(root, "ac710001");
    const handle = Akuma.at({ path: root }).of({ id: source.id });
    const before = handle.status();
    const heart = new DatabaseSync(source.paths.heart);
    try { heart.prepare("DELETE FROM activity").run(); } finally { heart.close(); }
    assert.deepEqual(handle.status(), { ...before, activity: { rows: [], omitted: 0 } });
    const afterDeletion = [];
    for await (const event of handle.follow()) afterDeletion.push(event);
    assert.deepEqual(afterDeletion, []);

    appendActivity(source.paths, {
      event: { type: "activity", event: { provider: "legacy", secret: "raw" } },
      at: "2026-08-08T00:00:01.000Z",
    });
    await assert.rejects(async () => {
      for await (const _event of handle.follow()) { /* drain */ }
    }, /invalid event shape/);
    assert.throws(() => handle.status(), /invalid event shape/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("kill gives the body a stop grace before putting down its process tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-kill-"));
  try {
    const allocated = allocateAkumaDirectory({ worldRoot: root, persona: "claude", draw: () => "fedcba98" });
    initializeHeart(allocated.paths);
    let aborted = false;
    let settle!: (result: { kind: "failed"; diagnostic: string }) => void;
    const completion = new Promise<{ kind: "failed"; diagnostic: string }>((resolve) => { settle = resolve; });
    const running: ProviderAdapter = {
      confinement: () => ({ kind: "unconfined" }),
      admitOptions(options) { return { kind: "admitted", options }; },
      async start() {
        return {
          events: {
            async *[Symbol.asyncIterator]() {
              while (!aborted) {
                yield { type: "note" as const, text: "Working" };
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            },
          },
          completion,
          async abort() {
            aborted = true;
            settle({ kind: "failed", diagnostic: "stopped" });
          },
        };
      },
    };
    const launch: BodyLaunch = {
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        persona: "claude",
        provider: CLAUDE_EXECUTION,
        options: {},
        origin: { kind: "direct" },
        confinement: { kind: "unconfined" },
        cwd: root,
      },
      initialBody: "keep working",
    };
    const body = driveAkumaBody(launch, running, {
      collar: { pid: 999_996, processGroup: 999_996, spawnedAt: "kill-fixture" },
      now: () => "2026-08-08T00:00:00.000Z",
      async putDownOwnTree() {},
    });
    while (readHeart(allocated.paths).latestBody === null) await new Promise((resolve) => setTimeout(resolve, 5));

    const handle = Akuma.at({ path: root }).of({ id: allocated.id });
    const waited = handle.wait();
    assert.equal(await handle.kill(), "killed");
    await body;
    assert.notEqual((await waited).life, "running");
    assert.equal(aborted, true);
    assert.equal(readHeart(allocated.paths).latestBody?.end, "put-down");
    assert.equal(handle.status().life, "dead");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Akuma normalizes a relative world before projecting its run root", () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-relative-"));
  try {
    const coordinate = relative(process.cwd(), root);
    assert.equal(Akuma.at({ path: coordinate }).list().searched[0], resolve(root, ".keiyaku", "akuma", "run"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status reports a missing coordinate as not born without creating heart residue", () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-not-born-"));
  try {
    const handle = Akuma.at({ path: root }).of({ id: "aku/claude/1234abcd" });
    assert.throws(() => handle.status(), { name: "AkumaNotBornError" });
    assert.equal(existsSync(join(root, ".keiyaku", "akuma", "run", "claude-1234abcd")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
