import assert from "node:assert/strict";
import test from "node:test";
import { CliUsageError, parseArgv } from "../src/cli/parse.js";

test("bind mints its contract identity and keeps JSON output separate from input", () => {
  assert.deepEqual(
    parseArgv([
      "bind",
      "--target",
      "refs/heads/main",
      "--json",
      "-",
    ]),
    {
      command: {
        command: "bind",
        target: "refs/heads/main",
        output: "json",
      },
    },
  );
});

test("bind accepts boolean --here and preserves -C outside the contract command", () => {
  const parsed = parseArgv(["-C", "/repo/caller", "bind", "--here", "-"]);
  assert.deepEqual(parsed, {
    cwd: "/repo/caller",
    command: {
      command: "bind",
      workspace: "here",
      output: "text",
    },
  });
});

test("global cwd has two spellings and is independent of command position", () => {
  assert.deepEqual(parseArgv(["task", "ls", "-C", "/repo/caller"]), {
    cwd: "/repo/caller",
    command: { command: "task", action: "ls", output: "text", positionals: [], flags: {} },
  });
  assert.deepEqual(parseArgv(["settings", "--cwd", "/repo/caller"]), {
    cwd: "/repo/caller",
    command: { command: "settings", output: "text" },
  });
});

test("bind accepts one Task association at the Contract boundary", () => {
  assert.deepEqual(parseArgv(["bind", "--task", "task/example", "-"]), {
    command: {
      command: "bind",
      task: "task/example",
      output: "text",
    },
  });
});

test("unknown command syntax is refused with the exact command usage", () => {
  assert.throws(
    () => parseArgv(["bind", "--workspace", "here", "-"]),
    (error: unknown) => error instanceof CliUsageError
      && error.message.includes("usage: keiyaku bind [--task <task/...>] [--target <ref>]"),
  );
  assert.throws(() => parseArgv(["unknown"]), /usage: keiyaku \[-C <path>\] <command>/);
});

test("existing selectors are optional and review stdin is a distinct summary source", () => {
  assert.deepEqual(parseArgv(["deliver", "--actor", "external-test"]), {
    command: { command: "deliver", output: "text", actor: "external-test", includeDirty: false },
  });
  assert.deepEqual(parseArgv(["deliver", "kei/example", "--include-dirty", "--json"]), {
    command: { command: "deliver", contract: "kei/example", includeDirty: true, output: "json" },
  });
  assert.deepEqual(parseArgv(["review", "@managed-worktree", "--satisfied", "-"]), {
    command: {
      command: "review",
      contract: "@managed-worktree",
      verdict: "satisfied",
      summaryFromStdin: true,
      output: "text",
    },
  });
  assert.throws(
    () => parseArgv(["review", "kei/example", "--satisfied", "--summary", "inline", "-"]),
    /mutually exclusive/,
  );
});

test("status parses one folded board and preserves its optional contract filter", () => {
  assert.deepEqual(parseArgv(["status"]), {
    command: { command: "status", output: "text" },
  });
  assert.deepEqual(parseArgv(["status", "kei/example", "--json"]), {
    command: { command: "status", contract: "kei/example", output: "json" },
  });
  assert.throws(() => parseArgv(["status", "--fast"]), /not valid for status/);
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
  assert.deepEqual(parseArgv(["ls", "task/"]), {
    command: { command: "ls", query: { kind: "tasks" }, output: "text" },
  });
  assert.deepEqual(parseArgv(["ls", "kei/", "--json"]), {
    command: { command: "ls", query: { kind: "contracts" }, output: "json" },
  });
  assert.deepEqual(parseArgv(["ls", "aku/"]), {
    command: { command: "ls", query: { kind: "archetypes" }, output: "text" },
  });
  assert.deepEqual(parseArgv(["ls", "aku/worker/"]), {
    command: { command: "ls", query: { kind: "akuma", archetype: "worker" }, output: "text" },
  });
  assert.deepEqual(parseArgv(["ls", "aku/*/*"]), {
    command: { command: "ls", query: { kind: "akuma" }, output: "text" },
  });
  for (const path of ["task", "kei", "aku", "keiy/", "@review", "kei/review", "aku/worker/1234abcd", "aku/*/"]) {
    assert.throws(() => parseArgv(["ls", path]), CliUsageError);
  }
});

test("bind and amend retain complete after snapshots and gate-set selectors", () => {
  assert.deepEqual(
    parseArgv(["bind", "--after", "kei/one", "--after", "kei/two", "--gates", "strict", "-"]),
    {
      command: {
        command: "bind",
        after: ["kei/one", "kei/two"],
        gates: "strict",
        output: "text",
      },
    },
  );
  assert.deepEqual(
    parseArgv(["amend", "kei/example", "--clear-after", "-"]),
    { command: { command: "amend", contract: "kei/example", clearAfter: true, output: "text" } },
  );
  assert.throws(
    () => parseArgv(["amend", "kei/example", "--after", "kei/one", "--clear-after", "-"]),
    /mutually exclusive/,
  );
  assert.throws(
    () => parseArgv(["bind", "--clear-after", "-"]),
    /not valid for bind/,
  );
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

test("flag specs preserve value and boolean option behavior", () => {
  assert.throws(
    () => parseArgv(["bind", "--gates", "strict", "--gates", "default", "-"]),
    /duplicate option: --gates/,
  );
  assert.throws(
    () => parseArgv(["amend", "kei/example", "--clear-after", "--clear-after", "-"]),
    /duplicate option: --clear-after/,
  );
  assert.deepEqual(parseArgv(["audit", "kei/example", "--show-diff-body"]), {
    command: { command: "audit", contract: "kei/example", showDiffBody: true, output: "text" },
  });
  assert.deepEqual(parseArgv(["audit", "kei/example", "--actor", "audit-user"]), {
    command: { command: "audit", contract: "kei/example", showDiffBody: false, actor: "audit-user", output: "text" },
  });
});
