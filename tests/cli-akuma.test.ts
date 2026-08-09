import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { driveAkumaBody } from "../src/akuma/body.js";
import { initializeHeart, recordDeath, recordTurn } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import type { ProviderAdapter } from "../src/akuma/provider.js";
import { invoke } from "../src/cli/invoke.js";
import { main } from "../src/cli/main.js";
import { CliUsageError, parseArgv } from "../src/cli/parse.js";
import { akumaExitCode, akumaJsonValue, renderAkumaJson, renderAkumaText } from "../src/cli/render/akuma.js";

test("Akuma CLI parses root verbs without the removed namespace", () => {
  assert.deepEqual(parseArgv(["-C", "/world", "call", "--persona", "claude", "--cwd", "/work", "--contract", "kei/delivery", "-"]), {
    cwd: "/world",
    command: { command: "call", persona: "claude", cwd: "/work", contract: "kei/delivery", output: "text" },
  });
  assert.deepEqual(parseArgv(["tell", "aku/claude/1234abcd", "--json", "-"]), {
    command: { command: "tell", id: "aku/claude/1234abcd", output: "json" },
  });
  assert.deepEqual(parseArgv(["interrupt", "aku/claude/1234abcd", "-"]), {
    command: { command: "interrupt", id: "aku/claude/1234abcd", output: "text" },
  });
  assert.deepEqual(parseArgv(["fork", "aku/claude/1234abcd", "--at", "history-1", "--json"]), {
    command: { command: "fork", id: "aku/claude/1234abcd", at: "history-1", output: "json" },
  });
  assert.deepEqual(parseArgv(["status", "aku/claude/1234abcd"]), {
    command: { command: "status", contract: "aku/claude/1234abcd", akuma: true, output: "text" },
  });
  assert.deepEqual(parseArgv(["wait", "aku/claude/1234abcd", "--timeout", "25ms", "--json"]), {
    command: { command: "wait", id: "aku/claude/1234abcd", timeoutMs: 25, output: "json" },
  });
  assert.equal(parseArgv(["wait", "aku/claude/1234abcd", "--timeout", "50s"]).command.timeoutMs, 50_000);
  assert.equal(parseArgv(["wait", "aku/claude/1234abcd", "--timeout", "10m"]).command.timeoutMs, 600_000);
  assert.equal(parseArgv(["wait", "aku/claude/1234abcd", "--timeout", "2h"]).command.timeoutMs, 7_200_000);
  for (const duration of ["5000", "1.5m", "01s", "-1s", "1d"]) {
    assert.throws(() => parseArgv(["wait", "aku/claude/1234abcd", "--timeout", duration]), /--timeout requires/u);
  }
  assert.throws(
    () => parseArgv(["wait", "aku/claude/1234abcd", "--timeout", "9007199254741s"]),
    /exceeds the safe millisecond range/u,
  );
  assert.throws(() => parseArgv(["wait", "aku/claude/1234abcd", "--deadline", "25"]), /option --deadline is not valid/u);
  assert.throws(() => parseArgv(["akuma", "ls"]), CliUsageError);
  assert.throws(() => parseArgv(["status", "--akuma"]), CliUsageError);
  assert.throws(() => parseArgv(["call", "--persona", "claude"]), /requires stdin/);
  assert.throws(() => parseArgv(["interrupt", "aku\/claude\/1234abcd"]), /requires stdin/);
  assert.throws(() => parseArgv(["kill", "aku\/claude\/1234abcd", "-"]), /stdin marker .* not valid/);
  assert.throws(() => parseArgv(["fork", "aku\/claude\/1234abcd"]), /requires --at/);
  assert.throws(() => parseArgv(["fork", "aku\/claude\/1234abcd", "--at", ""]), /requires --at/);
});

test("Akuma follow renders the closed event union as text and JSON lines", () => {
  const command = parseArgv(["follow", "aku/claude/1234abcd"]).command;
  const result = {
    kind: "akuma" as const,
    action: "follow" as const,
    id: "aku/claude/1234abcd",
    events: [
      { type: "session" as const, coordinate: { sessionId: "native-1" } },
      { type: "assistant" as const, text: "completed answer" },
      { type: "note" as const, text: "Command npm test" },
      { type: "unknown" as const, kind: "future/event" },
    ],
  };
  assert.equal(renderAkumaText(command, result), [
    "session native-1",
    "completed answer",
    'note "Command npm test"',
    'unknown "future/event"',
  ].join("\n"));
  assert.equal(renderAkumaJson(command, result), result.events.map((event) => JSON.stringify(event)).join("\n"));
  assert.equal(renderAkumaJson(command, result).startsWith("["), false);
});

test("akuma fork renders the public receipt and maps every exit class", () => {
  const command = parseArgv(["fork", "aku/claude/1234abcd", "--at", "history-1"]).command;
  const result = (receipt: import("../src/akuma/index.js").ForkReceipt) => ({
    kind: "akuma" as const,
    action: "fork" as const,
    akuma: "aku/claude/1234abcd",
    receipt,
  });
  const forked = result({ kind: "forked", child: "aku/claude/87654321" as import("../src/akuma/index.js").AkuId });
  assert.equal(renderAkumaText(command, forked), "aku/claude/87654321");
  assert.equal(akumaExitCode(forked), 0);
  assert.deepEqual(akumaJsonValue(command, forked), forked.receipt);

  const incapable = result({ kind: "provider-cannot-fork", provider: "claude" });
  assert.equal(renderAkumaText(command, incapable), "claude cannot fork");
  assert.equal(akumaExitCode(incapable), 1);
  const unknown = result({ kind: "unknown-history", at: "history-1" });
  assert.equal(renderAkumaText(command, unknown), "history-1 has no matching retained answered turn");
  assert.equal(akumaExitCode(unknown), 1);
  const failed = result({ kind: "fork-failed", diagnostic: "native refused" });
  assert.equal(renderAkumaText(command, failed), "native refused");
  assert.equal(akumaExitCode(failed), 1);
  const partial = result({ kind: "upstream-forked", childSession: { sessionId: "native-child" }, diagnostic: "local failed" });
  assert.equal(renderAkumaText(command, partial), "session native-child\nlocal failed");
  assert.equal(akumaExitCode(partial), 2);
});

test("akuma interrupt invokes the public receipt and maps every exit class", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-cli-akuma-interrupt-"));
  try {
    const allocated = allocateAkumaDirectory({ worldRoot: root, persona: "claude", draw: () => "1d1e0004" });
    initializeHeart(allocated.paths);
    await driveAkumaBody({
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        persona: "claude",
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: {},
        origin: { kind: "direct" },
        confinement: { kind: "unconfined" },
        contract: "kei/cli-purpose",
        cwd: root,
      },
      initialBody: "done",
    }, {
      confinement: () => ({ kind: "unconfined" }),
      admitOptions(options) { return { kind: "admitted", options }; },
      async start() {
        return {
          events: { async *[Symbol.asyncIterator]() {} },
          completion: Promise.resolve({ kind: "failed", diagnostic: "done" }),
          async abort() {},
        };
      },
    }, {
      collar: { pid: 999_986, processGroup: 999_986, spawnedAt: "cli-interrupt" },
      now: () => "2026-08-08T00:00:00.000Z",
      async putDownOwnTree() {},
    });
    recordDeath(allocated.paths, { evidence: "killed", at: "2026-08-08T00:00:01.000Z" });
    const parsed = parseArgv(["-C", root, "interrupt", allocated.id, "-"]);
    const result = await invoke(parsed, { readStdin: () => "replace" });
    assert.deepEqual(result, {
      kind: "akuma",
      action: "interrupt",
      akuma: allocated.id,
      receipt: { kind: "dead" },
    });
    if (!("kind" in result) || result.kind !== "akuma") return;
    assert.equal(renderAkumaText(parsed.command, result), `${allocated.id} interrupt dead`);
    assert.equal(akumaExitCode(result), 1);

    const interrupted = {
      kind: "akuma" as const,
      action: "interrupt" as const,
      akuma: allocated.id,
      receipt: {
        kind: "interrupted" as const,
        putDown: "self-aborted" as const,
        tell: { id: "tell-1", state: "recorded" as const, wake: "spawned" as const },
      },
    };
    assert.equal(renderAkumaText(parsed.command, interrupted), `${allocated.id} interrupted self-aborted\ntell tell-1 recorded`);
    assert.equal(akumaExitCode(interrupted), 0);
    assert.equal(akumaExitCode({
      ...interrupted,
      receipt: { ...interrupted.receipt, tell: { id: "tell-1", state: "recorded", wake: { kind: "failed", diagnostic: "spawn" } } },
    }), 2);
    assert.equal(akumaExitCode({
      ...interrupted,
      receipt: { kind: "interrupted", putDown: "collar", tell: { kind: "refused-dead" } },
    }), 1);
    assert.equal(akumaExitCode({
      ...interrupted,
      receipt: { kind: "unstoppable", evidence: "leash-held-after-put-down" },
    }), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Akuma status, wait, and history share public observations without embedding history", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-cli-akuma-status-"));
  try {
    const allocated = allocateAkumaDirectory({ worldRoot: root, persona: "claude", draw: () => "1234abcd" });
    initializeHeart(allocated.paths);
    const provider: ProviderAdapter = {
      confinement: () => ({ kind: "unconfined" }),
      admitOptions(options) { return { kind: "admitted", options }; },
      async start() {
        return {
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: "session" as const, coordinate: { sessionId: "cli-session" } };
            },
          },
          completion: Promise.resolve({ kind: "answered", answer: "cli answer", historyId: "cli-history" }),
          async abort() {},
        };
      },
    };
    await driveAkumaBody({
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        persona: "claude",
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: {},
        origin: { kind: "direct" },
        confinement: { kind: "unconfined" },
        contract: "kei/cli-purpose",
        cwd: root,
      },
      initialBody: "work",
    }, provider, {
      collar: { pid: 999_990, processGroup: 999_990, spawnedAt: "cli-status" },
      now: () => "2026-08-08T00:00:00.000Z",
      async putDownOwnTree() {},
    });

    const parsedStatus = parseArgv(["-C", root, "status", allocated.id]);
    const statusResult = await invoke(parsedStatus, { readStdin: () => { throw new Error("status must not read stdin"); } });
    assert.equal("kind" in statusResult && statusResult.kind, "akuma");
    if (!("kind" in statusResult) || statusResult.kind !== "akuma" || statusResult.action !== "status") return;
    assert.equal(statusResult.status.answer, "cli answer");
    assert.equal("history" in statusResult.status, false);
    assert.deepEqual(statusResult.status.activity, { rows: [], omitted: 0 });
    assert.match(renderAkumaText(parsedStatus.command, statusResult), /answer\ncli answer\nactivity 0/u);
    assert.match(renderAkumaText(parsedStatus.command, statusResult), /contract kei\/cli-purpose/u);

    const waitResult = await invoke(parseArgv(["-C", root, "wait", allocated.id, "--timeout", "0ms"]), {
      readStdin: () => { throw new Error("wait must not read stdin"); },
    });
    assert.equal("kind" in waitResult && waitResult.kind, "akuma");
    if (!("kind" in waitResult) || waitResult.kind !== "akuma" || waitResult.action !== "wait") return;
    assert.deepEqual(waitResult.status, statusResult.status);

    recordTurn(allocated.paths, {
      bodySequence: 1,
      outcome: { kind: "failed", diagnostic: "later failed" },
      completedAt: "2026-08-08T00:00:01.000Z",
    });
    const failedStatus = await invoke(parseArgv(["-C", root, "status", allocated.id]));
    if (!("kind" in failedStatus) || failedStatus.kind !== "akuma" || failedStatus.action !== "status") return;
    assert.equal(failedStatus.status.answer, undefined);
    assert.equal(failedStatus.status.failure, "later failed");

    const historyParsed = parseArgv(["-C", root, "history", allocated.id]);
    const historyResult = await invoke(historyParsed, { readStdin: () => { throw new Error("history must not read stdin"); } });
    if (!("kind" in historyResult) || historyResult.kind !== "akuma" || historyResult.action !== "history") return;
    assert.deepEqual(historyResult.turns.map((turn) => turn.outcome), [
      { kind: "answered", answer: "cli answer", historyId: "cli-history", session: { sessionId: "cli-session" } },
      { kind: "failed", diagnostic: "later failed" },
    ]);
    assert.match(renderAkumaText(historyParsed.command, historyResult), /turn 1 answered cli-history session cli-session/u);
    const lastParsed = parseArgv(["-C", root, "history", allocated.id, "--last"]);
    const lastResult = await invoke(lastParsed);
    if (!("kind" in lastResult) || lastResult.kind !== "akuma" || lastResult.action !== "history") return;
    assert.equal(renderAkumaText(lastParsed.command, lastResult), "cli answer");
    let stdout = "";
    const writeStdout = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
    try {
      assert.equal(await main(["-C", root, "history", allocated.id, "--last"]), 0);
    } finally {
      process.stdout.write = writeStdout;
    }
    assert.equal(stdout, "cli answer");

    const forkResult = await invoke(parseArgv(["-C", root, "fork", allocated.id, "--at", "missing-history"]), {
      readStdin: () => { throw new Error("fork must not read stdin"); },
    });
    assert.deepEqual(forkResult, {
      kind: "akuma",
      action: "fork",
      akuma: allocated.id,
      receipt: { kind: "unknown-history", at: "missing-history" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
