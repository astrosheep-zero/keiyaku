import "./keiyaku-invocation.cases.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  Akuma, Akumas, AkumaAddressError, AkumaArchetypeError, AkumaBusyError, AkumaDecodeError,
  AkumaNotBornError, AkumaObservationError, AkumaProviderError, AkumaWorldScopeError,
  AuthorityCorruptionError, DebtAuthorityCorruptionError, Keis, KeiyakuArcDocumentError,
  KeiyakuError, KeiyakuUsageError, NoGitWorldError, Repo, SettingsError, World, WorldError,
  type AliasBinding, type KeiyakuErrorCategory, type KeiyakuErrorOptions,
} from "../src/index.js";
import ts from "typescript";
import { join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { moveAlias } from "../src/alias/index.js";
import { parseAkumaId } from "../src/akuma/identity.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { temporaryDirectory } from "./support/process.js";
import { accepted, document, present, repositoryWithMain } from "./support/library-verbs.js";

test("all distinguished root SDK errors share the base and retain their existing categories", async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-public-errors-"));
  const id = Akuma.select(world, "aku/worker/11111111").id;
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keis.of(repo).bind({ markdown: document(), gates: [], target: null }));
  const cause = new TypeError("native cause");
  const options: KeiyakuErrorOptions = {
    cause,
    outcome: { kind: "contract", contractId: bound.contractId },
    spawn: { kind: "spawned", akumaId: id },
    tell: { kind: "admitted", akumaId: id, tellId: "exact-input" },
  };
  const base = new KeiyakuError("invalid-input", "caller error", options);
  const cases: readonly (readonly [KeiyakuError, KeiyakuErrorCategory])[] = [
    [base, "invalid-input"],
    [new KeiyakuArcDocumentError(bound.contractId, cause), "internal"],
    [new KeiyakuUsageError("usage"), "internal"],
    [new AkumaAddressError({ kind: "invalid-akuma", selector: "invalid" }), "internal"],
    [new AkumaWorldScopeError({ kind: "akuma-not-in-world", ids: [id], world }), "internal"],
    [new AkumaNotBornError(id), "internal"],
    [new AkumaObservationError(id, "unreadable"), "internal"],
    [new AkumaDecodeError("invalid answer"), "internal"],
    [new AkumaProviderError("provider failure"), "internal"],
    [new AkumaArchetypeError("worker", [], "was not found"), "internal"],
    [new AkumaBusyError(), "internal"],
    [new AuthorityCorruptionError("corrupt authority"), "authority-corruption"],
    [new NoGitWorldError(world), "internal"],
    [new DebtAuthorityCorruptionError("corrupt Debt"), "internal"],
    [new SettingsError("unavailable Settings"), "internal"],
    [new WorldError("invalid World"), "internal"],
  ];
  for (const [error, category] of cases) {
    assert.ok(error instanceof Error && error instanceof KeiyakuError, error.name);
    assert.equal(error.category, category, error.name);
  }
  assert.equal(base.cause, cause);
  for (const key of ["outcome", "spawn", "tell"] as const) {
    assert.equal(base[key], options[key]);
    assert.ok(Object.isFrozen(base[key]));
    assert.equal(Reflect.set(base, key, undefined), false);
  }
});

test("compiled package declarations expose typed readonly error receipts to a root-only consumer", () => {
  const root = resolve(import.meta.dirname, import.meta.url.endsWith(".js") ? "../.." : "..");
  const consumer = join(root, "tests", "public-error-consumer.mts");
  const source = `
import { KeiyakuError, type KeiyakuErrorOptions, type PartialOutcomeEnvelope,
  type SpawnResult, type AkumaTellResult } from "@astrosheep/keiyaku";
declare const outcome: PartialOutcomeEnvelope;
declare const spawn: SpawnResult;
declare const tell: AkumaTellResult;
const options: KeiyakuErrorOptions = { outcome, spawn, tell, cause: new TypeError("native") };
const error = new KeiyakuError("internal", "failed", options);
const receipts: [PartialOutcomeEnvelope | undefined, SpawnResult | undefined, AkumaTellResult | undefined] =
  [error.outcome, error.spawn, error.tell];
// @ts-expect-error receipts are readonly
error.outcome = outcome;
// @ts-expect-error receipts are readonly
error.spawn = spawn;
// @ts-expect-error receipts are readonly
error.tell = tell;
void receipts;
`;
  const options: ts.CompilerOptions = {
    strict: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: true,
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile;
  host.getSourceFile = (path, ...rest) => path === consumer
    ? ts.createSourceFile(path, source, ts.ScriptTarget.ES2023, true)
    : original(path, ...rest);
  const program = ts.createProgram([consumer], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));
  assert.ok(program.getSourceFile(join(root, "build", "src", "errors.d.ts")), "consumer must use compiled declarations");
});

/**
 * The package-root bind surface owns the one omitted-target default: the current branch of the
 * caller's explicit Repo worktree coordinate, with `null` as the deliberate targetless spelling.
 * The CLI edge's own literal flags are witnessed separately in tests/cli-bind-target.test.ts.
 */
test("public Keis.bind omitted target names the Repo worktree branch", async () => {
  const raw = repositoryWithMain();
  const repo = await Repo.at({ path: raw.path });

  const bound = accepted(await Keis.of(repo).bind({ markdown: document(), gates: [] }));
  const state = present(await bound.kei.state());
  assert.equal(state.coordinates.target, "refs/heads/main");
  const json = JSON.parse(JSON.stringify(bound));
  assert.equal(json.contractId, state.id);
  assert.equal(json.target, "refs/heads/main");
  assert.equal(json.worktreePath, bound.worktreePath);
  assert.equal(Object.hasOwn(json, "kei"), false);

  await assert.rejects(
    () =>
      Keis.of(repo).bind({
        markdown: document(),
        targetSelection: { kind: "current-branch" },
      } as never),
    /Keis.bind input has unknown field: targetSelection/u,
  );
});

test("public Keis.bind target:null stays targetless and a string target stays literal", async () => {
  const raw = repositoryWithMain();
  raw.run(["branch", "release"]);
  const repo = await Repo.at({ path: raw.path });

  const targetless = accepted(
    await Keis.of(repo).bind({ markdown: document(), target: null, gates: [] }),
  );
  assert.equal(present(await targetless.kei.state()).coordinates.target, undefined);

  const explicit = accepted(
    await Keis.of(repo).bind({
      markdown: document(),
      target: "release",
      gates: [],
    }),
  );
  assert.equal(present(await explicit.kei.state()).coordinates.target, "refs/heads/release");

  await assert.rejects(
    () => Keis.of(repo).bind({ markdown: document(), target: 7 } as never),
    /target must be a string or null/u,
  );
});

test("World-bound alias observation selects one canonical mapping without requiring Akuma existence", async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-public-aliases-"));
  const akumas = Akumas.of(world);
  const first = parseAkumaId("aku/worker/11111111").id;
  const second = parseAkumaId("aku/reviewer/22222222").id;
  const missing = "aku/worker/33333333";
  assert.deepEqual(await akumas.aliases({ akumaIds: [first, missing] }), []);
  for (const [name, akumaId] of [["zeta", first], ["alpha", first], ["reviewer", second]] as const) {
    await moveAlias({ world, alias: parseAkumaAlias(`@${name}`), akumaId });
  }
  const bindings: readonly AliasBinding[] = await akumas.aliases({ akumaIds: [second, first, first, missing] });
  assert.deepEqual(bindings, [
    { alias: "@alpha", akumaId: first },
    { alias: "@reviewer", akumaId: second },
    { alias: "@zeta", akumaId: first },
  ]);
  await moveAlias({ world, alias: parseAkumaAlias("@alpha"), akumaId: second });
  assert.deepEqual(await akumas.aliases({ akumaIds: [first] }), [{ alias: "@zeta", akumaId: first }]);
  assert.deepEqual(await akumas.aliases({ akumaIds: [second] }), [
    { alias: "@alpha", akumaId: second }, { alias: "@reviewer", akumaId: second },
  ]);
  assert.deepEqual(await akumas.aliases({ akumaIds: [] }), []);
  for (const input of [{}, { akumaIds: "@alpha" }, { akumaIds: ["@alpha"] }, { akumaIds: [first, 1] },
    { akumaIds: [first], path: world }]) {
    await assert.rejects(akumas.aliases(input as never), TypeError);
  }
  writeFileSync(join(world, ".keiyaku", "akuma", "alias.json"), "corrupt\n");
  await assert.rejects(akumas.aliases({ akumaIds: [missing] }), AuthorityCorruptionError);
});

test("Repo.at rejects an absent or relative worktree coordinate before any filesystem work", async () => {
  await assert.rejects(() => Repo.at(undefined as never), /Repo\.at input must be an object/u);
  await assert.rejects(() => Repo.at({} as never), /repository path must be a nonblank string/u);
  await assert.rejects(() => Repo.at({ path: "relative/worktree" }), /repository path must be absolute/u);
});
