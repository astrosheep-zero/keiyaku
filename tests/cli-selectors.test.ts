import assert from "node:assert/strict";
import test from "node:test";
import type { KanshiReport } from "../src/kanshi/index.js";
import { resolveContractId } from "../src/cli/selectors.js";
import { CliUsageError } from "../src/cli/parse.js";
import { makeGitRepository } from "./support/git.js";
import { rmSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AKUMA_REQUESTS_ENV } from "../src/akuma/provider.js";
import { parseArgv } from "../src/cli/parse.js";
import { cliJson, runCli } from "./support/cli-fixtures.js";
import { bornDirectAkuma } from "./support/akuma-fixtures.js";
import { breakBody } from "../src/akuma/heart/index.js";
import { Akumas, Keiyaku, Repo, World } from "../src/index.js";
import type { KanshiCategoryReport } from "../src/kanshi/index.js";
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
  const environment = { ...process.env };
  delete environment[AKUMA_REQUESTS_ENV];
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
    { encoding: "utf8", env: environment },
  );
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

test("CLI adapts public Contract selector refusals without owning matching", async () => {
  const repository = makeGitRepository();
  const repo = await Repo.at({ path: repository.path });
  const selector = "@missing";
  assert.deepEqual(await Keiyaku.with().resolve({ repo, selector }), {
    kind: "refused",
    refusal: { kind: "unknown-short-selector", selector },
  });
  await assert.rejects(resolveContractId(repo, selector, repo.cwd), (error: unknown) => {
    assert.ok(error instanceof CliUsageError);
    assert.match(error.message, /unknown contract selector: @missing/u);
    return true;
  });
  await assert.rejects(resolveContractId(repo, "@kei/missing", repo.cwd), /redundant short contract selector/u);
  await assert.rejects(resolveContractId(repo, undefined, repo.cwd), /required outside a managed worktree/u);
});

test("missing Contract selectors refuse uniformly across read and reconcile verbs", () => {
  const repo = makeGitRepository();
  try {
    const refusalKind = (value: Readonly<{ kind: string; refusal?: Readonly<{ kind: string }> }>): string =>
      value.kind === "refused" ? (value.refusal?.kind ?? "missing-envelope") : value.kind;
    for (const argv of [
      ["deliver", "kei/missing"],
      ["status", "kei/missing"],
      ["region", "kei/missing"],
      ["reconcile", "kei/missing"],
    ] as const) {
      const result = runCliJson(repo.path, argv);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(refusalKind(JSON.parse(result.stdout)), "contract-missing");
    }
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
      archetype: "worker",
      draw: index.toString(16).padStart(8, "0"),
      createdAt: `2026-08-09T00:00:${String(index).padStart(2, "0")}.000Z`,
    });
    const body = await born.leash.recordBody(born.paths, { leashTakenAt: born.soul.createdAt });
    await breakBody(born.paths, { sequence: body.sequence, end: "put-down", at: born.soul.createdAt });
    born.leash.release();
  }
  const owner = await Akumas.of(world).list({ limit: 11 });
  assert.equal(owner.rows[0]!.id, "aku/worker/0000000a");
  await moveAlias({ world, alias: parseAkumaAlias("@recent"), akuId: owner.rows[0]!.id });
  mkdirSync(join(world, ".keiyaku", "debts"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "debts", "bad.md"), "not a debt document\n");
  for (const selector of ["aku", "aku/", "aku/*"]) {
    const json = await cliJson<KanshiCategoryReport>(["-C", root, "status", selector], { environment: {} });
    assert.equal(json.exit, 0, json.stderr);
    assert.equal(json.value.category, "akuma");
    if (json.value.category !== "akuma" || json.value.akuma.kind !== "present") assert.fail(json.stdout);
    assert.equal(json.value.akuma.value.hasMore, true);
    assert.deepEqual(json.value.akuma.value.rows.map((row) => row.id), owner.rows.slice(0, 10).map((row) => row.id));
    assert.deepEqual(json.value.akuma.value.rows[0]!.aliases, ["@recent"]);
    assert.equal("debts" in json.value, false);
    assert.equal("contracts" in json.value, false);
    const text = await runCli(["-C", root, "status", selector, "--limit", "2"], { environment: {} });
    assert.equal(text.exit, 0, text.stderr);
    assert.match(text.stdout, /^AKUMA \/\/ 2 recent/u);
    assert.match(text.stdout, /@recent/u);
    assert.ok(text.stdout.indexOf(owner.rows[0]!.id) < text.stdout.indexOf(owner.rows[1]!.id));
    assert.doesNotMatch(text.stdout, new RegExp(owner.rows[2]!.id, "u"));
    assert.ok(text.stdout.trimEnd().endsWith("…"));
  }
  const full = await cliJson<KanshiCategoryReport>(["-C", root, "status", "aku", "--limit", "501"], { environment: {} });
  assert.equal(full.exit, 0, full.stderr);
  if (full.value.category !== "akuma" || full.value.akuma.kind !== "present") assert.fail(full.stdout);
  assert.equal(full.value.akuma.value.rows.length, 11);
  assert.equal(full.value.akuma.value.hasMore, false);
  const exact = await cliJson<{ status: { id: string } }>(["-C", root, "status", owner.rows[10]!.id], { environment: {} });
  assert.equal(exact.exit, 0, exact.stderr);
  assert.equal(exact.value.status.id, owner.rows[10]!.id);
});

test("Contract categories preserve active catalogue facts and readable Dispatch without Debt reads", async (t) => {
  const repository = makeGitRepository();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const world = await World.at(repository.path);
  const library = Keiyaku.with();
  for (let index = 0; index < 11; index += 1) {
    accepted(await library.bind({
      repo,
      target: "main",
      markdown: contractMarkdown(`Category ${index}`, {
        Context: "category status", Objective: "observe", Design: "owner rows",
        Region: "src/**", Criteria: "### Visible\nOwner facts remain visible.",
      }),
      gates: ["reviewed"],
    }));
  }
  const owner = await library.list({ repo, limit: 11 });
  const oldest = owner.rows[10]!;
  const short = `@${oldest.id.slice("kei/".length)}`;
  assert.equal(await resolveContractId(repo, short, repo.cwd), oldest.id);
  assert.equal(await resolveContractId(repo, undefined, oldest.worktreePath!), oldest.id);
  const region = await cliJson<{ kind: string; value: { declaration: { contract: string } } }>(
    ["-C", repository.path, "region", short],
    { environment: {} },
  );
  assert.equal(region.exit, 0, region.stderr);
  assert.equal(region.value.kind, "present");
  assert.equal(region.value.value.declaration.contract, oldest.id);
  const contextual = await cliJson<{ contract: string }>(["-C", oldest.worktreePath!, "deliver", "--dry-run"], { environment: {} });
  assert.equal(contextual.exit, 0, contextual.stderr);
  assert.equal(contextual.value.contract, oldest.id);
  const named = await cliJson<KanshiReport>(["-C", world, "status", short], { environment: {} });
  assert.equal(named.exit, 0, named.stderr);
  if (named.value.contracts.kind !== "present") assert.fail(named.stdout);
  assert.equal(named.value.contracts.value.rows[0]!.id, oldest.id, "the oldest short name selects its Contract");
  const exactById = await cliJson<KanshiReport>(["-C", world, "status", oldest.id], { environment: {} });
  assert.equal(exactById.value.contracts.kind === "present" && exactById.value.contracts.value.rows[0]!.id, oldest.id);
  const born = await bornDirectAkuma({ root: world, archetype: "worker", draw: "a0000001", createdAt: "2026-08-09T00:00:00.000Z" });
  born.leash.release();
  await moveAlias({ world, alias: parseAkumaAlias(short), akuId: born.id });
  const ambiguous = runCliJson(repository.path, ["status", short]);
  assert.equal(ambiguous.status, 3, ambiguous.stderr);
  const refusal = JSON.parse(ambiguous.stdout) as Readonly<{ kind: string; diagnostic: string }>;
  assert.equal(refusal.kind, "failed");
  assert.match(refusal.diagnostic, /ambiguous selector matches Contract and Akuma/u);
  const dispatch = await publishDispatch({ repository: await repositoryAt(repository.path), akuId: born.id, contractId: owner.rows[0]!.id });
  assert.equal(dispatch.kind, "dispatched");
  mkdirSync(join(world, ".keiyaku", "debts"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "debts", "bad.md"), "not a debt document\n");
  for (const selector of ["kei", "kei/", "kei/*"]) {
    const json = await cliJson<KanshiCategoryReport>(["-C", world, "status", selector], { environment: {} });
    assert.equal(json.exit, 0, json.stderr);
    if (json.value.category !== "contract" || json.value.contracts.kind !== "present") assert.fail(json.stdout);
    const rows = json.value.contracts.value.rows;
    assert.deepEqual(rows.map((row) => row.id), owner.rows.slice(0, 10).map((row) => row.id));
    assert.equal(json.value.contracts.value.hasMore, true);
    assert.equal("debts" in json.value, false);
    assert.equal("akuma" in json.value, false);
    for (let index = 0; index < rows.length; index += 1) {
      assert.equal(rows[index]!.target, owner.rows[index]!.target);
      assert.equal(rows[index]!.worktreePath, owner.rows[index]!.worktreePath);
      assert.deepEqual(rows[index]!.workspaceObservation, owner.rows[index]!.workspaceObservation);
      assert.deepEqual(rows[index]!.gates, owner.rows[index]!.gates);
      assert.equal(rows[index]!.namespaceDebts, undefined);
    }
    const text = await runCli(["-C", world, "status", selector, "--limit", "2"], { environment: {} });
    assert.equal(text.exit, 0, text.stderr);
    assert.match(text.stdout, /^CONTRACTS \/\/ recent/u);
    assert.match(text.stdout, /\[ \] review/u);
    assert.ok(text.stdout.indexOf(owner.rows[0]!.id) < text.stdout.indexOf(owner.rows[1]!.id));
    assert.doesNotMatch(text.stdout, new RegExp(owner.rows[2]!.id, "u"));
    assert.ok(text.stdout.trimEnd().endsWith("…"));
  }
  const akuma = await cliJson<KanshiCategoryReport>(["-C", world, "status", "aku"], { environment: {} });
  if (akuma.value.category !== "akuma" || akuma.value.akuma.kind !== "present") assert.fail(akuma.stdout);
  assert.equal(akuma.value.akuma.value.rows[0]!.contract?.id, owner.rows[0]!.id);
  const terminal = library.select({ repo, id: owner.rows[10]!.id });
  accepted(await terminal.abandon());
  const activeOwner = await library.list({ repo, limit: 11 });
  const full = await cliJson<KanshiCategoryReport>(["-C", world, "status", "kei", "--limit", "501"], { environment: {} });
  if (full.value.category !== "contract" || full.value.contracts.kind !== "present") assert.fail(full.stdout);
  assert.equal(full.value.contracts.value.rows.length, 10);
  assert.equal(full.value.contracts.value.hasMore, false);
  assert.deepEqual(full.value.contracts.value.rows.map((row) => row.id), activeOwner.rows.map((row) => row.id));
  const exact = await cliJson<KanshiReport>(["-C", world, "status", owner.rows[10]!.id], { environment: {} });
  assert.equal(exact.exit, 0, exact.stderr);
  if (exact.value.contracts.kind !== "present") assert.fail(exact.stdout);
  assert.equal(exact.value.contracts.value.rows[0]!.phase, "abandoned");
  assert.equal(exact.value.debts.kind, "failed");
});

test("category empty, absent and unavailable observations remain distinct", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-category-empty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const absent = await cliJson<KanshiCategoryReport>(["-C", root, "status", "aku"], { environment: {} });
  assert.equal(absent.exit, 0, absent.stderr);
  assert.equal(absent.value.category, "akuma");
  if (absent.value.category !== "akuma") assert.fail(absent.stdout);
  assert.equal(absent.value.akuma.kind, "absent");
  const noRepo = runCliJson(root, ["status", "kei"]);
  assert.equal(noRepo.status, 64);
  assert.match(noRepo.stderr, /requires a resolved Repo/u);
  const world = await World.at(root);
  const empty = await runCli(["-C", world, "status", "aku"], { environment: {} });
  assert.equal(empty.exit, 0, empty.stderr);
  assert.equal(empty.stdout.trim(), "akuma  none");
  mkdirSync(join(world, ".keiyaku", "akuma"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "akuma", "alias.json"), "broken\n");
  const failed = await cliJson<KanshiCategoryReport>(["-C", world, "status", "aku"], { environment: {} });
  if (failed.value.category !== "akuma") assert.fail(failed.stdout);
  assert.equal(failed.value.akuma.kind, "failed");
  const text = await runCli(["-C", world, "status", "aku"], { environment: {} });
  assert.match(text.stdout, /^AKUMA \/\/ unavailable/u);
  assert.doesNotMatch(text.stdout, /none|world empty/u);
  const repository = makeGitRepository();
  const contracts = await runCli(["-C", repository.path, "status", "kei"], { environment: {} });
  assert.equal(contracts.exit, 0, contracts.stderr);
  assert.equal(contracts.stdout.trim(), "contracts  none");
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "invalid authority"]);
  repository.run(["update-ref", "refs/heads/keiyaku-state", "HEAD"]);
  const failedContracts = await cliJson<KanshiCategoryReport>(["-C", repository.path, "status", "kei"], { environment: {} });
  if (failedContracts.value.category !== "contract") assert.fail(failedContracts.stdout);
  assert.equal(failedContracts.value.contracts.kind, "failed");
});
