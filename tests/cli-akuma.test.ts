import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { moveAlias } from "../src/alias/index.js";
import { driveAkumaBody } from "../src/akuma/body.js";
import { initializeHeart, recordTurn } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import type { ProviderAdapter } from "../src/akuma/provider.js";
import { invoke } from "../src/cli/invoke.js";
import { main } from "../src/cli/main.js";
import { CliUsageError, parseArgv } from "../src/cli/parse.js";
import { akumaExitCode, akumaJsonValue, renderAkumaJson, renderAkumaText } from "../src/cli/render/akuma.js";
import { displayColumns } from "../src/cli/render/terminal.js";

test("Akuma CLI parses root verbs without the removed namespace", () => {
  assert.deepEqual(parseArgv(["-C", "/world", "call", "claude", "--workdir", "/work", "-"]), {
    cwd: "/world",
    command: { command: "call", archetype: "claude", workdir: "/work", mode: "wait", output: "text" },
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

test("Akuma status aligns and counts omitted activity", () => {
  const command = parseArgv(["status", "aku/worker/1234abcd"]).command;
  const status = {
    id: "aku/worker/1234abcd",
    life: "running" as const,
    collar: { kind: "alive" as const },
    activity: {
      entries: [{ kind: "gap" as const, count: 12 }, { kind: "row" as const, row: {
        kind: "note" as const,
        sequence: 13,
        bodySequence: 1,
        at: "2026-08-10T16:42:00.000Z",
        text: "running tests",
      } }],
      lowestRetained: 1,
      highest: 13,
    },
  };
  const result = { kind: "akuma" as const, action: "status" as const, status };
  const lines = renderAkumaText(command, result).split("\n");
  assert.match(lines[0]!, /^aku\/worker\/1234abcd ─+$/u);
  assert.equal(lines[1], "     ⋮ +12");
  assert.equal(lines[1]!.indexOf("⋮"), lines[2]!.indexOf("│"));
  assert.match(lines[2]!, /^\d{2}:42│ note {3}running tests$/u);
  assert.equal(lines.at(-1), lines[2]);
  assert.deepEqual((akumaJsonValue(command, result) as typeof status).activity.entries[0], { kind: "gap", count: 12 });

  const complete = { ...result, status: { ...status, activity: { ...status.activity, entries: status.activity.entries.slice(1) } } };
  assert.equal(renderAkumaText(command, complete).split("\n").length, lines.length - 1);
  assert.equal(renderAkumaText(command, {
    kind: "akuma",
    action: "wait",
    result: { completion: "all", statuses: [status] },
  }), renderAkumaText(command, result));
  const aliasedWait = renderAkumaText(command, {
    kind: "akuma",
    action: "wait",
    alias: "@review",
    result: { completion: "all", statuses: [status] },
  });
  assert.match(aliasedWait.split("\n")[0]!, /^aku\/worker\/1234abcd \(@review\) ─+$/u);
  const answered = {
    ...status,
    life: "asleep" as const,
    collar: { kind: "gone" as const, end: "exited" as const },
    answer: "first answer",
    activity: { entries: [], lowestRetained: null, highest: null },
  };
  const other = {
    ...answered,
    id: "aku/reviewer/deadbeef",
    answer: "second answer",
  };
  assert.equal(renderAkumaText(command, {
    kind: "akuma",
    action: "wait",
    result: { completion: "any", statuses: [answered] },
  }), "first answer");
  const plural = renderAkumaText(command, {
    kind: "akuma",
    action: "wait",
    result: { completion: "all", statuses: [answered, other] },
  });
  assert.match(plural, /^aku\/worker\/1234abcd ─+\nfirst answer\n\naku\/reviewer\/deadbeef ─+\nsecond answer$/u);
  assert.doesNotMatch(plural, /came back|N of M/u);
  const recorded = {
    kind: "akuma",
    action: "tell" as const,
    mode: "ordinary" as const,
    alias: "@review",
    body: "current input",
    result: {
      akuma: status.id,
      tell: { admission: { tellId: "tell-1", fact: "recorded" }, wake: "spawned" },
      observation: status,
    },
  };
  const recordedText = renderAkumaText(command, recorded);
  assert.match(recordedText.split("\n")[0]!, /^aku\/worker\/1234abcd \(@review\) ─+$/u);
  assert.match(recordedText, /│ ⧗ tell “current input”$/u);
  assert.deepEqual(akumaJsonValue(command, recorded), recorded.result);
  assert.equal(renderAkumaText(command, {
    ...recorded,
    result: { ...recorded.result, tell: { admission: { tellId: "tell-1", fact: "recorded" }, wake: { kind: "failed" as const, diagnostic: "spawn\nfailed" } } },
  }), `${recordedText}\nwake failed: spawn failed`);
  const observedTell = {
    kind: "akuma" as const,
    action: "tell" as const,
    mode: "ordinary" as const,
    body: "current input",
    result: {
      akuma: status.id,
      tell: { admission: { tellId: "tell-1", fact: "recorded" as const }, wake: "spawned" as const },
      observation: {
        ...status,
        activity: {
          ...status.activity,
          entries: [...status.activity.entries, { kind: "row" as const, row: {
            kind: "tell" as const,
            sequence: 14,
            at: "2026-08-10T16:43:00.000Z",
            tellId: "tell-1",
            text: "current input",
            state: "told" as const,
          } }],
        },
      },
    },
  };
  assert.equal(renderAkumaText(command, observedTell).match(/current input/gu)?.length, 1);
  assert.deepEqual(akumaJsonValue(command, observedTell), observedTell.result);
});

test("Akuma voice is quoted and running tools carry the live mark", () => {
  const command = parseArgv(["status", "aku/worker/1234abcd"]).command;
  const status = {
    id: "aku/worker/1234abcd",
    life: "running" as const,
    collar: { kind: "alive" as const },
    activity: { entries: [
      { kind: "row" as const, row: {
        kind: "said" as const, sequence: 1, bodySequence: 1,
        at: "2026-08-10T16:42:00.000Z", text: "hello",
      } },
      { kind: "row" as const, row: {
        kind: "thought" as const, sequence: 2, bodySequence: 1,
        at: "2026-08-10T16:42:01.000Z", text: "considering",
      } },
      { kind: "row" as const, row: {
        kind: "tool" as const, sequence: 3, bodySequence: 1,
        at: "2026-08-10T16:42:02.000Z", name: "Search",
        call: { kind: "search" as const, query: "TODO" }, state: "running" as const,
      } },
    ], lowestRetained: 1, highest: 3 },
  };
  const text = renderAkumaText(command, { kind: "akuma", action: "status", status });
  assert.match(text, /│ say {4}“hello”/u);
  assert.match(text, /│ think {2}“considering”/u);
  assert.match(text, /● search TODO/u);
  const activity = text.split("\n").slice(1);
  assert.deepEqual(activity.map((line) => line.indexOf("say") >= 0
    ? line.indexOf("say")
    : line.indexOf("think") >= 0 ? line.indexOf("think") : line.indexOf("search")), [7, 7, 7]);
  assert.deepEqual(activity.map((line) => line.indexOf("“") >= 0 ? line.indexOf("“") : line.indexOf("TODO")), [14, 14, 14]);
  assert.doesNotMatch(text, /● running$/u);

  const narrow = renderAkumaText(command, {
    kind: "akuma",
    action: "status",
    status: {
      ...status,
      activity: { ...status.activity, entries: [{ kind: "row", row: {
        kind: "said", sequence: 1, bodySequence: 1,
        at: "2026-08-10T16:42:00.000Z",
        text: "alpha beta gamma delta epsilon zeta eta theta iota",
      } }] },
    },
  }, { columns: 30, color: false });
  const voice = narrow.split("\n").slice(1).join("\n");
  assert.match(voice, /“/u);
  assert.match(voice, /…”$/u);
  assert.equal(voice.match(/“/gu)?.length, 1);
  assert.equal(voice.match(/”/gu)?.length, 1);
});

test("Akuma run commands stay on one row and preserve their head and tail", () => {
  const command = parseArgv(["status", "aku/worker/1234abcd"]).command;
  const status = {
    id: "aku/worker/1234abcd",
    life: "running" as const,
    collar: { kind: "alive" as const },
    activity: { entries: [{ kind: "row" as const, row: {
      kind: "tool" as const, sequence: 1, bodySequence: 1,
      at: "2026-08-10T16:42:00.000Z", name: "Shell",
      call: { kind: "run" as const, command: "npm test -- --configuration production --reporter final.json" },
      state: "running" as const,
    } }], lowestRetained: 1, highest: 1 },
  };
  const text = renderAkumaText(command, { kind: "akuma", action: "status", status }, { columns: 42, color: false });
  const activity = text.split("\n").slice(1);
  assert.equal(activity.length, 1);
  assert.match(activity[0]!, /^\d{2}:42● run {4}\$ npm test/u);
  assert.match(activity[0]!, /….*final\.json$/u);

  const completed = renderAkumaText(command, {
    kind: "akuma",
    action: "status",
    status: {
      ...status,
      activity: { ...status.activity, entries: [{ kind: "row", row: {
        ...status.activity.entries[0]!.row,
        state: { status: "failed", exitCode: 1 },
        durationMs: 41_000,
      } }] },
    },
  }, { columns: 50, color: false }).split("\n").at(-1)!;
  assert.match(completed, /\$ npm test/u);
  assert.match(completed, /….*final\.json — 41s · exit 1$/u);

  const unicode = renderAkumaText(command, {
    kind: "akuma",
    action: "status",
    status: {
      ...status,
      activity: { ...status.activity, entries: [{ kind: "row", row: {
        ...status.activity.entries[0]!.row,
        call: { kind: "run", command: "printf long-command-ending-in-界́" },
      } }] },
    },
  }, { columns: 24, color: false }).split("\n").at(-1)!;
  assert.match(unicode, /….*界́$/u);
  assert.doesNotMatch(unicode, /…\p{Mark}/u);

  const combiningHead = renderAkumaText(command, {
    kind: "akuma",
    action: "status",
    status: {
      ...status,
      activity: { ...status.activity, entries: [{ kind: "row", row: {
        ...status.activity.entries[0]!.row,
        call: { kind: "run", command: "界́abcdefghijklmnopqrstuvwxyz-final.json" },
      } }] },
    },
  }, { columns: 24, color: false }).split("\n").at(-1)!;
  assert.ok(displayColumns(combiningHead) <= 24);
  assert.match(combiningHead, /界́/u);

  const narrowCompleted = renderAkumaText(command, {
    kind: "akuma",
    action: "status",
    status: {
      ...status,
      activity: { ...status.activity, entries: [{ kind: "row", row: {
        ...status.activity.entries[0]!.row,
        state: { status: "failed", exitCode: 1 },
        durationMs: 41_000,
      } }] },
    },
  }, { columns: 30, color: false }).split("\n").at(-1)!;
  assert.ok(displayColumns(narrowCompleted) <= 30);
  assert.match(narrowCompleted, /\$ npm/u);
  assert.match(narrowCompleted, /al\.json$/u);
  assert.doesNotMatch(narrowCompleted, /exit 1/u);
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
  assert.equal(renderAkumaText(command, integrated), `${akuma} (@worker)\ndispatch kei/work`);
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
          answer: "finished",
          activity: { entries: [], lowestRetained: null, highest: null },
        },
      },
    },
  };
  assert.equal(renderAkumaText(command, answered), `${akuma}\nfinished`);

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
  assert.equal(renderAkumaText(command, observationFailed), `${akuma}\nwait failed infrastructure heart unavailable`);
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
  assert.equal(renderAkumaText(command, dispatched), "aku/claude/87654321\ndispatch kei/work");

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
  assert.equal(renderAkumaText(command, partial), "session native-child\nlocal failed");
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
    },
  };
  assert.equal(renderAkumaText(parsed.command, interrupted), "aku/claude/1d1e0004 interrupted self-aborted");
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
  assert.equal(
    renderAkumaText(parsed.command, wakeFailed),
    "aku/claude/1d1e0004 interrupted self-aborted · wake failed: spawn",
  );
  assert.equal(akumaExitCode(wakeFailed), 2);

  const unstoppable = {
    ...interrupted,
    result: {
      ...interrupted.result,
      receipt: { kind: "unstoppable" as const, evidence: "leash-held-after-put-down" as const },
    },
  };
  assert.equal(
    renderAkumaText(parsed.command, unstoppable),
    "aku/claude/1d1e0004 interrupt unstoppable leash-held-after-put-down",
  );
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
    assert.equal(statusResult.status.answer, "cli answer");
    assert.equal("history" in statusResult.status, false);
    assert.deepEqual(statusResult.status.activity, {
      entries: [{ kind: "row", row: {
        kind: "said",
        sequence: 2,
        bodySequence: 1,
        at: "2026-08-08T00:00:00.000Z",
        text: "cli activity",
      } }],
      lowestRetained: 1,
      highest: 2,
    });

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
    assert.deepEqual(historyResult.history.turns.map((turn) => turn.outcome), [
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

test("history --last renders typed no-answer and preserves answered empty bytes", () => {
  const command = parseArgv(["history", "aku/worker/00000001", "--last"]).command;
  const noAnswer = {
    kind: "akuma" as const,
    action: "history" as const,
    akuma: "aku/worker/00000001" as const,
    mode: "no-answer" as const,
  };
  assert.equal(renderAkumaText(command, noAnswer), "no answer retained");
  assert.deepEqual(akumaJsonValue(command, noAnswer), {
    kind: "no-answer",
    id: "aku/worker/00000001",
  });
  assert.equal(akumaExitCode(noAnswer), 0);

  const emptyAnswer = { ...noAnswer, mode: "last" as const, answer: "" };
  assert.equal(renderAkumaText(command, emptyAnswer), "");
  assert.deepEqual(akumaJsonValue(command, emptyAnswer), {
    kind: "last",
    id: "aku/worker/00000001",
    answer: "",
  });
  assert.equal(akumaExitCode(emptyAnswer), 0);
});
