import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { invoke } from "../src/cli/invoke.js";
import { CliUsageError, parseArgv } from "../src/cli/parse.js";
import { renderText } from "../src/cli/render/text.js";
import { Keiyaku, Repo, type ContractId } from "../src/index.js";
import { kanshi } from "../src/kanshi/index.js";
import { repositoryWithMain } from "./support/library-verbs.js";
import { World } from "../src/world.js";
import { decodeJournal, encodeEntry, type JournalEntry } from "../src/core/facts/codec.js";
import { contractJournalPath } from "../src/git/identity.js";
import { readGit, repositoryAt, updateGitTree, updateRefsAtomically, writeBlob, writeCommit, GIT_REF } from "../src/git/repository.js";

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
  return kanshi({ world: await World.at(repository.path), repo: await Repo.at({ path: repository.path }), ...(region === undefined ? {} : { region }) });
}

test("Kanshi Region reads own declarations, explicit intersections, and active path matches", async () => {
  const repository = repositoryWithMain();
  const first = await bind(repository, "Region first", ["src/**", "docs/guide/**"]);
  const second = await bind(repository, "Region second", ["src/cli/**", "tests/**"]);

  const defaultReport = await read(repository, undefined);
  assert.equal("region" in defaultReport, false);

  const own = await read(repository, { kind: "contract", contract: first.id });
  assert.deepEqual(own.region, { kind: "present", value: { kind: "contract", declaration: { contract: first.id, patterns: ["src/**", "docs/guide/**"] } } });

  const overlap = await read(repository, { kind: "overlap", contract: first.id });
  assert.deepEqual(overlap.region, {
    kind: "present",
    value: {
      kind: "overlap",
      subject: first.id,
      intersections: [{ left: first.id, right: second.id, patterns: [{ left: "src/**", right: "src/cli/**" }] }],
    },
  });

  const path = await read(repository, { kind: "path", path: "src/cli/invoke.ts" });
  assert.deepEqual(path.region, {
    kind: "present",
    value: {
      kind: "path",
      path: "src/cli/invoke.ts",
      matches: [{ contract: first.id, pattern: "src/**" }, { contract: second.id, pattern: "src/cli/**" }],
    },
  });
});

test("CLI Region keeps overlaps explicit, rejects invalid paths, and refuses terminal selectors", async () => {
  const repository = repositoryWithMain();
  const first = await bind(repository, "CLI region first", ["src/**", "docs/guide/**"]);
  await bind(repository, "CLI region second", ["lib/**"]);
  mkdirSync(join(repository.path, ".keiyaku"), { recursive: true });
  writeFileSync(join(repository.path, ".keiyaku", "settings.json"), "{ malformed", "utf8");

  const declaration = await invoke(parseArgv(["region", first.id, "--json"]), { cwd: repository.path, environment: {} });
  assert.equal(declaration.kind, "region");
  if (declaration.kind !== "region" || declaration.region.kind !== "present") return;
  assert.deepEqual(declaration.region.value, { kind: "contract", declaration: { contract: first.id, patterns: ["src/**", "docs/guide/**"] } });
  assert.equal(renderText(declaration), `region ${first.id} src/** docs/guide/**`);

  const noOverlap = await invoke(parseArgv(["region", "--overlap"]), { cwd: repository.path, environment: {} });
  assert.equal(noOverlap.kind, "region");
  if (noOverlap.kind === "region") assert.equal(renderText(noOverlap), "");

  await assert.rejects(
    () => invoke(parseArgv(["region", "--path", "../outside"]), { cwd: repository.path, environment: {} }),
    (error: unknown) => error instanceof CliUsageError && error.message.includes("canonical repository-relative path"),
  );
  assert.throws(() => parseArgv(["region", first.id, "--path", "src/file.ts"]), CliUsageError);

  await first.contract.abandon();
  await assert.rejects(
    () => invoke(parseArgv(["region", first.id]), { cwd: repository.path, environment: {} }),
    (error: unknown) => error instanceof CliUsageError && error.message.includes(`unknown contract selector: ${first.id}`),
  );
});

test("Kanshi Region path and overlap results contain no delivery or audit path facts", async () => {
  const repository = repositoryWithMain();
  const { id } = await bind(repository, "No actual paths", ["src/**"]);
  const report = await read(repository, { kind: "path", path: "src/file.ts" });
  assert.equal(report.region?.kind, "present");
  if (report.region?.kind !== "present") return;
  assert.deepEqual(report.region.value, { kind: "path", path: "src/file.ts", matches: [{ contract: id as ContractId, pattern: "src/**" }] });
  assert.equal(JSON.stringify(report.region.value).includes("diff"), false);
  assert.equal(JSON.stringify(report.region.value).includes("conflict"), false);
});

test("Kanshi validates Region selections and matches literal repository paths", async () => {
  const repository = repositoryWithMain();
  const { id } = await bind(repository, "Literal paths", ["docs/**"]);
  const dotted = await read(repository, { kind: "path", path: "docs/foo..bar.md" });
  const bracketed = await read(repository, { kind: "path", path: "docs/[draft].md" });
  assert.deepEqual(dotted.region, { kind: "present", value: { kind: "path", path: "docs/foo..bar.md", matches: [{ contract: id, pattern: "docs/**" }] } });
  assert.deepEqual(bracketed.region, { kind: "present", value: { kind: "path", path: "docs/[draft].md", matches: [{ contract: id, pattern: "docs/**" }] } });

  await assert.rejects(
    async () => kanshi({ world: await World.at(repository.path), repo: await Repo.at({ path: repository.path }), region: { kind: "bogus" } as never }),
    (error: unknown) => error instanceof TypeError && error.message.includes("kind is invalid"),
  );
  await assert.rejects(
    async () => kanshi({ world: await World.at(repository.path), repo: await Repo.at({ path: repository.path }), region: { kind: "path", path: "docs/[draft].md", extra: true } as never }),
    (error: unknown) => error instanceof TypeError && error.message.includes("unknown field"),
  );
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
  const tree = await updateGitTree(git, snapshot.tree, new Map([[journalPath, { oid: await writeBlob(git, encodeEntry(malformed)) }]]));
  const commit = await writeCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal((await updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }])).kind, "published");
  const report = await read(repository, { kind: "declarations" });
  assert.equal(report.contracts.kind, "present");
  assert.equal(report.region?.kind, "failed");
});
