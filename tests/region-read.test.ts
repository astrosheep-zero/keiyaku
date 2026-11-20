import { accepted, present, repositoryWithMain } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Keis, Repo } from "../src/index.js";
import { Kanshi, type KanshiRegionSelection, type RegionRead } from "../src/kanshi/index.js";
import { World } from "../src/world.js";

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
      terms: document(title, patterns),
      gates: [],
    }),
  );
  return { id: present(await result.kei.state()).id };
}

async function read(
  repository: ReturnType<typeof repositoryWithMain>,
  region: KanshiRegionSelection,
): Promise<RegionRead> {
  const world = await World.at(repository.path);
  const repo = await Repo.at({ path: repository.path });
  return Kanshi.of({ world, repo }).region(region);
}

test("Kanshi Region reads own declarations, grouped contract overlaps, and query-pattern overlaps", async () => {
  const repository = repositoryWithMain();
  const first = await bind(repository, "Region first", ["src/**", "docs/guide/**"]);
  const second = await bind(repository, "Region second", ["src/cli/**", "tests/**"]);
  const firstIsLeft = first.id.localeCompare(second.id) < 0;

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
