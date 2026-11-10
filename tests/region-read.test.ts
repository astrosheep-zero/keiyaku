import { accepted, present } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { runCli } from "./support/cli-fixtures.js";
import { Keis, Repo } from "../src/index.js";
import { kanshi } from "../src/kanshi/index.js";
import type { KanshiRegionSelection, KanshiReport, RegionRead } from "../src/kanshi/index.js";
import { repositoryWithMain } from "./support/library-verbs.js";
import { World } from "../src/world.js";
import { decodeJournal, encodeEntry } from "../src/core/facts/codec.js";
import type { JournalEntry } from "../src/core/facts/types.js";
import { contractJournalPath } from "../src/git/identity.js";
import {
  readGitPaths,
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
  const result = accepted(
    await Keis.of(await Repo.at({ path: repository.path })).bind({
      markdown: document(title, patterns),
      workspace: "worktree",
      gates: [],
    }),
  );
  return { id: present(await result.kei.state()).id, contract: result.kei };
}

function read(repository: ReturnType<typeof repositoryWithMain>): Promise<KanshiReport>;
function read(repository: ReturnType<typeof repositoryWithMain>, region: KanshiRegionSelection): Promise<RegionRead>;
async function read(
  repository: ReturnType<typeof repositoryWithMain>,
  region?: KanshiRegionSelection,
): Promise<KanshiReport | RegionRead> {
  const world = await World.at(repository.path);
  const repo = await Repo.at({ path: repository.path });
  return region === undefined ? kanshi({ world, repo }) : kanshi({ world, repo, region });
}

// Each case owns its repository, fault injector and cleanup; no process-global mocks.
describe("region-read isolated fixtures", { concurrency: 3 }, () => {
  test("Kanshi Region reads own declarations, grouped contract overlaps, and query-pattern overlaps", async () => {
    const repository = repositoryWithMain();
    const first = await bind(repository, "Region first", ["src/**", "docs/guide/**"]);
    const second = await bind(repository, "Region second", ["src/cli/**", "tests/**"]);
    const firstIsLeft = first.id.localeCompare(second.id) < 0;

    const defaultReport = await read(repository);
    assert.ok("contracts" in defaultReport, "a bare World read answers the World board, not a Region result");

    const world = await read(repository, { kind: "declarations" });
    assert.deepEqual(world, {
      kind: "present",
      declarations: firstIsLeft
        ? [
            { id: first.id, patterns: ["src/**", "docs/guide/**"] },
            { id: second.id, patterns: ["src/cli/**", "tests/**"] },
          ]
        : [
            { id: second.id, patterns: ["src/cli/**", "tests/**"] },
            { id: first.id, patterns: ["src/**", "docs/guide/**"] },
          ],
    });

    const own = await read(repository, { kind: "contract", contract: first.id });
    assert.deepEqual(own, {
      kind: "present",
      id: first.id,
      patterns: ["src/**", "docs/guide/**"],
      overlaps: [
        { contractId: second.id, patterns: [{ mine: "src/**", theirs: "src/cli/**", relation: "theirs-within-mine" }] },
      ],
    });

    const path = await read(repository, { kind: "path", patterns: ["src/cli/invoke.ts"] });
    assert.deepEqual(path, {
      kind: "present",
      overlaps: firstIsLeft
          ? [
              {
                contractId: first.id,
                patterns: [{ mine: "src/cli/invoke.ts", theirs: "src/**", relation: "mine-within-theirs" }],
              },
              {
                contractId: second.id,
                patterns: [{ mine: "src/cli/invoke.ts", theirs: "src/cli/**", relation: "mine-within-theirs" }],
              },
            ]
          : [
              {
                contractId: second.id,
                patterns: [{ mine: "src/cli/invoke.ts", theirs: "src/cli/**", relation: "mine-within-theirs" }],
              },
              {
                contractId: first.id,
                patterns: [{ mine: "src/cli/invoke.ts", theirs: "src/**", relation: "mine-within-theirs" }],
              },
            ],
    });
  });

  test("Kanshi validates Region selections and query patterns", async () => {
    const repository = repositoryWithMain();
    const { id } = await bind(repository, "Literal paths", ["docs/**"]);
    const world = await World.at(repository.path);
    const repo = await Repo.at({ path: repository.path });
    const invalid = (region: unknown): Promise<unknown> => Reflect.apply(kanshi, undefined, [{ world, repo, region }]);

    await assert.rejects(
      invalid({ kind: "bogus" }),
      (error: unknown) => error instanceof TypeError && error.message.includes("kind is invalid"),
    );
    await assert.rejects(
      invalid({ kind: "path", patterns: ["docs/**"], extra: true }),
      (error: unknown) => error instanceof TypeError && error.message.includes("unknown field"),
    );
    await assert.rejects(
      invalid({ kind: "overlap" }),
      (error: unknown) => error instanceof TypeError && error.message.includes("kind is invalid"),
    );
    await assert.rejects(
      invalid({ kind: "path", patterns: ["docs/[draft].md"] }),
      (error: unknown) => error instanceof TypeError && error.message.includes("forbidden glob form"),
    );
    const canonical = await read(repository, { kind: "path", patterns: ["docs/"] });
    assert.deepEqual(canonical, {
      kind: "present",
      overlaps: [{ contractId: id, patterns: [{ mine: "docs/**", theirs: "docs/**" }] }],
    });
  });

  test("a malformed active document fails only the selected Region section", async () => {
    const repository = repositoryWithMain();
    const { id } = await bind(repository, "Isolated failure", ["src/**"]);
    const git = await repositoryAt(repository.path);
    const journalPath = contractJournalPath(id);
    const snapshot = await readGitPaths(git, [journalPath]);
    const journalOid = snapshot.paths.get(journalPath)?.oid;
    assert.ok(journalOid);
    const entries = decodeJournal(repository.run(["cat-file", "-p", journalOid]));
    const first = entries[0]!;
    if (first.kind !== "bind") throw new Error("test contract did not bind");
    const malformed: JournalEntry = {
      ...first,
      data: {
        ...first.data,
        terms: {
          ...first.data.terms,
          document: { ...first.data.terms.document, bytes: "# malformed" },
        },
      },
    };
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
    const region = await read(repository, { kind: "declarations" });
    assert.equal(region.kind, "failed");
    if (region.kind === "failed") assert.match(region.diagnostic, /malformed|Markdown|title|document/u);
    const report = await kanshi({
      world: await World.at(repository.path),
      repo: await Repo.at({ path: repository.path }),
    });
    assert.ok("contracts" in report, "the bare World read still answers the World board");
    if (!("contracts" in report)) return;
    assert.ok(report.contracts.kind === "present", 'expected report.contracts.kind = "present"');
    const row = report.contracts.kind === "present" ? report.contracts.rows?.find((candidate) => candidate.id === id) : undefined;
    assert.equal(row?.title, undefined, "an unreadable document leaves the title unknown");
    assert.equal(row?.gates, undefined, "no declared gates leave the summary gates omitted");
    const failed = await runCli(["region"], { cwd: repository.path, environment: {} });
    assert.match(failed.stdout, /^× region\n  reason  /u);
  });
});
