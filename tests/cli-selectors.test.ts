import assert from "node:assert/strict";
import test from "node:test";
import type { KanshiCategoryReport, KanshiContractReport } from "../src/kanshi/index.js";
import { CliUsageError } from "../src/cli/parse.js";
import { makeGitRepository } from "./support/git.js";
import { rmSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgv } from "../src/cli/parse.js";
import { cliJson, runCli } from "./support/cli-fixtures.js";
import { bornDirectAkuma } from "./support/akuma-fixtures.js";
import { breakBody } from "../src/akuma/heart/index.js";
import { Akumas, Keis, Keiyaku, KeiyakuUsageError, Repo, World } from "../src/index.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { repositoryAt } from "../src/git/repository.js";
import { moveAlias } from "../src/alias/index.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { accepted } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";

/**
 * Run the real CLI boundary for one invocation. The refusal this suite pins is process output,
 * so it is observed across a real process instead of by swapping the in-process stdout that the
 * test runner also owns.
 */
function runCliJson(cwd: string, argv: readonly string[]) {
  const result = spawnSync(
    process.execPath,
    [
      ...(import.meta.url.endsWith(".js") ? [] : ["--import", "tsx"]),
      fileURLToPath(
        new URL(import.meta.url.endsWith(".js") ? "../src/cli/index.js" : "../src/cli/index.ts", import.meta.url),
      ),
      "-C",
      cwd,
      ...argv,
      "--json",
    ],
    { encoding: "utf8", env: process.env },
  );
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

test("CLI adapts public Contract selector refusals without owning matching", async () => {
  const repository = makeGitRepository();
  const repo = await Repo.at({ path: repository.path });
  const selector = "@missing";
  assert.deepEqual(await Keis.of(repo).resolve({ selector }), {
    kind: "refused",
    refusal: { kind: "unknown-short-selector", selector },
  });
  const facet = Keiyaku.at({ cwd: repo.cwd, environment: {} });
  await assert.rejects(facet.show({ contract: selector }), (error: unknown) => {
    assert.ok(error instanceof KeiyakuUsageError);
    assert.match(error.message, /unknown contract selector: @missing/u);
    return true;
  });
  await assert.rejects(facet.show({ contract: "@kei/missing" }), /redundant short contract selector/u);
  await assert.rejects(facet.show(), /required outside a managed worktree/u);
});

test("missing Contract selectors preserve each native read or mutation outcome", () => {
  const repo = makeGitRepository();
  try {
    const delivered = runCliJson(repo.path, ["deliver", "kei/missing"]);
    assert.equal(delivered.status, 1, delivered.stderr);
    assert.deepEqual(JSON.parse(delivered.stdout), {
      kind: "refused",
      contractId: "kei/missing",
      reason: { kind: "contract-missing" },
    });
    const reconciled = runCliJson(repo.path, ["reconcile", "kei/missing"]);
    assert.equal(reconciled.status, 1, reconciled.stderr);
    assert.deepEqual(JSON.parse(reconciled.stdout), { kind: "missing", contractId: "kei/missing" });
    const status = runCliJson(repo.path, ["status", "kei/missing"]);
    assert.equal(status.status, 1, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout), { kind: "contract-missing" });
    const region = runCliJson(repo.path, ["region", "kei/missing"]);
    assert.equal(region.status, 1, region.stderr);
    assert.deepEqual(JSON.parse(region.stdout), { kind: "contract-missing", id: "kei/missing" });
  } finally {
    rmSync(repo.path, { recursive: true, force: true });
  }
});

test("status category grammar stays separate from exact, plural, show and ls", () => {
  for (const [category, selectors] of [
    ["akuma", ["aku", "aku/", "aku/*"]],
    ["contract", ["kei", "kei/", "kei/*"]],
  ] as const) {
    for (const selector of selectors) {
      assert.deepEqual(parseArgv(["status", selector]), {
        command: { command: "status", category, output: "text" },
      });
      assert.deepEqual(parseArgv(["status", selector, "--limit", "501", "--json"]), {
        command: { command: "status", category, limit: 501, output: "json" },
      });
      assert.throws(() => parseArgv(["show", selector]), /cannot select a category/u);
      assert.throws(() => parseArgv(["status", selector, "kei/exact"]), /cannot combine/u);
    }
  }
  for (const value of ["0", "-1", "01", "1.5", "1e2", "9007199254740992"]) {
    assert.throws(() => parseArgv(["status", "aku", "--limit", value]), CliUsageError);
  }
  assert.throws(() => parseArgv(["status", "aku", "--limit"]), /requires a value/u);
  assert.throws(() => parseArgv(["status", "aku", "--limit", "2", "--limit", "3"]), /duplicate option/u);
  for (const selectors of [[], ["kei/exact"], ["aku/worker/1234abcd"], ["kei/a", "kei/b"]]) {
    assert.throws(() => parseArgv(["status", ...selectors, "--limit", "2"]), /only for/u);
  }
  for (const pattern of ["aku/*/*", "aku/worker/*", "kei/foo*", "kei/?", "kei/[ab]"]) {
    assert.throws(() => parseArgv(["status", pattern]), /unsupported status glob/u);
    assert.throws(() => parseArgv(["status", "kei/exact", pattern]), /unsupported status glob/u);
  }
  assert.deepEqual(parseArgv(["status"]), { command: { command: "status", output: "text" } });
  assert.deepEqual(parseArgv(["status", "kei/a", "aku/worker/1234abcd"]), {
    command: { command: "status", selectors: ["kei/a", "aku/worker/1234abcd"], output: "text" },
  });
  assert.throws(() => parseArgv(["show", "kei/a", "--limit", "2"]), /not valid for show/u);
  assert.deepEqual(parseArgv(["status", "aku/worker/1234abcd"]), {
    command: { command: "status", contract: "aku/worker/1234abcd", akuma: true, output: "text" },
  });
  assert.deepEqual(parseArgv(["show", "kei/a"]), {
    command: { command: "show", contract: "kei/a", output: "text" },
  });
  assert.deepEqual(parseArgv(["ls", "aku"]), {
    command: { command: "ls", query: { kind: "archetypes" }, output: "text" },
  });
});

test("Akuma categories preserve bounded recent owner rows without Repo or Debt reads", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-category-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const world = await World.at(root);
  for (let index = 0; index < 11; index += 1) {
    const born = await bornDirectAkuma({
      root: world,
      akumaName: "worker",
      draw: index.toString(16).padStart(8, "0"),
      createdAt: `2026-08-09T00:00:${String(index).padStart(2, "0")}.000Z`,
    });
    const body = await born.leash.recordBody(born.paths, { leashTakenAt: born.soul.createdAt });
    await breakBody(born.paths, { sequence: body.sequence, end: "put-down", at: born.soul.createdAt });
    born.leash.release();
  }
  const owner = await Akumas.of(world).list({ limit: 11 });
  const ownerRows = owner.rows;
  assert.ok(ownerRows !== undefined, "the bounded roster returns owner rows");
  assert.equal(ownerRows[0]!.id, "aku/worker/0000000a");
  await moveAlias({ world, alias: parseAkumaAlias("@recent"), akumaId: ownerRows[0]!.id });
  mkdirSync(join(world, ".keiyaku", "debts"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "debts", "bad.md"), "not a debt document\n");
  for (const selector of ["aku", "aku/", "aku/*"]) {
    const json = await cliJson<KanshiCategoryReport<"akuma">>(["-C", root, "status", selector], { environment: {} });
    assert.equal(json.exit, 0, json.stderr);
    const section = json.value.section;
    if (section.kind !== "present") assert.fail(json.stdout);
    assert.equal(section.more, true);
    assert.deepEqual(
      section.rows?.map((row) => row.id),
      ownerRows.slice(0, 10).map((row) => row.id),
    );
    assert.deepEqual(section.rows?.[0]?.aliases, ["@recent"]);
    assert.equal("debts" in json.value, false);
    assert.equal("contracts" in json.value, false);
    const text = await runCli(["-C", root, "status", selector, "--limit", "2"], { environment: {} });
    assert.equal(text.exit, 0, text.stderr);
    assert.match(text.stdout, /^AKUMA \/\/ 2 recent/u);
    assert.match(text.stdout, /@recent/u);
    assert.ok(text.stdout.indexOf(ownerRows[0]!.id) < text.stdout.indexOf(ownerRows[1]!.id));
    assert.doesNotMatch(text.stdout, new RegExp(ownerRows[2]!.id, "u"));
    assert.ok(text.stdout.trimEnd().endsWith("…"));
  }
  const full = await cliJson<KanshiCategoryReport<"akuma">>(["-C", root, "status", "aku", "--limit", "501"], {
    environment: {},
  });
  assert.equal(full.exit, 0, full.stderr);
  const fullSection = full.value.section;
  if (fullSection.kind !== "present") assert.fail(full.stdout);
  assert.equal(fullSection.rows?.length, 11);
  assert.equal(fullSection.more, undefined);
  const exact = await cliJson<{ kind: string; id: string }>(["-C", root, "status", ownerRows[10]!.id], {
    environment: {},
  });
  assert.equal(exact.exit, 0, exact.stderr);
  assert.equal(exact.value.kind, "akuma");
  assert.equal(exact.value.id, ownerRows[10]!.id);
});

test("Contract categories preserve active catalogue facts and readable Dispatch without Debt reads", async (t) => {
  const repository = makeGitRepository();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const world = await World.at(repository.path);
  const library = Keis.of(repo);
  for (let index = 0; index < 11; index += 1) {
    accepted(
      await library.bind({
        target: "main",
        markdown: contractMarkdown(`Category ${index}`, {
          Context: "category status",
          Objective: "observe",
          Design: "owner rows",
          Region: "src/**",
          Criteria: "### Visible\nOwner facts remain visible.",
        }),
        gates: ["reviewed"],
      }),
    );
  }
  const owner = await library.list({ limit: 11 });
  const ownerRows = owner.rows;
  assert.ok(ownerRows !== undefined, "the bounded catalogue returns owner summaries");
  const oldest = ownerRows[10]!;
  const short = `@${oldest.id.slice("kei/".length)}`;
  const guidance = await library.kei({ id: oldest.id }).guidance();
  assert.deepEqual(await Keiyaku.at({ cwd: repo.cwd, environment: {} }).show({ contract: short }), guidance);
  const oldestObservation = await library.observe({ id: oldest.id });
  assert.equal(oldestObservation.kind, "present");
  if (oldestObservation.kind !== "present") assert.fail("the selected Contract has an exact observation");
  const oldestWorkspace = oldestObservation.row.workspace;
  if (!("path" in oldestWorkspace)) assert.fail("the selected Contract has an appointed worktree");
  const oldestWorktree = oldestWorkspace.path;
  assert.deepEqual(await Keiyaku.at({ cwd: oldestWorktree, environment: {} }).show(), guidance);
  const region = await cliJson<{ kind: string; id: string; patterns: string[] }>(
    ["-C", repository.path, "region", short],
    { environment: {} },
  );
  assert.equal(region.exit, 0, region.stderr);
  assert.equal(region.value.kind, "present");
  assert.equal(region.value.id, oldest.id);
  const contextual = await cliJson<{ contractId: string }>(["-C", oldestWorktree, "deliver", "--dry-run"], {
    environment: {},
  });
  assert.equal(contextual.exit, 0, contextual.stderr);
  assert.equal(contextual.value.contractId, oldest.id);
  const named = await cliJson<KanshiContractReport>(["-C", world, "status", short], { environment: {} });
  assert.equal(named.exit, 0, named.stderr);
  assert.equal(named.value.kind, "contract");
  assert.equal(named.value.id, oldest.id, "the oldest short name selects its Contract");
  const exactById = await cliJson<KanshiContractReport>(["-C", world, "status", oldest.id], { environment: {} });
  assert.equal(exactById.value.kind, "contract");
  assert.equal(exactById.value.id, oldest.id);
  const born = await bornDirectAkuma({
    root: world,
    akumaName: "worker",
    draw: "a0000001",
    createdAt: "2026-08-09T00:00:00.000Z",
  });
  born.leash.release();
  await moveAlias({ world, alias: parseAkumaAlias(short), akumaId: born.id });
  const ambiguous = runCliJson(repository.path, ["status", short]);
  assert.equal(ambiguous.status, 3, ambiguous.stderr);
  const refusal = JSON.parse(ambiguous.stdout) as Readonly<{ kind: string; diagnostic: string }>;
  assert.equal(refusal.kind, "failed");
  assert.match(refusal.diagnostic, /ambiguous selector matches Contract and Akuma/u);
  const dispatch = await publishDispatch({
    repository: await repositoryAt(repository.path),
    akumaId: born.id,
    contractId: ownerRows[0]!.id,
  });
  assert.equal(dispatch.kind, "dispatched");
  mkdirSync(join(world, ".keiyaku", "debts"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "debts", "bad.md"), "not a debt document\n");
  for (const selector of ["kei", "kei/", "kei/*"]) {
    const json = await cliJson<KanshiCategoryReport<"contract">>(["-C", world, "status", selector], { environment: {} });
    assert.equal(json.exit, 0, json.stderr);
    const section = json.value.section;
    if (section.kind !== "present") assert.fail(json.stdout);
    const rows = section.rows;
    assert.ok(rows !== undefined, "the bounded catalogue returns owner summaries");
    assert.deepEqual(
      rows.map((row) => row.id),
      ownerRows.slice(0, 10).map((row) => row.id),
    );
    assert.equal(section.more, true);
    assert.equal("debts" in json.value, false);
    assert.equal("akuma" in json.value, false);
    for (let index = 0; index < rows.length; index += 1) {
      assert.equal(rows[index]!.phaseAt, ownerRows[index]!.phaseAt);
      assert.equal(rows[index]!.delivered, ownerRows[index]!.delivered);
      assert.deepEqual(rows[index]!.gates, ownerRows[index]!.gates);
    }
    const text = await runCli(["-C", world, "status", selector, "--limit", "2"], { environment: {} });
    assert.equal(text.exit, 0, text.stderr);
    assert.match(text.stdout, /^CONTRACTS \/\/ recent/u);
    assert.match(text.stdout, /\[ \] review/u);
    assert.ok(text.stdout.indexOf(ownerRows[0]!.id) < text.stdout.indexOf(ownerRows[1]!.id));
    assert.doesNotMatch(text.stdout, new RegExp(ownerRows[2]!.id, "u"));
    assert.ok(text.stdout.trimEnd().endsWith("…"));
  }
  const akuma = await cliJson<KanshiCategoryReport<"akuma">>(["-C", world, "status", "aku"], { environment: {} });
  const akumaSection = akuma.value.section;
  if (akumaSection.kind !== "present") assert.fail(akuma.stdout);
  const akumaRows = akumaSection.rows;
  assert.ok(akumaRows !== undefined, "the bounded roster returns owner rows");
  const association = akumaRows[0]!.contract;
  assert.equal(
    association?.kind === "associated" ? association.contractId : undefined,
    ownerRows[0]!.id,
    "a category association names the dispatched Contract even without its board",
  );
  const terminal = library.kei({ id: ownerRows[10]!.id });
  accepted(await terminal.abandon());
  const activeOwner = await library.list({ limit: 11 });
  const activeRows = activeOwner.rows;
  assert.ok(activeRows !== undefined, "the abandoned Contract leaves the live catalogue");
  const full = await cliJson<KanshiCategoryReport<"contract">>(["-C", world, "status", "kei", "--limit", "501"], {
    environment: {},
  });
  const fullSection = full.value.section;
  if (fullSection.kind !== "present") assert.fail(full.stdout);
  assert.equal(fullSection.rows?.length, 10);
  assert.equal(fullSection.more, undefined);
  assert.deepEqual(
    fullSection.rows?.map((row) => row.id),
    activeRows.map((row) => row.id),
  );
  const exact = await cliJson<KanshiContractReport>(["-C", world, "status", ownerRows[10]!.id], { environment: {} });
  assert.equal(exact.exit, 0, exact.stderr);
  assert.equal(exact.value.kind, "contract");
  assert.equal(exact.value.kind === "contract" ? exact.value.phase : undefined, "abandoned");
});

test("category empty, absent and unavailable observations remain distinct", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-category-empty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const absent = await cliJson<KanshiCategoryReport<"akuma">>(["-C", root, "status", "aku"], { environment: {} });
  assert.equal(absent.exit, 0, absent.stderr);
  assert.equal(absent.value.section.kind, "absent");
  const noRepo = runCliJson(root, ["status", "kei"]);
  assert.equal(noRepo.status, 64);
  assert.match(noRepo.stderr, /requires a resolved Repo/u);
  const world = await World.at(root);
  const empty = await runCli(["-C", world, "status", "aku"], { environment: {} });
  assert.equal(empty.exit, 0, empty.stderr);
  assert.equal(empty.stdout.trim(), "akuma  none");
  mkdirSync(join(world, ".keiyaku", "akuma"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "akuma", "alias.json"), "broken\n");
  const unavailableAliases = await cliJson<KanshiCategoryReport<"akuma">>(["-C", world, "status", "aku"], { environment: {} });
  const unavailableSection = unavailableAliases.value.section;
  assert.equal(unavailableSection.kind, "present");
  if (unavailableSection.kind !== "present") assert.fail(unavailableAliases.stdout);
  assert.equal(unavailableSection.aliasesError === undefined, false);
  assert.equal(unavailableSection.rows, undefined);
  const text = await runCli(["-C", world, "status", "aku"], { environment: {} });
  assert.match(text.stdout, /^akuma  none$/mu);
  assert.match(text.stdout, /aliases unavailable/u);
  assert.doesNotMatch(text.stdout, /AKUMA \/\/ unavailable|world empty/u);
  const repository = makeGitRepository();
  const contracts = await runCli(["-C", repository.path, "status", "kei"], { environment: {} });
  assert.equal(contracts.exit, 0, contracts.stderr);
  assert.equal(contracts.stdout.trim(), "contracts  none");
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "invalid authority"]);
  repository.run(["update-ref", "refs/heads/keiyaku-state", "HEAD"]);
  const failedContracts = await cliJson<KanshiCategoryReport<"contract">>(["-C", repository.path, "status", "kei"], {
    environment: {},
  });
  assert.equal(failedContracts.value.section.kind, "failed");
});
