import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { invoke as invokeRaw, type InvocationResult } from "../src/cli/invoke.js";
import { CliUsageError, parseArgv as parseInvocation, type ParsedExecution } from "../src/cli/parse.js";
import { renderText } from "../src/cli/render/text.js";
import { Keiyaku, Repo, type ContractId } from "../src/index.js";
import { kanshi } from "../src/kanshi/index.js";
import { repositoryWithMain } from "./support/library-verbs.js";
import { World } from "../src/world.js";
import { decodeJournal, encodeEntry } from "../src/core/facts/codec.js";
import type { JournalEntry } from "../src/core/facts/types.js";
import { contractJournalPath } from "../src/git/identity.js";
import {
  readGit,
  repositoryAt,
  updateGitTree,
  updateRefsAtomically,
  writeBlob,
  writeCommit,
  GIT_REF,
} from "../src/git/repository.js";

function parseArgv(argv: readonly string[]): ParsedExecution {
  const parsed = parseInvocation(argv);
  if ("help" in parsed) throw new Error("expected executable command");
  return parsed;
}

async function invoke(invocation: Parameters<typeof invokeRaw>[0], runtime?: Parameters<typeof invokeRaw>[1]): Promise<InvocationResult> {
  return (await invokeRaw(invocation, runtime)) as InvocationResult;
}

function document(title: string, patterns: readonly string[]): string {
  return [
    `# ${title}`,
    "",
    "## Context",
    "Current declarations.",
    "",
    "## Objective",
    "Read Region declarations.",
    "",
    "## Design",
    "Use the Region owner.",
    "",
    "## Region",
    "~~~",
    ...patterns,
    "~~~",
    "",
    "## Criteria",
    "### Reads declarations",
    "The read is typed.",
    "",
  ].join("\n");
}

async function bind(repository: ReturnType<typeof repositoryWithMain>, title: string, patterns: readonly string[]) {
  const result = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: document(title, patterns),
    workspace: "worktree",
    gates: [],
  });
  return { id: (await result.keiyaku.state()).id, contract: result.keiyaku };
}

async function read(repository: ReturnType<typeof repositoryWithMain>, region: Parameters<typeof kanshi>[0]["region"]) {
  return kanshi({
    world: await World.at(repository.path),
    repo: await Repo.at({ path: repository.path }),
    ...(region === undefined ? {} : { region }),
  });
}

test("Kanshi Region reads own declarations, grouped contract overlaps, and query-pattern overlaps", async () => {
  const repository = repositoryWithMain();
  const first = await bind(repository, "Region first", ["src/**", "docs/guide/**"]);
  const second = await bind(repository, "Region second", ["src/cli/**", "tests/**"]);
  const firstIsLeft = first.id.localeCompare(second.id) < 0;

  const defaultReport = await read(repository, undefined);
  assert.equal("region" in defaultReport, false);

  const world = await read(repository, { kind: "declarations" });
  assert.deepEqual(world.region, {
    kind: "present",
    value: {
      kind: "declarations",
      declarations: firstIsLeft
        ? [
            { contract: first.id, patterns: ["src/**", "docs/guide/**"] },
            { contract: second.id, patterns: ["src/cli/**", "tests/**"] },
          ]
        : [
            { contract: second.id, patterns: ["src/cli/**", "tests/**"] },
            { contract: first.id, patterns: ["src/**", "docs/guide/**"] },
          ],
    },
  });

  const own = await read(repository, { kind: "contract", contract: first.id });
  assert.deepEqual(own.region, {
    kind: "present",
    value: {
      kind: "contract",
      declaration: { contract: first.id, patterns: ["src/**", "docs/guide/**"] },
      overlaps: [{ contract: second.id, patterns: [{ mine: "src/**", theirs: "src/cli/**" }] }],
    },
  });

  const path = await read(repository, { kind: "path", patterns: ["src/cli/invoke.ts"] });
  assert.deepEqual(path.region, {
    kind: "present",
    value: {
      kind: "path",
      patterns: ["src/cli/invoke.ts"],
      overlaps: firstIsLeft
        ? [
            { contract: first.id, patterns: [{ mine: "src/cli/invoke.ts", theirs: "src/**" }] },
            { contract: second.id, patterns: [{ mine: "src/cli/invoke.ts", theirs: "src/cli/**" }] },
          ]
        : [
            { contract: second.id, patterns: [{ mine: "src/cli/invoke.ts", theirs: "src/cli/**" }] },
            { contract: first.id, patterns: [{ mine: "src/cli/invoke.ts", theirs: "src/**" }] },
          ],
    },
  });
});

test("CLI Region renders grouped overlaps, empty facts, and refuses deleted dialects", async () => {
  const repository = repositoryWithMain();
  const first = await bind(repository, "CLI region first", ["src/**", "docs/guide/**"]);
  const second = await bind(repository, "CLI region second", ["src/cli/**", "tests/**"]);
  mkdirSync(join(repository.path, ".keiyaku"), { recursive: true });
  writeFileSync(join(repository.path, ".keiyaku", "settings.json"), "{ malformed", "utf8");

  const emptyWorld = repositoryWithMain();
  const empty = await invoke(parseArgv(["region"]), { cwd: emptyWorld.path, environment: {} });
  assert.equal(empty.kind, "region");
  if (empty.kind === "region") {
    assert.deepEqual(empty.region, { kind: "present", value: { kind: "declarations", declarations: [] } });
    assert.equal(renderText(empty), "no active Region declarations");
  }

  const world = await invoke(parseArgv(["region"]), { cwd: repository.path, environment: {} });
  assert.equal(world.kind, "region");
  if (world.kind === "region") {
    assert.match(renderText(world), new RegExp(`^region ${first.id} src/\\*\\* docs/guide/\\*\\*$`, "m"));
    assert.match(renderText(world), new RegExp(`^region ${second.id} src/cli/\\*\\* tests/\\*\\*$`, "m"));
  }

  const declaration = await invoke(parseArgv(["region", first.id, "--json"]), {
    cwd: repository.path,
    environment: {},
  });
  assert.equal(declaration.kind, "region");
  if (declaration.kind !== "region" || declaration.region.kind !== "present") return;
  assert.deepEqual(declaration.region.value, {
    kind: "contract",
    declaration: { contract: first.id, patterns: ["src/**", "docs/guide/**"] },
    overlaps: [{ contract: second.id, patterns: [{ mine: "src/**", theirs: "src/cli/**" }] }],
  });
  assert.equal(
    renderText(declaration),
    [`region ${first.id} src/** docs/guide/**`, `overlap ${second.id} 1 pair`, "  src/** ~ src/cli/**"].join("\n"),
  );

  const isolated = await bind(repository, "CLI region isolated", ["lib/**"]);
  const noOverlap = await invoke(parseArgv(["region", isolated.id]), { cwd: repository.path, environment: {} });
  assert.equal(noOverlap.kind, "region");
  if (noOverlap.kind === "region") {
    assert.equal(renderText(noOverlap), `region ${isolated.id} lib/**\nno overlap with active declarations`);
  }

  const path = await invoke(parseArgv(["region", "--path", "src/**", "--path", "tests/**"]), {
    cwd: repository.path,
    environment: {},
  });
  assert.equal(path.kind, "region");
  if (path.kind === "region" && path.region.kind === "present" && path.region.value.kind === "path") {
    assert.deepEqual(path.region.value.patterns, ["src/**", "tests/**"]);
    assert.deepEqual(
      path.region.value.overlaps.find((overlap) => overlap.contract === first.id),
      {
        contract: first.id,
        patterns: [{ mine: "src/**", theirs: "src/**" }],
      },
    );
    assert.deepEqual(
      path.region.value.overlaps.find((overlap) => overlap.contract === second.id),
      {
        contract: second.id,
        patterns: [
          { mine: "src/**", theirs: "src/cli/**" },
          { mine: "tests/**", theirs: "tests/**" },
        ],
      },
    );
    const text = renderText(path);
    assert.match(text, new RegExp(`overlap ${second.id} 1 pair`));
    assert.match(text, /^ {2}src\/\*\* ~ src\/cli\/\*\*$/m);
    assert.doesNotMatch(text, /tests\/\*\* ~ tests\/\*\*/u);
    assert.match(text, new RegExp(`overlap ${first.id} exact match`, "u"));
  }

  const exactPath = await invoke(parseArgv(["region", "--path", "docs/guide/**"]), {
    cwd: repository.path,
    environment: {},
  });
  assert.equal(exactPath.kind, "region");
  if (exactPath.kind === "region") {
    assert.equal(renderText(exactPath), [`overlap ${first.id} exact match`].join("\n"));
  }

  const miss = await invoke(parseArgv(["region", "--path", "other/**"]), { cwd: repository.path, environment: {} });
  assert.equal(miss.kind, "region");
  if (miss.kind === "region") assert.equal(renderText(miss), "no active Region declares: other/**");

  await assert.rejects(
    () => invoke(parseArgv(["region", "--path", "../outside"]), { cwd: repository.path, environment: {} }),
    (error: unknown) => error instanceof CliUsageError && error.message.includes("may not contain .."),
  );
  await assert.rejects(
    () => invoke(parseArgv(["region", "--path", "docs/[draft].md"]), { cwd: repository.path, environment: {} }),
    (error: unknown) => error instanceof CliUsageError && error.message.includes("forbidden glob form"),
  );
  assert.throws(() => parseArgv(["region", "--overlap"]), CliUsageError);
  assert.throws(() => parseArgv(["region", first.id, "--path", "src/file.ts"]), CliUsageError);
  assert.throws(() => parseArgv(["region", first.id, second.id]), CliUsageError);
  assert.throws(() => parseArgv(["region", "-"]), CliUsageError);

  await first.contract.abandon();
  await assert.rejects(
    () => invoke(parseArgv(["region", first.id]), { cwd: repository.path, environment: {} }),
    (error: unknown) =>
      error instanceof CliUsageError && error.message.includes(`unknown contract selector: ${first.id}`),
  );
});

test("Kanshi Region path results contain no delivery or audit path facts", async () => {
  const repository = repositoryWithMain();
  const { id } = await bind(repository, "No actual paths", ["src/**"]);
  const report = await read(repository, { kind: "path", patterns: ["src/file.ts"] });
  assert.equal(report.region?.kind, "present");
  if (report.region?.kind !== "present") return;
  assert.deepEqual(report.region.value, {
    kind: "path",
    patterns: ["src/file.ts"],
    overlaps: [{ contract: id as ContractId, patterns: [{ mine: "src/file.ts", theirs: "src/**" }] }],
  });
  assert.equal(JSON.stringify(report.region.value).includes("diff"), false);
  assert.equal(JSON.stringify(report.region.value).includes("conflict"), false);
});

test("Kanshi validates Region selections and query patterns", async () => {
  const repository = repositoryWithMain();
  const { id } = await bind(repository, "Literal paths", ["docs/**"]);

  await assert.rejects(
    async () =>
      kanshi({
        world: await World.at(repository.path),
        repo: await Repo.at({ path: repository.path }),
        region: { kind: "bogus" } as never,
      }),
    (error: unknown) => error instanceof TypeError && error.message.includes("kind is invalid"),
  );
  await assert.rejects(
    async () =>
      kanshi({
        world: await World.at(repository.path),
        repo: await Repo.at({ path: repository.path }),
        region: { kind: "path", patterns: ["docs/**"], extra: true } as never,
      }),
    (error: unknown) => error instanceof TypeError && error.message.includes("unknown field"),
  );
  await assert.rejects(
    async () =>
      kanshi({
        world: await World.at(repository.path),
        repo: await Repo.at({ path: repository.path }),
        region: { kind: "overlap" } as never,
      }),
    (error: unknown) => error instanceof TypeError && error.message.includes("kind is invalid"),
  );
  await assert.rejects(
    async () =>
      kanshi({
        world: await World.at(repository.path),
        repo: await Repo.at({ path: repository.path }),
        region: { kind: "path", patterns: ["docs/[draft].md"] },
      }),
    (error: unknown) => error instanceof TypeError && error.message.includes("forbidden glob form"),
  );
  const canonical = await read(repository, { kind: "path", patterns: ["docs/"] });
  assert.deepEqual(canonical.region, {
    kind: "present",
    value: {
      kind: "path",
      patterns: ["docs/**"],
      overlaps: [{ contract: id, patterns: [{ mine: "docs/**", theirs: "docs/**" }] }],
    },
  });
});

test("a malformed active document fails only the selected Region section", async () => {
  const repository = repositoryWithMain();
  const { id } = await bind(repository, "Isolated failure", ["src/**"]);
  const git = await repositoryAt(repository.path);
  const snapshot = await readGit(git);
  const journalPath = contractJournalPath(id);
  const journalOid = snapshot.paths.get(journalPath)?.oid;
  assert.ok(journalOid);
  const entries = decodeJournal(repository.run(["cat-file", "-p", journalOid]));
  const first = entries[0]!;
  if (first.kind !== "bind") throw new Error("test contract did not bind");
  const malformed = {
    ...first,
    data: {
      ...first.data,
      terms: {
        ...first.data.terms,
        document: { ...first.data.terms.document, bytes: "# malformed" },
      },
    },
  } as JournalEntry;
  const tree = await updateGitTree(
    git,
    snapshot.tree,
    new Map([[journalPath, { oid: await writeBlob(git, encodeEntry(malformed)) }]]),
  );
  const commit = await writeCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal(
    (await updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }])).kind,
    "published",
  );
  const report = await read(repository, { kind: "declarations" });
  assert.equal(report.contracts.kind, "present");
  if (report.contracts.kind !== "present") return;
  assert.equal(report.contracts.value.rows.find((row) => row.id === id)?.title, null);
  assert.equal(report.region?.kind, "failed");
  const failed = await invoke(parseArgv(["region"]), { cwd: repository.path, environment: {} });
  assert.equal(failed.kind, "region");
  if (failed.kind === "region") assert.match(renderText(failed), /^region failed /);
});
