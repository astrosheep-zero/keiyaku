import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliUsageError, parseArgv } from "../src/cli/parse.js";
import {
  Akumas,
  Debts,
  Keis,
  Keiyaku,
  KeiyakuUsageError,
  Repo,
  World,
  Kanshi,
  type AkumaList,
  type KanshiContractReport,
} from "../src/index.js";
import { moveAlias } from "../src/alias/index.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { bornLineageAkuma } from "./support/akuma-fixtures.js";
import { main } from "../src/cli/main.js";
import { captureOutput, cliJson, runCli } from "./support/cli-fixtures.js";
import { repositoryWithCommit } from "./support/git.js";
import { accepted, document } from "./support/library-verbs.js";
import { temporaryDirectory } from "./support/process.js";

test("CLI adapts public Contract selector refusals without owning matching", async () => {
  const repository = repositoryWithCommit();
  const repo = await Repo.at({ path: repository.path });
  const selector = "@missing";
  assert.deepEqual(await Keis.of(repo).resolve({ selector }), {
    kind: "refused", refusal: { kind: "unknown-short-selector", selector },
  });
  const facet = Keiyaku.at({ cwd: repo.cwd, environment: {} });
  await assert.rejects(facet.show({ id: selector }), KeiyakuUsageError);
  await assert.rejects(facet.show(), KeiyakuUsageError);
});

test("status parses one complete own-family identity, or defers one name to acquisition", () => {
  assert.throws(() => parseArgv(["status"]), CliUsageError);
  assert.deepEqual(parseArgv(["status", "kei/example"]), {
    command: { name: "status", input: { id: "kei/example" }, output: "text" },
  });
  assert.deepEqual(parseArgv(["status", "aku/worker/1234abcd", "--json"]), {
    command: { name: "status", input: { id: "aku/worker/1234abcd" }, output: "json" },
  });
  assert.deepEqual(parseArgv(["status", "@example"]), {
    command: { name: "status", input: {}, acquire: { selector: "@example" }, output: "text" },
  });
  for (const selectors of [
    ["kei/one", "kei/two"], ["aku/worker/1234abcd", "aku/worker/1234abce"],
    ["kei/one", "@two"], ["kei"], ["kei/"], ["kei/*"], ["aku/"],
    ["aku/worker"], ["aku/worker/*"], ["aku/*/*"], ["@worker*"], ["debt/example"],
  ]) assert.throws(() => parseArgv(["status", ...selectors]), CliUsageError);
  assert.throws(() => parseArgv(["status", "--limit", "2"]), CliUsageError);
});

test("CLI list and status families preserve their native owner answers", async () => {
  const repository = repositoryWithCommit();
  const world = await World.at(repository.path);
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keis.of(repo).bind({ markdown: document(), target: null, gates: ["reviewed"] }));
  const worker = await bornLineageAkuma({ root: world, akumaName: "worker", draw: "a0000004", createdAt: "2026-08-09T00:00:00.000Z" });
  mkdirSync(join(world, ".keiyaku", "akumas"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "akumas", "worker.md"), "---\nprovider: claude\n---\nWorker.\n");
  accepted(await Debts.of(world).add({ title: "Root work" }));
  for (const [args, expected] of [
    [["ls", "kei/", "--limit", "1"], await Keis.of(repo).list({ limit: 1 })],
    [["ls", "aku/*/*", "--limit", "1"], await Akumas.of(world).list({ repo, limit: 1 })],
    [["ls", "aku/"], await Akumas.akumaNames({ cwd: world, home: world })],
    [["ls", "debt/"], await Keiyaku.at({ cwd: world, environment: {}, home: world }).ls({ selector: "debt/" })],
    [["status", bound.contractId], await Kanshi.of({ world, repo }).contract(bound.contractId)],
    [["status", worker.id], await Akumas.of(world).status({ akuma: worker.id, repo })],
    [["kanshi"], await Kanshi.of({ world, repo }).board()],
  ] as const) {
    const response = await cliJson(["-C", world, ...args], { environment: { HOME: world, USERPROFILE: world, KEIYAKU_HOME: world } });
    assert.equal(response.exit, 0, response.stderr);
    assert.deepEqual(
      JSON.parse(JSON.stringify(response.value, (key, value: unknown) => key === "observedAt" ? undefined : value)),
      JSON.parse(JSON.stringify(expected, (key, value: unknown) => key === "observedAt" ? undefined : value)),
      args.join(" "),
    );
  }
});

test("exact Contract status without a Repo keeps the usage boundary", async (t) => {
  const cwd = temporaryDirectory(t, "cli-status-no-repo-");
  const facet = Keiyaku.at({ cwd, environment: {} });
  await assert.rejects(facet.status({ id: "kei/example" }), KeiyakuUsageError);
  const result = await captureOutput(() => main(["-C", cwd, "status", "kei/example", "--json"]));
  assert.equal(result.exit, 64);
  assert.equal(result.stderr, "");
  assert.match(JSON.parse(result.stdout).diagnostic, /this command requires a resolved Repo/u);
});

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
  const owner = await Akumas.of(world).list({ limit: 2 });
  await moveAlias({ world, alias: parseAkumaAlias("@recent"), akumaId: owner.rows![0]!.id });
  mkdirSync(join(world, ".keiyaku", "debts"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "debts", "bad.md"), "not Debt authority\n");
  const listed = await cliJson<AkumaList>(["-C", world, "ls", "aku/*/*", "--limit", "2"], { environment: {} });
  assert.equal(listed.exit, 0, listed.stderr);
  assert.deepEqual(listed.value.rows?.map(row => row.id), owner.rows!.map(row => row.id));
  assert.equal(listed.value.more, true);
  assert.deepEqual(listed.value.rows![0]!.aliases, ["@recent"]);
  const exact = await cliJson<{ kind: string; id: string }>(["-C", world, "status", "@recent"], { environment: {} });
  assert.equal(exact.exit, 0, exact.stderr);
  assert.equal(exact.value.kind, "akuma");
  assert.equal(exact.value.id, owner.rows![0]!.id);
  const text = await runCli(["-C", world, "status", "@recent"], { environment: {} });
  assert.equal(text.exit, 0, text.stderr);
  assert.ok(text.stdout.includes(`${owner.rows![0]!.id} (@recent)`));
});

test("named status uses complete live membership and preserves Alias collisions", async () => {
  const repository = repositoryWithCommit();
  const repo = await Repo.at({ path: repository.path });
  const world = await World.at(repository.path);
  const contracts = Keis.of(repo);
  const oldest = accepted(await contracts.bind({ markdown: document(), target: null, gates: ["reviewed"] }));
  for (let index = 0; index < 10; index += 1)
    accepted(await contracts.bind({ markdown: document(), target: null, gates: ["reviewed"] }));
  const name = `@${oldest.contractId.slice(4)}`;
  const selected = await cliJson<KanshiContractReport>(["-C", world, "status", name], { environment: {} });
  assert.equal(selected.exit, 0, selected.stderr);
  assert.equal(selected.value.id, oldest.contractId);
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

test("instance listing preserves empty Alias failure and requires an invocation World", async (t) => {
  const root = temporaryDirectory(t, "cli-empty-list-");
  const missing = await runCli(["-C", root, "ls", "aku/*/*"], { environment: {} });
  assert.equal(missing.exit, 64);
  assert.match(missing.stderr, /× usage  keiyaku ls/u);
  const world = await World.at(root);
  mkdirSync(join(world, ".keiyaku", "akuma"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "akuma", "alias.json"), "broken\n");
  const listed = await cliJson<AkumaList>(["-C", world, "ls", "aku/*/*"], { environment: {} });
  assert.equal(listed.exit, 0, listed.stderr);
  assert.equal(listed.value.rows, undefined);
  assert.ok(listed.value.aliasesError);
});
