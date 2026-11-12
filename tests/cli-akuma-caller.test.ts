import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createKeiyakuMcpServer } from "../src/mcp/adapter.js";
import type { AkumaList } from "../src/library/akumas.js";
import type { AkumaCaller } from "../src/akuma/caller.js";
import { Akumas, Keiyaku, KeiyakuUsageError } from "../src/index.js";
import { akumaCallerFromEnvironment } from "../src/library/keiyaku-identity.js";
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
  assert.deepEqual(
    await akumaCallerFromEnvironment({
      KEIYAKU_ACTOR_ID: "aku/parent/1234abcd",
      KEIYAKU_ACTOR_WORLD: join(root, "alias"),
      KEIYAKU_EXTERNAL_CALLER: "malformed",
    }),
    { kind: "akuma", world: realpathSync(target), akumaId: "aku/parent/1234abcd" },
  );
  assert.equal(existsSync(join(target, ".keiyaku")), false, "attribution must not establish the caller's World");
  assert.deepEqual(await akumaCallerFromEnvironment({ KEIYAKU_EXTERNAL_CALLER: "slack:channel:thread" }), {
    kind: "external",
    integration: "slack",
    id: "channel:thread",
  });
  assert.equal(await akumaCallerFromEnvironment({}), undefined);
  for (const environment of [
    { KEIYAKU_ACTOR_ID: "aku/parent/1234abcd", KEIYAKU_EXTERNAL_CALLER: "slack:external" },
    { KEIYAKU_ACTOR_WORLD: target },
  ])
    await assert.rejects(akumaCallerFromEnvironment(environment), /both KEIYAKU_ACTOR_ID and KEIYAKU_ACTOR_WORLD/u);
  await assert.rejects(akumaCallerFromEnvironment({ KEIYAKU_EXTERNAL_CALLER: "missing-colon" }), /<integration>:<id>/u);
});

test("ls --mine selects this process caller's World-local descendants", async (t) => {
  const root = await World.at(temporaryDirectory(t, "keiyaku-cli-caller-roster-"));
  const external: AkumaCaller = { kind: "external", integration: "test", id: "root" };
  const direct = await bornLineageAkuma({
    root,
    akumaName: "worker",
    draw: "dddd0001",
    createdAt: "2026-08-08T00:00:01.000Z",
    caller: external,
  });
  const sibling = await bornLineageAkuma({
    root,
    akumaName: "worker",
    draw: "dddd0002",
    createdAt: "2026-08-08T00:00:02.000Z",
    caller: external,
  });
  const grandchild = await bornLineageAkuma({
    root,
    akumaName: "intern",
    draw: "dddd0003",
    createdAt: "2026-08-08T00:00:03.000Z",
    caller: { kind: "akuma", world: root, akumaId: direct.id },
  });
  const unrelated = await bornLineageAkuma({
    root,
    akumaName: "intern",
    draw: "dddd0004",
    createdAt: "2026-08-08T00:00:04.000Z",
    caller: { kind: "external", integration: "other", id: "elsewhere" },
  });
  const environment = { KEIYAKU_EXTERNAL_CALLER: "test:root" };
  const facet = Keiyaku.at({ cwd: root, environment });
  const selectedFacet = await facet.ls({ selector: "aku/*", mine: true });
  assert.equal(selectedFacet.kind, "akuma-catalogue");
  if (selectedFacet.kind !== "akuma-catalogue") assert.fail("wrong catalogue");
  const { observedAt: _facetTime, ...facetList } = selectedFacet;
  const { observedAt: _nativeTime, ...nativeList } = await Akumas.of(root).list({ caller: external });
  assert.deepEqual(facetList, nativeList);
  const childEnvironment = { KEIYAKU_ACTOR_ID: direct.id, KEIYAKU_ACTOR_WORLD: root };
  const selectedChild = await Keiyaku.at({ cwd: root, environment: childEnvironment }).ls({ selector: "aku/*", mine: true });
  if (selectedChild.kind !== "akuma-catalogue") assert.fail("wrong catalogue");
  const { observedAt: _childTime, ...childList } = selectedChild;
  const { observedAt: _nativeChildTime, ...nativeChildList } = await Akumas.of(root).list({
    caller: { kind: "akuma", world: root, akumaId: direct.id },
  });
  assert.deepEqual(childList, nativeChildList);

  const shorthand = await cliJson<AkumaList>(["-C", root, "ls", "--mine"], { environment });
  const globbed = await cliJson<AkumaList>(["-C", root, "ls", "aku/*/*", "--mine"], { environment });
  assert.equal(shorthand.exit, 0, shorthand.stderr);
  assert.deepEqual(shorthand.value.rows, globbed.value.rows, "the shorthand and the complete Akuma catalogue agree");
  assert.deepEqual(
    (shorthand.value.rows ?? []).map((row) => row.id),
    [grandchild.id, sibling.id, direct.id],
  );
  assert.deepEqual(
    (shorthand.value.rows ?? []).map((row) => ("parentAkumaId" in row ? row.parentAkumaId : undefined)),
    [direct.id, undefined, undefined],
    "each row names its immediate Akuma parent, never the original caller",
  );
  assert.equal(
    (shorthand.value.rows ?? []).some((row) => row.id === unrelated.id),
    false,
  );

  const text = await runCli(["-C", root, "ls", "aku/*/*", "--mine"], { environment });
  assert.equal(text.exit, 0, text.stderr);
  const descendantLine = text.stdout.split("\n").find((line) => line.includes(grandchild.id));
  assert.ok(descendantLine, "the descendant remains in the filtered catalogue");
  assert.ok(descendantLine.includes(`by ${direct.id}`), "the descendant names its immediate parent");
  const directLine = text.stdout.split("\n").find((line) => line.includes(`${direct.id} ·`));
  assert.equal(directLine?.includes("· by"), false, "a direct child names no calling Akuma");
  assert.doesNotMatch(text.stdout, /dddd0004/u);

  const childListCli = await cliJson<AkumaList>(["-C", root, "ls", "aku/*/*", "--mine"], {
    environment: childEnvironment,
  });
  assert.deepEqual((childListCli.value.rows ?? []).map(row => row.id), [grandchild.id]);
  const childText = await runCli(["-C", root, "ls", "aku/*/*", "--mine"], { environment: childEnvironment });
  assert.equal(childText.exit, 0, childText.stderr);
  assert.match(childText.stdout, /aku\/intern\/dddd0003/u);
  assert.doesNotMatch(childText.stdout, /· by/u);

  for (const [environment, byParent] of [[{ KEIYAKU_EXTERNAL_CALLER: "test:root" }, true], [childEnvironment, false]] as const) {
    const frozenInput = { ...environment };
    const adapter = createKeiyakuMcpServer({ cwd: root, environment: frozenInput, version: "test" });
    Object.assign(frozenInput, { KEIYAKU_ACTOR_ID: unrelated.id, KEIYAKU_ACTOR_WORLD: root });
    const client = new Client({ name: "mine-caller", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), adapter.server.connect(b)]);
    try {
      await client.listTools();
      const response = await client.callTool({ name: "ls", arguments: { selector: "aku/*", mine: true } });
      assert.equal(response.isError, false);
      const text = (response.content as { text: string }[])[0]!.text;
      assert.ok(text.includes(grandchild.id));
      assert.equal(text.includes(`by ${direct.id}`), byParent);
      assert.ok(!text.includes(unrelated.id), "server caller and presentation use the same frozen input");
    } finally {
      await client.close();
      await adapter.close();
    }
  }
});

test("ls caller selection refuses absent identity and non-Akuma catalogues", async (t) => {
  const root = await World.at(temporaryDirectory(t, "keiyaku-cli-caller-refusal-"));
  const facet = Keiyaku.at({ cwd: root, environment: {} });
  await assert.rejects(
    facet.ls({ selector: "aku/*", mine: true }),
    (error: unknown) => error instanceof KeiyakuUsageError && /--mine requires a caller identity/u.test(error.message),
  );
  const missing = await runCli(["-C", root, "ls", "--mine"], { environment: {} });
  assert.equal(missing.exit, 64);
  assert.match(missing.stderr, /--mine requires a caller identity/u);
  for (const [environment, message] of [
    [{ CODEX_THREAD_ID: "codex", PI_SESSION_ID: "pi" }, /Ambiguous native host caller: CODEX_THREAD_ID, PI_SESSION_ID/u],
    [{ KEIYAKU_ACTOR_ID: "aku/parent/1234abcd" }, /requires both KEIYAKU_ACTOR_ID and KEIYAKU_ACTOR_WORLD/u],
  ] as const) {
    const ambiguous = await runCli(["-C", root, "ls", "--mine"], { environment });
    assert.equal(ambiguous.exit, 64);
    assert.match(ambiguous.stderr, message);
  }
  for (const argv of [
    ["ls", "aku/*/*", "--caller", "test:root"],
    ["ls", "aku/", "--mine"],
    ["ls", "kei", "--mine"],
    ["ls", "debt", "--mine"],
  ]) {
    assert.throws(() => parseArgv(argv), CliUsageError, argv.join(" "));
  }
});
