import assert from "node:assert/strict";
import test from "node:test";
import { AuthorityCorruptionError } from "../src/core/facts/errors.js";
import { decodeJournal } from "../src/core/facts/codec.js";
import { contractId, documentKey, entryUlid, snapshotId } from "../src/core/facts/types.js";
import { CliUsageError, parseArgv, renderContractHelp, type ParsedCommand } from "../src/cli/parse.js";

function command(argv: readonly string[]): ParsedCommand {
  const parsed = parseArgv(argv);
  if (!("command" in parsed)) throw new Error("expected an executable command");
  return parsed.command;
}

test("nuke admits only a literal WorldRoot confirmation", () => {
  assert.deepEqual(parseArgv(["nuke"]), {
    command: { command: "nuke", output: "text" },
  });
  assert.deepEqual(parseArgv(["nuke", "--confirm", "/world/root", "--json"]), {
    command: { command: "nuke", confirm: "/world/root", output: "json" },
  });
  assert.throws(() => parseArgv(["nuke", "kei/example"]), /nuke accepts no contract/u);
  assert.throws(() => parseArgv(["nuke", "-"]), /nuke reads no stdin/u);
  assert.throws(() => parseArgv(["nuke", "--confirm", " "]), /requires a nonblank value/u);
  assert.throws(() => parseArgv(["nuke", "--confirm", "/one", "--confirm", "/two"]), /duplicate option/u);
  assert.match(renderContractHelp("nuke"), /usage  keiyaku nuke \[--confirm <WorldRoot>\]/u);
  assert.match(renderContractHelp("nuke"), /Remove Keiyaku-owned data/u);
});

test("persisted removed workspace bytes are authority corruption", () => {
  const bind = {
    v: 1,
    kind: "bind",
    contract: contractId("kei/corrupt-workspace"),
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
    at: "2026-08-06T00:00:00Z",
    data: {
      coordinates: { start: snapshotId("snapshot-initial"), workspace: "here" },
      terms: {
        document: { bytes: "# Corrupt\n", key: documentKey("document-corrupt") },
        segments: [],
        gates: [],
        after: [],
      },
    },
  };
  assert.throws(() => decodeJournal(`${JSON.stringify(bind)}\n`), AuthorityCorruptionError);
});

test("global coordinates are independent of command position", () => {
  assert.deepEqual(parseArgv(["task", "ls", "-C", "/repo/caller"]), {
    cwd: "/repo/caller",
    command: { command: "task", action: "ls", output: "text", positionals: [], flags: {} },
  });
  assert.deepEqual(parseArgv(["settings", "--cwd", "/repo/caller"]), {
    cwd: "/repo/caller",
    command: { command: "settings", output: "text" },
  });
  assert.deepEqual(parseArgv(["--repo", "../delivery", "status", "-C", "/repo/caller"]), {
    cwd: "/repo/caller",
    repo: "../delivery",
    command: { command: "status", output: "text" },
  });
  assert.deepEqual(parseArgv(["call", "worker", "--workdir", "work", "body"]), {
    workdir: "work",
    command: {
      command: "call",
      archetype: "worker",
      mode: "detach",
      prompt: { kind: "argument", value: "body" },
      output: "text",
    },
  });
  assert.deepEqual(parseArgv(["call", "worker", "--contract", "kei/example", "--workdir", "work", "body"]), {
    workdir: "work",
    command: {
      command: "call",
      archetype: "worker",
      contract: "kei/example",
      mode: "detach",
      prompt: { kind: "argument", value: "body" },
      output: "text",
    },
  });
  assert.throws(() => parseArgv(["status", "--repo"]), /--repo requires a path/u);
  assert.throws(() => parseArgv(["--repo", "/one", "status", "--repo", "/two"]), /--repo may appear only once/u);
  assert.throws(
    () => parseArgv(["call", "worker", "--workdir", "one", "--workdir", "two", "body"]),
    /--workdir may appear only once/u,
  );
  assert.throws(() => parseArgv(["call", "worker", "--workdir", "body"]), /call requires a prompt argument or stdin/u);
  assert.throws(() => parseArgv(["call", "worker", "-d", "prompt"]), /option -d is not valid for call/u);
  assert.throws(() => parseArgv(["call", "worker", "--detach", "prompt"]), /option --detach is not valid for call/u);
  assert.throws(() => parseArgv(["call", "worker", "--workdir", " ", "body"]), /--workdir requires a path/u);
  assert.throws(
    () => parseArgv(["tell", "@worker", "--workdir", "work", "body"]),
    /option --workdir is not valid for tell/u,
  );
  assert.throws(
    () => parseArgv(["fork", "aku/worker/1234abcd", "--at", "turn/1", "--workdir", "work"]),
    /option --workdir is not valid for fork/u,
  );
});

test("root version is recognized only after coordinates and help", () => {
  assert.deepEqual(parseArgv(["--version"]), { version: true });
  assert.deepEqual(parseArgv(["-C", "/definitely/absent/keiyaku-world", "--version"]), { version: true });
  assert.deepEqual(parseArgv(["--version", "--help"]), { help: { kind: "root" } });
  assert.throws(
    () => parseArgv(["--version", "status"]),
    (error: unknown) => error instanceof CliUsageError && error.guide?.given === "--version",
  );
  assert.throws(
    () => parseArgv(["call", "worker", "--version"]),
    (error: unknown) =>
      error instanceof CliUsageError && error.message.includes("option --version is not valid for call"),
  );
  assert.throws(
    () => parseArgv(["tell", "@worker", "--version"]),
    (error: unknown) =>
      error instanceof CliUsageError && error.message.includes("option --version is not valid for tell"),
  );
});

test("audit maps only --show-diff to the existing display choice", () => {
  assert.deepEqual(command(["audit"]), {
    command: "audit", includeDirty: false, showDiff: false, output: "text",
  });
  assert.deepEqual(command(["audit", "kei/example", "--show-diff", "--include-dirty"]), {
    command: "audit", contract: "kei/example", includeDirty: true, showDiff: true, output: "text",
  });
  assert.deepEqual(command(["audit", "@example", "--show-diff", "--json"]), {
    command: "audit", contract: "@example", includeDirty: false, showDiff: true, output: "json",
  });
  assert.throws(() => parseArgv(["audit", "--diff"]), /option --diff is not valid for audit/u);
  assert.throws(() => parseArgv(["deliver", "kei/example", "--show-diff"]), /option --show-diff is not valid for deliver/u);
});

test("show parses one optional Contract selector and JSON output", () => {
  assert.deepEqual(parseArgv(["show", "kei/example", "--json"]), {
    command: { command: "show", contract: "kei/example", output: "json" },
  });
  assert.deepEqual(parseArgv(["show", "@example"]), {
    command: { command: "show", contract: "@example", output: "text" },
  });
  assert.throws(() => parseArgv(["show", "kei/one", "kei/two"]), /at most one contract/);
});

test("ls parses only canonical identity directories", () => {
  for (const path of ["task", "task/"]) {
    assert.deepEqual(parseArgv(["ls", path]), {
      command: { command: "ls", query: { kind: "tasks", namespace: [] }, output: "text" },
    });
  }
  assert.deepEqual(parseArgv(["ls", "task/feature/sub/", "--json"]), {
    command: { command: "ls", query: { kind: "tasks", namespace: ["feature", "sub"] }, output: "json" },
  });
  for (const path of ["task/feature", "task//", "task/feature//"]) {
    assert.throws(() => parseArgv(["ls", path]), /Task namespace selector/);
  }
  for (const path of ["kei", "kei/"]) {
    assert.deepEqual(parseArgv(["ls", path, "--json"]), {
      command: { command: "ls", query: { kind: "contracts" }, output: "json" },
    });
  }
  assert.deepEqual(parseArgv(["ls", "kei/", "--limit", "100"]), {
    command: { command: "ls", query: { kind: "contracts", limit: 100 }, output: "text" },
  });
  assert.throws(() => parseArgv(["ls", "kei/", "--limit", "0"]), /positive safe integer/u);
  for (const path of ["aku", "aku/"]) {
    assert.deepEqual(parseArgv(["ls", path]), {
      command: { command: "ls", query: { kind: "archetypes" }, output: "text" },
    });
  }
  for (const path of ["aku/worker", "aku/worker/"]) {
    assert.deepEqual(parseArgv(["ls", path]), {
      command: { command: "ls", query: { kind: "akuma", archetype: "worker" }, output: "text" },
    });
  }
  assert.deepEqual(parseArgv(["ls", "aku/*/*"]), {
    command: { command: "ls", query: { kind: "akuma" }, output: "text" },
  });
  for (const path of [
    "keiy/",
    "@review",
    "kei/review",
    "task/namespace",
    "aku//",
    "aku/worker/1234abcd",
    "aku/*/",
    "aku/worker/extra/",
  ]) {
    assert.throws(() => parseArgv(["ls", path]), CliUsageError);
  }
});

test("bind and amend retain complete after snapshots and mixed gate selectors", () => {
  assert.deepEqual(
    parseArgv(["bind", "--after", "kei/one", "--after", "kei/two", "--gates", "strict,review-only", "-"]),
    {
      command: {
        command: "bind",
        after: ["kei/one", "kei/two"],
        gates: ["strict", "review-only"],
        output: "text",
      },
    },
  );
  assert.deepEqual(parseArgv(["amend", "kei/example", "--clear-after", "-"]), {
    command: { command: "amend", contract: "kei/example", clearAfter: true, stdin: true, output: "text" },
  });
  assert.deepEqual(parseArgv(["amend", "kei/example", "--after", "kei/one"]), {
    command: { command: "amend", contract: "kei/example", after: ["kei/one"], output: "text" },
  });
  assert.deepEqual(parseArgv(["amend", "kei/example", "--clear-after"]), {
    command: { command: "amend", contract: "kei/example", clearAfter: true, output: "text" },
  });
  assert.deepEqual(parseArgv(["amend", "kei/example", "--gates", "default"]), {
    command: { command: "amend", contract: "kei/example", gates: ["default"], output: "text" },
  });
  assert.deepEqual(parseArgv(["bind", "--gates", "", "-"]), {
    command: { command: "bind", gates: [], output: "text" },
  });
  assert.deepEqual(parseArgv(["amend", "kei/example", "--gates", ""]), {
    command: { command: "amend", contract: "kei/example", gates: [], output: "text" },
  });
  assert.deepEqual(parseArgv(["bind", "--gates", "reviewed,strict", "-"]), {
    command: { command: "bind", gates: ["reviewed", "strict"], output: "text" },
  });
  for (const value of [",", "strict,", ",strict", "strict,,default"]) {
    assert.throws(() => parseArgv(["bind", "--gates", value, "-"]), /comma-separated names/u);
  }
  assert.deepEqual(parseArgv(["bind", "--gates", " ,--strict", "-"]), {
    command: { command: "bind", gates: [" ", "--strict"], output: "text" },
  });
  assert.throws(
    () => parseArgv(["amend", "kei/example"]),
    /amend requires stdin or --after, --clear-after, or --gates/,
  );
  assert.throws(
    () => parseArgv(["amend", "kei/example", "--actor", "operator", "--json"]),
    /amend requires stdin or --after, --clear-after, or --gates/,
  );
  assert.throws(
    () => parseArgv(["amend", "kei/example", "--after", "kei/one", "--clear-after", "-"]),
    /mutually exclusive/,
  );
  assert.throws(() => parseArgv(["bind", "--clear-after", "-"]), /not valid for bind/);
});

test("abandon accepts a note but no caller-selected reason", () => {
  assert.deepEqual(parseArgv(["abandon", "kei/example", "--note", "scope changed", "--actor", "operator"]), {
    command: {
      command: "abandon",
      contract: "kei/example",
      note: "scope changed",
      actor: "operator",
      output: "text",
    },
  });
  assert.throws(() => parseArgv(["abandon", "kei/example", "--reason", "manual"]), CliUsageError);
});

test("call accepts a bare alias name and keeps prefixed input compatible", () => {
  for (const input of ["pi-reset-api-review", "@pi-reset-api-review"]) {
    const parsed = command(["call", "intern", "--alias", input, "audit"]);
    assert.equal(parsed.command, "call");
    if (parsed.command === "call") assert.equal(parsed.alias, "@pi-reset-api-review");
  }
  const unicode = command(["call", "审查-二号", "--alias", "审查-二号", "audit"]);
  assert.equal(unicode.command, "call");
  if (unicode.command === "call") assert.equal(unicode.alias, "@审查-二号");
  assert.throws(() => parseArgv(["call", "intern", "--alias", "Reviewer", "audit"]), /normalized Akuma name/u);
  assert.throws(() => parseArgv(["call", "intern", "--alias", "a".repeat(65), "audit"]), /64 UTF-8 bytes/u);
});

test("wait accepts a plural selection without an explicit completion mode", () => {
  assert.deepEqual(command(["wait", "aku/claude/1234abcd", "aku/claude/5678ef90"]), {
    command: "wait",
    akuma: ["aku/claude/1234abcd", "aku/claude/5678ef90"],
    output: "text",
  });
  assert.deepEqual(command(["wait", "aku/claude/1234abcd", "@peer", "--timeout", "5m"]), {
    command: "wait",
    akuma: ["aku/claude/1234abcd", "@peer"],
    timeoutMs: 300_000,
    output: "text",
  });
  assert.deepEqual(command(["wait", "aku/*/*", "--all"]), {
    command: "wait",
    akuma: ["aku/*/*"],
    completion: "all",
    output: "text",
  });
  assert.deepEqual(command(["wait", "aku/*/*", "--any"]), {
    command: "wait",
    akuma: ["aku/*/*"],
    completion: "any",
    output: "text",
  });
  assert.throws(() => parseArgv(["wait", "@one", "@two", "--any", "--all"]), /mutually exclusive/u);
});

test("tell parses optional exact-answer wait windows", () => {
  assert.deepEqual(command(["tell", "@worker", "--wait", "0ms", "continue"]), {
    command: "tell",
    akuma: "@worker",
    interrupt: false,
    timeoutMs: 0,
    prompt: { kind: "argument", value: "continue" },
    output: "text",
  });
  assert.deepEqual(command(["tell", "aku/worker/1234abcd", "--schema", "answer.json", "--wait", "5m", "continue"]), {
    command: "tell",
    akuma: "aku/worker/1234abcd",
    interrupt: false,
    schema: "answer.json",
    timeoutMs: 300_000,
    prompt: { kind: "argument", value: "continue" },
    output: "text",
  });
  assert.throws(() => parseArgv(["tell", "@worker", "--wait", "--interrupt", "continue"]), /--wait requires a value/u);
  assert.throws(() => parseArgv(["tell", "@worker", "--wait", "later", "continue"]), /integer duration/u);
});

test("exact-one source selection and nonblank argv fail at parse", () => {
  const cases: ReadonlyArray<readonly [argv: readonly string[], pattern: RegExp]> = [
    [["review", "--satisfied"], /review requires exactly one of --summary <text> or stdin '-'/],
    [["review", "--satisfied", "--summary", "ok", "-"], /review requires exactly one of --summary <text> or stdin '-'/],
    [["review", "--satisfied", "--summary", ""], /--summary requires a nonblank value/],
    [["review", "--satisfied", "--summary", " \t"], /--summary requires a nonblank value/],
    [["bind", "--target", "", "-"], /--target requires a nonblank value/],
    [["deliver", "--message", "  "], /--message requires a nonblank value/],
    [["abandon", "--note", "\n"], /--note requires a nonblank value/],
    [["bind", "--actor", " ", "-"], /--actor requires a nonblank value/],
    [["call", "worker"], /call requires a prompt argument or stdin/],
    [["call", "worker", "ok", "-"], /accepts either a prompt argument or stdin, not both/],
    [["call", "worker", ""], /call requires a nonblank value/],
    [["call", " ", "-"], /call requires a nonblank value/],
    [["tell", "aku/claude/1234abcd", " \u00a0"], /tell requires a nonblank value/],
    [["fork", "aku/claude/1234abcd", "--at", "  "], /--at requires a nonblank value/],
    [["task", "add"], /task add requires either TITLE or '-' input/],
    [["task", "add", "Title", "-"], /task add requires either TITLE or '-' input/],
    [["task", "add", "  "], /task add requires a nonblank value/],
    [["task", "add", "Title", "--body", ""], /--body requires a nonblank value/],
    [["task", "add", "Title", "--note", "\t"], /--note requires a nonblank value/],
    [["task", "add", "Title", "--actor", " "], /--actor requires a nonblank value/],
    [["task", "compose", "--actor", "\t", "-"], /--actor requires a nonblank value/],
    [["task", "update", "task/a", "--title", " "], /--title requires a nonblank value/],
    [["task", "done", "task/a", "--note", ""], /--note requires a nonblank value/],
    [["bind", "--after", "   ", "-"], /--after requires a nonblank value/],
    [["bind", "--after", "kei/one", "--after", " ", "-"], /--after requires a nonblank value/],
    [["call", "worker", "--contract", " ", "prompt"], /--contract requires a nonblank value/],
    [["task", "show", " "], /task show requires a nonblank value/],
    [["task", "add", "Title", "--needs", "task/a", "--needs", "\t"], /--needs requires a nonblank value/],
    [["task", "hold", "task/a", "  "], /task hold requires a nonblank value/],
    [["wait", "aku/claude/1234abcd", " "], /wait requires a nonblank value/],
    [["region", "--path", "  "], /--path requires a nonblank value/],
    [["region", "--overlap"], /option --overlap is not valid for region/],
    [["region", "kei/one", "kei/two"], /region accepts at most one contract/],
    [["region", "-"], /region reads no stdin/],
    [["region", "kei/one", "--path", "src/**"], /--path cannot combine with a contract/],
  ];
  for (const [argv, pattern] of cases) {
    assert.throws(
      () => parseArgv(argv),
      (error: unknown) => error instanceof CliUsageError && pattern.test(error.message),
    );
  }
  assert.deepEqual(command(["review", "--unsatisfied", "--summary", "  keep  "]), {
    command: "review",
    verdict: "unsatisfied",
    summary: "  keep  ",
    output: "text",
  });
  const called = command(["call", "worker", "  keep  "]);
  assert.equal(called.command, "call");
  if (called.command === "call") assert.deepEqual(called.prompt, { kind: "argument", value: "  keep  " });
  assert.deepEqual(command(["task", "update", "task/a", "--priority", "1"]), {
    command: "task",
    action: "update",
    output: "text",
    positionals: ["task/a"],
    flags: { priority: "1" },
  });
});

test("stdin marker is position independent for Contract commands and global coordinates", () => {
  assert.deepEqual(parseArgv(["bind", "-", "--task", "task/example", "--json"]), {
    command: { command: "bind", task: "task/example", output: "json" },
  });
  assert.deepEqual(parseArgv(["amend", "-", "kei/example", "--json"]), {
    command: { command: "amend", contract: "kei/example", stdin: true, output: "json" },
  });
  assert.deepEqual(parseArgv(["arc", "-", "--actor", "operator", "kei/example"]), {
    command: { command: "arc", contract: "kei/example", actor: "operator", output: "text" },
  });
  assert.deepEqual(parseArgv(["review", "-", "--satisfied", "kei/example"]), {
    command: {
      command: "review",
      contract: "kei/example",
      verdict: "satisfied",
      summaryFromStdin: true,
      output: "text",
    },
  });
  assert.deepEqual(parseArgv(["bind", "-", "-C", "/repo/caller", "--repo", "../delivery"]), {
    cwd: "/repo/caller",
    repo: "../delivery",
    command: { command: "bind", output: "text" },
  });
  assert.deepEqual(parseArgv(["--repo", "../delivery", "bind", "-", "-C", "/repo/caller"]), {
    cwd: "/repo/caller",
    repo: "../delivery",
    command: { command: "bind", output: "text" },
  });
  assert.throws(() => parseArgv(["bind", "-", "--json", "-"]), /stdin marker '-' may appear only once/u);
  assert.throws(() => parseArgv(["status", "-", "--json"]), /status reads no stdin/u);
  assert.throws(() => parseArgv(["arc", "kei/example"]), /arc requires stdin/u);
  assert.throws(() => parseArgv(["bind", "-", "-C", "/one", "--cwd", "/two"]), /-C\/--cwd may appear only once/u);
  assert.throws(() => parseArgv(["bind", "-", "--repo"]), /--repo requires a path/u);
});
