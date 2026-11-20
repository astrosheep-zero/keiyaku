import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Akumas,
  Keis,
  Repo,
  World,
  type AkumaList,
  type KanshiContractReport,
} from "../src/index.js";
import { moveAlias } from "../src/alias/index.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { bornLineageAkuma } from "./support/akuma-fixtures.js";
import { cliJson } from "./support/cli-fixtures.js";
import { repositoryWithCommit } from "./support/git.js";
import { accepted, document } from "./support/library-verbs.js";
import { temporaryDirectory } from "./support/process.js";

test("missing addressed Contracts retain their native status refusal", async () => {
  const repository = repositoryWithCommit();
  const status = await cliJson(["-C", repository.path, "status", "kei/missing"], { environment: {} });
  assert.equal(status.exit, 1, status.stderr);
  assert.deepEqual(status.value, { kind: "contract-missing", id: "kei/missing" });
});

test("instance listing preserves bounded native rows and reads no Debt authority", async (t) => {
  const world = await World.at(temporaryDirectory(t, "cli-owner-list-"));
  for (let index = 0; index < 4; index += 1) await bornLineageAkuma({
    root: world, akumaName: "worker", draw: index.toString(16).padStart(8, "0"),
    createdAt: `2026-08-09T00:00:0${index}.000Z`,
  });
  const owner = await Akumas.of(world).list({ limit: 2, selection: "all" });
  await moveAlias({ world, alias: parseAkumaAlias("@recent"), akumaId: owner.rows![0]!.id });
  mkdirSync(join(world, ".keiyaku", "debts"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "debts", "bad.md"), "not Debt authority\n");
  const listed = await cliJson<AkumaList>(["-C", world, "ls", "aku/*/*", "--all", "--limit", "2"], { environment: {} });
  assert.equal(listed.exit, 0, listed.stderr);
  assert.deepEqual(listed.value.rows?.map(row => row.id), owner.rows!.map(row => row.id));
  assert.equal(listed.value.more, true);
  assert.deepEqual(listed.value.rows![0]!.aliases, ["@recent"]);
});

test("named status resolves Contract shorthand and refuses Alias collisions", async () => {
  const repository = repositoryWithCommit();
  const repo = await Repo.at({ path: repository.path });
  const world = await World.at(repository.path);
  const contracts = Keis.of(repo);
  const bound = accepted(await contracts.bind({ terms: document(), target: null, gates: ["reviewed"] }));
  const name = `@${bound.contractId.slice(4)}`;
  const selected = await cliJson<KanshiContractReport>(["-C", world, "status", name], { environment: {} });
  assert.equal(selected.exit, 0, selected.stderr);
  assert.equal(selected.value.id, bound.contractId);
  assert.equal(selected.value.kind, "contract");
  const born = await bornLineageAkuma({ root: world, akumaName: "worker", draw: "a0000001", createdAt: "2026-08-09T00:00:00.000Z" });
  await moveAlias({ world, alias: parseAkumaAlias(name), akumaId: born.id });
  const collision = await cliJson<{ kind: string; category: string; diagnostic: string }>(["-C", world, "status", name], { environment: {} });
  assert.equal(collision.exit, 64, collision.stderr);
  assert.equal(collision.value.kind, "failed");
  assert.equal(collision.value.category, "invalid-input");
  assert.match(collision.value.diagnostic, /ambiguous selector/u);
  // A failed Contract source cannot erase a readable Alias or pretend an unresolved name is absent.
  repository.run(["update-ref", "refs/heads/keiyaku-state", "HEAD"]);
  const readableAlias = await cliJson<{ id: string }>(["-C", world, "status", name], { environment: {} });
  assert.equal(readableAlias.exit, 0, readableAlias.stderr);
  assert.equal(readableAlias.value.id, born.id);
  const unresolved = await cliJson<{ diagnostic: string }>(["-C", world, "status", "@unknown"], { environment: {} });
  assert.equal(unresolved.exit, 3, unresolved.stderr);
  assert.match(unresolved.value.diagnostic, /Contract world is failed/u);
});
