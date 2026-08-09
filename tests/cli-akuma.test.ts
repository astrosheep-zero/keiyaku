import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { driveAkumaBody } from "../src/akuma/body.js";
import { initializeHeart, recordDeath } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import type { ProviderAdapter } from "../src/akuma/provider.js";
import { invoke } from "../src/cli/invoke.js";
import { CliUsageError, parseArgv } from "../src/cli/parse.js";
import { akumaExitCode, akumaJsonValue, renderAkumaJson, renderAkumaText } from "../src/cli/render/akuma.js";

test("akuma CLI parses the public verbs without inventing aliases", () => {
  assert.deepEqual(parseArgv(["-C", "/world", "akuma", "call", "--persona", "claude", "--cwd", "/work", "-"]), {
    cwd: "/world",
    command: { command: "akuma", action: "call", persona: "claude", cwd: "/work", output: "text" },
  });
  assert.deepEqual(parseArgv(["akuma", "tell", "aku/claude/1234abcd", "--json", "-"]), {
    command: { command: "akuma", action: "tell", id: "aku/claude/1234abcd", output: "json" },
  });
  assert.deepEqual(parseArgv(["akuma", "interrupt", "aku/claude/1234abcd", "-"]), {
    command: { command: "akuma", action: "interrupt", id: "aku/claude/1234abcd", output: "text" },
  });
  assert.deepEqual(parseArgv(["akuma", "fork", "aku/claude/1234abcd", "--at", "history-1", "--json"]), {
    command: { command: "akuma", action: "fork", id: "aku/claude/1234abcd", at: "history-1", output: "json" },
  });
  assert.deepEqual(parseArgv(["akuma", "list"]), {
    command: { command: "akuma", action: "list", output: "text" },
  });
  assert.deepEqual(parseArgv(["akuma", "status", "aku/claude/1234abcd"]), {
    command: { command: "akuma", action: "status", id: "aku/claude/1234abcd", output: "text" },
  });
  assert.deepEqual(parseArgv(["akuma", "wait", "aku/claude/1234abcd", "--json"]), {
    command: { command: "akuma", action: "wait", id: "aku/claude/1234abcd", output: "json" },
  });
  assert.throws(() => parseArgv(["akuma", "ls"]), CliUsageError);
  assert.throws(() => parseArgv(["akuma", "of", "aku/claude/1234abcd"]), CliUsageError);
  assert.throws(() => parseArgv(["akuma", "comeback", "aku/claude/1234abcd"]), CliUsageError);
  assert.throws(() => parseArgv(["akuma", "tell", "aku/claude/1234abcd", "--interrupt", "-"]), /not valid/);
  assert.throws(() => parseArgv(["akuma", "call", "--persona", "claude"]), /requires stdin/);
  assert.throws(() => parseArgv(["akuma", "interrupt", "aku\/claude\/1234abcd"]), /requires stdin/);
  assert.throws(() => parseArgv(["akuma", "kill", "aku\/claude\/1234abcd", "-"]), /stdin marker .* not valid/);
  assert.throws(() => parseArgv(["akuma", "fork", "aku\/claude\/1234abcd"]), /requires --at/);
  assert.throws(() => parseArgv(["akuma", "fork", "aku\/claude\/1234abcd", "--at", ""]), /requires --at/);
});

test("akuma follow renders the closed event union as text and JSON lines", () => {
  const command = parseArgv(["akuma", "follow", "aku/claude/1234abcd"]).command;
  if (command.command !== "akuma") return;
  const result = {
    kind: "akuma" as const,
    action: "follow" as const,
    id: "aku/claude/1234abcd",
    events: [
      { type: "session" as const, coordinate: { sessionId: "native-1" } },
      { type: "assistant" as const, text: "completed answer" },
      { type: "action" as const, note: "Command npm test" },
      { type: "unknown" as const, kind: "future/event" },
    ],
  };
  assert.equal(renderAkumaText(command, result), [
    "session: native-1",
    "completed answer",
    "action: Command npm test",
    "unknown: future/event",
  ].join("\n"));
  assert.equal(renderAkumaJson(result), result.events.map((event) => JSON.stringify(event)).join("\n"));
  assert.equal(renderAkumaJson(result).startsWith("["), false);
});

test("akuma fork renders the public receipt and maps every exit class", () => {
  const command = parseArgv(["akuma", "fork", "aku/claude/1234abcd", "--at", "history-1"]).command;
  if (command.command !== "akuma") return;
  const result = (receipt: import("../src/akuma/index.js").ForkReceipt) => ({
    kind: "akuma" as const,
    action: "fork" as const,
    akuma: "aku/claude/1234abcd",
    receipt,
  });
  const forked = result({ kind: "forked", child: "aku/claude/87654321" as import("../src/akuma/index.js").AkuId });
  assert.equal(renderAkumaText(command, forked), "aku/claude/87654321");
  assert.equal(akumaExitCode(forked), 0);
  assert.deepEqual(akumaJsonValue(forked), forked.receipt);

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
        provider: "claude",
        options: {},
        origin: { kind: "direct" },
        confinement: { kind: "unconfined" },
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
    const parsed = parseArgv(["-C", root, "akuma", "interrupt", allocated.id, "-"]);
    const result = await invoke(parsed, { readStdin: () => "replace" });
    assert.deepEqual(result, {
      kind: "akuma",
      action: "interrupt",
      akuma: allocated.id,
      receipt: { kind: "dead" },
    });
    if (!("kind" in result) || result.kind !== "akuma" || parsed.command.command !== "akuma") return;
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

test("akuma status and wait expose the same ordered retained history", async () => {
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
        provider: "claude",
        options: {},
        origin: { kind: "direct" },
        confinement: { kind: "unconfined" },
        cwd: root,
      },
      initialBody: "work",
    }, provider, {
      collar: { pid: 999_990, processGroup: 999_990, spawnedAt: "cli-status" },
      now: () => "2026-08-08T00:00:00.000Z",
      async putDownOwnTree() {},
    });

    const parsedStatus = parseArgv(["-C", root, "akuma", "status", allocated.id]);
    const statusResult = await invoke(parsedStatus, { readStdin: () => { throw new Error("status must not read stdin"); } });
    assert.equal("kind" in statusResult && statusResult.kind, "akuma");
    if (!("kind" in statusResult) || statusResult.kind !== "akuma" || statusResult.action !== "status") return;
    assert.deepEqual(statusResult.status.history.map((turn) => turn.outcome), [{
      kind: "answered",
      answer: "cli answer",
      historyId: "cli-history",
      session: { sessionId: "cli-session" },
    }]);
    if (parsedStatus.command.command !== "akuma") return;
    assert.match(renderAkumaText(parsedStatus.command, statusResult), /history 1\nturn 1 answered cli-history session cli-session/);

    const waitResult = await invoke(parseArgv(["-C", root, "akuma", "wait", allocated.id]), {
      readStdin: () => { throw new Error("wait must not read stdin"); },
    });
    assert.equal("kind" in waitResult && waitResult.kind, "akuma");
    if (!("kind" in waitResult) || waitResult.kind !== "akuma" || waitResult.action !== "wait") return;
    assert.deepEqual(waitResult.status, statusResult.status);

    const forkResult = await invoke(parseArgv(["-C", root, "akuma", "fork", allocated.id, "--at", "missing-history"]), {
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

test("akuma list uses the invocation world and renders its searched coordinate", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-cli-akuma-"));
  try {
    const parsed = parseArgv(["-C", root, "akuma", "list"]);
    const result = await invoke(parsed, { readStdin: () => { throw new Error("list must not read stdin"); } });
    assert.equal("kind" in result && result.kind, "akuma");
    if (!("kind" in result) || result.kind !== "akuma") return;
    assert.equal(result.action, "list");
    if (result.action !== "list" || parsed.command.command !== "akuma") return;
    assert.deepEqual(result.report.rows, []);
    assert.match(renderAkumaText(parsed.command, result), new RegExp(`^akuma 0\\nsearched ${root}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
