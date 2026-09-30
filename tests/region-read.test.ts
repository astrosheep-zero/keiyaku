import { accepted, present } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { runCli } from "./support/cli-fixtures.js";
import { Keiyaku, Repo } from "../src/index.js";
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

function document(title: string, patterns: readonly string[]): string {
  return contractMarkdown(title, {
    Context: "Current declarations.",
    Objective: "Read Region declarations.",
    Design: "Use the Region owner.",
    Region: ["~~~", ...patterns, "~~~"].join("\n"),
    Criteria: "### Reads declarations\nThe read is typed.\n",
  });
}

async function bind(repository: ReturnType<typeof repositoryWithMain>, title: string, patterns: readonly string[]) {
  const result = accepted(await Keiyaku.with().bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: document(title, patterns),
    workspace: "worktree",
    gates: [],
  }));
  return { id: (present(await result.value.keiyaku.state())).id, contract: result.value.keiyaku };
}

async function read(repository: ReturnType<typeof repositoryWithMain>, region: Parameters<typeof kanshi>[0]["region"]) {
  return kanshi({
    world: await World.at(repository.path),
    repo: await Repo.at({ path: repository.path }),
    ...(region === undefined ? {} : { region }),
  });
}

// Each case owns its repository, fault injector and cleanup; no process-global mocks.
describe("region-read isolated fixtures", { concurrency: 3 }, () => {
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
        overlaps: [
          { contract: second.id, patterns: [{ mine: "src/**", theirs: "src/cli/**", relation: "theirs-within-mine" }] },
        ],
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
              {
                contract: first.id,
                patterns: [{ mine: "src/cli/invoke.ts", theirs: "src/**", relation: "mine-within-theirs" }],
              },
              {
                contract: second.id,
                patterns: [{ mine: "src/cli/invoke.ts", theirs: "src/cli/**", relation: "mine-within-theirs" }],
              },
            ]
          : [
              {
                contract: second.id,
                patterns: [{ mine: "src/cli/invoke.ts", theirs: "src/cli/**", relation: "mine-within-theirs" }],
              },
              {
                contract: first.id,
                patterns: [{ mine: "src/cli/invoke.ts", theirs: "src/**", relation: "mine-within-theirs" }],
              },
            ],
      },
    });
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
        overlaps: [{ contract: id, patterns: [{ mine: "docs/**", theirs: "docs/**", relation: "same" }] }],
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
    assert.ok(report.contracts.kind === "present", 'expected report.contracts.kind = "present"');
    const row = report.contracts.value.rows.find((candidate) => candidate.id === id);
    assert.equal(row?.title, null);
    assert.equal(row?.verification, undefined);
    assert.equal(report.region?.kind, "failed");
    const failed = await runCli(["region"], { cwd: repository.path, environment: {} });
    assert.match(failed.stdout, /^× region\n  reason  /u);
  });
});
