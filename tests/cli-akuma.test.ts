import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { moveAlias } from "../src/alias/index.js";
import { driveAkumaBody } from "../src/akuma/body.js";
import { beginTurn, endTurn, initializeHeart, readSoul } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import type { ProviderAdapter } from "../src/akuma/provider.js";
import { invoke } from "../src/cli/invoke.js";
import { main } from "../src/cli/main.js";
import { CliUsageError, parseArgv } from "../src/cli/parse.js";
import { akumaExitCode, akumaJsonValue, renderAkumaJson, renderAkumaText } from "../src/cli/render/akuma.js";
import { displayColumns } from "../src/cli/render/terminal.js";
import { makeGitRepository } from "./support/git.js";

test("Akuma CLI parses root verbs without the removed namespace", () => {
  assert.deepEqual(parseArgv(["-C", "/world", "call", "claude", "-"]), {
    cwd: "/world",
    command: { command: "call", archetype: "claude", mode: "wait", output: "text" },
  });
  assert.deepEqual(parseArgv(["call", "claude", "--contract", "kei/delivery", "--alias", "@review", "-d", "-"]), {
    command: {
      command: "call",
      archetype: "claude",
      contract: "kei/delivery",
      alias: "@review",
      mode: "detach",
      output: "text",
    },
  });
  assert.deepEqual(parseArgv(["call", "claude", "--wait", "--timeout", "10m", "--cwd", "/world", "-"]), {
    cwd: "/world",
    command: { command: "call", archetype: "claude", mode: "wait", timeoutMs: 600_000, output: "text" },
  });
  assert.deepEqual(parseArgv(["call", "claude", "--detach", "-C", "/world", "-"]), {
    cwd: "/world",
    command: { command: "call", archetype: "claude", mode: "detach", output: "text" },
  });
  assert.throws(() => parseArgv(["-C", "/one", "call", "claude", "--cwd", "/two", "-"]), /may appear only once/u);
  assert.throws(() => parseArgv(["call", "claude", "-", "--cwd", "/world"]), /stdin marker '-' must be the final argument/u);
  assert.throws(() => parseArgv(["call", "claude", "--wait", "--detach", "-"]), /mutually exclusive/u);
  assert.throws(() => parseArgv(["call", "claude", "--timeout", "5m", "-d", "-"]), /mutually exclusive/u);
  assert.throws(() => parseArgv(["call", "claude", "--alias", "review", "-"]), /Akuma alias must match/u);
  assert.deepEqual(parseArgv(["tell", "aku/claude/1234abcd", "--json", "-"]), {
    command: { command: "tell", akuma: "aku/claude/1234abcd", interrupt: false, output: "json" },
  });
  assert.deepEqual(parseArgv(["tell", "aku/claude/1234abcd", "--interrupt", "-"]), {
    command: { command: "tell", akuma: "aku/claude/1234abcd", interrupt: true, output: "text" },
  });
  assert.deepEqual(parseArgv(["fork", "aku/claude/1234abcd", "--at", "history-1", "--json"]), {
    command: { command: "fork", akuma: "aku/claude/1234abcd", at: "history-1", output: "json" },
  });
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
  assert.throws(() => parseArgv(["call", "claude", "reviewer", "-"]), CliUsageError);
  assert.throws(() => parseArgv(["interrupt", "aku\/claude\/1234abcd", "-"]), /unknown command/u);
  assert.throws(() => parseArgv(["tell", "aku\/claude\/1234abcd", "--interrupt"]), /requires stdin/);
  assert.throws(() => parseArgv(["kill", "aku\/claude\/1234abcd", "-"]), /stdin marker .* not valid/);
  assert.throws(() => parseArgv(["fork", "aku\/claude\/1234abcd"]), /requires --at/);
  assert.throws(() => parseArgv(["fork", "aku\/claude\/1234abcd", "--at", ""]), /requires --at/);
});

test("Akuma snapshots preserve activity and typed omission", () => {
  const command = parseArgv(["status", "aku/worker/1234abcd"]).command;
  const status = {
    id: "aku/worker/1234abcd",
    life: "running" as const,
    collar: { kind: "alive" as const },
    timeline: {
      kind: "open" as const,
      turn: { kind: "turn" as const, sequence: 1, turnSequence: 1, bodySequence: 1, at: "2026-08-10T16:42:00.000Z" },
      entries: [
        { kind: "row" as const, row: { kind: "note" as const, sequence: 13, turnSequence: 1, at: "2026-08-10T16:42:00.000Z", text: "running tests" } },
        { kind: "row" as const, row: { kind: "thought" as const, sequence: 14, turnSequence: 1, at: "2026-08-10T16:42:30.000Z", text: "same minute" } },
      ],
      omitted: 12,
    },
  };
  const result = { kind: "akuma" as const, action: "status" as const, status: { status } };
  const text = renderAkumaText(command, result);
  assert.match(text, /running tests/u);
  assert.match(text, /same minute/u);
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
  assert.equal(aliasedWait.split("\n")[0], "aku/worker/1234abcd (@review)");
  const answered = {
    ...status,
    life: "asleep" as const,
    collar: { kind: "gone" as const, end: "exited" as const },
    timeline: { kind: "idle" as const, entries: [], omitted: 0, outcome: { kind: "outcome" as const, sequence: 1, turnSequence: 1, at: "2026-08-10T16:42:00.000Z", outcome: { kind: "answered" as const, answer: "first answer", historyId: "history-1", session: { sessionId: "session-1" } } } },
  };
  const other = {
    ...answered,
    id: "aku/reviewer/deadbeef",
    timeline: { kind: "idle" as const, entries: [], omitted: 0, outcome: { kind: "outcome" as const, sequence: 1, turnSequence: 1, at: "2026-08-10T16:42:00.000Z", outcome: { kind: "answered" as const, answer: "second answer", historyId: "history-2", session: { sessionId: "session-2" } } } },
  };
  assert.match(renderAkumaText(command, {
    kind: "akuma",
    action: "wait",
    result: { completion: "any", statuses: [{ status: answered }] },
  }), /first answer/u);
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
  assert.equal(recordedText.split("\n")[0], "aku/worker/1234abcd (@review)");
  assert.deepEqual(akumaJsonValue(command, recorded), recorded.result);
  assert.equal(renderAkumaText(command, {
    ...recorded,
    result: { ...recorded.result, tell: { admission: { tellId: "tell-1", fact: "recorded" }, wake: { kind: "failed" as const, diagnostic: "spawn\nfailed" } } },
  }), `${recordedText.split("\n")[0]}\n! error spawn failed\n${recordedText.split("\n").slice(1).join("\n")}`);
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
    collar: { kind: "alive" as const },
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
    const footer = rendered.findIndex((line) => line === "● running");
    assert.ok(footer > 2);
    return rendered.slice(2, footer - 1);
  };
  const rows: readonly Readonly<{ kind: import("../src/akuma/index.js").ActivityRow["kind"]; lines: number; row: import("../src/akuma/index.js").ActivityRow }>[] = [
    {
      kind: "said",
      lines: 3,
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
    collar: { kind: "gone" as const, end: "exited" as const },
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
  assert.equal(text.split("\n")[0], "aku/worker/1234abcd");
  assert.deepEqual(akumaJsonValue(command, result), result.result);
});

test("Akuma voice is bounded and active tools carry the live mark", () => {
  const command = parseArgv(["status", "aku/worker/1234abcd"]).command;
  const status = {
    id: "aku/worker/1234abcd",
    life: "running" as const,
    collar: { kind: "alive" as const },
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
  assert.match(text, /⧖ search: TODO/u);

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
  const voiceStart = narrowLines.findIndex((line) => line.startsWith("· say: "));
  assert.ok(voiceStart >= 0);
  const voice = narrowLines.slice(voiceStart, narrowLines.indexOf("", voiceStart)).join("\n");
  assert.match(voice, /alpha/u);
  assert.match(voice, /…$/u);
});

test("Akuma snapshot life uses the fleet vocabulary independently of activity", () => {
  const command = parseArgv(["status", "aku/worker/1234abcd"]).command;
  const base = {
    id: "aku/worker/1234abcd" as const,
    collar: { kind: "gone" as const, end: null },
    timeline: { kind: "idle" as const, entries: [], omitted: 0 },
  };
  const cases = [
    ["running", "● running"],
    ["asleep", "○ asleep"],
    ["killed", "× killed"],
    ["stranded", "? stranded"],
    ["headless", "? headless"],
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
    collar: { kind: "alive" as const },
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
        result: { kind: "called" as const, akuma: id, dispatch: { kind: "none" as const }, alias: { kind: "none" as const }, observation: { kind: "observed" as const, status } },
      },
      hasLife: true,
    },
    {
      name: "kill",
      command: parseArgv(["kill", id]).command,
      result: { kind: "akuma" as const, action: "kill" as const, result: { results: [{ id, evidence: "alive-after-sigkill" as const, observation }] } },
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
  ];
  for (const item of cases) {
    assert.equal(renderAkumaText(item.command, item.result).includes("● running"), item.hasLife, item.name);
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
  assert.match(text, /⧖ search: active/u);
  assert.match(text, /\? search: unsettled/u);
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
      collar: { kind: "alive" },
      confinement: { kind: "unconfined" },
      pending: [],
      timeline: { kind: "unborn", entries: [], omitted: 0 },
    }, contractId: "kei/provider-core-review" },
  }, { columns: 28, color: false });
  const lines = text.split("\n");
  assert.equal(lines[0], "aku/worker/1234abcd");
  assert.equal(lines[1], "contract kei/provider-core-review");
});

test("Akuma run commands stay on one row and preserve their head and tail", () => {
  const command = parseArgv(["status", "aku/worker/1234abcd"]).command;
  const status = {
    id: "aku/worker/1234abcd",
    life: "running" as const,
    collar: { kind: "alive" as const },
    timeline: { kind: "open" as const, turn: { kind: "turn" as const, sequence: 0, turnSequence: 1, bodySequence: 1, at: "2026-08-10T16:42:00.000Z" }, entries: [{ kind: "row" as const, row: {
      kind: "tool" as const, sequence: 1, turnSequence: 1,
      at: "2026-08-10T16:42:00.000Z", name: "Shell",
      call: { kind: "run" as const, command: "npm test -- --configuration production --reporter final.json" },
      state: "active" as const,
    } }], omitted: 0 },
  };
  const text = renderAkumaText(command, { kind: "akuma", action: "status", status: { status } }, { columns: 42, color: false });
  const runLine = (rendered: string): string => {
    const line = rendered.split("\n").find((candidate) => candidate.includes("run: "));
    assert.ok(line !== undefined);
    return line;
  };
  assert.match(runLine(text), /^⧖ run: \$ npm test/u);
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
  assert.match(completed, /^! run:/u);
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

  const narrowCompleted = runLine(renderAkumaText(command, {
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
  }, { columns: 30, color: false }));
  assert.ok(displayColumns(narrowCompleted) <= 32);
  assert.match(narrowCompleted, /run: .*…/u);
  assert.match(narrowCompleted, /exit 1$/u);
  assert.match(narrowCompleted, /exit 1/u);
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
      dispatch: { kind: "none" as const },
      alias: { kind: "none" as const },
      observation: { kind: "detached" as const },
    },
  };
  assert.equal(renderAkumaText(command, plain), akuma);
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
  assert.equal(renderAkumaText(command, integrated), `${akuma} (@worker)\ncontract kei/work`);
  assert.equal(akumaExitCode(integrated), 0);

  const partial = {
    ...plain,
    result: {
      ...plain.result,
      dispatch: { kind: "failed" as const, failure: { kind: "contention" as const } },
      alias: { kind: "skipped" as const, reason: "dispatch-failed" as const },
    },
  };
  assert.equal(renderAkumaText(command, partial), `${akuma}\ndispatch failed contention`);
  assert.equal(akumaExitCode(partial), 2);

  const answered = {
    ...plain,
    result: {
      ...plain.result,
      observation: {
        kind: "observed" as const,
        status: {
          id: akuma,
          life: "asleep" as const,
          collar: { kind: "gone" as const, end: "exited" as const },
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
  assert.match(answeredText, new RegExp(akuma, "u"));
  assert.match(answeredText, /finished/u);

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
  assert.equal(renderAkumaText(command, observationFailed), `${akuma}\n! error heart unavailable`);
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
  assert.equal(renderAkumaText(command, dispatched), "aku/claude/87654321\ncontract kei/work");

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
        collar: { kind: "gone" as const, end: "put-down" as const },
        timeline: { entries: [], lowestRetained: null, highest: null },
      }, contractId: "kei/provider-core-review" as const },
    },
  };
  const interruptedText = renderAkumaText(parsed.command, interrupted);
  assert.equal(interruptedText.split("\n")[0], "aku/claude/1d1e0004");
  assert.match(interruptedText, /contract kei\/provider-core-review/u);
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
  assert.match(renderAkumaText(parsed.command, wakeFailed), /^aku\/claude\/1d1e0004/u);
  assert.equal(akumaExitCode(wakeFailed), 0);

  const unstoppable = {
    ...interrupted,
    result: {
      ...interrupted.result,
      receipt: { kind: "unstoppable" as const, evidence: "leash-held-after-put-down" as const },
    },
  };
  assert.match(renderAkumaText(parsed.command, unstoppable), /^aku\/claude\/1d1e0004/u);
  assert.equal(akumaExitCode(unstoppable), 1);
});

test("Akuma status, wait, and history share public observations without embedding history", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-cli-akuma-status-"));
  try {
    const allocated = allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1234abcd" });
    initializeHeart(allocated.paths);
    const provider: ProviderAdapter = {
      confinement: () => ({ kind: "unconfined" }),
      admitOptions(options) { return { kind: "admitted", options }; },
      async start() {
        return {
          admission: { fence: "cli-fixture-turn" },
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: "session" as const, coordinate: { sessionId: "cli-session" } };
              yield { type: "assistant" as const, text: "cli activity" };
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
        archetype: "claude",
        provider: { name: "claude", kind: "claude-agent-sdk" },
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
    await moveAlias({ world: root, alias: "@review", akuId: allocated.id });
    const aliasWait = await invoke(parseArgv(["-C", root, "wait", "@review", "--timeout", "0ms"]));
    assert.equal("kind" in aliasWait && aliasWait.kind === "akuma" && aliasWait.action === "wait"
      ? aliasWait.alias : undefined, "@review");

    const laterTurn = beginTurn(allocated.paths, { bodySequence: 1, startedAt: "2026-08-08T00:00:01.000Z" });
    endTurn(allocated.paths, { turnSequence: laterTurn.sequence, outcome: { kind: "failed", diagnostic: "later failed" }, completedAt: "2026-08-08T00:00:01.000Z" });
    const failedStatus = await invoke(parseArgv(["-C", root, "status", allocated.id]));
    if (!("kind" in failedStatus) || failedStatus.kind !== "akuma" || failedStatus.action !== "status") return;
    assert.equal(failedStatus.status.status.timeline.kind === "idle"
      && failedStatus.status.status.timeline.outcome?.outcome.kind === "failed", true);

    const historyParsed = parseArgv(["-C", root, "history", allocated.id]);
    const historyResult = await invoke(historyParsed, { readStdin: () => { throw new Error("history must not read stdin"); } });
    if (!("kind" in historyResult) || historyResult.kind !== "akuma" || historyResult.action !== "history") return;
    assert.deepEqual(historyResult.history.rows.filter((row) => row.kind === "outcome").map((row) => row.outcome), [
      { kind: "answered", answer: "cli answer", historyId: "cli-history", session: { sessionId: "cli-session" } },
      { kind: "failed", diagnostic: "later failed" },
    ]);
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

  const allocated = allocateAkumaDirectory({
    worldRoot: repository.path,
    archetype: "worker",
    draw: () => "1357ace0",
  });
  initializeHeart(allocated.paths);
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
      provider: { name: "worker", kind: "codex-exec" },
      options: {},
      origin: { kind: "direct" },
      confinement: { kind: "unconfined" },
      cwd: linked,
    },
    initialBody: "work",
  }, provider, {
    collar: { pid: 999_991, processGroup: 999_991, spawnedAt: "shared-world" },
    now: () => "2026-08-14T00:00:00.000Z",
    async putDownOwnTree() {},
  });

  const fromLinked = await invoke(parseArgv(["-C", linked, "status", allocated.id]));
  const fromPrimary = await invoke(parseArgv(["-C", repository.path, "status", allocated.id]));
  assert.equal(fromLinked.kind, "akuma");
  assert.deepEqual(fromLinked, fromPrimary);
  await moveAlias({ world: repository.path, alias: "@shared", akuId: allocated.id });
  const fromLinkedAlias = await invoke(parseArgv(["-C", linked, "status", "@shared"]));
  assert.equal(fromLinkedAlias.kind === "akuma" ? fromLinkedAlias.status.status.id : undefined, allocated.id);
  assert.equal(readSoul(allocated.paths)?.cwd, linked);
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
