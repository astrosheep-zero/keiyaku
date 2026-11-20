import assert from "node:assert/strict";
import test from "node:test";
import { AuthorityCorruptionError } from "../src/core/facts/errors.js";
import { decodeJournal } from "../src/core/facts/codec.js";
import { contractId, documentKey, entryUlid, snapshotId } from "../src/core/facts/types.js";
import { assertExplicitRepoUse, CliUsageError, parseArgv, type ParsedCommand } from "../src/cli/parse.js";

function command(argv: readonly string[]): ParsedCommand {
  const parsed = parseArgv(argv);
  if (!("command" in parsed)) throw new Error("expected an executable command");
  return parsed.command;
}

test("surveil and unsurveil map exact Akuma selection to one invocation operation", () => {
  assert.deepEqual(command(["surveil", "aku/worker/1234abcd", "--json"]), {
    name: "surveil", input: { akuma: "aku/worker/1234abcd" }, output: "json",
  });
  assert.deepEqual(command(["unsurveil", "@worker"]), {
    name: "surveil", input: { akuma: "@worker", off: true }, output: "text",
  });
  assert.throws(() => command(["surveil", "aku/worker/*"]), /one complete/u);
  assert.throws(() => command(["unsurveil", "@one", "@two"]), /accepts one/u);
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
  assert.deepEqual(parseArgv(["ls", "debt/", "-C", "/repo/caller"]), {
    cwd: "/repo/caller",
    command: { name: "ls", input: { selector: "debt/" }, output: "text" },
  });
  assert.deepEqual(parseArgv(["settings", "--cwd", "/repo/caller"]), {
    cwd: "/repo/caller",
    command: { name: "settings", input: {}, output: "text" },
  });
  assert.deepEqual(parseArgv(["--repo", "../delivery", "status", "kei/example", "-C", "/repo/caller"]), {
    cwd: "/repo/caller",
    repo: "../delivery",
    command: { name: "status", input: { selector: "kei/example" }, output: "text" },
  });
  assert.deepEqual(parseArgv(["spawn", "worker", "--workdir", "work", "body"]), {
    workdir: "work",
    command: {
      name: "spawn",
      input: { akumaName: "worker" },
      acquire: { prompt: { kind: "argument", value: "body" } },
      output: "text",
    },
  });
  assert.deepEqual(parseArgv(["spawn", "worker", "--contract", "kei/example", "--workdir", "work", "body"]), {
    workdir: "work",
    command: {
      name: "spawn",
      input: { akumaName: "worker", contract: "kei/example" },
      acquire: { prompt: { kind: "argument", value: "body" } },
      output: "text",
    },
  });
  assert.throws(() => parseArgv(["status", "--repo"]), /--repo requires a path/u);
  assert.throws(() => parseArgv(["--repo", "/one", "status", "--repo", "/two"]), /--repo may appear only once/u);
  assert.throws(
    () => parseArgv(["spawn", "worker", "--workdir", "one", "--workdir", "two", "body"]),
    /--workdir may appear only once/u,
  );
  assert.deepEqual(command(["spawn", "worker"]), {
    name: "spawn",
    input: { akumaName: "worker" },
    acquire: {},
    output: "text",
  });
  assert.deepEqual(command(["spawn", "worker", "--bare"]), {
    name: "spawn",
    input: { akumaName: "worker", bare: true },
    acquire: {},
    output: "text",
  });
  assert.deepEqual(command(["fork", "@worker", "--at", "turn/1", "--bare"]), {
    name: "fork",
    input: { akuma: "@worker", at: "turn/1", bare: true },
    output: "text",
  });
  assert.throws(() => parseArgv(["spawn", "worker", "--wait", "1s"]), /option --wait is not valid for spawn/u);

  assert.throws(() => parseArgv(["spawn", "worker", "-d", "prompt"]), /option -d is not valid for spawn/u);
  assert.throws(() => parseArgv(["spawn", "worker", "--detach", "prompt"]), /option --detach is not valid for spawn/u);
  assert.throws(() => parseArgv(["spawn", "worker", "--workdir", " ", "body"]), /--workdir requires a path/u);
  assert.throws(
    () => parseArgv(["tell", "@worker", "--workdir", "work", "body"]),
    /option --workdir is not valid for tell/u,
  );
  assert.throws(
    () => parseArgv(["fork", "aku/worker/1234abcd", "--at", "turn/1", "--workdir", "work"]),
    /option --workdir is not valid for fork/u,
  );
});

test("verify parses contextual and indexed execution and refuses malformed index syntax", () => {
  assert.deepEqual(command(["verify"]), { name: "verify", input: { includeDirty: false }, output: "text" });
  assert.deepEqual(command(["verify", "@example", "--index", "2", "--include-dirty", "--json"]), {
    name: "verify",
    input: { contract: "@example", index: 2, includeDirty: true },
    output: "json",
  });
  for (const value of ["0", "-1", "+1", "01", "1.0", "1e2", "2x", "9007199254740992"]) {
    assert.throws(() => parseArgv(["verify", "--index", value]), CliUsageError, value);
  }
  assert.throws(() => parseArgv(["verify", "--index", "1", "--index", "2"]), /duplicate option/u);
  assert.throws(() => parseArgv(["verify", "kei/one", "kei/two"]), /at most one contract/u);
  assert.throws(() => parseArgv(["verify", "-"]), /verify reads no stdin/u);
  assert.throws(() => parseArgv(["verify", "--dry-run"]), /not valid for verify/u);
  assert.doesNotThrow(() => assertExplicitRepoUse(command(["verify"]), "/repo"));
});

test("delivery dry-run parses preview options and rejects unused mutation options", () => {
  assert.deepEqual(command(["deliver"]), {
    name: "deliver",
    input: { includeDirty: false, materializeConflict: false, overwrite: false },
    output: "text",
  });
  assert.deepEqual(command(["deliver", "--dry-run"]), {
    name: "deliver",
    input: { includeDirty: false, dryRun: true, showDiff: false },
    output: "text",
  });
  assert.deepEqual(command(["deliver", "kei/example", "--dry-run", "--show-diff", "--include-dirty"]), {
    name: "deliver",
    input: { contract: "kei/example", includeDirty: true, dryRun: true, showDiff: true },
    output: "text",
  });
  assert.deepEqual(command(["deliver", "@example", "--dry-run", "--show-diff", "--json"]), {
    name: "deliver",
    input: { contract: "@example", includeDirty: false, dryRun: true, showDiff: true },
    output: "json",
  });
  assert.throws(() => parseArgv(["deliver", "--dry-run", "--diff"]), /option --diff is not valid for deliver/u);
  assert.throws(() => parseArgv(["deliver", "--show-diff"]), /--show-diff requires --dry-run/u);
  for (const options of [["--overwrite"], ["--materialize-conflict"], ["--message", "unused"]]) {
    assert.throws(() => parseArgv(["deliver", "--dry-run", ...options]), /not valid with --dry-run/u);
  }
  assert.throws(() => parseArgv(["audit"]), CliUsageError);
  assert.throws(() => parseArgv(["deliver-preview"]), CliUsageError);
});

test("show parses a standalone Contract guidance read with root coordinates", () => {
  assert.throws(() => parseArgv(["show"]), /show requires one explicit selector/u);
  for (const selector of ["kei/example", "@example"]) {
    assert.deepEqual(parseArgv(["-C", "/invocation", "--repo", "/repository", "show", selector, "--json"]), {
      cwd: "/invocation",
      repo: "/repository",
      command: { name: "show", input: { selector }, output: "json" },
    });
  }
  for (const selector of ["aku", "aku/", "aku/*", "kei", "kei/", "kei/*", "aku/worker/1234abcd", "kei/foo*"]) {
    assert.throws(() => parseArgv(["show", selector]), CliUsageError);
  }
  assert.throws(() => parseArgv(["show", "kei/one", "kei/two"]), /at most one selector/u);
  assert.throws(() => parseArgv(["show", "--guidance"]), /not valid for show/u);
  assert.throws(() => parseArgv(["show", "--limit", "2"]), /not valid for show/u);
  assert.throws(() => parseArgv(["show", "-"]), /show reads no stdin/u);
});

test("ls parses caller-scoped Akuma selection", () => {
  assert.deepEqual(parseArgv(["ls", "--mine"]), {
    command: { name: "ls", input: { selector: "aku/*", mine: true }, output: "text" },
  });
  assert.deepEqual(parseArgv(["ls", "aku/*/*", "--mine", "--json"]), {
    command: { name: "ls", input: { selector: "aku/*/*", mine: true }, output: "json" },
  });
  assert.deepEqual(parseArgv(["ls", "aku/intern", "--mine"]), {
    command: { name: "ls", input: { selector: "aku/intern", mine: true }, output: "text" },
  });
  for (const argv of [
    ["ls", "aku/*/*", "--caller", "slack:channel"],
    ["ls", "aku/", "--mine"],
    ["ls", "kei", "--mine"],
    ["ls", "debt", "--mine"],
  ])
    assert.throws(() => parseArgv(argv), CliUsageError, argv.join(" "));
});

test("bind and amend retain complete after snapshots and mixed gate selectors", () => {
  assert.deepEqual(
    parseArgv(["bind", "--after", "kei/one", "--after", "kei/two", "--gates", "strict,review-only", "-"]),
    {
      command: {
        name: "bind",
        input: { after: ["kei/one", "kei/two"], gates: ["strict", "review-only"] },
        acquire: { markdown: true },
        output: "text",
      },
    },
  );
  assert.deepEqual(parseArgv(["amend", "kei/example", "--clear-after", "-"]), {
    command: {
      name: "amend",
      input: { contract: "kei/example", after: [] },
      acquire: { markdown: true },
      output: "text",
    },
  });
  assert.deepEqual(parseArgv(["amend", "kei/example", "--after", "kei/one"]), {
    command: { name: "amend", input: { contract: "kei/example", after: ["kei/one"] }, output: "text" },
  });
  assert.deepEqual(parseArgv(["amend", "kei/example", "--clear-after"]), {
    command: { name: "amend", input: { contract: "kei/example", after: [] }, output: "text" },
  });
  assert.deepEqual(parseArgv(["amend", "kei/example", "--gates", "default"]), {
    command: { name: "amend", input: { contract: "kei/example", gates: ["default"] }, output: "text" },
  });
  assert.deepEqual(parseArgv(["amend", "kei/example", "--target", "main"]), {
    command: { name: "amend", input: { contract: "kei/example", target: "main" }, output: "text" },
  });
  assert.deepEqual(parseArgv(["bind", "--gates", "", "-"]), {
    command: { name: "bind", input: { gates: [] }, acquire: { markdown: true }, output: "text" },
  });
  assert.deepEqual(parseArgv(["amend", "kei/example", "--gates", ""]), {
    command: { name: "amend", input: { contract: "kei/example", gates: [] }, output: "text" },
  });
  assert.deepEqual(parseArgv(["bind", "--gates", "reviewed,strict", "-"]), {
    command: { name: "bind", input: { gates: ["reviewed", "strict"] }, acquire: { markdown: true }, output: "text" },
  });
  for (const value of [",", "strict,", ",strict", "strict,,default"]) {
    assert.throws(() => parseArgv(["bind", "--gates", value, "-"]), /comma-separated names/u);
  }
  for (const value of [" ,--strict", "BAD GATE!!", "Strict"]) {
    assert.throws(() => parseArgv(["bind", "--gates", value, "-"]), /--gates name must match/u);
  }
  // An amendment that names no edit stays that way: omission never synthesizes clearing fields.
  assert.deepEqual(parseArgv(["amend", "kei/example"]), {
    command: { name: "amend", input: { contract: "kei/example" }, output: "text" },
  });
  assert.deepEqual(parseArgv(["amend"]), {
    command: { name: "amend", input: {}, output: "text" },
  });
  assert.throws(
    () => parseArgv(["amend", "kei/example", "--after", "kei/one", "--clear-after", "-"]),
    /mutually exclusive/,
  );
  assert.throws(() => parseArgv(["bind", "--clear-after", "-"]), /not valid for bind/);
});

test("spawn accepts a bare alias name and keeps prefixed input compatible", () => {
  for (const input of ["pi-reset-api-review", "@pi-reset-api-review"]) {
    const parsed = command(["spawn", "intern", "--alias", input, "audit"]);
    assert.ok("name" in parsed && parsed.name === "spawn");
    assert.equal(parsed.input.alias, "@pi-reset-api-review");
  }
  const unicode = command(["spawn", "审查-二号", "--alias", "审查-二号", "audit"]);
  assert.ok("name" in unicode && unicode.name === "spawn");
  assert.equal(unicode.input.alias, "@审查-二号");
  assert.throws(() => parseArgv(["spawn", "intern", "--alias", "Reviewer", "audit"]), /normalized Akuma name/u);
  assert.throws(() => parseArgv(["spawn", "intern", "--alias", "a".repeat(65), "audit"]), /64 UTF-8 bytes/u);
});

test("wait accepts mixed selector families while kill takes one expanding selector", () => {
  assert.deepEqual(command(["wait", "kei/example", "aku/work*/12*", "--for", "5m"]), {
    name: "wait", input: { selectors: ["kei/example", "aku/work*/12*"], for: "5m" }, output: "text",
  });
  for (const action of ["wait", "kill"] as const) {
    const selectors = ["kei/example"];
    const parsed = parseArgv([action, ...selectors, "--repo", "/repo", "--json"]);
    assert.ok("command" in parsed);
    assert.deepEqual(parsed.command, {
      name: action,
      input: action === "wait" ? { selectors } : { akuma: selectors[0]! },
      output: "json",
    });
    assert.doesNotThrow(() => assertExplicitRepoUse(parsed.command, parsed.repo));
    const akumaOnly = parseArgv([action, "aku/*/*", "--repo", "/repo"]);
    assert.ok("command" in akumaOnly);
    assert.throws(() => assertExplicitRepoUse(akumaOnly.command, akumaOnly.repo), /--repo has no consumer/u);
  }
  assert.deepEqual(command(["kill", "aku/work*/12*"]), {
    name: "kill", input: { akuma: "aku/work*/12*" }, output: "text",
  });
  assert.throws(() => command(["kill", "kei/example", "aku/work*/12*"]), /kill accepts one Akuma selector/u);
});

test("tell admits text without observation and ask requires a schema document", () => {
  assert.deepEqual(command(["tell", "@worker", "continue"]), {
    name: "tell",
    input: { akuma: "@worker" },
    acquire: { prompt: { kind: "argument", value: "continue" } },
    output: "text",
  });
  for (const [tokens, wait] of [[[], true], [["0ms"], "0ms"]] as const) {
    assert.deepEqual(command(["tell", "@worker", "--wait", ...tokens, "continue"]), {
      name: "tell", input: { akuma: "@worker", wait },
      acquire: { prompt: { kind: "argument", value: "continue" } }, output: "text",
    });
  }
  const overflow = "9007199254740992ms";
  assert.throws(() => command(["tell", "@worker", "--wait", overflow]), /duration exceeds/u);
  assert.deepEqual(command(["tell", "@worker", "--wait", "--", overflow]), {
    name: "tell", input: { akuma: "@worker", wait: true },
    acquire: { prompt: { kind: "argument", value: overflow } }, output: "text",
  });
  assert.deepEqual(command(["tell", "@worker", "--wait", "-"]), {
    name: "tell", input: { akuma: "@worker", wait: true }, acquire: { prompt: { kind: "stdin" } }, output: "text",
  });
  assert.deepEqual(command(["ask", "aku/worker/1234abcd", "--schema", "answer.json", "--wait", "5m", "continue"]), {
    name: "ask",
    input: { akuma: "aku/worker/1234abcd", timeout: "5m" },
    acquire: { schema: "answer.json", prompt: { kind: "argument", value: "continue" } },
    output: "text",
  });
  assert.deepEqual(command(["ask", "@worker", "--schema", "answer.json", "-"]), {
    name: "ask", input: { akuma: "@worker" },
    acquire: { prompt: { kind: "stdin" }, schema: "answer.json" }, output: "text",
  });
  assert.throws(() => parseArgv(["tell", "@worker", "--wait"]), /requires a prompt/u);
  assert.throws(() => parseArgv(["ask", "@worker", "continue"]), CliUsageError);

  assert.throws(() => parseArgv(["tell", "@worker"]), /requires a prompt/u);
});

test("review accepts either summary source", () => {
  assert.deepEqual(command(["review", "kei/example", "--satisfied", "--summary", "ok"]), {
    name: "review",
    input: { contract: "kei/example", verdict: "satisfied", summary: "ok" },
    output: "text",
  });
  assert.deepEqual(command(["review", "--unsatisfied", "-"]), {
    name: "review",
    input: { verdict: "unsatisfied" },
    acquire: { summary: true },
    output: "text",
  });
});

test("exact-one source selection and nonblank argv fail at parse", () => {
  const cases: ReadonlyArray<readonly [argv: readonly string[], pattern: RegExp]> = [
    [["review", "--satisfied"], /review requires exactly one of --summary <text> or stdin '-'/],
    [["review", "--satisfied", "--summary", "ok", "-"], /review requires exactly one of --summary <text> or stdin '-'/],
    [["review", "--satisfied", "--summary", ""], /--summary requires a nonblank value/],
    [["review", "--satisfied", "--summary", " \t"], /--summary requires a nonblank value/],
    [["bind", "--target", "", "-"], /--target requires a nonblank value/],
    [["bind", "--target", "main", "--no-target", "-"], /mutually exclusive/],
    [["deliver", "--message", "  "], /--message requires a nonblank value/],
    [["abandon", "--note", "\n"], /--note requires a nonblank value/],
    [["spawn", "worker", "ok", "-"], /accepts either a prompt argument or stdin, not both/],
    [["spawn", "worker", "ok", "-"], /accepts either a prompt argument or stdin, not both/],
    [["spawn", "worker", ""], /spawn requires a nonblank value/],
    [["spawn", " ", "-"], /spawn requires a nonblank value/],
    [["tell", "aku/claude/1234abcd", " \u00a0"], /tell requires a nonblank value/],
    [["fork", "aku/claude/1234abcd", "--at", "  "], /--at requires a nonblank value/],
    [["debt", "add"], /debt add requires either TITLE or '-' input/],
    [["debt", "add", "Title", "-"], /debt add requires either TITLE or '-' input/],
    [["debt", "add", "  "], /debt add requires a nonblank value/],
    [["debt", "add", "Title", "--note", "\t"], /option --note is not valid for debt add/],
    [["debt", "update", "debt/a", "--title", " "], /--title requires a nonblank value/],
    [["bind", "--after", "   ", "-"], /--after requires a nonblank value/],
    [["bind", "--after", "kei/one", "--after", " ", "-"], /--after requires a nonblank value/],
    [["spawn", "worker", "--contract", " ", "prompt"], /--contract requires a nonblank value/],
    [["show", " "], /show requires a nonblank value/],
    [["debt", "add", "Title", "--needs", "debt/a", "--needs", "\t"], /duplicate option: --needs/],
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
    name: "review",
    input: { verdict: "unsatisfied", summary: "  keep  " },
    output: "text",
  });
  const called = command(["spawn", "worker", "  keep  "]);
  assert.ok("name" in called && called.name === "spawn" && "acquire" in called);
  assert.deepEqual(called.acquire.prompt, { kind: "argument", value: "  keep  " });
  assert.deepEqual(command(["debt", "add", "--", "--urgent debt"]), {
    command: "debt",
    action: "add",
    output: "text",
    positionals: ["--urgent debt"],
    flags: {},
  });
  assert.deepEqual(command(["debt", "add", "Title", "--body", "", "--needs", "debt/a,debt/b"]), {
    command: "debt",
    action: "add",
    output: "text",
    positionals: ["Title"],
    flags: { body: "", needs: "debt/a,debt/b" },
  });
  assert.deepEqual(command(["debt", "update", "debt/a", "--state", "done", "--note", ""]), {
    command: "debt",
    action: "update",
    output: "text",
    positionals: ["debt/a"],
    flags: { state: "done", note: "" },
  });
  assert.deepEqual(command(["spawn", "worker", "--", "--workdir"]), {
    name: "spawn",
    input: { akumaName: "worker" },
    acquire: { prompt: { kind: "argument", value: "--workdir" } },
    output: "text",
  });
  assert.deepEqual(parseArgv(["spawn", "worker", "--", "--workdir"]), {
    command: {
      name: "spawn",
      input: { akumaName: "worker" },
      acquire: { prompt: { kind: "argument", value: "--workdir" } },
      output: "text",
    },
  });
  assert.throws(() => parseArgv(["bind", "--gates", "--json", "-"]), /--gates requires a value/u);
  assert.deepEqual(command(["debt", "update", "debt/a", "--priority", "1"]), {
    command: "debt",
    action: "update",
    output: "text",
    positionals: ["debt/a"],
    flags: { priority: "1" },
  });
});

test("history accepts shared pages, exact records and Akuma answers", () => {
  for (const args of [
    ["history", "@worker", "--since", "2", "--limit", "4"],
    ["history", "@worker", "--id", "turn/3"],
    ["history", "@worker", "--id", "3"],
    ["history", "@worker", "--answer"],
    ["history", "kei/example", "--id", "2", "--json"],
    ["history", "kei/example", "--before", "4", "--limit", "2"],
    ["history", "kei/example", "--since", "1"],
  ])
    assert.doesNotThrow(() => parseArgv(args));
  for (const selector of ["@worker", "kei/example"]) {
    for (const id of ["0", "-1", "01", "+1", "1.5", "1e2", "9007199254740992", "act/3"]) {
      assert.throws(() => parseArgv(["history", selector, "--id", id]));
    }
    assert.throws(() => parseArgv(["history", selector, "--id", "3", "--answer"]), /cannot be combined/u);
    assert.throws(() => parseArgv(["history", selector, "--answer", "--limit", "4"]), /cannot be combined/u);
  }
  assert.throws(() => parseArgv(["history", "kei/example", "--answer"]), /requires an Akuma/u);
  assert.throws(() => parseArgv(["history", "kei/example", "--id", "turn/1"]), /decimal integer/u);
});

test("history keeps the id conflict ahead of an invalid limit and id", () => {
  assert.throws(
    () => parseArgv(["history", "aku/worker/1234abcd", "--id", "not-a-turn", "--limit", "0"]),
    /history --id cannot be combined with --answer, --before, --since, or --limit/u,
  );
});
