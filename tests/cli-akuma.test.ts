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
import { HeldAkumaLeash, beginTurn, endTurn, initializeHeart, readSoul, type Soul } from "../src/akuma/heart/index.js";
import { decodeSoul } from "../src/akuma/heart/soul.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import type { ProviderAdapter } from "../src/akuma/provider.js";
import { AKUMA_REQUESTS_ENV } from "../src/akuma/provider.js";
import { BodyRequestPump } from "../src/akuma/requests.js";
import type { AkumaStatusView } from "../src/index.js";
import type { AkumaInvocationResult } from "../src/cli/commands/akuma-invoke.js";
import { invoke } from "../src/cli/invoke.js";
import { main } from "../src/cli/main.js";
import { CliUsageError, parseArgv } from "../src/cli/parse.js";
import { akumaExitCode, akumaJsonValue, akumaRawAnswer, renderAkumaJson, renderAkumaText } from "../src/cli/render/akuma.js";
import { toolRepr } from "../src/cli/render/akuma-tool.js";
import { normalizeToolCommand } from "../src/cli/render/akuma-tool-command.js";
import { displayColumns } from "../src/cli/render/terminal.js";
import { makeGitRepository } from "./support/git.js";
import type { ActivityRow } from "../src/akuma/index.js";

const PACKAGED_CLI = fileURLToPath(new URL("../build/src/cli/index.js", import.meta.url));

function packagedCliEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.FORCE_COLOR;
  delete next.NO_COLOR;
  return next;
}

async function captureMain(argv: readonly string[]): Promise<Readonly<{ code: number; stdout: string }>> {
  let stdout = "";
  const writeStdout = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
  try {
    return { code: await main([...argv]), stdout };
  } finally {
    process.stdout.write = writeStdout;
  }
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

test("Akuma snapshots preserve activity and typed omission", () => {
  const command = parseArgv(["status", "aku/worker/1234abcd"]).command;
  const status = {
    id: "aku/worker/1234abcd",
    life: "running" as const,
    timeline: {
      kind: "open" as const,
      turn: { kind: "turn" as const, sequence: 1, turnSequence: 1, bodySequence: 1, at: "2026-08-10T16:42:00.000Z" },
      entries: [
        { kind: "row" as const, row: { kind: "note" as const, sequence: 13, turnSequence: 1, at: "2026-08-10T16:42:00.000Z", text: "running tests" } },
        { kind: "gap" as const, count: 12 },
        { kind: "row" as const, row: { kind: "thought" as const, sequence: 14, turnSequence: 1, at: "2026-08-10T16:42:30.000Z", text: "same minute" } },
      ],
      omitted: 12,
    },
  };
  const result = { kind: "akuma" as const, action: "status" as const, status: { status } };
  const text = renderAkumaText(command, result);
  assert.match(text, /running tests/u);
  assert.match(text, /same minute/u);
  const snapshotLines = text.split("\n");
  assert.equal(snapshotLines[0], "─────");
  assert.equal(snapshotLines[1], "aku/worker/1234abcd");
  assert.equal(text.match(/● running/gu)?.length, 1);
  assert.match(snapshotLines[2]!, /^\d{2}:\d{2} · note   /u);
  assert.equal(snapshotLines[3], "      ⋮ 12 omitted");
  assert.match(snapshotLines[4]!, /^ {5} · think  “same minute”$/u);
  assert.equal(snapshotLines.at(-1), "  ● running");
  assert.equal(snapshotLines.filter((line) => line === "─────").length, 1);
  assert.equal((akumaJsonValue(command, result) as { status: typeof status }).status.timeline.omitted, 12);
  assert.equal(renderAkumaText(command, {
    kind: "akuma",
    action: "wait",
    result: { completion: "all", statuses: [{ status }] },
  }), renderAkumaText(command, result));
  const aliasedWait = renderAkumaText(command, {
    kind: "akuma",
    action: "wait",
    alias: "@review",
    result: { completion: "all", statuses: [{ status }] },
  });
  assert.equal(aliasedWait.split("\n")[1], "aku/worker/1234abcd (@review)");
  const answered = {
    ...status,
    life: "asleep" as const,
    timeline: { kind: "idle" as const, entries: [], omitted: 0, outcome: { kind: "outcome" as const, sequence: 1, turnSequence: 1, at: "2026-08-10T16:42:00.000Z", outcome: { kind: "answered" as const, answer: "first answer", historyId: "history-1", session: { sessionId: "session-1" } } } },
  };
  const other = {
    ...answered,
    id: "aku/reviewer/deadbeef",
    timeline: { kind: "idle" as const, entries: [], omitted: 0, outcome: { kind: "outcome" as const, sequence: 1, turnSequence: 1, at: "2026-08-10T16:42:00.000Z", outcome: { kind: "answered" as const, answer: "second answer", historyId: "history-2", session: { sessionId: "session-2" } } } },
  };
  assert.equal(renderAkumaText(command, {
    kind: "akuma",
    action: "wait",
    result: { completion: "any", statuses: [{ status: answered }] },
  }), "first answer");
  const plural = renderAkumaText(command, {
    kind: "akuma",
    action: "wait",
    result: { completion: "all", statuses: [{ status: answered }, { status: other }] },
  });
  assert.match(plural, /aku\/worker\/1234abcd/u);
  assert.match(plural, /first answer/u);
  assert.match(plural, /aku\/reviewer\/deadbeef/u);
  assert.match(plural, /second answer/u);
  const recorded = {
    kind: "akuma",
    action: "tell" as const,
    mode: "ordinary" as const,
    alias: "@review",
    body: "current input",
    result: {
      akuma: status.id,
      tell: { admission: { tellId: "tell-1", fact: "recorded" }, wake: "spawned" },
      observation: { status },
    },
  };
  const recordedText = renderAkumaText(command, recorded);
  assert.equal(recordedText.split("\n")[0], "─────");
  assert.equal(recordedText.split("\n")[1], "aku/worker/1234abcd (@review)");
  assert.deepEqual(akumaJsonValue(command, recorded), recorded.result);
  const recordedLines = recordedText.split("\n");
  assert.equal(renderAkumaText(command, {
    ...recorded,
    result: { ...recorded.result, tell: { admission: { tellId: "tell-1", fact: "recorded" }, wake: { kind: "failed" as const, diagnostic: "spawn\nfailed" } } },
  }), `${recordedLines[0]}\n${recordedLines[1]}\n! error spawn failed\n${recordedLines.slice(2).join("\n")}`);
  const observedTell = {
    kind: "akuma" as const,
    action: "tell" as const,
    mode: "ordinary" as const,
    body: "current input",
    result: {
      akuma: status.id,
      tell: { admission: { tellId: "tell-1", fact: "recorded" as const }, wake: "spawned" as const },
      observation: { status: {
        ...status,
        timeline: {
          ...status.timeline,
          entries: [...status.timeline.entries, { kind: "row" as const, row: {
            kind: "tell" as const,
            sequence: 14,
            at: "2026-08-10T16:43:00.000Z",
            tellId: "tell-1",
            text: "current input",
            state: "told" as const,
          } }],
        },
      } },
    },
  };
  assert.equal(renderAkumaText(command, observedTell).match(/current input/gu)?.length, 1);
  assert.deepEqual(akumaJsonValue(command, observedTell), observedTell.result);
});

test("Akuma snapshot rows use fixed semantic line budgets", () => {
  const command = parseArgv(["status", "aku/worker/1234abcd"]).command;
  const base = {
    id: "aku/worker/1234abcd" as const,
    archetype: "worker",
    life: "running" as const,
    confinement: { kind: "unconfined" as const },
    pending: [],
  };
  const longText = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma";
  const renderRow = (row: import("../src/akuma/index.js").ActivityRow): readonly string[] => {
    const timeline = row.kind === "outcome"
      ? { kind: "idle" as const, entries: [], omitted: 0, outcome: row }
      : { kind: "open" as const, turn: { kind: "turn" as const, sequence: 0, turnSequence: 1, bodySequence: 1, at: row.at }, entries: [{ kind: "row" as const, row }], omitted: 0 };
    const status = {
      ...base,
      timeline,
    };
    const rendered = renderAkumaText(command, { kind: "akuma", action: "status", status: { status } }, { columns: 34, color: false }).split("\n");
    const start = rendered.findIndex((line) => / [·✓!⧖⧗?] /u.test(line) || line.includes("⋮"));
    const footer = rendered.findIndex((line) => /^  (?:●|○|×|\?)/u.test(line));
    return rendered.slice(start === -1 ? 0 : start, footer === -1 ? undefined : footer);
  };
  const rows: readonly Readonly<{ kind: import("../src/akuma/index.js").ActivityRow["kind"]; lines: number; row: import("../src/akuma/index.js").ActivityRow }>[] = [
    {
      kind: "said",
      lines: 2,
      row: { kind: "said", sequence: 1, turnSequence: 1, at: "2026-08-10T16:42:00.000Z", text: longText },
    },
    {
      kind: "thought",
      lines: 2,
      row: { kind: "thought", sequence: 1, turnSequence: 1, at: "2026-08-10T16:42:00.000Z", text: longText },
    },
    {
      kind: "note",
      lines: 2,
      row: { kind: "note", sequence: 1, turnSequence: 1, at: "2026-08-10T16:42:00.000Z", text: longText },
    },
    {
      kind: "tell",
      lines: 1,
      row: { kind: "tell", sequence: 1, at: "2026-08-10T16:42:00.000Z", tellId: "tell-1", text: longText, state: "told" },
    },
    {
      kind: "tool",
      lines: 2,
      row: {
        kind: "tool", sequence: 1, turnSequence: 1, at: "2026-08-10T16:42:00.000Z", name: "Read",
        call: { kind: "read", path: longText }, state: { status: "ok" },
      },
    },
  ];
  for (const item of rows) {
    const lines = renderRow(item.row);
    assert.equal(lines.length, item.lines, item.kind);
    assert.match(lines.at(-1)!, /…(?:”)?$/u, item.kind);
  }

  const history = {
    kind: "akuma" as const,
    action: "history" as const,
    akuma: base.id,
    mode: "page" as const,
    historyResult: {
      kind: "history" as const,
      id: base.id,
      history: {
        rows: [], omitted: 0, hasEarlier: false, hasLater: false,
        historyLost: false, lowestRetained: null, highest: null,
      },
    },
    history: {
      rows: [rows[1]!.row],
      omitted: 0,
      hasEarlier: false,
      hasLater: false,
      historyLost: false,
      lowestRetained: 1,
      highest: 1,
    },
  };
  assert.ok(renderAkumaText(parseArgv(["history", base.id]).command, history, { columns: 34, color: false }).split("\n").length > 3);
});

test("ordinary tell leads with mutation authority before an asleep observation", () => {
  const command = parseArgv(["tell", "aku/worker/1234abcd", "-"]).command;
  const observation = {
    id: "aku/worker/1234abcd" as const,
    archetype: "worker",
    life: "asleep" as const,
    confinement: { kind: "unconfined" as const },
    pending: [],
    timeline: { kind: "idle" as const, entries: [], omitted: 0 },
  };
  const result = {
    kind: "akuma" as const,
    action: "tell" as const,
    mode: "ordinary" as const,
    body: "continue",
    result: {
      akuma: observation.id,
      tell: { admission: { tellId: "tell-1", fact: "recorded" as const }, wake: "spawned" as const },
      observation: { status: observation },
    },
  };
  const text = renderAkumaText(command, result);
  assert.equal(text.split("\n")[0], "─────");
  assert.equal(text.split("\n")[1], "aku/worker/1234abcd");
  assert.deepEqual(akumaJsonValue(command, result), result.result);
});

test("Akuma voice is bounded and active tools carry the live mark", () => {
  const command = parseArgv(["status", "aku/worker/1234abcd"]).command;
  const status = {
    id: "aku/worker/1234abcd",
    life: "running" as const,
    timeline: { kind: "open" as const, turn: { kind: "turn" as const, sequence: 0, turnSequence: 1, bodySequence: 1, at: "2026-08-10T16:42:00.000Z" }, entries: [
      { kind: "row" as const, row: {
        kind: "said" as const, sequence: 1, turnSequence: 1,
        at: "2026-08-10T16:42:00.000Z", text: "hello",
      } },
      { kind: "row" as const, row: {
        kind: "thought" as const, sequence: 2, turnSequence: 1,
        at: "2026-08-10T16:42:01.000Z", text: "considering",
      } },
      { kind: "row" as const, row: {
        kind: "tool" as const, sequence: 3, turnSequence: 1,
        at: "2026-08-10T16:42:02.000Z", name: "Search",
        call: { kind: "search" as const, query: "TODO" }, state: "active" as const,
      } },
    ], omitted: 0 },
  };
  const text = renderAkumaText(command, { kind: "akuma", action: "status", status: { status } });
  assert.match(text, /hello/u);
  assert.match(text, /considering/u);
  assert.match(text, /⧖ search TODO/u);

  const narrow = renderAkumaText(command, {
    kind: "akuma",
    action: "status",
    status: { status: {
      ...status,
      timeline: { ...status.timeline, entries: [{ kind: "row", row: {
        kind: "said", sequence: 1, turnSequence: 1,
        at: "2026-08-10T16:42:00.000Z",
        text: "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon",
      } }] },
    } },
  }, { columns: 30, color: false });
  const narrowLines = narrow.split("\n");
  const voiceStart = narrowLines.findIndex((line) => /^\d{2}:\d{2} · say    /u.test(line));
  assert.ok(voiceStart >= 0);
  const voice = narrowLines.slice(voiceStart, voiceStart + 2).join("\n");
  assert.match(voice, /“alpha/u);
  assert.match(voice, /…”$/u);
  assert.equal(voice.split("\n").length, 2);
  assert.match(voice.split("\n")[1]!, /^ {5} │ {8}“/u);
});

test("Akuma snapshot life uses the fleet vocabulary independently of activity", () => {
  const command = parseArgv(["status", "aku/worker/1234abcd"]).command;
  const base = {
    id: "aku/worker/1234abcd" as const,
    timeline: { kind: "idle" as const, entries: [], omitted: 0 },
  };
  const cases = [
    ["running", "● running"],
    ["asleep", "○ asleep"],
    ["killed", "× killed"],
    ["stranded", "? stranded"],
    ["hung", "? hung"],
    ["untidy", "? untidy"],
  ] as const;
  for (const [life, expected] of cases) {
    const text = renderAkumaText(command, {
      kind: "akuma",
      action: "status",
      status: { status: { ...base, life } },
    });
    assert.ok(text.includes(expected));
  }
});

test("Akuma status-oriented commands include life while tell excludes it", () => {
  const id = "aku/worker/1234abcd" as const;
  const status = {
    id,
    life: "running" as const,
    timeline: { kind: "idle" as const, entries: [], omitted: 0 },
  };
  const observation = { status };
  const tell = { admission: { tellId: "tell-1", fact: "recorded" as const }, wake: "spawned" as const };
  const cases = [
    {
      name: "status",
      command: parseArgv(["status", id]).command,
      result: { kind: "akuma" as const, action: "status" as const, status: observation },
      hasLife: true,
    },
    {
      name: "wait",
      command: parseArgv(["wait", id]).command,
      result: { kind: "akuma" as const, action: "wait" as const, result: { completion: "all" as const, statuses: [observation] } },
      hasLife: true,
    },
    {
      name: "observed call",
      command: parseArgv(["call", "worker", "-"]).command,
      result: {
        kind: "akuma" as const,
        action: "call" as const,
        result: { kind: "called" as const, akuma: id, execution: { cwd: "/world", source: "world" as const }, dispatch: { kind: "none" as const }, alias: { kind: "none" as const }, observation: { kind: "observed" as const, status } },
        world: "/world" as import("../src/index.js").WorldRoot,
      },
      hasLife: true,
    },
    {
      name: "kill",
      command: parseArgv(["kill", id]).command,
      result: { kind: "akuma" as const, action: "kill" as const, result: { results: [{ id, evidence: "hung" as const, observation }] } },
      hasLife: true,
    },
    {
      name: "tell",
      command: parseArgv(["tell", id, "-"]).command,
      result: { kind: "akuma" as const, action: "tell" as const, mode: "ordinary" as const, body: "continue", result: { akuma: id, tell, observation } },
      hasLife: false,
    },
    {
      name: "interrupt tell",
      command: parseArgv(["tell", id, "--interrupt", "-"]).command,
      result: {
        kind: "akuma" as const,
        action: "tell" as const,
        mode: "interrupt" as const,
        body: "replace",
        result: { id, receipt: { kind: "interrupted" as const, putDown: "self-aborted" as const, tell }, observation },
      },
      hasLife: false,
    },
    {
      name: "history",
      command: parseArgv(["history", id]).command,
      result: {
        kind: "akuma" as const,
        action: "history" as const,
        akuma: id,
        mode: "page" as const,
        history: { rows: [], omitted: 0, hasEarlier: false, hasLater: false, historyLost: false, lowestRetained: null, highest: null },
        historyResult: { kind: "history" as const, id, history: { rows: [], omitted: 0, hasEarlier: false, hasLater: false, historyLost: false, lowestRetained: null, highest: null } },
      },
      hasLife: false,
    },
  ] satisfies readonly Readonly<{
    name: string;
    command: ReturnType<typeof parseArgv>["command"];
    result: AkumaInvocationResult;
    hasLife: boolean;
  }>[];
  for (const item of cases) {
    assert.equal(renderAkumaText(item.command, item.result).includes("● running"), item.hasLife, item.name);
  }
});

test("Akuma text renders only a none readonly restraint as an existing ! line", () => {
  const id = "aku/worker/1234abcd" as const;
  const base = { id, life: "running" as const, timeline: { kind: "idle" as const, entries: [], omitted: 0 } };
  const command = parseArgv(["status", id]).command;
  const none = renderAkumaText(command, {
    kind: "akuma" as const,
    action: "status" as const,
    status: {
      status: {
        ...base,
        readonly: { enforcement: "none" as const, diagnostic: "ACP cannot remove task-surface mutation capabilities" },
      },
    },
  });
  assert.ok(none.includes("! ACP cannot remove task-surface mutation capabilities"));
  const native = renderAkumaText(command, {
    kind: "akuma" as const,
    action: "status" as const,
    status: { status: { ...base, readonly: { enforcement: "native" as const } } },
  });
  assert.ok(!native.includes("! "));
  const absent = renderAkumaText(command, {
    kind: "akuma" as const,
    action: "status" as const,
    status: { status: base },
  });
  assert.ok(!absent.includes("! "));
});

function toolRow(
  call: Extract<ActivityRow, { kind: "tool" }>["call"],
  state: Extract<ActivityRow, { kind: "tool" }>["state"] = { status: "ok" },
  extra: Partial<Extract<ActivityRow, { kind: "tool" }>> = {},
): Extract<ActivityRow, { kind: "tool" }> {
  return {
    kind: "tool",
    sequence: 1,
    turnSequence: 1,
    at: "2026-08-10T16:42:00.000Z",
    name: "Tool",
    call,
    state,
    ...extra,
  };
}

test("ToolRepr presents honest read ranges, search facts, outcomes, and transport unwrap", () => {
  assert.deepEqual(toolRepr(toolRow({ kind: "read", path: "src/a.ts", offset: 10, limit: 20 })), {
    label: "read",
    text: "src/a.ts · L10-29 — ok",
  });
  assert.equal(toolRepr(toolRow({ kind: "read", path: "src/a.ts", offset: 10 })).text, "src/a.ts · from L10 — ok");
  assert.equal(toolRepr(toolRow({ kind: "read", path: "src/a.ts", limit: 7 })).text, "src/a.ts · 7 lines — ok");
  assert.equal(toolRepr(toolRow({ kind: "read", path: "src/a.ts" })).text, "src/a.ts — ok");
  assert.deepEqual(
    toolRepr(toolRow({ kind: "search", query: "TODO", scope: "content", path: "src", glob: "*.ts" })),
    { label: "search", text: "TODO · src · *.ts — ok" },
  );
  assert.deepEqual(
    toolRepr(toolRow({ kind: "search", query: "*.md", scope: "files", path: "docs" })),
    { label: "find", text: "*.md · docs — ok" },
  );
  assert.deepEqual(
    toolRepr(toolRow({ kind: "search", query: "keiyaku", scope: "web" })),
    { label: "web", text: "keiyaku — ok" },
  );
  assert.deepEqual(toolRepr(toolRow({ kind: "search", query: "TODO" })), {
    label: "search",
    text: "TODO — ok",
  });

  assert.deepEqual(toolRepr(toolRow({ kind: "search", query: "active" }, "active")), {
    label: "search",
    text: "active",
  });
  assert.deepEqual(toolRepr(toolRow({ kind: "search", query: "unsettled" }, "unsettled")), {
    label: "search",
    text: "unsettled",
  });

  const completedRun = toolRepr(toolRow(
    { kind: "run", command: "bash -lc 'npm test'" },
    { status: "ok", exitCode: 0 },
    { durationMs: 1_500 },
  ));
  assert.equal(completedRun.label, "run");
  assert.equal(completedRun.text, "$ npm test");
  assert.equal(completedRun.overflow, "middle-ellipsis");
  assert.equal(completedRun.suffix, " — 2s · ok");

  assert.equal(
    toolRepr(toolRow({ kind: "fileChange", changes: [{ op: "update", path: "src/a.ts", diffstat: { added: 3, removed: 1 } }] })).text,
    "src/a.ts — +3 -1",
  );
  assert.equal(
    toolRepr(toolRow({
      kind: "fileChange",
      changes: [
        { op: "update", path: "src/a.ts", diffstat: { added: 1, removed: 0 } },
        { op: "add", path: "src/b.ts", diffstat: { added: 2, removed: 0 } },
      ],
    })).text,
    "2 files · src/a.ts ... — +3 -0",
  );

  assert.equal(normalizeToolCommand("bash -c 'rg TODO src'"), "rg TODO src");
  assert.equal(normalizeToolCommand("/bin/zsh -lc \"git status\""), "git status");
  assert.equal(normalizeToolCommand("pwsh -NoLogo -NoProfile -Command Get-ChildItem"), "Get-ChildItem");
  assert.equal(normalizeToolCommand("bash -c 'echo hi' && true"), "bash -c 'echo hi' && true");
  assert.equal(normalizeToolCommand("npm test"), "npm test");
});

test("normalizeToolCommand preserves exact bytes unless a complete transport unwraps", () => {
  const cases = [
    ["bash -c 'rg TODO src'", "rg TODO src"],
    ["/bin/zsh -lc \"git status\"", "git status"],
    ["pwsh -NoLogo -NoProfile -Command Get-ChildItem", "Get-ChildItem"],
    ["powershell -nologo -Command Get-ChildItem", "Get-ChildItem"],
    ["pwsh -c Get-ChildItem", "Get-ChildItem"],
    ["C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe -Command Get-ChildItem", "Get-ChildItem"],
    ["/usr/bin/pwsh -NoProfile -Command Get-ChildItem", "Get-ChildItem"],
    ["/usr/bin/bash -c 'rg TODO src'", "rg TODO src"],
    ["bash -c foo\\ bar", "foo bar"],
    ["bash -c \"git \\\"status\\\"\"", "git \"status\""],
    ["bash -c \"foo\\\\bar\"", "foo\\bar"],
    ["bash -c \"foo\\$bar\"", "foo$bar"],
    ["bash -c \"foo\\`bar\"", "foo`bar"],
    ["bash -c \"foo\\nbar\"", "foo\\nbar"],
    ["bash -c \"\"foo\"\"", "foo"],
    ["bash -c ' '", " "],
    ["  bash\t-c\t'rg TODO src'  ", "rg TODO src"],
    ["npm test", "npm test"],
    ["bash -c 'echo hi' && true", "bash -c 'echo hi' && true"],
    ["bash -c 'echo hi' || true", "bash -c 'echo hi' || true"],
    ["bash -c 'echo hi'; true", "bash -c 'echo hi'; true"],
    ["bash -c 'echo hi' | true", "bash -c 'echo hi' | true"],
    ["bash -c $(echo hi)", "bash -c $(echo hi)"],
    ["bash -c `echo hi`", "bash -c `echo hi`"],
    ["bash -c <file", "bash -c <file"],
    ["bash -c >file", "bash -c >file"],
    ["bash -c (echo hi)", "bash -c (echo hi)"],
    ["bash -c \"echo $HOME\"", "bash -c \"echo $HOME\""],
    ["bash -c \"echo `date`\"", "bash -c \"echo `date`\""],
    ["bash -c 'unclosed", "bash -c 'unclosed"],
    ["bash -c \"unclosed", "bash -c \"unclosed"],
    ["bash -c foo\\", "bash -c foo\\"],
    ["bash -c \"foo\\", "bash -c \"foo\\"],
    ["bash -c 'line\nbreak'", "line\nbreak"],
    ["bash -c \"line\nbreak\"", "line\nbreak"],
    ["bash -c 'line\rbreak'", "line\rbreak"],
    ["bash -c foo\nbar", "bash -c foo\nbar"],
    ["bash -c foo\\\nbar", "bash -c foo\\\nbar"],
    ["bash -c 'foo'\nbar", "bash -c 'foo'\nbar"],
    ["bash -c ''", "bash -c ''"],
    ["bash -c \"\"", "bash -c \"\""],
    ["bash -lc 'npm test' extra", "bash -lc 'npm test' extra"],
    ["bash -l 'npm test'", "bash -l 'npm test'"],
    ["./bash -c 'rg TODO src'", "./bash -c 'rg TODO src'"],
    ["/bin/sh -c 'rg TODO src'", "/bin/sh -c 'rg TODO src'"],
    ["Bash -c 'rg TODO src'", "Bash -c 'rg TODO src'"],
    ["pwsh.exe -Command Get-ChildItem", "pwsh.exe -Command Get-ChildItem"],
    ["powershell.exe -Command Get-ChildItem", "powershell.exe -Command Get-ChildItem"],
    ["PowerShell -Command Get-ChildItem", "Get-ChildItem"],
    ["pwsh -NoLogo -NoLogo -Command Get-ChildItem", "pwsh -NoLogo -NoLogo -Command Get-ChildItem"],
    ["pwsh -File script.ps1", "pwsh -File script.ps1"],
    ["pwsh -Command Get-ChildItem extra", "pwsh -Command Get-ChildItem extra"],
    ["pwsh -Command", "pwsh -Command"],
    ["pwsh Get-ChildItem", "pwsh Get-ChildItem"],
    ["pwsh -Command ''", "pwsh -Command ''"],
    ["pwsh -Command Get-ChildItem -NoLogo", "pwsh -Command Get-ChildItem -NoLogo"],
  ] as const;
  for (const [command, expected] of cases) {
    assert.equal(normalizeToolCommand(command), expected);
  }
});

test("Akuma history distinguishes open active tools from closed unsettled tools", () => {
  const akuma = "aku/worker/1234abcd" as const;
  const command = parseArgv(["history", akuma]).command;
  const history = {
    rows: [
      {
        kind: "tool" as const,
        sequence: 1,
        turnSequence: 1,
        at: "2026-08-10T16:42:00.000Z",
        name: "Search",
        call: { kind: "search" as const, query: "active" },
        state: "active" as const,
      },
      {
        kind: "tool" as const,
        sequence: 2,
        turnSequence: 2,
        at: "2026-08-10T16:43:00.000Z",
        name: "Search",
        call: { kind: "search" as const, query: "unsettled" },
        state: "unsettled" as const,
      },
    ],
    omitted: 0,
    hasEarlier: false,
    hasLater: false,
    historyLost: false,
    lowestRetained: 1,
    highest: 2,
  };
  const result = {
    kind: "akuma" as const,
    action: "history" as const,
    akuma,
    mode: "page" as const,
    history,
    historyResult: { kind: "history" as const, id: akuma, history },
  };
  const text = renderAkumaText(command, result);
  assert.match(text, /\d{2}:\d{2} ⧖ search active/u);
  assert.match(text, /\d{2}:\d{2} \? search unsettled/u);
});

test("Akuma semantic glyphs mark successful tools and pending tells", () => {
  const command = parseArgv(["status", "aku/worker/1234abcd"]).command;
  const at = "2026-08-10T16:42:00.000Z";
  const cases = [
    {
      name: "successful tool",
      glyph: "✓",
      row: {
        kind: "tool" as const,
        sequence: 1,
        turnSequence: 1,
        at,
        name: "Search",
        call: { kind: "search" as const, query: "done" },
        state: { status: "ok" as const },
      },
    },
    {
      name: "pending tell",
      glyph: "⧗",
      row: {
        kind: "tell" as const,
        sequence: 1,
        at,
        tellId: "tell-1",
        text: "steer",
        state: "pending" as const,
      },
    },
  ] as const;
  for (const item of cases) {
    const text = renderAkumaText(command, {
      kind: "akuma",
      action: "status",
      status: { status: {
        id: "aku/worker/1234abcd",
        life: "running",
        timeline: {
          kind: "open",
          turn: { kind: "turn", sequence: 0, turnSequence: 1, bodySequence: 1, at },
          entries: [{ kind: "row", row: item.row }],
          omitted: 0,
        },
      } },
    });
    assert.match(text, new RegExp(String.raw`\d{2}:\d{2} ${item.glyph} `, "u"), item.name);
  }
});

test("Akuma header shows a complete associated Contract without truncating identity", () => {
  const command = parseArgv(["status", "aku/worker/1234abcd"]).command;
  const text = renderAkumaText(command, {
    kind: "akuma",
    action: "status",
    status: { status: {
      id: "aku/worker/1234abcd",
      archetype: "worker",
      life: "running",
      confinement: { kind: "unconfined" },
      pending: [],
      timeline: { kind: "unborn", entries: [], omitted: 0 },
    }, contractId: "kei/provider-core-review" },
  }, { columns: 28, color: false });
  const lines = text.split("\n");
  assert.equal(lines[0], "─────");
  assert.equal(lines[1], "aku/worker/1234abcd");
  assert.equal(lines[2], "└─ kei/provider-core-review");
  assert.equal(lines[3], "  ● running");
  assert.doesNotMatch(lines[1]!, /●|○|×|\?/u);
  assert.match(text, /kei\/provider-core-review/u);
});

test("Akuma run commands stay on one row and preserve their head and tail", () => {
  const command = parseArgv(["status", "aku/worker/1234abcd"]).command;
  const status = {
    id: "aku/worker/1234abcd",
    life: "running" as const,
    timeline: { kind: "open" as const, turn: { kind: "turn" as const, sequence: 0, turnSequence: 1, bodySequence: 1, at: "2026-08-10T16:42:00.000Z" }, entries: [{ kind: "row" as const, row: {
      kind: "tool" as const, sequence: 1, turnSequence: 1,
      at: "2026-08-10T16:42:00.000Z", name: "Shell",
      call: { kind: "run" as const, command: "npm test -- --configuration production --reporter final.json" },
      state: "active" as const,
    } }], omitted: 0 },
  };
  const text = renderAkumaText(command, { kind: "akuma", action: "status", status: { status } }, { columns: 42, color: false });
  const runLine = (rendered: string): string => {
    const line = rendered.split("\n").find((candidate) => candidate.includes(" run    "));
    assert.ok(line !== undefined);
    return line;
  };
  assert.match(runLine(text), /^\d{2}:\d{2} ⧖ run    \$ npm test/u);
  assert.match(runLine(text), /….*final\.json$/u);

  const completedText = renderAkumaText(command, {
    kind: "akuma",
    action: "status",
    status: { status: {
      ...status,
      timeline: { ...status.timeline, entries: [{ kind: "row", row: {
        ...status.timeline.entries[0]!.row,
        state: { status: "failed", exitCode: 1 },
        durationMs: 41_000,
      } }] },
    } },
  }, { columns: 50, color: false });
  const completed = runLine(completedText);
  assert.match(completed, /\$ npm test/u);
  assert.match(completed, /….*inal\.json — 41s · exit 1$/u);
  assert.match(completed, /^\d{2}:\d{2} ! run   /u);
  assert.match(completedText, /● running/u);

  const unicode = runLine(renderAkumaText(command, {
    kind: "akuma",
    action: "status",
    status: { status: {
      ...status,
      timeline: { ...status.timeline, entries: [{ kind: "row", row: {
        ...status.timeline.entries[0]!.row,
        call: { kind: "run", command: "printf long-command-ending-in-界́" },
      } }] },
    } },
  }, { columns: 24, color: false }));
  assert.match(unicode, /….*界́$/u);
  assert.doesNotMatch(unicode, /…\p{Mark}/u);

  const combiningHead = runLine(renderAkumaText(command, {
    kind: "akuma",
    action: "status",
    status: { status: {
      ...status,
      timeline: { ...status.timeline, entries: [{ kind: "row", row: {
        ...status.timeline.entries[0]!.row,
        call: { kind: "run", command: "界́abcdefghijklmnopqrstuvwxyz-final.json" },
      } }] },
    } },
  }, { columns: 24, color: false }));
  assert.ok(displayColumns(combiningHead) <= 24);
  assert.match(combiningHead, /界́/u);

  const narrowCompletedText = renderAkumaText(command, {
    kind: "akuma",
    action: "status",
    status: { status: {
      ...status,
      timeline: { ...status.timeline, entries: [{ kind: "row", row: {
        ...status.timeline.entries[0]!.row,
        state: { status: "failed", exitCode: 1 },
        durationMs: 41_000,
      } }] },
    } },
  }, { columns: 30, color: false });
  const narrowCompleted = runLine(narrowCompletedText);
  for (const line of narrowCompletedText.split("\n")) {
    assert.ok(displayColumns(line) <= 30);
  }
  assert.match(narrowCompleted, /\$ npm t/u);
  assert.match(narrowCompleted, /….*\.json$/u);
  assert.doesNotMatch(narrowCompleted, /exit 1|41s/u);

  const shortSuccessText = renderAkumaText(command, {
    kind: "akuma",
    action: "status",
    status: { status: {
      ...status,
      timeline: { ...status.timeline, entries: [{ kind: "row", row: {
        ...status.timeline.entries[0]!.row,
        state: { status: "ok", exitCode: 0 },
        durationMs: 1_000,
      } }] },
    } },
  }, { columns: 28, color: false });
  const shortSuccess = runLine(shortSuccessText);
  for (const line of shortSuccessText.split("\n")) {
    assert.ok(displayColumns(line) <= 28);
  }
  assert.match(shortSuccess, /\$ npm/u);
  assert.match(shortSuccess, /….*json/u);
  assert.doesNotMatch(shortSuccess, /\$…/u);
  assert.doesNotMatch(shortSuccess, /ok|1s/u);
});

test("Akuma follow remains outside the unsettled CLI vocabulary", () => {
  assert.throws(() => parseArgv(["follow", "aku/claude/1234abcd"]), CliUsageError);
});

test("akuma call renders optional integration stages and maps partial success", () => {
  const command = parseArgv(["call", "worker", "-"]).command;
  const akuma = "aku/worker/1234abcd" as import("../src/index.js").AkuId;
  const plain = {
    kind: "akuma" as const,
    action: "call" as const,
    result: {
      kind: "called" as const,
      akuma,
      execution: { cwd: "/world", source: "world" as const },
      dispatch: { kind: "none" as const },
      alias: { kind: "none" as const },
      observation: { kind: "detached" as const },
    },
    world: "/world" as import("../src/index.js").WorldRoot,
  };
  assert.equal(renderAkumaText(command, plain), `─────\n${akuma}\n$ keiyaku -C /world wait ${akuma} --timeout 5m`);
  const managed = {
    ...plain,
    result: {
      ...plain.result,
      execution: { cwd: "/repo/.git/keiyaku/wt/atlantis", source: "contract-worktree" as const },
    },
  };
  assert.equal(
    renderAkumaText(command, managed),
    `─────\n${akuma}\ncwd /repo/.git/keiyaku/wt/atlantis\n$ keiyaku -C /world wait ${akuma} --timeout 5m`,
  );
  assert.deepEqual(akumaJsonValue(command, plain), plain.result);
  assert.equal(akumaExitCode(plain), 0);

  const integrated = {
    ...plain,
    result: {
      ...plain.result,
      dispatch: {
        kind: "dispatched" as const,
        dispatch: { akuId: akuma, contractId: "kei/work" as import("../src/index.js").ContractId, dispatchedAt: "2026-08-11T00:00:00.000Z" },
      },
      alias: {
        kind: "aliased" as const,
        alias: { alias: "@worker" as import("../src/index.js").AkumaAlias, akuId: akuma },
        previous: null,
      },
    },
  };
  assert.equal(renderAkumaText(command, integrated), `─────\n${akuma} (@worker)\n└─ kei/work\n$ keiyaku -C /world wait @worker --timeout 5m`);
  assert.equal(akumaExitCode(integrated), 0);

  const partial = {
    ...plain,
    result: {
      ...plain.result,
      dispatch: { kind: "failed" as const, failure: { kind: "contention" as const } },
      alias: { kind: "skipped" as const, reason: "dispatch-failed" as const },
    },
  };
  assert.equal(renderAkumaText(command, partial), `─────\n${akuma}\ndispatch failed contention`);
  assert.doesNotMatch(renderAkumaText(command, partial), /keiyaku wait/u);
  assert.equal(akumaExitCode(partial), 2);

  const aliasFailed = {
    ...plain,
    result: {
      ...plain.result,
      alias: { kind: "failed" as const, failure: { kind: "infrastructure" as const, diagnostic: "alias locked" } },
    },
  };
  assert.equal(renderAkumaText(command, aliasFailed), `─────\n${akuma}\nalias failed infrastructure alias locked`);
  assert.doesNotMatch(renderAkumaText(command, aliasFailed), /keiyaku wait/u);
  assert.equal(akumaExitCode(aliasFailed), 2);

  const answered = {
    ...plain,
    result: {
      ...plain.result,
      observation: {
        kind: "observed" as const,
        status: {
          id: akuma,
          life: "asleep" as const,
          timeline: {
            kind: "idle" as const,
            entries: [],
            omitted: 0,
            outcome: {
              kind: "outcome" as const,
              sequence: 1,
              turnSequence: 1,
              at: "2026-08-10T16:42:00.000Z",
              outcome: { kind: "answered" as const, answer: "finished", historyId: "history", session: { sessionId: "session" } },
            },
          },
        },
      },
    },
  };
  const answeredText = renderAkumaText(command, answered);
  assert.equal(answeredText, "finished");
  assert.equal(akumaExitCode(answered), 0);

  const answeredAfterDispatchFailure = {
    ...answered,
    result: {
      ...answered.result,
      dispatch: { kind: "failed" as const, failure: { kind: "contention" as const } },
    },
  };
  assert.match(renderAkumaText(command, answeredAfterDispatchFailure), /dispatch failed contention/u);
  assert.notEqual(renderAkumaText(command, answeredAfterDispatchFailure), "finished");
  assert.equal(akumaExitCode(answeredAfterDispatchFailure), 2);

  const running = {
    ...plain,
    result: {
      ...plain.result,
      observation: {
        kind: "observed" as const,
        status: {
          id: akuma,
          life: "running" as const,
          timeline: {
            kind: "open" as const,
            turn: { kind: "turn" as const, sequence: 1, turnSequence: 1, bodySequence: 1, at: "2026-08-10T16:42:00.000Z" },
            entries: [],
            omitted: 0,
          },
        },
      },
    },
  };
  const waitCommand = parseArgv(["wait", akuma]).command;
  const waited = { kind: "akuma" as const, action: "wait" as const, result: { completion: "all" as const, statuses: [{ status: running.result.observation.status }] } };
  assert.equal(renderAkumaText(command, running), renderAkumaText(waitCommand, waited));

  const failedTurn = {
    ...answered,
    result: {
      ...answered.result,
      observation: {
        kind: "observed" as const,
        status: {
          ...answered.result.observation.status,
          timeline: {
            kind: "idle" as const,
            entries: [],
            omitted: 0,
            outcome: {
              kind: "outcome" as const,
              sequence: 1,
              turnSequence: 1,
              at: "2026-08-10T16:42:00.000Z",
              outcome: { kind: "failed" as const, diagnostic: "turn failed" },
            },
          },
        },
      },
    },
  };
  assert.match(renderAkumaText(command, failedTurn), /! error\s+turn failed/u);
  assert.equal(akumaExitCode(failedTurn), 2);

  const observationFailed = {
    ...plain,
    result: {
      ...plain.result,
      observation: {
        kind: "failed" as const,
        failure: { kind: "infrastructure" as const, diagnostic: "heart unavailable" },
      },
    },
  };
  assert.equal(renderAkumaText(command, observationFailed), `─────\n${akuma}\n! error heart unavailable`);
  assert.equal(akumaExitCode(observationFailed), 2);
});

test("akuma fork renders the public receipt and maps every exit class", () => {
  const command = parseArgv(["fork", "aku/claude/1234abcd", "--at", "history-1"]).command;
  const parent = "aku/claude/1234abcd" as import("../src/akuma/index.js").AkuId;
  const result = (receipt: import("../src/index.js").ForkResult) => ({
    kind: "akuma" as const,
    action: "fork" as const,
    receipt,
  });
  const forked = result({
    kind: "forked",
    parent,
    child: "aku/claude/87654321" as import("../src/akuma/index.js").AkuId,
    dispatch: { kind: "none" },
  });
  assert.equal(renderAkumaText(command, forked), "aku/claude/87654321");
  assert.equal(akumaExitCode(forked), 0);
  assert.deepEqual(akumaJsonValue(command, forked), forked.receipt);
  const dispatched = result({
    kind: "forked",
    parent,
    child: "aku/claude/87654321" as import("../src/akuma/index.js").AkuId,
    dispatch: {
      kind: "dispatched",
      dispatch: {
        akuId: "aku/claude/87654321" as import("../src/akuma/index.js").AkuId,
        contractId: "kei/work" as import("../src/index.js").ContractId,
        dispatchedAt: "2026-08-11T00:00:00.000Z",
      },
    },
  });
  assert.equal(renderAkumaText(command, dispatched), "aku/claude/87654321 [kei/work]");

  const incapable = result({ kind: "provider-cannot-fork", provider: "claude", parent });
  assert.equal(renderAkumaText(command, incapable), "claude cannot fork");
  assert.equal(akumaExitCode(incapable), 1);
  const unknown = result({ kind: "unknown-history", at: "history-1", parent });
  assert.equal(renderAkumaText(command, unknown), "history-1 has no matching retained answered turn");
  assert.equal(akumaExitCode(unknown), 1);
  const failed = result({ kind: "fork-failed", diagnostic: "native refused", parent });
  assert.equal(renderAkumaText(command, failed), "native refused");
  assert.equal(akumaExitCode(failed), 1);
  const partial = result({ kind: "upstream-forked", childSession: { sessionId: "native-child" }, diagnostic: "local failed", parent });
  assert.equal(renderAkumaText(command, partial), "local failed");
  assert.equal(akumaExitCode(partial), 2);
});

test("tell --interrupt renders the public receipt and maps every exit class", () => {
  const parsed = parseArgv(["tell", "aku/claude/1d1e0004", "--interrupt", "-"]);
  const interrupted = {
    kind: "akuma" as const,
    action: "tell" as const,
    mode: "interrupt" as const,
    body: "replace",
    result: {
      id: "aku/claude/1d1e0004" as const,
      receipt: {
        kind: "interrupted" as const,
        putDown: "self-aborted" as const,
        tell: { admission: { tellId: "tell-1", fact: "recorded" as const }, wake: "spawned" as const },
      },
      observation: { status: {
        id: "aku/claude/1d1e0004" as const,
        life: "asleep" as const,
        timeline: { entries: [], lowestRetained: null, highest: null },
      }, contractId: "kei/provider-core-review" as const },
    },
  };
  const interruptedText = renderAkumaText(parsed.command, interrupted);
  assert.equal(interruptedText.split("\n")[0], "─────");
  assert.equal(interruptedText.split("\n")[1], "aku/claude/1d1e0004");
  assert.equal(interruptedText.split("\n")[2], "└─ kei/provider-core-review");
  assert.doesNotMatch(interruptedText, /(?:^|\n)contract /u);
  assert.equal(akumaExitCode(interrupted), 0);

  const wakeFailed = {
    ...interrupted,
    result: {
      ...interrupted.result,
      receipt: {
        ...interrupted.result.receipt,
        tell: {
          admission: { tellId: "tell-1", fact: "recorded" as const },
          wake: { kind: "failed" as const, diagnostic: "spawn" },
        },
      },
    },
  };
  assert.match(renderAkumaText(parsed.command, wakeFailed), /^─────\naku\/claude\/1d1e0004/u);
  assert.equal(akumaExitCode(wakeFailed), 0);

  const unavailable = {
    ...interrupted,
    result: {
      ...interrupted.result,
      receipt: { kind: "unavailable" as const, evidence: "hung" as const },
    },
  };
  assert.match(renderAkumaText(parsed.command, unavailable), /^─────\naku\/claude\/1d1e0004/u);
  assert.equal(akumaExitCode(unavailable), 1);
});

test("Akuma status, wait, and history share public observations without embedding history", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-cli-akuma-status-"));
  try {
    const allocated = await allocateAkumaDirectory({
      worldRoot: root,
      archetype: "claude",
      draw: () => "1234abcd",
    });
    await initializeHeart(allocated.paths);
    const provider: ProviderAdapter = {
      confinement: () => ({ kind: "unconfined" }),
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
        confinement: { kind: "unconfined" },
        cwd: root,
      },
      initialBody: "work",
    }, provider, {
      now: () => "2026-08-08T00:00:00.000Z",
    });

    const parsedStatus = parseArgv(["-C", root, "status", allocated.id]);
    const statusResult = await invoke(parsedStatus, { readStdin: () => { throw new Error("status must not read stdin"); } });
    assert.equal("kind" in statusResult && statusResult.kind, "akuma");
    if (!("kind" in statusResult) || statusResult.kind !== "akuma" || statusResult.action !== "status") return;
    assert.equal(statusResult.status.status.timeline.kind === "idle"
      && statusResult.status.status.timeline.outcome?.outcome.kind === "answered", true);
    assert.equal("history" in statusResult.status.status, false);
    assert.deepEqual(statusResult.status.status.timeline.entries, []);

    const waitResult = await invoke(parseArgv(["-C", root, "wait", allocated.id, "--timeout", "0ms"]), {
      readStdin: () => { throw new Error("wait must not read stdin"); },
    });
    assert.equal("kind" in waitResult && waitResult.kind, "akuma");
    if (!("kind" in waitResult) || waitResult.kind !== "akuma" || waitResult.action !== "wait") return;
    assert.deepEqual(waitResult.result.statuses, [statusResult.status]);
    assert.equal(renderAkumaText(parseArgv(["wait", allocated.id]).command, waitResult), "cli answer");
    assert.equal(akumaRawAnswer(waitResult), "cli answer");
    const waited = await captureMain(["-C", root, "wait", allocated.id, "--timeout", "0ms"]);
    assert.equal(waited.code, 0);
    assert.equal(waited.stdout, "cli answer");
    await moveAlias({ world: root, alias: "@review", akuId: allocated.id });
    const aliasWait = await invoke(parseArgv(["-C", root, "wait", "@review", "--timeout", "0ms"]));
    assert.equal("kind" in aliasWait && aliasWait.kind === "akuma" && aliasWait.action === "wait"
      ? aliasWait.alias : undefined, "@review");
    if (!("kind" in aliasWait) || aliasWait.kind !== "akuma" || aliasWait.action !== "wait") return;
    assert.equal(renderAkumaText(parseArgv(["wait", "@review"]).command, aliasWait), "cli answer");
    const aliasOut = await captureMain(["-C", root, "wait", "@review", "--timeout", "0ms"]);
    assert.equal(aliasOut.code, 0);
    assert.equal(aliasOut.stdout, "cli answer");

    const laterTurn = await beginTurn(allocated.paths, {
      bodySequence: 1,
      startedAt: "2026-08-08T00:00:01.000Z",
    });
    await endTurn(allocated.paths, {
      turnSequence: laterTurn.sequence,
      outcome: { kind: "failed", diagnostic: "later failed" },
      completedAt: "2026-08-08T00:00:01.000Z",
    });
    const failedStatus = await invoke(parseArgv(["-C", root, "status", allocated.id]));
    if (!("kind" in failedStatus) || failedStatus.kind !== "akuma" || failedStatus.action !== "status") return;
    assert.equal(failedStatus.status.status.timeline.kind === "idle"
      && failedStatus.status.status.timeline.outcome?.outcome.kind === "failed", true);
    const failedWait = await captureMain(["-C", root, "wait", allocated.id, "--timeout", "0ms"]);
    assert.equal(failedWait.code, 0);
    assert.match(failedWait.stdout, /! error\s+later failed/u);
    assert.match(failedWait.stdout, / {2}○ asleep\n$/u);
    assert.notEqual(failedWait.stdout, "cli answer");
    assert.equal(akumaRawAnswer({
      kind: "akuma",
      action: "wait",
      result: { completion: "all", statuses: [failedStatus.status] },
    }), undefined);

    const historyParsed = parseArgv(["-C", root, "history", allocated.id]);
    const historyResult = await invoke(historyParsed, { readStdin: () => { throw new Error("history must not read stdin"); } });
    if (!("kind" in historyResult) || historyResult.kind !== "akuma" || historyResult.action !== "history") return;
    assert.deepEqual(historyResult.history.rows.filter((row) => row.kind === "outcome").map((row) => row.outcome), [
      { kind: "answered", answer: "cli answer", historyId: "cli-history", session: { sessionId: "cli-session" } },
      { kind: "failed", diagnostic: "later failed" },
    ]);
    const limitedHistory = await invoke(parseArgv(["-C", root, "history", allocated.id, "--limit", "1"]));
    if (!("kind" in limitedHistory) || limitedHistory.kind !== "akuma" || limitedHistory.action !== "history") return;
    assert.equal(limitedHistory.history.rows.length, 1);
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
      receipt: { kind: "unknown-history", at: "missing-history", parent: allocated.id },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    confinement: () => ({ kind: "unconfined" }),
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
      confinement: { kind: "unconfined" },
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

test("history --last renders typed no-answer and preserves answered empty bytes", () => {
  const command = parseArgv(["history", "aku/worker/00000001", "--last"]).command;
  const noAnswer = {
    kind: "akuma" as const,
    action: "history" as const,
    akuma: "aku/worker/00000001" as const,
    mode: "no-answer" as const,
    historyResult: {
      kind: "no-answer" as const,
      id: "aku/worker/00000001" as const,
      contractId: "kei/provider-core-review" as const,
    },
  };
  assert.equal(renderAkumaText(command, noAnswer), "no answer retained");
  assert.deepEqual(akumaJsonValue(command, noAnswer), {
    kind: "no-answer",
    id: "aku/worker/00000001",
    contractId: "kei/provider-core-review" as const,
  });
  assert.equal(akumaExitCode(noAnswer), 0);

  const emptyAnswer = {
    ...noAnswer,
    mode: "last" as const,
    answer: "",
    historyResult: {
      kind: "last" as const,
      id: noAnswer.akuma,
      answer: "",
      contractId: noAnswer.historyResult.contractId,
    },
  };
  assert.equal(renderAkumaText(command, emptyAnswer), "");
  assert.deepEqual(akumaJsonValue(command, emptyAnswer), {
    kind: "last",
    id: "aku/worker/00000001",
    answer: "",
    contractId: "kei/provider-core-review" as const,
  });
  assert.equal(akumaExitCode(emptyAnswer), 0);
});

test("one raw-answer decision writes exact wait bytes and keeps unfinished observations as snapshots", () => {
  const id = "aku/worker/1234abcd" as const;
  const other = "aku/reviewer/deadbeef" as const;
  const waitCommand = parseArgv(["wait", id]).command;
  const answered = (answer: string, life: "asleep" | "running" | "killed" | "stranded" | "hung" | "untidy" = "asleep") => ({
    status: {
      id,
      life,
      timeline: {
        kind: "idle" as const,
        entries: [],
        omitted: 0,
        outcome: {
          kind: "outcome" as const,
          sequence: 1,
          turnSequence: 1,
          at: "2026-08-10T16:42:00.000Z",
          outcome: { kind: "answered" as const, answer, historyId: "history", session: { sessionId: "session" } },
        },
      },
    },
  });
  const waitOf = (...statuses: readonly AkumaStatusView[]): Extract<AkumaInvocationResult, { action: "wait" }> => ({
    kind: "akuma",
    action: "wait",
    result: { completion: "all", statuses },
  });
  const multiline = "line one\nline two\n";
  const complete = waitOf(answered(multiline));
  const call = {
    kind: "akuma" as const,
    action: "call" as const,
    result: {
      kind: "called" as const,
      akuma: id,
      execution: { cwd: "/world", source: "world" as const },
      dispatch: { kind: "none" as const },
      alias: { kind: "none" as const },
      observation: { kind: "observed" as const, status: complete.result.statuses[0]!.status },
    },
    world: "/world" as import("../src/index.js").WorldRoot,
  };
  const cases = [
    { name: "multiline", result: complete, raw: multiline },
    { name: "empty", result: waitOf(answered("")), raw: "" },
    { name: "trailing", result: waitOf(answered("kept\n")), raw: "kept\n" },
    { name: "call", result: call, command: parseArgv(["call", "worker", "-"]).command, raw: multiline },
    { name: "running", result: waitOf(answered("kept", "running")), fact: / {2}● running$/u },
    { name: "killed", result: waitOf(answered("kept", "killed")), fact: / {2}× killed$/u },
    { name: "stranded", result: waitOf(answered("kept", "stranded")), fact: / {2}\? stranded$/u },
    { name: "hung", result: waitOf(answered("kept", "hung")), fact: / {2}\? hung$/u },
    { name: "untidy", result: waitOf(answered("kept", "untidy")), fact: / {2}\? untidy$/u },
    {
      name: "readonly-none",
      result: waitOf({
        status: {
          ...answered("kept").status,
          readonly: { enforcement: "none" as const, diagnostic: "ACP cannot remove task-surface mutation capabilities" },
        },
      }),
      fact: /! ACP cannot remove task-surface mutation capabilities/u,
    },
    {
      name: "failed",
      result: waitOf({
        status: {
          id,
          life: "asleep",
          timeline: {
            kind: "idle",
            entries: [],
            omitted: 0,
            outcome: {
              kind: "outcome",
              sequence: 1,
              turnSequence: 1,
              at: "2026-08-10T16:42:00.000Z",
              outcome: { kind: "failed", diagnostic: "turn failed" },
            },
          },
        },
      }),
      fact: /! error\s+turn failed/u,
    },
    {
      name: "open",
      result: waitOf({
        status: {
          id,
          life: "asleep",
          timeline: {
            kind: "open",
            turn: { kind: "turn", sequence: 1, turnSequence: 1, bodySequence: 1, at: "2026-08-10T16:42:00.000Z" },
            entries: [],
            omitted: 0,
          },
        },
      }),
      fact: / {2}○ asleep$/u,
    },
    {
      name: "no-outcome",
      result: waitOf({ status: { id, life: "asleep", timeline: { kind: "idle", entries: [], omitted: 0 } } }),
      fact: / {2}○ asleep$/u,
    },
  ] as const;
  for (const item of cases) {
    assert.equal(akumaRawAnswer(item.result), "raw" in item ? item.raw : undefined, item.name);
    const text = renderAkumaText("command" in item ? item.command : waitCommand, item.result);
    if ("raw" in item) assert.equal(text, item.raw, item.name);
    else {
      assert.notEqual(text, "kept", item.name);
      assert.match(text, /^─────/u, item.name);
      assert.match(text, /aku\/worker\/1234abcd/u, item.name);
      assert.match(text, item.fact, item.name);
    }
  }

  const managedCall = {
    ...call,
    result: {
      ...call.result,
      execution: { cwd: "/repo/.git/keiyaku/wt/atlantis", source: "contract-worktree" as const },
    },
  };
  assert.equal(akumaRawAnswer(managedCall), multiline);
  assert.equal(
    renderAkumaText(parseArgv(["call", "worker", "-"]).command, managedCall),
    `cwd /repo/.git/keiyaku/wt/atlantis\n${multiline}`,
  );

  const plural = waitOf(answered("first answer"), { status: { ...answered("second answer").status, id: other } });
  assert.equal(akumaRawAnswer(plural), undefined);
  const pluralText = renderAkumaText(waitCommand, plural);
  assert.match(pluralText, /aku\/worker\/1234abcd/u);
  assert.match(pluralText, /first answer/u);
  assert.match(pluralText, /aku\/reviewer\/deadbeef/u);
  assert.match(pluralText, /second answer/u);
  assert.notEqual(pluralText, "first answersecond answer");
  assert.deepEqual(akumaJsonValue(parseArgv(["wait", id, "--json"]).command, complete), complete.result);
  assert.deepEqual(akumaJsonValue(parseArgv(["wait", id, other, "--all", "--json"]).command, plural), plural.result);
});

test("history JSON preserves an associated Contract for every result mode", () => {
  const akuma = "aku/worker/00000001" as const;
  const contractId = "kei/provider-core-review" as const;
  const pageCommand = parseArgv(["history", akuma, "--json"]).command;
  const page = {
    kind: "akuma" as const,
    action: "history" as const,
    akuma,
    mode: "page" as const,
    history: {
      rows: [],
      omitted: 0,
      hasEarlier: false,
      hasLater: false,
      historyLost: false,
      lowestRetained: null,
      highest: null,
    },
    historyResult: {
      kind: "history" as const,
      id: akuma,
      history: {
        rows: [], omitted: 0, hasEarlier: false, hasLater: false,
        historyLost: false, lowestRetained: null, highest: null,
      },
      contractId,
    },
  };
  assert.deepEqual(akumaJsonValue(pageCommand, page), {
    kind: "history",
    id: akuma,
    history: page.history,
    contractId,
  });

  const lastCommand = parseArgv(["history", akuma, "--last", "--json"]).command;
  const last = {
    ...page,
    mode: "last" as const,
    answer: "answer",
    historyResult: { kind: "last" as const, id: akuma, answer: "answer", contractId },
  };
  assert.deepEqual(akumaJsonValue(lastCommand, last), {
    kind: "last",
    id: akuma,
    answer: "answer",
    contractId,
  });
  const noAnswer = {
    ...page,
    mode: "no-answer" as const,
    historyResult: { kind: "no-answer" as const, id: akuma, contractId },
  };
  assert.deepEqual(akumaJsonValue(lastCommand, noAnswer), {
    kind: "no-answer",
    id: akuma,
    contractId,
  });
});

test("akuma call renders the CallResult restraint on detached and failed observations without duplication", () => {
  const command = parseArgv(["call", "worker", "-"]).command;
  const akuma = "aku/worker/1234abcd" as import("../src/index.js").AkuId;
  const restraint = { enforcement: "none" as const, diagnostic: "ACP cannot remove task-surface mutation capabilities" };
  const base = {
    kind: "akuma" as const,
    action: "call" as const,
    result: {
      kind: "called" as const,
      akuma,
      execution: { cwd: "/world", source: "world" as const },
      readonly: restraint,
      dispatch: { kind: "none" as const },
      alias: { kind: "none" as const },
    },
    world: "/world" as import("../src/index.js").WorldRoot,
  };

  const detached = renderAkumaText(command, { ...base, result: { ...base.result, observation: { kind: "detached" as const } } });
  assert.equal(detached, `─────\n${akuma}\n! ACP cannot remove task-surface mutation capabilities`);
  assert.doesNotMatch(detached, /keiyaku wait/u);
  assert.equal((detached.match(/! ACP cannot/g) ?? []).length, 1);

  const failed = renderAkumaText(command, {
    ...base,
    result: {
      ...base.result,
      observation: { kind: "failed" as const, failure: { kind: "infrastructure" as const, diagnostic: "heart unavailable" } },
    },
  });
  assert.equal(failed, `─────\n${akuma}\n! ACP cannot remove task-surface mutation capabilities\n! error heart unavailable`);
  assert.equal((failed.match(/! ACP cannot/g) ?? []).length, 1);

  const observed = renderAkumaText(command, {
    ...base,
    result: {
      ...base.result,
      observation: {
        kind: "observed" as const,
        status: {
          id: akuma,
          life: "asleep" as const,
          readonly: restraint,
          timeline: { kind: "idle" as const, entries: [], omitted: 0 },
        },
      },
    },
  });
  assert.equal((observed.match(/! ACP cannot/g) ?? []).length, 1, "observed status and CallResult project the same restraint once");

  const answeredRestraint = renderAkumaText(command, {
    ...base,
    result: {
      ...base.result,
      observation: {
        kind: "observed" as const,
        status: {
          id: akuma,
          life: "asleep" as const,
          readonly: restraint,
          timeline: {
            kind: "idle" as const,
            entries: [],
            omitted: 0,
            outcome: {
              kind: "outcome" as const,
              sequence: 1,
              turnSequence: 1,
              at: "2026-08-10T16:42:00.000Z",
              outcome: { kind: "answered" as const, answer: "finished", historyId: "history", session: { sessionId: "session" } },
            },
          },
        },
      },
    },
  });
  assert.match(answeredRestraint, /! ACP cannot remove task-surface mutation capabilities/u);
  assert.notEqual(answeredRestraint, "finished");
});

test("packaged CLI call writes missing, detached, answered, unfinished, and failed semantics", async () => {
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
    confinement: { kind: "unconfined" },
    createdAt: "2026-08-15T00:00:00.000Z",
  };
  const leash = (await HeldAkumaLeash.try(parent.paths))!;
  await leash.birth(parent.paths, soul);
  const answering: ProviderAdapter = {
    confinement: () => ({ kind: "unconfined" }),
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
    const missing = await runPackagedCli(["-C", root, "call", "missing", "-"], { cwd: root, env, stdin: "work" });
    assert.equal(missing.code, 3);
    assert.equal(missing.stdout, "");
    assert.equal(missing.stderr, "`missing` was not found\nuse `keiyaku ls aku/` to list available Akuma\n");
    assert.doesNotMatch(missing.stderr, /archetype|searched/iu);

    const invalid = await runPackagedCli(["-C", root, "call", "Not/A-Name", "-"], { cwd: root, env, stdin: "work" });
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /Akuma name must be one normalized human identity segment/u);
    assert.doesNotMatch(invalid.stderr, /archetype/iu);

    const detached = await runPackagedCli(["-C", root, "call", "worker", "--detach", "-"], { cwd: root, env, stdin: "detach" });
    assert.equal(detached.code, 0);
    const detachedLines = detached.stdout.trim().split("\n");
    assert.equal(detachedLines[0], "─────");
    const akuId = detachedLines[1]!;
    assert.match(akuId, /^aku\/worker\/[0-9a-f]{8}$/u);
    assert.equal(detached.stdout, `─────\n${akuId}\n$ keiyaku -C ${root} wait ${akuId} --timeout 5m\n`);
    assert.doesNotMatch(detached.stdout, /● running|○ asleep|success/u);

    const aliased = await runPackagedCli(["-C", root, "call", "worker", "--detach", "--alias", "@worker", "-"], { cwd: root, env, stdin: "detach-alias" });
    assert.equal(aliased.code, 0);
    const aliasedHeader = aliased.stdout.trim().split("\n")[1]!;
    const aliasedId = aliasedHeader.match(/^(aku\/worker\/[0-9a-f]{8})/u)?.[1];
    assert.equal(typeof aliasedId, "string");
    assert.equal(aliased.stdout, `─────\n${aliasedId} (@worker)\n$ keiyaku -C ${root} wait @worker --timeout 5m\n`);

    const nested = join(root, "nested");
    mkdirSync(nested);
    const nestedCall = await runPackagedCli(["-C", nested, "call", "worker", "--detach", "-"], { cwd: nested, env, stdin: "detach-nested" });
    assert.equal(nestedCall.code, 0);
    const nestedId = nestedCall.stdout.trim().split("\n")[1]!;
    assert.match(nestedId, /^aku\/worker\/[0-9a-f]{8}$/u);
    assert.equal(nestedCall.stdout, `─────\n${nestedId}\n$ keiyaku -C ${root} wait ${nestedId} --timeout 5m\n`);

    const answered = await runPackagedCli(["-C", root, "call", "worker", "answer"], { cwd: root, env });
    assert.equal(answered.code, 0);
    assert.equal(answered.stdout, "finished");
    assert.equal(answered.stderr, "");

    const unfinished = await runPackagedCli(["-C", root, "call", "worker", "--wait", "0ms", "-"], { cwd: root, env, stdin: "hang" });
    assert.equal(unfinished.code, 0);
    assert.match(unfinished.stdout, /^aku\/worker\/[0-9a-f]{8}$/mu);
    assert.match(unfinished.stdout, / {2}● running\n$/u);
    assert.doesNotMatch(unfinished.stdout, /keiyaku wait|finished/u);
    const unfinishedId = unfinished.stdout.match(/aku\/worker\/[0-9a-f]{8}/u)?.[0];
    assert.notEqual(unfinishedId, undefined);
    const told = await runPackagedCli(["-C", root, "tell", unfinishedId!, "continue with logs"], { cwd: root, env });
    assert.equal(told.code, 0);
    assert.match(told.stdout, /continue with logs/u);

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

test("packaged CLI wait writes exact multiline and empty answer bytes", async () => {
  assert.equal(existsSync(PACKAGED_CLI), true, "npm run build must produce build/src/cli/index.js before this test");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiyaku-cli-akuma-wait-")));
  const answering = (answer: string): ProviderAdapter => ({
    confinement: () => ({ kind: "unconfined" }),
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
    await driveAkumaBody({
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: {},
        origin: { kind: "direct" },
        confinement: { kind: "unconfined" },
        cwd: root,
        createdAt: "2026-08-16T00:00:00.000Z",
      },
      initialBody: "work",
    }, answering(answer), { now: () => "2026-08-16T00:00:00.000Z" });
    return allocated;
  };
  try {
    const multiline = await answered("aaa11111", "line one\nline two\n");
    const exact = await runPackagedCli(["-C", root, "wait", multiline.id, "--timeout", "0ms"], { cwd: root });
    assert.equal(exact.code, 0);
    assert.equal(exact.stdout, "line one\nline two\n");
    assert.equal(exact.stderr, "");
    const empty = await answered("bbb22222", "");
    const emptyOut = await runPackagedCli(["-C", root, "wait", empty.id, "--timeout", "0ms"], { cwd: root });
    assert.equal(emptyOut.code, 0);
    assert.equal(emptyOut.stdout, "");
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
    confinement: { kind: "unconfined" },
    createdAt: "2026-08-15T00:00:00.000Z",
  };
}

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
      confinement: { kind: "unconfined" },
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
