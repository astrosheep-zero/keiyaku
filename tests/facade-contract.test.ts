import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { Keiyaku, Repo } from "../src/index.js";
import { contractJournalPath } from "../src/git/identity.js";
import { GIT_REF, readGit, updateGitTree, updateRefsAtomically, writeCommit } from "../src/git/repository.js";
import { kanshi } from "../src/kanshi/index.js";
import { cachedRepositoryAt, makeGitRepository, withGitShim } from "./support/git.js";

function markdown(title: string): string {
  return [
    `# ${title}`,
    "",
    "## Context",
    "Exercise Contract catalogue observation.",
    "",
    "## Objective",
    "Keep the Contract catalogue bounded.",
    "",
    "## Design",
    "Read Contract authority through its public owner.",
    "",
    "## Region",
    "~~~",
    "src/**",
    "~~~",
    "",
    "## Criteria",
    "### Catalogue",
    "The catalogue preserves Contract facts.",
    "",
  ].join("\n");
}

function compareRecent(
  left: { lastJournalAt: string; id: string },
  right: { lastJournalAt: string; id: string },
): number {
  return (
    right.lastJournalAt.localeCompare(left.lastJournalAt) || Buffer.compare(Buffer.from(left.id), Buffer.from(right.id))
  );
}

type CatalogueFixture = Readonly<{
  selected: readonly [string, string, string];
  endpoint: string;
  dependent: string;
}>;

async function populateContractCatalogue(
  repository: ReturnType<typeof makeGitRepository>,
  source: string,
): Promise<CatalogueFixture> {
  const git = await cachedRepositoryAt(repository.path);
  const snapshot = await readGit(git);
  const directory = ".catalogue-journals";
  mkdirSync(`${repository.path}/${directory}`, { recursive: true });
  const ids = Array.from({ length: 501 }, (_, index) => `kei/catalogue-${String(index).padStart(3, "0")}`);
  const paths = ids.map((id, index) => {
    const journal = JSON.parse(source) as {
      contract: string;
      at: string;
      data: Readonly<{
        coordinates: { target?: string };
        terms: { after: string[] };
      }>;
    };
    const at =
      index < 2 ? "2099-03-01T00:00:00.000Z" : index === 2 ? "2099-02-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z";
    journal.contract = id;
    journal.at = at;
    journal.data.coordinates.target =
      index < 3 ? `refs/heads/catalogue-${String(index).padStart(3, "0")}` : "refs/heads/catalogue-hidden";
    journal.data.terms.after = index === 0 ? [ids[3]!] : index === 4 ? [ids[0]!] : [];
    const path = `${directory}/${index}`;
    writeFileSync(`${repository.path}/${path}`, `${JSON.stringify(journal)}\n`);
    return path;
  });
  const objects = repository
    .run(["hash-object", "-w", "--stdin-paths"], `${paths.join("\n")}\n`)
    .trim()
    .split("\n");
  const tree = await updateGitTree(
    git,
    snapshot.tree,
    new Map(ids.map((id, index) => [contractJournalPath(id as never), { oid: objects[index]! }])),
  );
  const commit = await writeCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal(
    (
      await updateRefsAtomically(git, [
        {
          ref: GIT_REF,
          newOid: commit,
          expectedOid: snapshot.commit,
        },
      ])
    ).kind,
    "published",
  );
  return { selected: [ids[0]!, ids[1]!, ids[2]!], endpoint: ids[3]!, dependent: ids[4]! };
}

test("Contract catalogue is bounded while Keiyaku.list remains a complete board", async () => {
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  try {
    const repo = await Repo.at({ path: repository.path });
    const bound = await Keiyaku.bind({
      repo,
      markdown: markdown("catalogue seed"),
      workspace: "worktree",
      target: "main",
      gates: [],
    });
    const boundId = (await bound.keiyaku.state()).id;
    const source = repository.run(["show", `${GIT_REF}:${contractJournalPath(boundId)}`]);
    const fixture = await populateContractCatalogue(repository, source);

    const complete = await Keiyaku.list({ repo });
    const expected = [...complete.rows].filter((row) => row.disposition === "active").sort(compareRecent);
    assert.equal(expected.length, 502);
    const targetLog = `${repository.path}/catalogue-targets.log`;
    writeFileSync(targetLog, "");
    const catalogue = await withGitShim(
      [
        'if [ "$1" = "rev-parse" ] && [ "$2" = "--verify" ] && [ "$3" = "--quiet" ]; then',
        '  case "$4" in',
        "    refs/heads/catalogue-*)",
        '      printf "%s\\n" "$4" >> "$KEIYAKU_TARGET_LOG"',
        '      case "$4" in',
        "        refs/heads/catalogue-000|refs/heads/catalogue-001|refs/heads/catalogue-002) ;;",
        '        *) echo "unexpected nonselected target resolution: $4" >&2; exit 97 ;;',
        "      esac",
        "      ;;",
        "  esac",
        "fi",
        'exec "$KEIYAKU_REAL_GIT" "$@"',
      ].join("\n"),
      { KEIYAKU_TARGET_LOG: targetLog },
      async (gitPath) =>
        await Keiyaku.ls({
          query: { kind: "contracts", limit: 3 },
          repo: await Repo.at({ path: repository.path, gitPath }),
        }),
    );

    assert.equal(catalogue.kind, "contracts");
    if (catalogue.kind !== "contracts") return;
    assert.deepEqual(
      catalogue.rows.map((row) => row.id),
      fixture.selected,
    );
    assert.deepEqual(
      catalogue.rows.map((row) => row.lastJournalAt),
      ["2099-03-01T00:00:00.000Z", "2099-03-01T00:00:00.000Z", "2099-02-01T00:00:00.000Z"],
    );
    assert.deepEqual(
      catalogue.rows.map((row) => row.id),
      expected.slice(0, 3).map((row) => row.id),
    );
    assert.equal(catalogue.rows[0]?.target, "refs/heads/catalogue-000");
    assert.deepEqual(catalogue.rows[0]?.targetObservation, { head: null, drift: false });
    assert.equal(catalogue.rows[0]?.workspaceObservation.kind, "unappointed");
    assert.deepEqual(catalogue.rows[0]?.after, [
      { contractId: fixture.endpoint, endpoint: { kind: "active", phase: "waiting" } },
    ]);
    assert.deepEqual(catalogue.rows[0]?.dependents, [{ contractId: fixture.dependent, phase: "waiting" }]);
    assert.deepEqual(
      readFileSync(targetLog, "utf8").trim().split("\n").sort(),
      fixture.selected.map((id) => `refs/heads/${id.slice("kei/".length)}`).sort(),
    );
    assert.equal(catalogue.hasMore, true);
    assert.deepEqual(JSON.parse(JSON.stringify(catalogue)), catalogue);
    const defaultCatalogue = await Keiyaku.ls({ query: { kind: "contracts" }, repo });
    assert.equal(defaultCatalogue.kind, "contracts");
    if (defaultCatalogue.kind !== "contracts") return;
    assert.equal(defaultCatalogue.rows.length, 50);
    assert.equal(defaultCatalogue.hasMore, true);
    const maximumCatalogue = await Keiyaku.ls({ query: { kind: "contracts", limit: 500 }, repo });
    assert.equal(maximumCatalogue.kind, "contracts");
    if (maximumCatalogue.kind !== "contracts") return;
    assert.equal(maximumCatalogue.rows.length, 500);
    assert.equal(maximumCatalogue.hasMore, true);
    assert.equal("hasMore" in complete, false);
    assert.deepEqual(
      complete.rows
        .filter((row) => row.disposition === "active")
        .map((row) => row.id)
        .sort(),
      expected.map((row) => row.id).sort(),
    );
    const world = await kanshi({ world: null, repo });
    assert.equal(world.contracts.kind, "present");
    if (world.contracts.kind !== "present") return;
    assert.equal(world.contracts.value.rows.length, 10);
    assert.equal(world.contracts.value.hasMore, true);
    const selected = await kanshi({ world: null, repo, contract: expected[10]!.id });
    assert.equal(selected.contracts.kind, "present");
    if (selected.contracts.kind !== "present") return;
    assert.deepEqual(
      selected.contracts.value.rows.map((row) => row.id),
      [expected[10]!.id],
    );
    assert.equal("hasMore" in selected.contracts.value, false);
    const observationLog = `${repository.path}/catalogue-validation.log`;
    const armed = `${repository.path}/catalogue-validation-armed`;
    writeFileSync(observationLog, "");
    const validationRepo = await withGitShim(
      [
        'if [ -e "$KEIYAKU_VALIDATION_ARMED" ]; then',
        '  printf "%s\\n" "$*" >> "$KEIYAKU_VALIDATION_LOG"',
        "  exit 98",
        "fi",
        'exec "$KEIYAKU_REAL_GIT" "$@"',
      ].join("\n"),
      { KEIYAKU_VALIDATION_ARMED: armed, KEIYAKU_VALIDATION_LOG: observationLog },
      async (gitPath) => await Repo.at({ path: repository.path, gitPath }),
    );
    writeFileSync(armed, "");
    await assert.rejects(
      () => Keiyaku.ls({ query: { kind: "contracts", limit: 501 }, repo: validationRepo }),
      /limit must be an integer from 1 to 500/u,
    );
    assert.equal(readFileSync(observationLog, "utf8"), "");

    const corrupted = await readGit(await cachedRepositoryAt(repository.path));
    const corruption = repository.run(["hash-object", "-w", "--stdin"], "not a Contract journal\n").trim();
    const corruptTree = await updateGitTree(
      await cachedRepositoryAt(repository.path),
      corrupted.tree,
      new Map([[contractJournalPath(fixture.dependent as never), { oid: corruption }]]),
    );
    const corruptCommit = await writeCommit({
      repository: await cachedRepositoryAt(repository.path),
      tree: corruptTree,
      parent: corrupted.commit,
    });
    assert.equal(
      (
        await updateRefsAtomically(await cachedRepositoryAt(repository.path), [
          { ref: GIT_REF, newOid: corruptCommit, expectedOid: corrupted.commit },
        ])
      ).kind,
      "published",
    );
    await assert.rejects(() => Keiyaku.ls({ query: { kind: "contracts", limit: 3 }, repo }));
  } finally {
    rmSync(repository.path, { recursive: true, force: true });
  }
});
