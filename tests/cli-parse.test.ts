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

test("show routes complete Debt addresses to the native Debt operation", () => {
  assert.deepEqual(command(["show", "debt/example"]), {
    name: "debt.show", input: { id: "debt/example" }, output: "text",
  });
  assert.deepEqual(command(["show", "debt/one", "debt/ns/two", "--json"]), {
    name: "debt.show", input: { ids: ["debt/one", "debt/ns/two"] }, output: "json",
  });
  assert.throws(() => command(["show", "debt/one", "kei/two"]), /cannot mix Debt and Contract/u);
  assert.throws(() => command(["show", "@one", "debt/two"]), /cannot mix Debt and Contract/u);
  assert.throws(() => command(["show", "debt/Bad Name"]), /debt ID/u);
  assert.throws(() => assertExplicitRepoUse(command(["show", "debt/example"]), "/repo"), /no consumer/u);
});

test("root Debt listings select closed or all only for Debt", () => {
  assert.deepEqual(command(["ls", "debt/", "--closed"]), {
    name: "ls",
    output: "text",
    input: { of: "debt", namespace: [], selection: "closed" },
  });
  assert.deepEqual(command(["ls", "debt/ns/", "--all"]), {
    name: "ls",
    output: "text",
    input: { of: "debt", namespace: ["ns"], selection: "all" },
  });
  assert.throws(() => command(["ls", "debt", "--all", "--closed"]), CliUsageError);
  assert.throws(() => command(["ls", "kei", "--all"]), CliUsageError);
  assert.throws(() => command(["ls", "aku", "--closed"]), CliUsageError);
});

test("nuke admits only a literal WorldRoot confirmation", () => {
  assert.deepEqual(parseArgv(["nuke"]), {
    command: { name: "nuke", input: {}, output: "text" },
  });
  assert.deepEqual(parseArgv(["nuke", "--confirm", "/world/root", "--json"]), {
    command: { name: "nuke", input: { confirm: "/world/root" }, output: "json" },
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
  assert.deepEqual(parseArgv(["ls", "debt/", "-C", "/repo/caller"]), {
    cwd: "/repo/caller",
    command: { name: "ls", input: { of: "debt", namespace: [] }, output: "text" },
  });
  assert.deepEqual(parseArgv(["settings", "--cwd", "/repo/caller"]), {
    cwd: "/repo/caller",
    command: { name: "settings", input: {}, output: "text" },
  });
  assert.deepEqual(parseArgv(["--repo", "../delivery", "status", "-C", "/repo/caller"]), {
    cwd: "/repo/caller",
    repo: "../delivery",
    command: { name: "status", input: {}, output: "text" },
  });
  assert.deepEqual(parseArgv(["spawn", "worker", "--workdir", "work", "body"]), {
    workdir: "work",
    command: {
      name: "spawn",
      input: { akumaName: "worker", mode: "detach" },
      acquire: { prompt: { kind: "argument", value: "body" } },
      output: "text",
    },
  });
  assert.deepEqual(parseArgv(["spawn", "worker", "--contract", "kei/example", "--workdir", "work", "body"]), {
    workdir: "work",
    command: {
      name: "spawn",
      input: { akumaName: "worker", contract: "kei/example", mode: "detach" },
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
    input: { akumaName: "worker", mode: "detach" },
    acquire: {},
    output: "text",
  });
  assert.deepEqual(command(["spawn", "worker", "--bare"]), {
    name: "spawn",
    input: { akumaName: "worker", mode: "detach", bare: true },
    acquire: {},
    output: "text",
  });
  assert.deepEqual(command(["fork", "@worker", "--at", "turn/1", "--bare"]), {
    name: "fork",
    input: { akuma: "@worker", at: "turn/1", bare: true },
    output: "text",
  });
  assert.throws(() => parseArgv(["spawn", "worker", "--wait", "1s"]), /spawn --wait requires a prompt/u);

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

test("spawn repeats native writable-directory grants and refuses retired options", () => {
  assert.deepEqual(command(["spawn", "worker", "--add-dir", "../runtime", "--add-dir", "/square"]), {
    name: "spawn",
    input: { akumaName: "worker", mode: "detach", writableDirectories: ["../runtime", "/square"] },
    acquire: {},
    output: "text",
  });
  assert.throws(
    () => command(["spawn", "worker", "--allowed", "contract.review"]),
    /option --allowed is not valid for spawn/u,
  );
  assert.throws(() => command(["spawn", "worker", "--add-dir"]), /--add-dir requires/u);
  assert.throws(() => command(["fork", "@worker", "--at", "turn/1", "--add-dir", "/square"]), /--add-dir/u);
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
    () => parseArgv(["spawn", "worker", "--version"]),
    (error: unknown) =>
      error instanceof CliUsageError && error.message.includes("option --version is not valid for spawn"),
  );
  assert.throws(
    () => parseArgv(["tell", "@worker", "--version"]),
    (error: unknown) =>
      error instanceof CliUsageError && error.message.includes("option --version is not valid for tell"),
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
    name: "deliver.preview",
    input: { includeDirty: false, showDiff: false },
    output: "text",
  });
  assert.deepEqual(command(["deliver", "kei/example", "--dry-run", "--show-diff", "--include-dirty"]), {
    name: "deliver.preview",
    input: { contract: "kei/example", includeDirty: true, showDiff: true },
    output: "text",
  });
  assert.deepEqual(command(["deliver", "@example", "--dry-run", "--show-diff", "--json"]), {
    name: "deliver.preview",
    input: { contract: "@example", includeDirty: false, showDiff: true },
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
  assert.deepEqual(parseArgv(["show"]), { command: { name: "show", input: {}, output: "text" } });
  for (const selector of ["kei/example", "@example"]) {
    assert.deepEqual(parseArgv(["-C", "/invocation", "--repo", "/repository", "show", selector, "--json"]), {
      cwd: "/invocation",
      repo: "/repository",
      command: { name: "show", input: { contract: selector }, output: "json" },
    });
  }
  for (const selector of ["aku", "aku/", "aku/*", "kei", "kei/", "kei/*", "aku/worker/1234abcd", "kei/foo*"]) {
    assert.throws(() => parseArgv(["show", selector]), CliUsageError);
  }
  assert.throws(() => parseArgv(["show", "kei/one", "kei/two"]), /at most one Contract/u);
  assert.throws(() => parseArgv(["show", "--guidance"]), /not valid for show/u);
  assert.throws(() => parseArgv(["show", "--limit", "2"]), /not valid for show/u);
  assert.throws(() => parseArgv(["show", "-"]), /show reads no stdin/u);
});

test("show parses one Contract selector and JSON output; status refuses the retired guidance flag", () => {
  assert.deepEqual(parseArgv(["show", "kei/example", "--json"]), {
    command: { name: "show", input: { contract: "kei/example" }, output: "json" },
  });
  assert.deepEqual(parseArgv(["show", "@example"]), {
    command: { name: "show", input: { contract: "@example" }, output: "text" },
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
      command: { name: "ls", input: { of: "debt", namespace: [] }, output: "text" },
    });
  }
  assert.deepEqual(parseArgv(["ls", "debt/feature/sub/", "--json"]), {
    command: { name: "ls", input: { of: "debt", namespace: ["feature", "sub"] }, output: "json" },
  });
  for (const path of ["debt/feature", "debt//", "debt/feature//"]) {
    assert.throws(() => parseArgv(["ls", path]), /Debt namespace selector/);
  }
  for (const path of ["kei", "kei/"]) {
    assert.deepEqual(parseArgv(["ls", path, "--json"]), {
      command: { name: "ls", input: { of: "kei" }, output: "json" },
    });
  }
  assert.deepEqual(parseArgv(["ls", "kei/", "--limit", "100"]), {
    command: { name: "ls", input: { of: "kei", limit: 100 }, output: "text" },
  });
  assert.throws(() => parseArgv(["ls", "kei/", "--limit", "0"]), /positive safe integer/u);
  for (const path of ["aku", "aku/"]) {
    assert.deepEqual(parseArgv(["ls", path]), {
      command: { name: "ls", input: { of: "akuma-name" }, output: "text" },
    });
  }
  for (const path of ["aku/worker", "aku/worker/"]) {
    assert.deepEqual(parseArgv(["ls", path]), {
      command: { name: "ls", input: { of: "aku", akumaName: "worker" }, output: "text" },
    });
  }
  assert.deepEqual(parseArgv(["ls", "aku/*/*"]), {
    command: { name: "ls", input: { of: "aku" }, output: "text" },
  });
  assert.deepEqual(parseArgv(["ls", "aku/elite/*", "--limit", "40"]), {
    command: { name: "ls", input: { of: "aku", akumaName: "elite", limit: 40 }, output: "text" },
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
    command: { name: "ls", input: { of: "aku", caller: { kind: "mine" } }, output: "text" },
  });
  assert.deepEqual(parseArgv(["ls", "aku/*/*", "--mine", "--json"]), {
    command: { name: "ls", input: { of: "aku", caller: { kind: "mine" } }, output: "json" },
  });
  assert.deepEqual(parseArgv(["ls", "aku/intern", "--mine"]), {
    command: { name: "ls", input: { of: "aku", akumaName: "intern", caller: { kind: "mine" } }, output: "text" },
  });
  assert.deepEqual(parseArgv(["ls", "aku/*/*", "--caller", "slack:channel:thread"]), {
    command: {
      name: "ls",
      input: {
        of: "aku",
        caller: { kind: "external", caller: { kind: "external", integration: "slack", id: "channel:thread" } },
      },
      output: "text",
    },
  });
  assert.deepEqual(parseArgv(["ls", "aku/worker/*", "--caller", "aku/lead/1234abcd", "--limit", "5"]), {
    command: {
      name: "ls",
      input: {
        of: "aku",
        akumaName: "worker",
        caller: { kind: "akuma", akumaId: "aku/lead/1234abcd" },
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
      name: "abandon",
      input: { contract: "kei/example", note: "scope changed", actor: "operator" },
      output: "text",
    },
  });
  assert.throws(() => parseArgv(["abandon", "kei/example", "--reason", "manual"]), CliUsageError);
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

test("wait accepts a plural selection without an explicit completion mode", () => {
  assert.deepEqual(command(["wait", "aku/claude/1234abcd", "aku/claude/5678ef90"]), {
    name: "wait",
    input: { selectors: ["aku/claude/1234abcd", "aku/claude/5678ef90"] },
    output: "text",
  });
  assert.deepEqual(command(["wait", "aku/claude/1234abcd", "@peer", "--timeout", "5m"]), {
    name: "wait",
    input: { selectors: ["aku/claude/1234abcd", "@peer"], timeoutMs: 300_000 },
    output: "text",
  });
  assert.deepEqual(command(["wait", "aku/*/*", "--all"]), {
    name: "wait",
    input: { selectors: ["aku/*/*"], completion: "all" },
    output: "text",
  });
  assert.deepEqual(command(["wait", "aku/*/*", "--any"]), {
    name: "wait",
    input: { selectors: ["aku/*/*"], completion: "any" },
    output: "text",
  });
  assert.throws(() => parseArgv(["wait", "@one", "@two", "--any", "--all"]), /mutually exclusive/u);
});

test("wait rejects mixed selector families while kill retains mixed selection", () => {
  assert.throws(
    () => command(["wait", "kei/example", "aku/work*/12*"]),
    /wait cannot mix Contract and Akuma selectors/u,
  );
  for (const action of ["wait", "kill"] as const) {
    const selectors = action === "wait" ? ["kei/example"] : ["kei/example", "aku/work*/12*"];
    const parsed = parseArgv([action, ...selectors, "--repo", "/repo", "--json"]);
    assert.ok("command" in parsed);
    assert.deepEqual(parsed.command, {
      name: action,
      input: action === "wait" ? { selectors } : { akuma: selectors },
      output: "json",
    });
    assert.doesNotThrow(() => assertExplicitRepoUse(parsed.command, parsed.repo));
    const akumaOnly = parseArgv([action, "aku/*/*", "--repo", "/repo"]);
    assert.ok("command" in akumaOnly);
    assert.throws(() => assertExplicitRepoUse(akumaOnly.command, akumaOnly.repo), /--repo has no consumer/u);
  }
});

test("tell parses text observation and ask requires a schema document", () => {
  assert.deepEqual(command(["tell", "@worker", "continue"]), {
    name: "tell",
    input: { akuma: "@worker" },
    acquire: { prompt: { kind: "argument", value: "continue" } },
    output: "text",
  });
  assert.deepEqual(command(["tell", "@worker", "--wait", "0ms", "continue"]), {
    name: "tell",
    input: { akuma: "@worker", wait: true, timeoutMs: 0 },
    acquire: { prompt: { kind: "argument", value: "continue" } },
    output: "text",
  });
  assert.deepEqual(command(["ask", "aku/worker/1234abcd", "--schema", "answer.json", "--wait", "5m", "continue"]), {
    name: "ask",
    input: { akuma: "aku/worker/1234abcd", timeoutMs: 300_000 },
    acquire: { schema: "answer.json", prompt: { kind: "argument", value: "continue" } },
    output: "text",
  });
  assert.deepEqual(command(["ask", "@worker", "--schema", "answer.json", "-"]), {
    name: "ask", input: { akuma: "@worker" },
    acquire: { prompt: { kind: "stdin" }, schema: "answer.json" }, output: "text",
  });
  assert.throws(() => parseArgv(["tell", "@worker", "--wait"]), /--wait requires a value/u);
  assert.throws(() => parseArgv(["ask", "@worker", "continue"]), CliUsageError);
  assert.throws(() => parseArgv(["tell", "@worker", "--wait", "--interrupt", "continue"]), /--wait requires a value/u);
  assert.throws(() => parseArgv(["tell", "@worker", "--wait", "later", "continue"]), /integer duration/u);
  assert.throws(() => parseArgv(["tell", "@worker"]), /requires a prompt/u);
});

test("review accepts actor with either summary source", () => {
  assert.deepEqual(command(["review", "kei/example", "--satisfied", "--summary", "ok", "--actor", "operator"]), {
    name: "review",
    input: { contract: "kei/example", verdict: "satisfied", summary: "ok", actor: "operator" },
    output: "text",
  });
  assert.deepEqual(command(["review", "--unsatisfied", "--actor", "operator", "-"]), {
    name: "review",
    input: { verdict: "unsatisfied", actor: "operator" },
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
    [["review", "--satisfied", "--summary", "ok", "--actor", " "], /--actor requires a nonblank value/],
    [["bind", "--target", "", "-"], /--target requires a nonblank value/],
    [["bind", "--target", "main", "--no-target", "-"], /mutually exclusive/],
    [["deliver", "--message", "  "], /--message requires a nonblank value/],
    [["abandon", "--note", "\n"], /--note requires a nonblank value/],
    [["bind", "--actor", " ", "-"], /--actor requires a nonblank value/],
    [["spawn", "worker", "ok", "-"], /accepts either a prompt argument or stdin, not both/],
    [["spawn", "worker", "ok", "-"], /accepts either a prompt argument or stdin, not both/],
    [["spawn", "worker", ""], /spawn requires a nonblank value/],
    [["spawn", " ", "-"], /spawn requires a nonblank value/],
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
    [["spawn", "worker", "--contract", " ", "prompt"], /--contract requires a nonblank value/],
    [["show", " "], /show requires a nonblank value/],
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
  assert.deepEqual(command(["spawn", "worker", "--", "--workdir"]), {
    name: "spawn",
    input: { akumaName: "worker", mode: "detach" },
    acquire: { prompt: { kind: "argument", value: "--workdir" } },
    output: "text",
  });
  assert.deepEqual(parseArgv(["spawn", "worker", "--", "--workdir"]), {
    command: {
      name: "spawn",
      input: { akumaName: "worker", mode: "detach" },
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

test("a deliberately targetless bind parses as an explicit absence", () => {
  assert.deepEqual(parseArgv(["bind", "--no-target", "-", "--json"]), {
    command: { name: "bind", input: { target: null }, acquire: { markdown: true }, output: "json" },
  });
  assert.deepEqual(parseArgv(["bind", "--fork-of", "kei/source", "--no-target", "--json"]), {
    command: { name: "bind", input: { forkOf: "kei/source", target: null }, output: "json" },
  });
});

test("stdin marker is position independent for Contract commands and global coordinates", () => {
  assert.deepEqual(parseArgv(["bind", "-", "--debt", "debt/example", "--json"]), {
    command: { name: "bind", input: { debt: "debt/example" }, acquire: { markdown: true }, output: "json" },
  });
  assert.deepEqual(parseArgv(["amend", "-", "kei/example", "--json"]), {
    command: { name: "amend", input: { contract: "kei/example" }, acquire: { markdown: true }, output: "json" },
  });
  assert.deepEqual(parseArgv(["arc", "-", "--actor", "operator", "kei/example"]), {
    command: {
      name: "arc",
      input: { contract: "kei/example", actor: "operator" },
      acquire: { markdown: true },
      output: "text",
    },
  });
  assert.deepEqual(parseArgv(["review", "-", "--satisfied", "kei/example"]), {
    command: {
      name: "review",
      input: { contract: "kei/example", verdict: "satisfied" },
      acquire: { summary: true },
      output: "text",
    },
  });
  assert.deepEqual(parseArgv(["bind", "-", "-C", "/repo/caller", "--repo", "../delivery"]), {
    cwd: "/repo/caller",
    repo: "../delivery",
    command: { name: "bind", input: {}, acquire: { markdown: true }, output: "text" },
  });
  assert.deepEqual(parseArgv(["tell", "aku/claude/1234abcd", "--", "--json"]), {
    command: {
      name: "tell",
      input: { akuma: "aku/claude/1234abcd" },
      acquire: { prompt: { kind: "argument", value: "--json" } },
      output: "text",
    },
  });
  assert.deepEqual(parseArgv(["spawn", "worker", "--", "--cwd"]), {
    command: {
      name: "spawn",
      input: { akumaName: "worker", mode: "detach" },
      acquire: { prompt: { kind: "argument", value: "--cwd" } },
      output: "text",
    },
  });
  assert.deepEqual(parseArgv(["spawn", "worker", "--", "--help"]), {
    command: {
      name: "spawn",
      input: { akumaName: "worker", mode: "detach" },
      acquire: { prompt: { kind: "argument", value: "--help" } },
      output: "text",
    },
  });
  assert.deepEqual(parseArgv(["--repo", "../delivery", "bind", "-", "-C", "/repo/caller"]), {
    cwd: "/repo/caller",
    repo: "../delivery",
    command: { name: "bind", input: {}, acquire: { markdown: true }, output: "text" },
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
  ])
    assert.doesNotThrow(() => parseArgv(args));
  assert.throws(() => parseArgv(["history", "@worker", "--last", "--limit", "4"]), /cannot be combined/u);
});

test("history keeps the id conflict ahead of an invalid limit and id", () => {
  assert.throws(
    () => parseArgv(["history", "aku/worker/1234abcd", "--id", "not-a-turn", "--limit", "0"]),
    /history --id cannot be combined with --last, --before, --since, or --limit/u,
  );
});
