import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { invoke as invokeRaw, type InvocationResult } from "../src/cli/invoke.js";
import { parseArgv as parseInvocation, type ParsedExecution } from "../src/cli/parse.js";
import { renderText } from "../src/cli/render/text.js";
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

function parseArgv(argv: readonly string[]): ParsedExecution {
  const parsed = parseInvocation(argv);
  if (!("command" in parsed)) throw new Error("expected executable command");
  return parsed;
}

async function invoke(invocation: Parameters<typeof invokeRaw>[0], runtime?: Parameters<typeof invokeRaw>[1]): Promise<InvocationResult> {
  return (await invokeRaw(invocation, runtime)) as InvocationResult;
}

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
    assert.ok(report.contracts.kind === "present", "expected report.contracts.kind = \"present\"");
    const row = report.contracts.value.rows.find((candidate) => candidate.id === id);
    assert.equal(row?.title, null);
    assert.equal(row?.verification, undefined);
    assert.equal(report.region?.kind, "failed");
    const failed = await invoke(parseArgv(["region"]), { cwd: repository.path, environment: {} });
    assert.equal(failed.kind, "region");
    if (failed.kind === "region") assert.match(renderText(failed), /^× region\n  diagnostic  /);
  });
});
