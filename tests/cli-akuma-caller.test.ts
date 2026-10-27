import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { AkumaList } from "../src/akuma/akuma.js";
import type { AkumaCaller } from "../src/akuma/caller.js";
import { akumaCallerFromEnvironment } from "../src/cli/akuma-caller.js";
import { CliUsageError, parseArgv } from "../src/cli/parse.js";
import { World } from "../src/world.js";
import { bornLineageAkuma } from "./support/akuma-fixtures.js";
import { cliJson, runCli } from "./support/cli-fixtures.js";
import { temporaryDirectory } from "./support/process.js";

test("CLI caller canonicalizes the actor World, prioritizes the complete pair and splits external identity once", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-cli-caller-");
  const target = join(root, "world");
  mkdirSync(target);
  symlinkSync(target, join(root, "alias"), "dir");
  assert.deepEqual(await akumaCallerFromEnvironment({
    KEIYAKU_ACTOR_ID: "aku/parent/1234abcd", KEIYAKU_ACTOR_WORLD: join(root, "alias"),
    KEIYAKU_EXTERNAL_CALLER: "malformed",
  }), { kind: "akuma", world: realpathSync(target), akuId: "aku/parent/1234abcd" });
  assert.equal(existsSync(join(target, ".keiyaku")), false, "attribution must not establish the caller's World");
  assert.deepEqual(await akumaCallerFromEnvironment({ KEIYAKU_EXTERNAL_CALLER: "slack:channel:thread" }), {
    kind: "external", integration: "slack", id: "channel:thread",
  });
  assert.equal(await akumaCallerFromEnvironment({}), undefined);
  for (const environment of [
    { KEIYAKU_ACTOR_ID: "aku/parent/1234abcd", KEIYAKU_EXTERNAL_CALLER: "slack:external" },
    { KEIYAKU_ACTOR_WORLD: target },
  ]) await assert.rejects(akumaCallerFromEnvironment(environment), /both KEIYAKU_ACTOR_ID and KEIYAKU_ACTOR_WORLD/u);
  await assert.rejects(akumaCallerFromEnvironment({ KEIYAKU_EXTERNAL_CALLER: "missing-colon" }), /<integration>:<id>/u);
});

test("ls --mine selects this process caller's World-local descendants", async (t) => {
  const root = await World.at(temporaryDirectory(t, "keiyaku-cli-caller-roster-"));
  const external: AkumaCaller = { kind: "external", integration: "test", id: "root" };
  const direct = await bornLineageAkuma({
    root,
    archetype: "worker",
    draw: "dddd0001",
    createdAt: "2026-08-08T00:00:01.000Z",
    caller: external,
  });
  const sibling = await bornLineageAkuma({
    root,
    archetype: "worker",
    draw: "dddd0002",
    createdAt: "2026-08-08T00:00:02.000Z",
    caller: external,
  });
  const grandchild = await bornLineageAkuma({
    root,
    archetype: "intern",
    draw: "dddd0003",
    createdAt: "2026-08-08T00:00:03.000Z",
    caller: { kind: "akuma", world: root, akuId: direct.id },
  });
  const unrelated = await bornLineageAkuma({
    root,
    archetype: "intern",
    draw: "dddd0004",
    createdAt: "2026-08-08T00:00:04.000Z",
    caller: { kind: "external", integration: "other", id: "elsewhere" },
  });
  const environment = { KEIYAKU_EXTERNAL_CALLER: "test:root" };

  const shorthand = await cliJson<AkumaList>(["-C", root, "ls", "--mine"], { environment });
  const globbed = await cliJson<AkumaList>(["-C", root, "ls", "aku/*/*", "--mine"], { environment });
  assert.equal(shorthand.exit, 0, shorthand.stderr);
  assert.deepEqual(shorthand.value.rows, globbed.value.rows, "the shorthand and the complete Akuma catalogue agree");
  assert.deepEqual(
    shorthand.value.rows.map((row) => row.id),
    [grandchild.id, sibling.id, direct.id],
  );
  assert.deepEqual(
    shorthand.value.rows.map((row) => ("caller" in row ? row.caller : undefined)),
    [{ kind: "akuma", world: root, akuId: direct.id }, external, external],
  );
  assert.equal(shorthand.value.rows.some((row) => row.id === unrelated.id), false);

  const text = await runCli(["-C", root, "ls", "aku/*/*", "--mine"], { environment });
  assert.equal(text.exit, 0, text.stderr);
  assert.match(text.stdout, new RegExp(`aku/intern/dddd0003 .* · by ${direct.id}`, "u"));
  const directLine = text.stdout.split("\n").find((line) => line.includes(`${direct.id} ·`));
  assert.equal(directLine?.includes("· by"), false, "a direct child names no calling Akuma");
  assert.doesNotMatch(text.stdout, /dddd0004/u);

  const explicitExternal = await cliJson<AkumaList>(
    ["-C", root, "ls", "aku/*/*", "--caller", "test:root"],
    { environment: {} },
  );
  assert.deepEqual(explicitExternal.value.rows.map((row) => row.id), [grandchild.id, sibling.id, direct.id]);
  const explicitAkuma = await cliJson<AkumaList>(
    ["-C", root, "ls", "aku/*/*", "--caller", direct.id],
    { environment: {} },
  );
  assert.deepEqual(explicitAkuma.value.rows.map((row) => row.id), [grandchild.id]);
});

test("ls caller selection refuses absent identity and non-Akuma catalogues", async (t) => {
  const root = await World.at(temporaryDirectory(t, "keiyaku-cli-caller-refusal-"));
  const missing = await runCli(["-C", root, "ls", "--mine"], { environment: {} });
  assert.equal(missing.exit, 64);
  assert.match(missing.stderr, /--mine requires a caller identity/u);
  for (const environment of [
    { CODEX_THREAD_ID: "codex", PI_SESSION_ID: "pi" },
    { KEIYAKU_ACTOR_ID: "aku/parent/1234abcd" },
  ]) {
    const ambiguous = await runCli(["-C", root, "ls", "--mine"], { environment });
    assert.equal(ambiguous.exit, 64);
  }
  for (const argv of [
    ["ls", "aku/*/*", "--mine", "--caller", "test:root"],
    ["ls", "aku/*/*", "--caller", "missing-colon"],
    ["ls", "aku/*/*", "--caller", "aku/worker/nothex"],
    ["ls", "aku/", "--mine"],
    ["ls", "kei", "--mine"],
    ["ls", "debt", "--mine"],
  ]) {
    assert.throws(() => parseArgv(argv), CliUsageError, argv.join(" "));
  }
});
