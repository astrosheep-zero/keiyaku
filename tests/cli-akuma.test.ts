import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { moveAlias } from "../src/alias/index.js";
import { driveAkumaBody } from "../src/akuma/body.js";
import { HeldAkumaLeash, initializeHeart, readSoul, type Soul } from "../src/akuma/heart/index.js";
import { decodeSoul } from "../src/akuma/heart/soul.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import type { ProviderAdapter } from "../src/akuma/provider.js";
import { AKUMA_REQUESTS_ENV } from "../src/akuma/provider.js";
import { BodyRequestPump } from "../src/akuma/request-serve.js";
import { executeKillAkuma, executeTellAkuma, executeWaitAkuma } from "../src/library/fleet.js";
import type { AkumaObservation } from "../src/index.js";
import { invoke } from "../src/cli/invoke.js";
import { CliUsageError, parseArgv } from "../src/cli/parse.js";
import { akumaExitCode, akumaJsonValue, akumaRawAnswer, renderAkumaText } from "../src/cli/render/akuma.js";
import type { TextRenderContext } from "../src/cli/render/terminal.js";
import type { AkuId } from "../src/akuma/identity.js";
import { makeGitRepository } from "./support/git.js";

const PACKAGED_CLI = fileURLToPath(new URL("../build/src/cli/index.js", import.meta.url));
const emptyCreatedTasks = { kind: "present" as const, rows: [] };
const emptyReported = { reportedChanges: [] as const, reportedChangesOmitted: 0 as const };
function akumaObservation(
  status: AkumaObservation["status"],
  extra: Omit<Partial<AkumaObservation>, "status"> = {},
): AkumaObservation {
  return {
    status: { ...status, timeline: { ...emptyReported, ...status.timeline } },
    contract: { kind: "none" },
    createdTasks: extra.createdTasks ?? emptyCreatedTasks,
    ...extra,
  };
}

function packagedCliEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.FORCE_COLOR;
  delete next.NO_COLOR;
  return next;
}

function runPackagedCli(
  args: readonly string[],
  input: Readonly<{ cwd: string; env?: NodeJS.ProcessEnv; stdin?: string }>,
): Promise<Readonly<{ code: number; stdout: string; stderr: string }>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PACKAGED_CLI, ...args], {
      cwd: input.cwd,
      env: packagedCliEnv(input.env ?? process.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk: Buffer | string) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input.stdin ?? "");
  });
}

test("Akuma CLI parses root verbs without the removed namespace", () => {
  assert.deepEqual(parseArgv(["-C", "/world", "call", "claude", "-"]), {
    cwd: "/world",
    command: { command: "call", archetype: "claude", mode: "wait", prompt: { kind: "stdin" }, output: "text" },
  });
  assert.deepEqual(parseArgv(["call", "claude", "--contract", "kei/delivery", "--alias", "@review", "-d", "review the patch"]), {
    command: {
      command: "call",
      archetype: "claude",
      contract: "kei/delivery",
      alias: "@review",
      mode: "detach",
      prompt: { kind: "argument", value: "review the patch" },
      output: "text",
    },
  });
  assert.deepEqual(parseArgv([
    "call", "claude", "--allowed", "task.add", "--allowed", "akuma.call", "-",
  ]), {
    command: {
      command: "call",
      archetype: "claude",
      allowed: ["akuma.call", "task.add"],
      mode: "wait",
      prompt: { kind: "stdin" },
      output: "text",
    },
  });
  assert.deepEqual(parseArgv(["call", "claude", "--allowed", "none", "-"]), {
    command: {
      command: "call",
      archetype: "claude",
      allowed: [],
      mode: "wait",
      prompt: { kind: "stdin" },
      output: "text",
    },
  });
  assert.deepEqual(parseArgv(["call", "claude", "--readonly", "-"]), {
    command: {
      command: "call",
      archetype: "claude",
      mode: "wait",
      readonly: true,
      prompt: { kind: "stdin" },
      output: "text",
    },
  });
  assert.throws(() => parseArgv(["call", "claude", "--write", "-"]), /option --write is not valid/u);
  assert.throws(
    () => parseArgv(["call", "claude", "--allowed", "none", "--allowed", "akuma.call", "-"]),
    /cannot be combined/u,
  );
  assert.throws(
    () => parseArgv(["call", "claude", "--allowed", "task.add", "--allowed", "task.add", "-"]),
    /duplicate action/u,
  );
  assert.deepEqual(parseArgv(["call", "claude", "--wait", "10m", "--cwd", "/world", "-"]), {
    cwd: "/world",
    command: {
      command: "call",
      archetype: "claude",
      mode: "wait",
      timeoutMs: 600_000,
      prompt: { kind: "stdin" },
      output: "text",
    },
  });
  assert.deepEqual(parseArgv(["call", "claude", "--detach", "-C", "/world", "ship it"]), {
    cwd: "/world",
    command: {
      command: "call",
      archetype: "claude",
      mode: "detach",
      prompt: { kind: "argument", value: "ship it" },
      output: "text",
    },
  });
  assert.throws(() => parseArgv(["-C", "/one", "call", "claude", "--cwd", "/two", "-"]), /may appear only once/u);
  assert.throws(() => parseArgv(["call", "claude", "-", "--cwd", "/world"]), /stdin marker '-' must be the final argument/u);
  assert.throws(() => parseArgv(["call", "claude", "--wait", "5m", "--detach", "-"]), /mutually exclusive/u);
  assert.throws(() => parseArgv(["call", "claude", "--alias", "review", "-"]), /Akuma alias must match/u);
  assert.deepEqual(parseArgv(["tell", "aku/claude/1234abcd", "--json", "-"]), {
    command: {
      command: "tell",
      akuma: "aku/claude/1234abcd",
      interrupt: false,
      prompt: { kind: "stdin" },
      output: "json",
    },
  });
  assert.deepEqual(parseArgv(["tell", "@review", "--interrupt", "continue from the failure"]), {
    command: {
      command: "tell",
      akuma: "@review",
      interrupt: true,
      prompt: { kind: "argument", value: "continue from the failure" },
      output: "text",
    },
  });
  assert.deepEqual(parseArgv(["fork", "aku/claude/1234abcd", "--at", "history-1", "--json"]), {
    command: { command: "fork", akuma: "aku/claude/1234abcd", at: "history-1", output: "json" },
  });
  assert.deepEqual(parseArgv(["history", "aku/claude/1234abcd", "--since", "7", "--limit", "25", "--json"]), {
    command: {
      command: "history",
      akuma: "aku/claude/1234abcd",
      last: false,
      since: 7,
      limit: 25,
      output: "json",
    },
  });
  assert.deepEqual(parseArgv(["history", "kei/example", "--json"]), {
    command: { command: "history", contract: "kei/example", output: "json" },
  });
  assert.deepEqual(parseArgv(["history", "@example"]), {
    command: { command: "history", akuma: "@example", last: false, output: "text" },
  });
  assert.throws(() => parseArgv(["history", "example"]), /identity must use aku\//u);
  assert.throws(() => parseArgv(["history", "aku/*/*"]), /one complete/u);
  assert.throws(() => parseArgv(["history", "kei/one", "kei/two"]), /invalid positional/u);
  for (const option of ["--before", "--since", "--limit", "--last"]) {
    assert.throws(
      () => parseArgv(option === "--last"
        ? ["history", "kei/example", option]
        : ["history", "kei/example", option, "1"]),
      /does not accept/u,
    );
  }
  for (const limit of ["0", "-1", "1.5", "5001"]) {
    assert.throws(() => parseArgv(["history", "aku/claude/1234abcd", "--limit", limit]), /--limit/u);
  }
  assert.throws(
    () => parseArgv(["history", "aku/claude/1234abcd", "--last", "--limit", "1"]),
    /cannot be combined/u,
  );
  assert.deepEqual(parseArgv(["status", "aku/claude/1234abcd"]), {
    command: { command: "status", contract: "aku/claude/1234abcd", akuma: true, output: "text" },
  });
  assert.deepEqual(parseArgv(["ls", "aku/reviewer/", "--json"]), {
    command: { command: "ls", query: { kind: "akuma", archetype: "reviewer" }, output: "json" },
  });
  assert.deepEqual(parseArgv(["wait", "aku/claude/1234abcd", "--timeout", "25ms", "--json"]), {
    command: { command: "wait", akuma: ["aku/claude/1234abcd"], timeoutMs: 25, output: "json" },
  });
  assert.deepEqual(parseArgv(["wait", "aku/claude/*", "kei/review", "--any"]), {
    command: { command: "wait", akuma: ["aku/claude/*", "kei/review"], completion: "any", output: "text" },
  });
  assert.throws(() => parseArgv(["wait", "aku/claude/*", "kei/review"]), /requires --any or --all/u);
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
  assert.throws(() => parseArgv(["call", "--archetype", "claude", "-"]), CliUsageError);
  assert.throws(() => parseArgv(["call", "-"]), CliUsageError);
  assert.throws(() => parseArgv(["call", "claude"]), CliUsageError);
  assert.throws(
    () => parseArgv(["call", "claude", "reviewer", "-"]),
    /accepts either a prompt argument or stdin, not both/u,
  );
  assert.throws(() => parseArgv(["interrupt", "aku\/claude\/1234abcd", "-"]), /unknown command/u);
  assert.throws(() => parseArgv(["tell", "aku\/claude\/1234abcd", "--interrupt"]), /requires a prompt argument or stdin/u);
  assert.throws(() => parseArgv(["kill", "aku\/claude\/1234abcd", "-"]), /stdin marker .* not valid/);
  assert.throws(() => parseArgv(["fork", "aku\/claude\/1234abcd"]), /requires --at/);
  assert.throws(() => parseArgv(["fork", "aku\/claude\/1234abcd", "--at", ""]), /--at requires a nonblank value/);
  const blankSources: ReadonlyArray<readonly [argv: readonly string[], pattern: RegExp]> = [
    [["call", "claude", "   "], /call requires a nonblank value/],
    [["tell", "aku/claude/1234abcd", "\t"], /tell requires a nonblank value/],
    [["fork", "aku/claude/1234abcd", "--at", " "], /--at requires a nonblank value/],
    [["call", "worker", "--contract", " ", "prompt"], /--contract requires a nonblank value/],
    [["wait", "aku/claude/1234abcd", " "], /wait requires a nonblank value/],
  ];
  for (const [argv, pattern] of blankSources) {
    assert.throws(() => parseArgv(argv), (error: unknown) => error instanceof CliUsageError && pattern.test(error.message));
  }
});


test("blank Akuma stdin is usage before World or package invocation", async () => {
  await assert.rejects(
    () => invoke(parseArgv(["call", "claude", "-"]), {
      cwd: "/absent/akuma-blank-stdin",
      environment: {},
      readStdin: () => " \n",
    }),
    (error: unknown) => error instanceof CliUsageError
      && /call requires a nonblank prompt/.test(error.message)
      && !/invocation cwd is not an existing directory/u.test(error.message),
  );
});

function statusCommand(id: string) {
  return parseArgv(["status", id]).command;
}

function renderStatus(observation: AkumaObservation, context?: TextRenderContext): string {
  return renderAkumaText(statusCommand(observation.status.id), { kind: "akuma", action: "status", status: observation }, context);
}

function waitCommand(id: string) {
  return parseArgv(["wait", id]).command;
}

function waitInvocation(observation: AkumaObservation) {
  return {
    kind: "akuma" as const,
    action: "wait" as const,
    result: { completion: "all" as const, observations: [observation], unobserved: [] },
  };
}

function tellInvocation(observation: AkumaObservation) {
  return {
    kind: "akuma" as const,
    action: "tell" as const,
    mode: "ordinary" as const,
    body: "steer",
    result: {
      akuma: observation.status.id,
      tell: { admission: { tellId: "tell-1", fact: "recorded" as const }, wake: "spawned" as const },
      observation: { kind: "observed" as const, ...observation },
    },
  };
}

function glyph(line: string): string {
  return line[6] ?? "";
}

test("Akuma snapshots preserve typed omission", () => {
  const result = {
    kind: "akuma" as const,
    action: "status" as const,
    status: akumaObservation({
      id: "aku/worker/1234abcd",
      life: "running" as const,
      timeline: {
        kind: "open" as const,
        turn: { kind: "turn" as const, sequence: 1, turnSequence: 1, bodySequence: 1, at: "2026-08-10T16:42:00.000Z" },
        entries: [{ kind: "gap" as const, count: 12 }],
        omitted: 12,
        ...emptyReported,
      },
    }),
  };
  const projected = akumaJsonValue(result) as { status: typeof result.status };
  assert.equal(projected.status.id, "aku/worker/1234abcd");
  assert.equal(projected.status.timeline.omitted, 12);
  assert.deepEqual(projected.status.timeline.entries, [{ kind: "gap", count: 12 }]);
});

test("Akuma snapshot text keeps timeline order and uses ordinary vertical marks", () => {
  const at = "2026-08-10T16:36:00.000Z";
  const later = "2026-08-10T16:47:00.000Z";
  const said = "I'm editing the architecture allowlist to mirror the completed migration: synchronous filesystem authority remains only in the two documented owners.";
  const thought = "The migrated Heart and Body slices now pass except one real async race exposed by the new boundary.";
  const observation = akumaObservation({
    id: "aku/expert-akuma/5659b10d",
    life: "running",
    timeline: {
      kind: "open",
      turn: { kind: "turn", sequence: 1, turnSequence: 1, bodySequence: 1, at },
      entries: [
        { kind: "gap", count: 171 },
        { kind: "row", row: { kind: "said", sequence: 2, turnSequence: 1, at, text: said } },
        { kind: "gap", count: 17 },
        { kind: "row", row: { kind: "thought", sequence: 3, turnSequence: 1, at: "2026-08-10T16:46:00.000Z", text: thought } },
        { kind: "row", row: { kind: "tool", sequence: 4, turnSequence: 1, at: later, name: "Bash", call: { kind: "run", command: "npm run test:focused" }, state: { status: "ok" } } },
        { kind: "row", row: { kind: "tool", sequence: 5, turnSequence: 1, at: later, name: "Bash", call: { kind: "run", command: "npm test" }, state: { status: "error" } } },
        { kind: "gap", count: 11 },
        { kind: "row", row: { kind: "tool", sequence: 6, turnSequence: 1, at: "2026-08-10T16:49:00.000Z", name: "Bash", call: { kind: "run", command: "npm test" }, state: { status: "ok" } } },
        { kind: "row", row: { kind: "tell", sequence: 7, at: "2026-08-10T16:49:00.000Z", tellId: "tell-1", text: "Please also inspect the termination path.", state: "pending", deliveries: [] } },
        { kind: "row", row: { kind: "tool", sequence: 8, turnSequence: 1, at: "2026-08-10T16:50:00.000Z", name: "Bash", call: { kind: "run", command: "npm run test:focused" }, state: "active" } },
        { kind: "row", row: { kind: "tool", sequence: 9, turnSequence: 1, at: "2026-08-10T16:50:00.000Z", name: "Bash", call: { kind: "run", command: "npm run lint" }, state: "unsettled" } },
      ],
      omitted: 199,
      ...emptyReported,
    },
  });
  const text = renderStatus(observation);
  const lines = text.split("\n");
  const gaps = lines.filter((line) => /⋮ \d+ omitted/u.test(line));
  assert.deepEqual(gaps, ["      ⋮ 171 omitted", "      ⋮ 17 omitted", "      ⋮ 11 omitted"]);
  const activity = lines.slice(lines.indexOf("      ⋮ 171 omitted"), lines.indexOf("tasks 0"));
  const verbs = activity.filter((line) => / (say|think|run|tell) /u.test(line) && line[5] === " ").map((line) => `${glyph(line)} ${line.slice(8, 14).trimEnd()}`);
  assert.deepEqual(verbs, [
    "│ say",
    "│ think",
    "✓ run",
    "! run",
    "✓ run",
    "⧗ tell",
    "⧖ run",
    "? run",
  ]);
  const sayAt = activity.findIndex((line) => line.includes("say"));
  assert.equal(glyph(activity[sayAt]!), "│");
  assert.equal(glyph(activity[sayAt + 1]!), "│");
  assert.match(activity[sayAt + 1]!, /^ {6}│ {8}/u);
  assert.doesNotMatch(text, /^.{5} · /mu);
  assert.equal(lines.at(-1), "● STILL RUNNING");
  assert.equal(lines.at(-2), "");
});

test("Akuma snapshot tasks stay compact and do not invent relations", () => {
  const observation = akumaObservation({
    id: "aku/worker/1234abcd",
    life: "running",
    timeline: { kind: "idle", entries: [], omitted: 0, ...emptyReported },
  }, {
    createdTasks: {
      kind: "present",
      rows: [
        {
          id: "task/repair-maintainability-limit",
          title: "Repair maintainability parameter limit",
          state: "in_progress",
          priority: 0,
          disposition: "in_progress",
        },
        {
          id: "task/restore-nuke-fixture",
          title: "Restore Nuke fixture API",
          state: "open",
          priority: 1,
          disposition: "blocked",
        },
      ],
    },
  });
  const text = renderStatus(observation, { columns: 120, color: false });
  const lines = text.split("\n");
  const tasksAt = lines.indexOf("tasks 2");
  assert.equal(lines[tasksAt], "tasks 2");
  assert.equal(lines[tasksAt + 1], "  ● task/repair-maintainability-limit · Repair maintainability parameter limit · in_progress · P0");
  assert.equal(lines[tasksAt + 2], "  ‖ task/restore-nuke-fixture · Restore Nuke fixture API · blocked · P1");
  assert.doesNotMatch(text, /unbound|blocked by|kei\//u);
  const empty = renderStatus(akumaObservation({
    id: "aku/worker/1234abcd",
    life: "asleep",
    timeline: { kind: "idle", entries: [], omitted: 0, ...emptyReported },
  }));
  assert.match(empty, /^tasks 0$/mu);
  const failed = renderStatus(akumaObservation({
    id: "aku/worker/1234abcd",
    life: "asleep",
    timeline: { kind: "idle", entries: [], omitted: 0, ...emptyReported },
  }, { createdTasks: { kind: "failed", diagnostic: "front matter" } }));
  assert.match(failed, /^! tasks failed front matter$/mu);
  const wrapped = renderStatus(observation, { columns: 36, color: false });
  assert.match(wrapped, /^ {2}● task\/repair-maintainability-limit/mu);
  assert.match(wrapped, /^ {4}\S/mu);
});

test("Akuma snapshot changes aggregate paths and leave JSON repeated", () => {
  const nuke = "/tmp/keiyaku-integration.uAA0a9/repo/tests/nuke.test.ts";
  const valhalla = "/Users/astrosheep/Developer/keiyaku-v4/.git/keiyaku/wt/valhalla/src/cli/invoke.ts";
  const invoke = "/tmp/keiyaku-integration.uAA0a9/repo/src/cli/invoke.ts";
  const reportedChanges = [
    { sequence: 1, at: "2026-08-10T16:42:00.000Z", op: "update" as const, path: nuke, diffstat: { added: 1, removed: 1 } },
    { sequence: 2, at: "2026-08-10T16:42:01.000Z", op: "add" as const, path: nuke, diffstat: { added: 2, removed: 1 } },
    { sequence: 3, at: "2026-08-10T16:42:02.000Z", op: "update" as const, path: valhalla, diffstat: { added: 15, removed: 10 } },
    { sequence: 4, at: "2026-08-10T16:42:03.000Z", op: "update" as const, path: invoke, diffstat: { added: 10, removed: 10 } },
    { sequence: 5, at: "2026-08-10T16:42:04.000Z", op: "update" as const, path: nuke, diffstat: { added: 0, removed: 0 } },
  ];
  const observation = akumaObservation({
    id: "aku/worker/1234abcd",
    life: "running",
    timeline: {
      kind: "idle",
      entries: [],
      omitted: 0,
      reportedChanges,
      reportedChangesOmitted: 10,
    },
  });
  const result = { kind: "akuma" as const, action: "status" as const, status: observation };
  const text = renderAkumaText(statusCommand(observation.status.id), result, { columns: 20, color: false });
  const lines = text.split("\n");
  const changesAt = lines.indexOf("changes 15");
  assert.equal(lines[changesAt], "changes 15");
  assert.equal(lines[changesAt + 1], `  +3 -2    ${nuke}`);
  assert.equal(lines[changesAt + 2], `  +15 -10  ${valhalla}`);
  assert.equal(lines[changesAt + 3], `  +10 -10  ${invoke}`);
  assert.equal(lines[changesAt + 4], "  ⋮ 10 earlier changes");
  assert.equal(text.split(nuke).length - 1, 1);
  const json = akumaJsonValue(result) as AkumaObservation;
  assert.deepEqual(json.status.timeline.reportedChanges, reportedChanges);
  assert.equal(json.status.timeline.reportedChangesOmitted, 10);
  const incomplete = renderStatus(akumaObservation({
    id: "aku/worker/1234abcd",
    life: "asleep",
    timeline: {
      kind: "idle",
      entries: [],
      omitted: 0,
      reportedChanges: [
        { sequence: 1, at: "2026-08-10T16:42:00.000Z", op: "update", path: "src/a.ts", diffstat: { added: 1, removed: 1 } },
        { sequence: 2, at: "2026-08-10T16:42:01.000Z", op: "update", path: "src/a.ts" },
        { sequence: 3, at: "2026-08-10T16:42:02.000Z", op: "add", path: "src/b.ts", diffstat: { added: 4, removed: 0 } },
      ],
      reportedChangesOmitted: 0,
    },
  }));
  assert.match(incomplete, /^ {2}\+\? -\? {2}src\/a\.ts$/mu);
  assert.match(incomplete, /^ {2}\+4 -0 {2}src\/b\.ts$/mu);
});

test("Akuma running life is the unfinished terminal line and tell omits it", () => {
  const observation = akumaObservation({
    id: "aku/worker/1234abcd",
    life: "running",
    timeline: {
      kind: "idle",
      entries: [{ kind: "row", row: { kind: "said", sequence: 1, turnSequence: 1, at: "2026-08-10T16:42:00.000Z", text: "working" } }],
      omitted: 0,
      ...emptyReported,
    },
  }, {
    createdTasks: {
      kind: "present",
      rows: [{
        id: "task/repair-maintainability-limit",
        title: "Repair maintainability parameter limit",
        state: "in_progress",
        priority: 0,
        disposition: "in_progress",
      }],
    },
  });
  const waitText = renderAkumaText(waitCommand(observation.status.id), waitInvocation(observation));
  const waitLines = waitText.split("\n");
  assert.equal(waitLines.at(-1), "● STILL RUNNING");
  assert.equal(waitLines[waitLines.indexOf("tasks 1") - 1], "");
  assert.ok(waitLines.indexOf("tasks 1") < waitLines.indexOf("changes 0"));
  assert.ok(waitLines.indexOf("changes 0") < waitLines.length - 1);
  assert.equal(waitLines.at(-2), "");
  const told = renderAkumaText(parseArgv(["tell", observation.status.id, "steer"]).command, tellInvocation(observation));
  assert.doesNotMatch(told, /STILL RUNNING/u);
  assert.match(told, /^tasks 1$/mu);
  assert.match(told, /^changes 0$/mu);
  assert.notEqual(told.split("\n").at(-1), "");
  const asleep = renderStatus(akumaObservation({
    id: "aku/worker/1234abcd",
    life: "asleep",
    timeline: { kind: "idle", entries: [], omitted: 0, ...emptyReported },
  }));
  assert.equal(asleep.split("\n").at(-1), "✓ came back");
  const hung = renderStatus(akumaObservation({
    id: "aku/worker/1234abcd",
    life: "hung",
    timeline: { kind: "idle", entries: [], omitted: 0, ...emptyReported },
  }));
  assert.equal(hung.split("\n").at(-1), "? hung");
  const callText = renderAkumaText(parseArgv(["call", "claude", "prompt"]).command, {
    kind: "akuma",
    action: "call",
    world: "/world" as import("../src/world.js").WorldRoot,
    result: {
      kind: "called",
      akuma: observation.status.id,
      execution: { cwd: "/world", source: "input" },
      dispatch: { kind: "none" },
      alias: { kind: "none" },
      observation: { kind: "observed", status: observation.status },
    },
  });
  assert.doesNotMatch(callText, /^tasks /mu);
  assert.match(callText, /^changes 0$/mu);
  assert.equal(callText.split("\n").at(-1), "● STILL RUNNING");
});

test("Akuma output preserves a complete associated Contract identity", () => {
  const result = {
    kind: "akuma" as const,
    action: "history" as const,
    akuma: "aku/worker/00000001" as const,
    mode: "no-answer" as const,
    historyResult: {
      kind: "no-answer" as const,
      id: "aku/worker/00000001" as const,
      contract: { kind: "associated" as const, contractId: "kei/provider-core-review" as const },
    },
  };
  assert.deepEqual(akumaJsonValue(result), {
    kind: "no-answer",
    id: "aku/worker/00000001",
    contract: { kind: "associated", contractId: "kei/provider-core-review" },
  });
});

test("Akuma status keeps a complete Contract ID at narrow width", () => {
  const contractId = "kei/provider-core-review" as const;
  const status = akumaObservation({
    id: "aku/worker/00000001",
    life: "asleep" as const,
    timeline: { kind: "idle" as const, entries: [], omitted: 0, ...emptyReported },
  }, { contract: { kind: "associated", contractId } });
  const context: TextRenderContext = { columns: 20, color: false };
  const text = renderAkumaText(
    parseArgv(["status", status.status.id]).command,
    { kind: "akuma", action: "status", status },
    context,
  );
  const contractLines = text.split("\n").filter((line) => line.includes(contractId));
  assert.deepEqual(contractLines, [`└─ ${contractId}`]);
});

test("Akuma status, wait, and history share public observations without embedding history", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-cli-akuma-status-"));
  const environment = { ...process.env };
  delete environment[AKUMA_REQUESTS_ENV];
  try {
    const allocated = await allocateAkumaDirectory({
      worldRoot: root,
      archetype: "claude",
      draw: () => "1234abcd",
    });
    await initializeHeart(allocated.paths);
    const leash = (await HeldAkumaLeash.try(allocated.paths))!;
    await leash.birth(allocated.paths, {
      id: allocated.id,
      archetype: "claude",
      provider: { name: "claude", kind: "claude-agent-sdk" },
      options: {},
      origin: { kind: "direct" },
      cwd: root,
      createdAt: "2026-08-08T00:00:00.000Z",
    });
    leash.release();
    const provider: ProviderAdapter = {
      admitOptions(options) { return { kind: "admitted", options }; },
      async start() {
        let finishEvents!: () => void;
        const eventsFinished = new Promise<void>((resolve) => { finishEvents = resolve; });
        return {
          admission: { fence: "cli-fixture-turn" },
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: "session" as const, coordinate: { sessionId: "cli-session" } };
              yield { type: "assistant" as const, text: "cli activity" };
              finishEvents();
            },
          },
          completion: eventsFinished.then(() => ({
            kind: "answered" as const,
            answer: "cli answer",
            historyId: "cli-history",
          })),
          async abort() {},
        };
      },
    };
    await driveAkumaBody({
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: {},
        origin: { kind: "direct" },
        cwd: root,
      },
      initialBody: "work",
    }, provider, {
      now: () => "2026-08-08T00:00:00.000Z",
    });

    const parsedStatus = parseArgv(["-C", root, "status", allocated.id]);
    const statusResult = await invoke(parsedStatus, { environment, readStdin: () => { throw new Error("status must not read stdin"); } });
    assert.equal("kind" in statusResult && statusResult.kind, "akuma");
    if (!("kind" in statusResult) || statusResult.kind !== "akuma" || statusResult.action !== "status") return;
    assert.equal(statusResult.status.status.timeline.kind === "idle"
      && statusResult.status.status.timeline.outcome?.outcome.kind === "answered", true);
    assert.equal("history" in statusResult.status.status, false);
    assert.deepEqual(statusResult.status.status.timeline.entries, []);

    const waitResult = {
      kind: "akuma" as const,
      action: "wait" as const,
      result: await executeWaitAkuma({
        path: root as import("../src/world.js").WorldRoot,
        ids: [allocated.id],
        completion: "all",
        timeoutMs: 0,
      }),
    };
    assert.deepEqual(waitResult.result.observations, [statusResult.status]);
    assert.equal(renderAkumaText(parseArgv(["wait", allocated.id]).command, waitResult), "cli answer");
    assert.equal(akumaRawAnswer(waitResult), "cli answer");
    const historyParsed = parseArgv(["-C", root, "history", allocated.id]);
    const historyResult = await invoke(historyParsed, { environment, readStdin: () => { throw new Error("history must not read stdin"); } });
    if (!("kind" in historyResult) || historyResult.kind !== "akuma" || historyResult.action !== "history") return;
    assert.deepEqual(historyResult.history.rows.filter((row) => row.kind === "outcome").map((row) => row.outcome), [
      { kind: "answered", answer: "cli answer", historyId: "cli-history", session: { sessionId: "cli-session" } },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("packaged CLI call writes representative success and failure exits", async () => {
  assert.equal(existsSync(PACKAGED_CLI), true, "npm run build must produce build/src/cli/index.js before this test");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiyaku-cli-akuma-call-")));
  const home = join(root, ".home");
  mkdirSync(join(home, "akuma"), { recursive: true });
  writeFileSync(join(home, "akuma", "worker.md"), "---\nprovider: claude\n---\nWork.\n");
  const parent = await allocateAkumaDirectory({ worldRoot: root, archetype: "parent", draw: () => "1234abcd" });
  await initializeHeart(parent.paths);
  const soul: Soul = {
    id: parent.id,
    archetype: "parent",
    provider: { name: "codex-app-server", kind: "codex-app-server" },
    options: {},
    cwd: root,
    origin: { kind: "direct" },
    createdAt: "2026-08-15T00:00:00.000Z",
  };
  const leash = (await HeldAkumaLeash.try(parent.paths))!;
  await leash.birth(parent.paths, soul);
  const answering: ProviderAdapter = {
    admitOptions(options) { return { kind: "admitted", options }; },
    async start() {
      let finishEvents!: () => void;
      const eventsFinished = new Promise<void>((resolve) => { finishEvents = resolve; });
      return {
        admission: { fence: "cli-call" },
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: "session" as const, coordinate: { sessionId: "cli-session" } };
            finishEvents();
          },
        },
        completion: eventsFinished.then(() => ({
          kind: "answered" as const,
          answer: "finished",
          historyId: "cli-history",
        })),
        async abort() {},
      };
    },
  };
  const failing: ProviderAdapter = {
    ...answering,
    async start() {
      return {
        admission: { fence: "cli-fail" },
        events: { async *[Symbol.asyncIterator]() {} },
        completion: Promise.resolve({ kind: "failed" as const, diagnostic: "turn failed" }),
        async abort() {},
      };
    },
  };
  const held: HeldAkumaLeash[] = [];
  const pump = await BodyRequestPump.open({
    paths: parent.paths,
    parent: soul,
    bodySequence: 1,
    now: () => "2026-08-15T00:00:01.000Z",
    signal: new AbortController().signal,
    upstream: {
      wait: async (input) => await executeWaitAkuma({
        path: root as import("../src/world.js").WorldRoot,
        ids: input.targets,
        completion: input.completion,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        signal: input.signal,
      }),
      tell: async (input) => await executeTellAkuma({
        path: root as import("../src/world.js").WorldRoot,
        id: input.target,
        body: input.body,
        tellId: input.tellId,
        recordedAt: input.recordedAt,
        signal: input.signal,
      }),
      kill: async (input) => {
        const result = await executeKillAkuma({
          path: root as import("../src/world.js").WorldRoot,
          ids: input.targets,
          signal: input.signal,
        });
        return { result, service: result.results.map(({ id, evidence }) => ({ id, evidence })) };
      },
    },
    async spawn(launch) {
      const adapter = launch.initialBody === "fail" ? failing : answering;
      if (launch.initialBody === "hang") {
        const child = (await HeldAkumaLeash.try(launch.paths))!;
        await child.birth(launch.paths, { ...launch.seed, createdAt: "2026-08-15T00:00:02.000Z" });
        held.push(child);
        return;
      }
      await driveAkumaBody(launch, adapter, { now: () => "2026-08-15T00:00:02.000Z" });
    },
  });
  const env = { ...process.env, KEIYAKU_HOME: home, [AKUMA_REQUESTS_ENV]: pump.directory };
  try {
    const answered = await runPackagedCli(["-C", root, "call", "worker", "answer"], { cwd: root, env });
    assert.equal(answered.code, 0);
    assert.equal(answered.stdout, "finished");
    assert.equal(answered.stderr, "");

    const failed = await runPackagedCli(["-C", root, "call", "worker", "--wait", "2s", "-"], { cwd: root, env, stdin: "fail" });
    assert.equal(failed.code, 2);
    assert.match(failed.stdout, /! error\s+turn failed/u);
    assert.notEqual(failed.stdout, "turn failed\n");
  } finally {
    await pump.close();
    for (const child of held) child.release();
    leash.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("packaged CLI wait and history --last write exact multiline and empty answer bytes", async () => {
  assert.equal(existsSync(PACKAGED_CLI), true, "npm run build must produce build/src/cli/index.js before this test");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiyaku-cli-akuma-wait-")));
  const environment = { ...process.env };
  delete environment[AKUMA_REQUESTS_ENV];
  const answering = (answer: string): ProviderAdapter => ({
    admitOptions(options) { return { kind: "admitted", options }; },
    async start() {
      return {
        admission: { fence: "wait-answer" },
        events: { async *[Symbol.asyncIterator]() {
          yield { type: "session" as const, coordinate: { sessionId: "wait-session" } };
        } },
        completion: Promise.resolve({ kind: "answered" as const, answer, historyId: "wait-history" }),
        async abort() {},
      };
    },
  });
  const answered = async (draw: string, answer: string) => {
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => draw });
    await initializeHeart(allocated.paths);
    const leash = (await HeldAkumaLeash.try(allocated.paths))!;
    await leash.birth(allocated.paths, {
      id: allocated.id,
      archetype: "claude",
      provider: { name: "claude", kind: "claude-agent-sdk" },
      options: {},
      origin: { kind: "direct" },
      cwd: root,
      createdAt: "2026-08-16T00:00:00.000Z",
    });
    leash.release();
    await driveAkumaBody({
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: {},
        origin: { kind: "direct" },
        cwd: root,
        createdAt: "2026-08-16T00:00:00.000Z",
      },
      initialBody: "work",
    }, answering(answer), { now: () => "2026-08-16T00:00:00.000Z" });
    return allocated;
  };
  try {
    const multiline = await answered("aaa11111", "line one\nline two\n");
    const exact = await runPackagedCli(["-C", root, "wait", multiline.id, "--timeout", "0ms"], { cwd: root, env: environment });
    assert.equal(exact.code, 0);
    assert.equal(exact.stdout, "line one\nline two\n");
    assert.equal(exact.stderr, "");
    const last = await runPackagedCli(["-C", root, "history", multiline.id, "--last"], { cwd: root, env: environment });
    assert.equal(last.code, 0);
    assert.equal(last.stdout, "line one\nline two\n");
    assert.equal(last.stderr, "");
    const empty = await answered("bbb22222", "");
    const emptyOut = await runPackagedCli(["-C", root, "wait", empty.id, "--timeout", "0ms"], { cwd: root, env: environment });
    assert.equal(emptyOut.code, 0);
    assert.equal(emptyOut.stdout, "");
    const emptyLast = await runPackagedCli(["-C", root, "history", empty.id, "--last"], { cwd: root, env: environment });
    assert.equal(emptyLast.code, 0);
    assert.equal(emptyLast.stdout, "");
    assert.equal(emptyLast.stderr, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixtureSoul(id: Soul["id"], name: string): Record<string, unknown> {
  return {
    id,
    archetype: name,
    provider: { name: "claude", kind: "claude-agent-sdk" },
    options: {},
    cwd: "/tmp",
    origin: { kind: "direct" },
    createdAt: "2026-08-15T00:00:00.000Z",
  };
}

test("linked and primary worktrees observe one Akuma World while Soul retains its execution cwd", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Keiyaku Test"]);
  repository.run(["config", "user.email", "keiyaku@example.invalid"]);
  repository.run(["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  const linked = mkdtempSync(join(tmpdir(), "keiyaku-cli-akuma-linked-"));
  repository.run(["worktree", "add", "--quiet", "--detach", linked]);

  const allocated = await allocateAkumaDirectory({
    worldRoot: repository.path,
    archetype: "worker",
    draw: () => "1357ace0",
  });
  await initializeHeart(allocated.paths);
  const provider: ProviderAdapter = {
    admitOptions(options) { return { kind: "admitted", options }; },
    async start() {
      return {
        admission: { fence: "shared-world" },
        events: { async *[Symbol.asyncIterator]() {} },
        completion: Promise.resolve({ kind: "answered", answer: "shared", historyId: "shared-world" }),
        async abort() {},
      };
    },
  };
  await driveAkumaBody({
    paths: allocated.paths,
    seed: {
      id: allocated.id,
      archetype: "worker",
      provider: { name: "worker", kind: "codex-app-server" },
      options: {},
      origin: { kind: "direct" },
      cwd: linked,
    },
    initialBody: "work",
  }, provider, {
    now: () => "2026-08-14T00:00:00.000Z",
  });

  const fromLinked = await invoke(parseArgv(["-C", linked, "status", allocated.id]));
  const fromPrimary = await invoke(parseArgv(["-C", repository.path, "status", allocated.id]));
  assert.equal(fromLinked.kind, "akuma");
  assert.deepEqual(fromLinked, fromPrimary);
  await moveAlias({ world: repository.path, alias: "@shared", akuId: allocated.id });
  const fromLinkedAlias = await invoke(parseArgv(["-C", linked, "status", "@shared"]));
  assert.equal(fromLinkedAlias.kind === "akuma" ? fromLinkedAlias.status.status.id : undefined, allocated.id);
  assert.equal((await readSoul(allocated.paths))?.cwd, linked);
  assert.equal(existsSync(join(linked, ".keiyaku", "akuma", "run")), false);
});

test("raw-answer selection preserves exact bytes and unfinished snapshots", () => {
  const id = "aku/worker/1234abcd" as const;
  const observation = (answer: string, life: "asleep" | "running" = "asleep"): AkumaObservation => akumaObservation({
    id,
    life,
    timeline: {
      kind: "idle",
      entries: [],
      omitted: 0,
      outcome: {
        kind: "outcome",
        sequence: 1,
        turnSequence: 1,
        at: "2026-08-10T16:42:00.000Z",
        outcome: { kind: "answered", answer, historyId: "history", session: { sessionId: "session" } },
      },
    },
  });
  const wait = (status: AkumaObservation["status"]) => ({
    kind: "akuma" as const,
    action: "wait" as const,
    result: { completion: "all" as const, observations: [akumaObservation(status)], unobserved: [] },
  });
  const multiline = wait(observation("line one\nline two\n").status);
  assert.equal(akumaRawAnswer(multiline), "line one\nline two\n");
  assert.equal(renderAkumaText(parseArgv(["wait", id]).command, multiline), "line one\nline two\n");
  const empty = wait(observation("").status);
  assert.equal(akumaRawAnswer(empty), "");
  assert.equal(renderAkumaText(parseArgv(["wait", id]).command, empty), "");
  const unfinished = wait(observation("kept", "running").status);
  assert.equal(akumaRawAnswer(unfinished), undefined);
  const unfinishedText = renderAkumaText(parseArgv(["wait", id]).command, unfinished);
  assert.match(unfinishedText, /aku\/worker\/1234abcd/u);
  assert.equal(unfinishedText.split("\n").at(-1), "● STILL RUNNING");
});

test("plural wait renders came-back answers and completion count", () => {
  const answered = akumaObservation({
    id: "aku/worker/1234abcd",
    life: "asleep",
    timeline: {
      kind: "idle",
      entries: [],
      omitted: 0,
      reportedChanges: [{ sequence: 1, at: "2026-08-10T16:42:00.000Z", op: "add", path: "src/result.ts", diffstat: { added: 4, removed: 0 } }],
      reportedChangesOmitted: 0,
      outcome: {
        kind: "outcome",
        sequence: 1,
        turnSequence: 1,
        at: "2026-08-10T16:42:00.000Z",
        outcome: { kind: "answered", answer: "returned\nverbatim", historyId: "history", session: { sessionId: "session" } },
      },
    },
  }, {
    createdTasks: {
      kind: "present",
      rows: [{
        id: "task/result",
        title: "Return result context",
        state: "done",
        priority: 0,
        disposition: "done",
      }],
    },
  });
  const running = akumaObservation({
    id: "aku/reviewer/5678abcd",
    life: "running",
    timeline: {
      kind: "open",
      turn: { kind: "turn", sequence: 1, turnSequence: 1, bodySequence: 1, at: "2026-08-10T16:42:00.000Z" },
      entries: [],
      omitted: 0,
    },
  });
  const result = {
    kind: "akuma" as const,
    action: "wait" as const,
    result: { completion: "any" as const, observations: [answered, running], unobserved: [] },
  };
  const text = renderAkumaText(parseArgv(["wait", "aku/worker/*", "aku/reviewer/*", "--any"]).command, result);
  assert.match(text, /^✓ came back aku\/worker\/1234abcd\n─+\nreturned\nverbatim$/mu);
  assert.match(text, /returned\nverbatim\n\ntasks 1\n  ✓ task\/result · Return result context · done · P0\nchanges 1/u);
  assert.match(text, /aku\/reviewer\/5678abcd[\s\S]*● STILL RUNNING/u);
  assert.match(text, /\n\n1 of 2 done$/u);
});

test("Soul validation diagnostics name the Akuma without the internal term", () => {
  assert.throws(
    () => decodeSoul(fixtureSoul("aku/claude/1234abcd" as Soul["id"], " ")),
    (error: unknown) => error instanceof Error
      && error.message === "Akuma soul name must be a nonblank string"
      && !/archetype/iu.test(error.message),
  );
  assert.throws(
    () => decodeSoul(fixtureSoul("aku/claude/1234abcd" as Soul["id"], "worker")),
    (error: unknown) => error instanceof Error
      && error.message === "Akuma soul id and name must agree"
      && !/archetype/iu.test(error.message),
  );
});

test("packaged CLI status writes the Soul name-agreement diagnostic", async () => {
  assert.equal(existsSync(PACKAGED_CLI), true, "npm run build must produce build/src/cli/index.js before this test");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiyaku-cli-akuma-soul-")));
  try {
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1234abcd" });
    await initializeHeart(allocated.paths);
    const leash = (await HeldAkumaLeash.try(allocated.paths))!;
    await leash.birth(allocated.paths, {
      id: allocated.id,
      archetype: "claude",
      provider: { name: "claude", kind: "claude-agent-sdk" },
      options: {},
      cwd: root,
      origin: { kind: "direct" },
      createdAt: "2026-08-15T00:00:00.000Z",
    });
    leash.release();
    const heart = new DatabaseSync(allocated.paths.heart);
    try {
      const row = heart.prepare("SELECT soul_json FROM soul WHERE singleton = 1").get() as { soul_json: string };
      const soul = JSON.parse(row.soul_json) as Record<string, unknown>;
      soul.archetype = "worker";
      heart.prepare("UPDATE soul SET soul_json = ? WHERE singleton = 1").run(JSON.stringify(soul));
    } finally {
      heart.close();
    }
    const status = await runPackagedCli(["-C", root, "status", allocated.id], { cwd: root });
    assert.equal(status.code, 3);
    assert.equal(status.stdout, "");
    assert.equal(status.stderr, "Akuma soul id and name must agree\n");
    assert.doesNotMatch(status.stderr, /archetype/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
