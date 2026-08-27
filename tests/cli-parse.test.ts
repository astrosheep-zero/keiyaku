import assert from "node:assert/strict";
import test from "node:test";
import { AuthorityCorruptionError } from "../src/core/facts/errors.js";
import { decodeJournal } from "../src/core/facts/codec.js";
import { contractId, documentKey, entryUlid, snapshotId } from "../src/core/facts/types.js";
import { CliUsageError, parseArgv, renderContractHelp, renderRootHelp } from "../src/cli/parse.js";

test("bind mints its contract identity and keeps JSON output separate from input", () => {
  assert.deepEqual(parseArgv(["bind", "--target", "refs/heads/main", "--json", "-"]), {
    command: {
      command: "bind",
      target: "refs/heads/main",
      output: "json",
    },
  });
});

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
  assert.match(renderRootHelp(), /nuke \[--confirm <WorldRoot>\] \[--json\]/u);
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
  assert.throws(() => parseArgv(["status", "--repo"]), /--repo requires a path/u);
  assert.throws(() => parseArgv(["--repo", "/one", "status", "--repo", "/two"]), /--repo may appear only once/u);
});

test("global path tokens remain opaque at the parser edge", () => {
  assert.deepEqual(parseArgv(["-C", "C:\\work tree", "status", "--repo", "..\\delivery"]), {
    cwd: "C:\\work tree",
    repo: "..\\delivery",
    command: { command: "status", output: "text" },
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
    () => parseArgv(["bind", "--workspace-mode", "-"]),
    (error: unknown) =>
      error instanceof CliUsageError &&
      error.message.includes("usage: keiyaku bind [--task <task/...>] [--target <ref>]"),
  );
  assert.throws(() => parseArgv(["unknown"]), /usage: keiyaku \[-C <path>\] \[--repo <path>\] <command>/);
});

test("existing selectors are optional and review stdin is a distinct summary source", () => {
  assert.deepEqual(parseArgv(["deliver", "--actor", "external-test"]), {
    command: {
      command: "deliver",
      output: "text",
      actor: "external-test",
      includeDirty: false,
      materializeConflict: false,
    },
  });
  assert.deepEqual(parseArgv(["deliver", "kei/example", "--include-dirty", "--json"]), {
    command: {
      command: "deliver",
      contract: "kei/example",
      includeDirty: true,
      materializeConflict: false,
      output: "json",
    },
  });
  assert.deepEqual(parseArgv(["deliver", "kei/example", "--materialize-conflict"]), {
    command: {
      command: "deliver",
      contract: "kei/example",
      includeDirty: false,
      materializeConflict: true,
      output: "text",
    },
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
    /review requires exactly one of --summary <text> or stdin '-'/,
  );
  assert.throws(
    () => parseArgv(["review", "kei/example", "--satisfied"]),
    /review requires exactly one of --summary <text> or stdin '-'/,
  );
});

test("status parses one folded board and preserves its optional contract filter", () => {
  assert.deepEqual(parseArgv(["status"]), {
    command: { command: "status", output: "text" },
  });
  assert.deepEqual(parseArgv(["status", "kei/example", "--json"]), {
    command: { command: "status", contract: "kei/example", output: "json" },
  });
  assert.deepEqual(parseArgv(["status", "kei/one", "kei/two", "aku/claude/1234abcd"]), {
    command: { command: "status", selectors: ["kei/one", "kei/two", "aku/claude/1234abcd"], output: "text" },
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
  for (const path of ["task", "task/"]) {
    assert.deepEqual(parseArgv(["ls", path]), {
      command: { command: "ls", query: { kind: "tasks" }, output: "text" },
    });
  }
  for (const path of ["kei", "kei/"]) {
    assert.deepEqual(parseArgv(["ls", path, "--json"]), {
      command: { command: "ls", query: { kind: "contracts" }, output: "json" },
    });
  }
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

test("bind and amend retain complete after snapshots and gate bundle selectors", () => {
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

test("flag specs preserve value and boolean option behavior", () => {
  assert.throws(() => parseArgv(["bind", "--gates", "strict", "--gates", "default", "-"]), /duplicate option: --gates/);
  assert.throws(
    () => parseArgv(["amend", "kei/example", "--clear-after", "--clear-after", "-"]),
    /duplicate option: --clear-after/,
  );
  assert.deepEqual(parseArgv(["audit", "kei/example", "--diff"]), {
    command: { command: "audit", contract: "kei/example", includeDirty: false, showDiff: true, output: "text" },
  });
  assert.deepEqual(parseArgv(["audit", "kei/example", "--actor", "audit-user"]), {
    command: {
      command: "audit",
      contract: "kei/example",
      includeDirty: false,
      showDiff: false,
      actor: "audit-user",
      output: "text",
    },
  });
  assert.deepEqual(parseArgv(["audit", "kei/example", "--include-dirty", "--diff"]), {
    command: { command: "audit", contract: "kei/example", includeDirty: true, showDiff: true, output: "text" },
  });
  assert.throws(
    () => parseArgv(["audit", "kei/example", "--show-diff-body"]),
    /option --show-diff-body is not valid for audit/,
  );
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
  assert.deepEqual(parseArgv(["review", "--unsatisfied", "--summary", "  keep  "]).command, {
    command: "review",
    verdict: "unsatisfied",
    summary: "  keep  ",
    output: "text",
  });
  const called = parseArgv(["call", "worker", "  keep  "]).command;
  assert.equal(called.command, "call");
  if (called.command === "call") assert.deepEqual(called.prompt, { kind: "argument", value: "  keep  " });
  assert.deepEqual(parseArgv(["task", "update", "task/a", "--priority", "1"]).command, {
    command: "task",
    action: "update",
    output: "text",
    positionals: ["task/a"],
    flags: { priority: "1" },
  });
});

test("region accepts repeated --path patterns and omits deleted overlap grammar", () => {
  assert.deepEqual(parseArgv(["region", "--path", "src/**", "--path", "tests/**", "--json"]).command, {
    command: "region",
    paths: ["src/**", "tests/**"],
    output: "json",
  });
  assert.deepEqual(parseArgv(["region", "kei/example"]).command, {
    command: "region",
    contract: "kei/example",
    output: "text",
  });
  assert.match(renderRootHelp(), /region \[<contract>\]/);
  assert.doesNotMatch(renderRootHelp(), /--overlap/);
  assert.doesNotMatch(renderContractHelp("region"), /--overlap/);
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
