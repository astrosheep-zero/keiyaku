import assert from "node:assert/strict";
import test from "node:test";
import { AuthorityCorruptionError } from "../src/core/facts/errors.js";
import { decodeJournal } from "../src/core/facts/codec.js";
import { contractId, documentKey, entryUlid, gateWord, snapshotId } from "../src/core/facts/types.js";
import { assertExplicitRepoUse, CliUsageError, parseArgv, type ParsedCommand } from "../src/cli/parse.js";
import { renderContractHelp } from "../src/cli/commands/contract-help.js";

function command(argv: readonly string[]): ParsedCommand {
  const parsed = parseArgv(argv);
  if (!("command" in parsed)) throw new Error("expected an executable command");
  return parsed.command;
}

test("Debt replaces the old family without restoring planning or progress verbs", () => {
  assert.throws(() => parseArgv(["task", "ls"]), CliUsageError);
  for (const verb of ["compose", "start", "stop", "hold", "resume"]) {
    assert.throws(() => parseArgv(["debt", verb]), { diagnostic: /unknown debt command/u });
  }
  assert.throws(() => parseArgv(["debt", "show", "task/example"]), { diagnostic: /debt ID must be/u });
  assert.equal(command(["debt", "show", "debt/example"]).command, "debt");
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
  assert.match(renderContractHelp("nuke"), /usage  keiyaku nuke \[--confirm <world-directory>\]/u);
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
  assert.deepEqual(parseArgv(["debt", "ls", "-C", "/repo/caller"]), {
    cwd: "/repo/caller",
    command: { command: "debt", action: "ls", output: "text", positionals: [], flags: {} },
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
  assert.deepEqual(command(["call", "worker"]), {
    command: "call",
    archetype: "worker",
    mode: "detach",
    output: "text",
  });
  assert.throws(() => parseArgv(["call", "worker", "--schema", "answer.json"]), /call --schema requires a prompt/u);
  assert.throws(() => parseArgv(["call", "worker", "--wait", "1s"]), /call --wait requires a prompt/u);

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

test("delivery dry-run parses preview options and rejects unused mutation options", () => {
  const normal = {
    command: "deliver", includeDirty: false, materializeConflict: false,
    overwrite: false, dryRun: false, showDiff: false, output: "text",
  };
  assert.deepEqual(command(["deliver"]), normal);
  assert.deepEqual(command(["deliver", "--dry-run"]), { ...normal, dryRun: true });
  assert.deepEqual(command(["deliver", "kei/example", "--dry-run", "--show-diff", "--include-dirty"]), {
    ...normal, contract: "kei/example", dryRun: true, includeDirty: true, showDiff: true,
  });
  assert.deepEqual(command(["deliver", "@example", "--dry-run", "--show-diff", "--json"]), {
    ...normal, contract: "@example", dryRun: true, showDiff: true, output: "json",
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
  assert.deepEqual(parseArgv(["show"]), { command: { command: "show", output: "text" } });
  for (const selector of ["kei/example", "@example"]) {
    assert.deepEqual(parseArgv(["-C", "/invocation", "--repo", "/repository", "show", selector, "--json"]), {
      cwd: "/invocation",
      repo: "/repository",
      command: { command: "show", contract: selector, output: "json" },
    });
  }
  for (const selector of ["aku", "aku/", "aku/*", "kei", "kei/", "kei/*", "aku/worker/1234abcd", "kei/foo*"]) {
    assert.throws(() => parseArgv(["show", selector]), CliUsageError);
  }
  assert.throws(() => parseArgv(["show", "kei/one", "kei/two"]), /at most one contract/u);
  assert.throws(() => parseArgv(["show", "--guidance"]), /not valid for show/u);
  assert.throws(() => parseArgv(["show", "--limit", "2"]), /not valid for show/u);
  assert.throws(() => parseArgv(["show", "-"]), /show reads no stdin/u);
});

test("show parses one Contract selector and JSON output; status refuses the retired guidance flag", () => {
  assert.deepEqual(parseArgv(["show", "kei/example", "--json"]), {
    command: { command: "show", contract: "kei/example", output: "json" },
  });
  assert.deepEqual(parseArgv(["show", "@example"]), {
    command: { command: "show", contract: "@example", output: "text" },
  });
  assert.throws(() => parseArgv(["show", "aku/x/*"]), /cannot select an Akuma/u);
  for (const selectors of [[], ["kei/example"], ["@example"], ["kei/one", "kei/two"], ["aku/x/*"]]) {
    assert.throws(
      () => parseArgv(["status", "--guidance", ...selectors]),
      /option --guidance is not valid for status/u,
    );
  }
});

test("bare ls requires a selector rather than opening help", () => {
  assert.throws(() => parseArgv(["ls"]), CliUsageError);
  assert.throws(() => parseArgv(["ls", "--json"]), CliUsageError);
});

test("ls parses only canonical identity directories", () => {
  for (const path of ["debt", "debt/"]) {
    assert.deepEqual(parseArgv(["ls", path]), {
      command: { command: "ls", query: { kind: "debts", namespace: [] }, output: "text" },
    });
  }
  assert.deepEqual(parseArgv(["ls", "debt/feature/sub/", "--json"]), {
    command: { command: "ls", query: { kind: "debts", namespace: ["feature", "sub"] }, output: "json" },
  });
  for (const path of ["debt/feature", "debt//", "debt/feature//"]) {
    assert.throws(() => parseArgv(["ls", path]), /Debt namespace selector/);
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
  assert.deepEqual(parseArgv(["ls", "aku/elite/*", "--limit", "40"]), {
    command: { command: "ls", query: { kind: "akuma", archetype: "elite", limit: 40 }, output: "text" },
  });
  assert.match(renderContractHelp("ls"), /ls "aku\/<name>\/\*"/u);
  for (const path of [
    "keiy/",
    "@review",
    "kei/review",
    "debt/namespace",
    "aku//",
    "aku/worker/1234abcd",
    "aku/*/",
    "aku/worker/extra/",
  ]) {
    assert.throws(() => parseArgv(["ls", path]), CliUsageError);
  }
});

test("ls parses caller-scoped Akuma selection", () => {
  assert.deepEqual(parseArgv(["ls", "--mine"]), {
    command: { command: "ls", query: { kind: "akuma", caller: { kind: "mine" } }, output: "text" },
  });
  assert.deepEqual(parseArgv(["ls", "aku/*/*", "--mine", "--json"]), {
    command: { command: "ls", query: { kind: "akuma", caller: { kind: "mine" } }, output: "json" },
  });
  assert.deepEqual(parseArgv(["ls", "aku/intern", "--mine"]), {
    command: { command: "ls", query: { kind: "akuma", archetype: "intern", caller: { kind: "mine" } }, output: "text" },
  });
  assert.deepEqual(parseArgv(["ls", "aku/*/*", "--caller", "slack:channel:thread"]), {
    command: {
      command: "ls",
      query: {
        kind: "akuma",
        caller: { kind: "external", caller: { kind: "external", integration: "slack", id: "channel:thread" } },
      },
      output: "text",
    },
  });
  assert.deepEqual(parseArgv(["ls", "aku/worker/*", "--caller", "aku/lead/1234abcd", "--limit", "5"]), {
    command: {
      command: "ls",
      query: {
        kind: "akuma",
        archetype: "worker",
        caller: { kind: "akuma", akuId: "aku/lead/1234abcd" },
        limit: 5,
      },
      output: "text",
    },
  });
  for (const argv of [
    ["ls", "aku/*/*", "--mine", "--caller", "slack:channel"],
    ["ls", "aku/*/*", "--caller", "missing-colon"],
    ["ls", "aku/*/*", "--caller", "aku/lead/nothex"],
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
  for (const value of [" ,--strict", "BAD GATE!!", "Strict"]) {
    assert.throws(() => parseArgv(["bind", "--gates", value, "-"]), /--gates name must match/u);
  }
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

test("--gates word grammar restates the Contract owner's gateWord", () => {
  const corpus = [
    "reviewed",
    "strict",
    "a",
    "x9-z",
    "a".repeat(64),
    "Strict",
    "BAD GATE!!",
    "9lives",
    "-lead",
    " ",
    "a_b",
    "café",
    "a".repeat(65),
  ];
  for (const word of corpus) {
    const parse = (): unknown => parseArgv(["bind", "--gates", word, "-"]);
    if (gateWord(word)) assert.doesNotThrow(parse, `--gates ${JSON.stringify(word)}`);
    else assert.throws(parse, /--gates name must match/u, `--gates ${JSON.stringify(word)}`);
  }
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

test("wait and kill select Contracts and Akuma globs with conditional repo coordinates", () => {
  for (const action of ["wait", "kill"] as const) {
    const parsed = parseArgv([action, "kei/example", "aku/work*/12*", "--repo", "/repo", "--json"]);
    assert.ok("command" in parsed);
    assert.deepEqual(parsed.command, {
      command: action,
      akuma: ["kei/example", "aku/work*/12*"],
      output: "json",
    });
    assert.doesNotThrow(() => assertExplicitRepoUse(parsed.command, parsed.repo));
    const akumaOnly = parseArgv([action, "aku/*/*", "--repo", "/repo"]);
    assert.ok("command" in akumaOnly);
    assert.throws(() => assertExplicitRepoUse(akumaOnly.command, akumaOnly.repo), /--repo has no consumer/u);
  }
});

test("tell admits; ask parses optional observation windows and schema", () => {
  assert.deepEqual(command(["tell", "@worker", "continue"]), {
    command: "tell",
    akuma: "@worker",
    interrupt: false,
    prompt: { kind: "argument", value: "continue" },
    output: "text",
  });
  assert.deepEqual(command(["ask", "@worker", "--wait", "0ms", "continue"]), {
    command: "ask",
    akuma: "@worker",
    interrupt: false,
    timeoutMs: 0,
    prompt: { kind: "argument", value: "continue" },
    output: "text",
  });
  assert.deepEqual(command(["ask", "aku/worker/1234abcd", "--schema", "answer.json", "--wait", "5m", "continue"]), {
    command: "ask",
    akuma: "aku/worker/1234abcd",
    interrupt: false,
    schema: "answer.json",
    timeoutMs: 300_000,
    prompt: { kind: "argument", value: "continue" },
    output: "text",
  });
  assert.throws(() => parseArgv(["tell", "@worker", "--wait", "1s", "continue"]), /use ask --wait/u);
  assert.throws(() => parseArgv(["tell", "@worker", "--schema", "answer.json", "continue"]), /use ask --schema/u);
  assert.throws(() => parseArgv(["tell", "@worker", "--wait"]), /use ask --wait/u);
  assert.throws(() => parseArgv(["tell", "@worker", "--schema"]), /use ask --schema/u);
  assert.throws(() => parseArgv(["ask", "@worker", "--wait", "--interrupt", "continue"]), /--wait requires a value/u);
  assert.throws(() => parseArgv(["ask", "@worker", "--wait", "later", "continue"]), /integer duration/u);
  assert.throws(() => parseArgv(["ask", "@worker"]), /requires a prompt/u);
  assert.throws(() => parseArgv(["tell", "@worker"]), /requires a prompt/u);
});

test("review accepts actor with either summary source", () => {
  assert.deepEqual(command(["review", "kei/example", "--satisfied", "--summary", "ok", "--actor", "operator"]), {
    command: "review",
    contract: "kei/example",
    verdict: "satisfied",
    summary: "ok",
    actor: "operator",
    output: "text",
  });
  assert.deepEqual(command(["review", "--unsatisfied", "--actor", "operator", "-"]), {
    command: "review",
    verdict: "unsatisfied",
    summaryFromStdin: true,
    actor: "operator",
    output: "text",
  });
});

test("exact-one source selection and nonblank argv fail at parse", () => {
  const cases: ReadonlyArray<readonly [argv: readonly string[], pattern: RegExp]> = [
    [["review", "--satisfied"], /review requires exactly one of --summary <text> or stdin '-'/],
    [["review", "--satisfied", "--summary", "ok", "-"], /review requires exactly one of --summary <text> or stdin '-'/],
    [["review", "--satisfied", "--summary", ""], /--summary requires a nonblank value/],
    [["review", "--satisfied", "--summary", " \t"], /--summary requires a nonblank value/],
    [["review", "--satisfied", "--summary", "ok", "--actor", " "], /--actor requires a nonblank value/],
    [["bind", "--target", "", "-"], /--target requires a nonblank value/],
    [["bind", "--target", "main", "--no-target", "-"], /mutually exclusive/],
    [["deliver", "--message", "  "], /--message requires a nonblank value/],
    [["abandon", "--note", "\n"], /--note requires a nonblank value/],
    [["bind", "--actor", " ", "-"], /--actor requires a nonblank value/],
    [["call", "worker", "ok", "-"], /accepts either a prompt argument or stdin, not both/],
    [["call", "worker", "ok", "-"], /accepts either a prompt argument or stdin, not both/],
    [["call", "worker", ""], /call requires a nonblank value/],
    [["call", " ", "-"], /call requires a nonblank value/],
    [["tell", "aku/claude/1234abcd", " \u00a0"], /tell requires a nonblank value/],
    [["fork", "aku/claude/1234abcd", "--at", "  "], /--at requires a nonblank value/],
    [["debt", "add"], /debt add requires either TITLE or '-' input/],
    [["debt", "add", "Title", "-"], /debt add requires either TITLE or '-' input/],
    [["debt", "add", "  "], /debt add requires a nonblank value/],
    [["debt", "add", "Title", "--body", ""], /--body requires a nonblank value/],
    [["debt", "add", "Title", "--note", "\t"], /--note requires a nonblank value/],
    [["debt", "add", "Title", "--actor", " "], /--actor requires a nonblank value/],
    [["debt", "update", "debt/a", "--title", " "], /--title requires a nonblank value/],
    [["debt", "done", "debt/a", "--note", ""], /--note requires a nonblank value/],
    [["bind", "--after", "   ", "-"], /--after requires a nonblank value/],
    [["bind", "--after", "kei/one", "--after", " ", "-"], /--after requires a nonblank value/],
    [["call", "worker", "--contract", " ", "prompt"], /--contract requires a nonblank value/],
    [["debt", "show", " "], /debt show requires a nonblank value/],
    [["debt", "add", "Title", "--needs", "debt/a", "--needs", "\t"], /--needs requires a nonblank value/],
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
  assert.deepEqual(command(["debt", "add", "--", "--urgent debt"]), {
    command: "debt",
    action: "add",
    output: "text",
    positionals: ["--urgent debt"],
    flags: {},
  });
  assert.deepEqual(command(["call", "worker", "--", "--workdir"]), {
    command: "call",
    archetype: "worker",
    mode: "detach",
    prompt: { kind: "argument", value: "--workdir" },
    output: "text",
  });
  assert.deepEqual(parseArgv(["call", "worker", "--", "--workdir"]), {
    command: {
      command: "call",
      archetype: "worker",
      mode: "detach",
      prompt: { kind: "argument", value: "--workdir" },
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

test("a deliberately targetless bind parses as an explicit absence", () => {
  assert.deepEqual(parseArgv(["bind", "--no-target", "-", "--json"]), {
    command: { command: "bind", target: null, output: "json" },
  });
  assert.deepEqual(parseArgv(["bind", "--fork-of", "kei/source", "--no-target", "--json"]), {
    command: { command: "bind", forkOf: "kei/source", target: null, output: "json" },
  });
});

test("stdin marker is position independent for Contract commands and global coordinates", () => {
  assert.deepEqual(parseArgv(["bind", "-", "--debt", "debt/example", "--json"]), {
    command: { command: "bind", debt: "debt/example", output: "json" },
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
  assert.deepEqual(parseArgv(["tell", "aku/claude/1234abcd", "--", "--json"]), {
    command: {
      command: "tell",
      akuma: "aku/claude/1234abcd",
      interrupt: false,
      prompt: { kind: "argument", value: "--json" },
      output: "text",
    },
  });
  assert.deepEqual(parseArgv(["call", "worker", "--", "--cwd"]), {
    command: {
      command: "call",
      archetype: "worker",
      mode: "detach",
      prompt: { kind: "argument", value: "--cwd" },
      output: "text",
    },
  });
  assert.deepEqual(parseArgv(["call", "worker", "--", "--help"]), {
    command: {
      command: "call",
      archetype: "worker",
      mode: "detach",
      prompt: { kind: "argument", value: "--help" },
      output: "text",
    },
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

test("history accepts separate paged, exact, last, and Contract forms", () => {
  for (const args of [
    ["history", "@worker", "--since", "2", "--limit", "4"],
    ["history", "@worker", "--id", "turn/3"],
    ["history", "@worker", "--last"],
    ["history", "kei/example", "--full", "--json"],
  ]) assert.doesNotThrow(() => parseArgv(args));
  assert.throws(() => parseArgv(["history", "@worker", "--last", "--limit", "4"]), /cannot be combined/u);
});

test("history keeps the id conflict ahead of an invalid limit and id", () => {
  assert.throws(
    () => parseArgv(["history", "aku/worker/1234abcd", "--id", "not-a-turn", "--limit", "0"]),
    /history --id cannot be combined with --last, --before, --since, or --limit/u,
  );
});
