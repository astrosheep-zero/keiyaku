import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { classifyVerb, type VerbName } from "../src/library/keiyaku-verbs.js";
import { createKeiyakuMcpServer } from "../src/mcp/adapter.js";
import { modelCoordinates, modelInputSchema as mcpInputSchema, modelJsonSchema, modelOutputSchemas } from "../src/library/model-tools.js";
import { Keiyaku, KeiyakuUsageError } from "../src/library/keiyaku.js";
import { projectFailure } from "../src/library/outcome.js";
import { renderVerb } from "../src/cli/render/verbs.js";
import { DEFAULT_CLI_COLUMNS } from "../src/cli/render/terminal.js";
import { Akuma, Keis, Repo, World } from "../src/index.js";
import { beginTurn, endTurn, finishBodyIfIdle, readSoul } from "../src/akuma/heart/index.js";
import { pathsForAkumaId } from "../src/akuma/identity.js";
import { bornBody, bornLineageAkuma } from "./support/akuma-fixtures.js";
import { installHostAcpFixture } from "./support/acp-host-fixture.js";
import {
  cleanupSpawnCapableFixtureForTest,
  installAkumaBodyPidReceipt,
  temporaryDirectory,
} from "./support/process.js";
import { accepted, document, repositoryWithMain } from "./support/library-verbs.js";
import { withGitShim } from "./support/git.js";
import { isolateUserHome } from "./support/user-home.js";

isolateUserHome();

async function mcpFixture(t: TestContext, options: Parameters<typeof createKeiyakuMcpServer>[0]) {
  const adapter = createKeiyakuMcpServer(options);
  const client = new Client({ name: "test", version: "1" });
  t.after(async () => {
    try { await client.close(); }
    finally { await adapter.close(); }
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), adapter.server.connect(b)]);
  const { tools } = await client.listTools();
  return { client, tools };
}

test("coordinate composition preserves flat refinements and rejects collisions at construction", () => {
  const schema = mcpInputSchema(Keiyaku.verbs.bind.input);
  assert.equal(schema.safeParse({ cwd: "/invocation", repo: "/contract", terms: "terms" }).success, true);
  assert.equal(schema.safeParse({ repo: "/contract", forkOf: "kei/source" }).success, true);
  assert.equal(schema.safeParse({ terms: "terms", forkOf: "kei/source" }).success, false);
  assert.equal(schema.safeParse({ input: { terms: "terms" } }).success, false);
  assert.equal(schema.safeParse({ forkOf: "kei/source", extra: true }).success, false);
  assert.throws(() => mcpInputSchema(z.strictObject({ repo: z.string() }).readonly()), /coordinate collides.*repo/u);
  assert.throws(() => mcpInputSchema(z.strictObject({ cwd: z.string() })), /coordinate collides.*cwd/u);
});

test("schema cleanup retains authored property names and values", () => {
  const authored = {
    readOnly: true,
    $schema: "authored",
    nested: { readOnly: false },
    properties: { readOnly: { type: "boolean" }, $schema: { type: "string" } },
    anyOf: [{ const: "a" }, { const: "b" }],
  };
  const schema = modelJsonSchema(z.strictObject({
    readOnly: z.boolean().readonly(),
    payload: z.unknown().meta({ const: authored }),
    defaults: z.unknown().meta({ default: authored }),
  }).readonly());
  assert.deepEqual(schema, {
    type: "object",
    properties: {
      readOnly: { type: "boolean" },
      payload: { const: authored },
      defaults: { default: authored },
    },
    required: ["readOnly", "payload", "defaults"],
    additionalProperties: false,
  });
});

test("flat publication retains authored leaves while native admission owns contradictions", () => {
  for (const name of ["bind", "deliver", "history"] as const) {
    const business = Keiyaku.verbs[name].input.unwrap();
    assert.ok(business instanceof z.ZodObject);
    assert.ok(business.def.catchall instanceof z.ZodNever);
    const published = modelJsonSchema(mcpInputSchema(Keiyaku.verbs[name].input));
    assert.equal(published.type, "object");
    assert.equal(published.anyOf, undefined);
    assert.deepEqual(published.properties, {
      ...modelJsonSchema(business).properties,
      ...modelJsonSchema(modelCoordinates(name)).properties,
    });
  }
  const history = modelJsonSchema(mcpInputSchema(Keiyaku.verbs.history.input));
  const validator = new AjvJsonSchemaValidator().getValidator(JSON.parse(JSON.stringify(history)));
  assert.equal(validator({ selector: "@worker", before: 2, since: 1 }).valid, true);
  assert.equal(Keiyaku.verbs.history.input.safeParse({ selector: "@worker", before: 2, since: 1 }).success, false);
  for (const input of [
    { selector: "@worker", before: 0 },
    { selector: "@worker", since: 1.5 },
    { selector: "@worker", limit: 5001 },
    { selector: "@worker", item: "turn/0" },
  ]) assert.equal(validator(input).valid, false, JSON.stringify(input));
});

test("MCP publishes the one verb table and carries native text and structured answers", async (t) => {
  const cwd = temporaryDirectory(t, "mcp-discovery-");
  const environment = { HOME: cwd, USERPROFILE: cwd, KEIYAKU_HOME: cwd };
  const { client, tools } = await mcpFixture(t, { cwd, environment, version: "test" });
  assert.ok(client.getInstructions());
  assert.equal(client.getInstructions(), client.getServerVersion()?.description);
  const excluded = ["nuke", "settings", "debt.doctor", "debt.addDocument"];
  assert.deepEqual(
    tools.map((tool) => tool.name),
    Object.keys(Keiyaku.verbs).filter((name) => !excluded.includes(name)).map((name) => name.replaceAll(".", "_")),
  );
  const tellWait = tools.find(({ name }) => name === "tell")?.inputSchema.properties?.wait as { anyOf?: unknown } | undefined;
  assert.deepEqual(tellWait?.anyOf, [{ type: "boolean", const: true }, { type: "string" }]);
  const waitFor = tools.find(({ name }) => name === "wait")?.inputSchema.properties?.for as { type?: string } | undefined;
  assert.equal(waitFor?.type, "string");
  await assert.rejects(
    () => client.callTool({ name: "no-such-tool", arguments: {} }),
    (error: unknown) => {
      assert.ok(error instanceof McpError);
      assert.equal(error.code, ErrorCode.InvalidParams);
      return true;
    },
  );
  assert.equal(existsSync(join(cwd, ".keiyaku")), false);
  const deliver = tools.find((tool) => tool.name === "deliver")!;
  assert.equal(deliver.annotations?.readOnlyHint, false);
  assert.equal(deliver.outputSchema, undefined);
  const spawn = tools.find((tool) => tool.name === "spawn")!;
  const properties = spawn.inputSchema.properties as Record<string, { description?: string }>;
  assert.equal(Object.hasOwn(properties, "writableDirectories"), false);
  assert.match(properties.akumaName!.description!, /akumaName to spawn.*ls \{"selector":"aku\/"\}/u);
  assert.match(spawn.description!, /from akumaName/u);
  const missing = await client.callTool({ name: "spawn", arguments: { akumaName: "missing", alias: "lane" } });
  assert.equal(missing.isError, true);
  const content = missing.content as { type: string; text: string }[];
  const text = content.map((block) => block.text).join("\n");
  assert.match(text, /Akuma not found · missing/u);
  assert.ok(text.includes('available  ls {"selector":"aku/"}'));
  assert.doesNotMatch(text, /keiyaku |--/u);
  assert.equal(missing._meta?.["keiyaku/disposition"], "refused");
  assert.equal(missing.structuredContent, undefined);
  const failure = content[1]!;
  assert.equal(failure.type, "text");
  if (failure.type === "text") {
    const projection = JSON.parse(failure.text);
    assert.equal(projection.category, "invalid-input");
    assert.deepEqual(projection.next, { verb: "ls", input: { selector: "aku/" } });
  }

  mkdirSync(join(cwd, "akumas"), { recursive: true });
  writeFileSync(join(cwd, "akumas", "child.md"), "---\nbase: missing\n---\n");
  const baseMissing = await client.callTool({ name: "spawn", arguments: { akumaName: "child" } });
  const baseText = (baseMissing.content as { text: string }[]).map((block) => block.text).join("\n");
  assert.equal(baseMissing._meta?.["keiyaku/disposition"], "refused");
  assert.ok(baseText.includes('available  ls {"selector":"aku/"}'));
  assert.match(baseText, /base chain: child -> missing/u);
  assert.doesNotMatch(baseText, /keiyaku |--/u);

  const native = await Keiyaku.for({ cwd, environment, home: cwd }).run("whoami", {});
  const result = await client.callTool({ name: "whoami", arguments: {} });
  assert.equal(result.structuredContent, undefined);
  assert.deepEqual(result.content, [
    {
      type: "text",
      text: renderVerb(
        "whoami",
        {},
        { kind: "returned", value: native },
        { columns: DEFAULT_CLI_COLUMNS, color: false },
      ),
    },
  ]);
  assert.equal(result.isError, false);
  assert.equal(result._meta?.["keiyaku/disposition"], classifyVerb("whoami", {}, { kind: "returned", value: native }));
  const bad = await client.callTool({ name: "whoami", arguments: { extra: true } });
  assert.equal(bad.isError, true);
  assert.equal(bad._meta?.["keiyaku/disposition"], "usage");
  assert.equal(bad.structuredContent, undefined);
  assert.equal((bad.content as { text: string }[])[0]?.text.split("\n")[0], "usage");
  const failureText = (bad.content as { type: string; text: string }[])[1];
  assert.equal(failureText?.type, "text");
  assert.deepEqual(
    JSON.parse(failureText!.text),
    projectFailure(new KeiyakuUsageError(Keiyaku.verbs.whoami.input.safeParse({ extra: true }).error!.message)),
  );

  const body = [
    ...Array.from({ length: 120 }, (_, index) => `Parent body section ${index + 1}\n\n  exact indentation`),
    "complete parent body tail",
  ].join("\n");
  const added = await client.callTool({ name: "debt_add", arguments: { title: "Fix the roof", body } });
  assert.equal(added.isError, false);
  const addedValue = Keiyaku.verbs["debt.add"].output.parse(added.structuredContent);
  assert.ok(addedValue.kind === "accepted");
  const facet = Keiyaku.for({ cwd, environment, home: cwd });
  const listed = await client.callTool({ name: "ls", arguments: { selector: "debt/" } });
  assert.equal(listed.isError, false);
  assert.deepEqual(listed.structuredContent, JSON.parse(JSON.stringify(await facet.ls({ selector: "debt/" }))));

  const shown = await client.callTool({ name: "show", arguments: { selector: addedValue.id } });
  assert.equal(shown.isError, false);
  assert.equal(shown.structuredContent, undefined);
  const shownText = (shown.content as { type: string; text?: string }[])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  assert.equal(
    shownText,
    renderVerb("show", { selector: addedValue.id }, { kind: "returned", value: await facet.show({ selector: addedValue.id }) }, { columns: DEFAULT_CLI_COLUMNS, color: false }),
  );
  for (const evidence of body.split("\n")) assert.ok(shownText.includes(evidence), evidence);
});

test("real invocation rejects contradictory intent before coordinate I/O or Akuma allocation", async (t) => {
  const cwd = temporaryDirectory(t, "mcp-pre-io-");
  const environment = { HOME: cwd, USERPROFILE: cwd, KEIYAKU_HOME: cwd };
  const facet = Keiyaku.for({ cwd, environment, home: cwd });
  const invalid: readonly (readonly [VerbName, Record<string, unknown>])[] = [
    ["bind", { terms: "terms", forkOf: "kei/source" }],
    ["bind", {}],
    ["bind", { forkOf: "kei/source", after: [] }],
    ["bind", { forkOf: "kei/source", gates: [] }],
    ["bind", { forkOf: "kei/source", debt: "debt/example-12345678" }],
    ["bind", { terms: "terms", actor: "operator" }],
    ["deliver", { dryRun: true, message: "unused" }],
    ["deliver", { dryRun: true, materializeConflict: false }],
    ["deliver", { dryRun: true, overwrite: false }],
    ["deliver", { showDiff: false }],
    ["deliver", { dryRun: false, showDiff: true }],
    ["deliver", { dryRun: true, extra: true }],
    ["amend", { edits: "## Context\nChanged\n", actor: "operator" }],
    ["arc", { body: "# Chapter", actor: "operator" }],
    ["review", { verdict: "satisfied", summary: "ok", actor: "operator" }],
    ["abandon", { actor: "operator" }],
    ["debt.add", { title: "Unwritten", actor: "operator" }],
    ["ls", { selector: "kei/", mine: true }],
    ["ls", { selector: "kei/", mine: false }],
    ["ls", { selector: "aku/", lifecycle: "all" }],
    ["spawn", { akumaName: "worker", writableDirectories: [cwd] }],
    ["spawn", { akumaName: "worker", prompt: "work", wait: "10m" }],
    ["tell", { akuma: "@worker", prompt: "work", wait: "invalid" }],
    ["tell", { akuma: "@worker", prompt: "work", wait: false }],
    ["tell", { akuma: "@worker", prompt: "work", timeout: "0ms" }],
    ["show", {}],
    ["show", { id: "debt/example" }],
    ["show", { ids: ["debt/example"] }],
    ["kill", { akuma: ["@worker"] }],
    ["wait", { selectors: ["kei/example", "aku/worker/12345678"], for: "invalid" }],
    ["wait", { selectors: ["kei/example"], for: 0 }],
    ["history", { selector: "@worker", item: "turn/1", before: 1 }],
    ["history", { selector: "@worker", item: "answer", limit: 1 }],
    ["history", { selector: "@worker", before: 2, since: 1 }],
    ["history", { selector: "@worker", item: "1", since: 2 }],
    ["history", { selector: "kei/example", item: "answer" }],
    ["history", { selector: "kei/example", item: "turn/1" }],
    ["history", { selector: "kei/example", item: "report/1" }],
    ["history", { selector: "@worker", item: "01" }],
    ["history", { selector: "@worker", item: "turn/9007199254740992" }],
    ["history", { selector: "@worker", before: 0 }],
    ["history", { selector: "@worker", since: Number.MAX_SAFE_INTEGER + 1 }],
    ["history", { selector: "@worker", limit: 5001 }],
    ["history", { selector: "@worker", extra: true }],
    ["debt.update", { id: "debt/example" }],
    ["debt.update", { id: "debt/example", state: "paused" }],
    ["debt.add", { title: " \n" }],
    ["region", { contract: "kei/example", paths: ["src/**"] }],
    ["region", { paths: [] }],
    ["whoami", { input: {} }],
    ["kanshi", { extra: true }],
    ["ls", { selector: "aku/", mine: true }],
    ["ls", { selector: "aku/*", caller: "aku/intern/00000001" }],
  ];
  for (const [name, input] of invalid)
    await assert.rejects(facet.run(name, input as never), (error: unknown) => error instanceof KeiyakuUsageError, name);

  const { client } = await mcpFixture(t, { cwd, environment, version: "test" });
  for (const [name, input] of [
    ["bind", { terms: "terms", forkOf: "kei/source" }],
    ["deliver", { dryRun: true, message: "unused" }],
    ["history", { selector: "@worker", extra: true }],
  ] as const) {
    const response = await client.callTool({
      name: name.replaceAll(".", "_"),
      arguments: { cwd: join(cwd, "missing"), repo: join(cwd, "missing-repo"), ...input },
    });
    assert.equal(response.isError, true, `${name}: ${JSON.stringify(response)}`);
    assert.equal(response._meta?.["keiyaku/disposition"], "usage", name);
    assert.equal(response.structuredContent, undefined, name);
    const failure = JSON.parse((response.content as { text: string }[])[1]!.text);
    assert.equal(failure.category, "invalid-input", name);
  }
  const rejectedRepo = await client.callTool({
    name: "report",
    arguments: { cwd: join(cwd, "missing"), repo: "/invalid", text: "unwritten" },
  });
  assert.equal(rejectedRepo._meta?.["keiyaku/disposition"], "usage");
  assert.match(JSON.stringify(rejectedRepo.content), /repo/u);
  // Discovery and the invalid calls in this existing directory leave no marker or allocated child.
  assert.equal(existsSync(join(cwd, ".keiyaku")), false);
  assert.deepEqual(readdirSync(cwd), []);
});

test("MCP carries a mixed-availability incomplete Wait and one terminal owner result", async (t) => {
  const cwd = temporaryDirectory(t, "mcp-wait-mixed-");
  const world = await World.at(cwd);
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
  const running = await bornBody(world, "feed0023", "2026-10-30T00:00:00.000Z");
  t.after(() => running.holder.release());
  const peer = await bornLineageAkuma({ root: world, akumaName: "worker", draw: "feed0024", createdAt: "2026-10-30T00:00:00.000Z" });
  const environment = { HOME: cwd, USERPROFILE: cwd, KEIYAKU_HOME: cwd };
  const { client } = await mcpFixture(t, { cwd, environment, version: "test" });
  const turn = await beginTurn(running.allocated.paths, {
    bodySequence: running.body.sequence,
    startedAt: "2026-10-30T00:00:00.000Z",
  });
  // The peer's frozen Soul stays readable; only its life rows are unavailable,
  // so explicit selection succeeds and the zero-bound observation witnesses both states.
  const peerHeart = new DatabaseSync(peer.paths.heart);
  try {
    peerHeart.exec("DROP TABLE bodies");
  } finally {
    peerHeart.close();
  }
  const mixed = await client.callTool({
    name: "wait",
    arguments: { selectors: [running.allocated.id, peer.id], completion: "all", for: "0ms" },
  });
  assert.equal(mixed.isError, false, JSON.stringify(mixed));
  const value = modelOutputSchemas.wait.parse(mixed.structuredContent);
  assert.deepEqual(value.members.map(({ state }) => state), ["running", "unavailable"]);
  const unavailable = value.members[1]!;
  assert.ok("akuma" in unavailable && unavailable.akuma === peer.id);
  assert.ok("reason" in unavailable && /bodies/u.test(unavailable.reason));
  assert.match(JSON.stringify(mixed.content), /bodies/u);

  await endTurn(running.allocated.paths, {
    turnSequence: turn.sequence,
    completedAt: "2026-10-30T00:00:01.000Z",
    outcome: { kind: "canceled" },
  });
  const finished = await finishBodyIfIdle(running.allocated.paths, {
    sequence: running.body.sequence,
    at: "2026-10-30T00:00:02.000Z",
  });
  assert.equal(finished.kind, "finished");
  running.holder.release();
  const terminal = await client.callTool({
    name: "wait",
    arguments: { selectors: [running.allocated.id], completion: "all", for: "150ms" },
  });
  assert.equal(terminal.isError, true);
  assert.equal(terminal._meta?.["keiyaku/disposition"], "failed");
  assert.equal(terminal.structuredContent, undefined);
  assert.ok(JSON.stringify(terminal.content).includes(`canceled turn/${turn.sequence}`));
});

test("MCP reports a returned partial Spawn, then carries native Tell, Wait, and Ask", async (t) => {
  const root = await World.at(temporaryDirectory(t, "mcp-spawn-ask-"));
  const home = temporaryDirectory(t, "mcp-spawn-ask-home-");
  const environment = { HOME: root, USERPROFILE: root, KEIYAKU_HOME: home };
  installHostAcpFixture(root);
  const agent = join(root, "host-acp.mjs");
  const source = readFileSync(agent, "utf8");
  assert.ok(source.includes('text: "acp-answer"'));
  writeFileSync(agent, source.replace('text: "acp-answer"', `text: ${JSON.stringify('{"ok":true}')}`));
  mkdirSync(join(root, ".keiyaku", "akuma"), { recursive: true });
  const authority = join(root, ".keiyaku", "akuma", "alias.json");
  writeFileSync(authority, "malformed Alias authority\n");
  const pidReceiptPath = join(root, "body-pids");
  const restoreReceipt = installAkumaBodyPidReceipt(pidReceiptPath);
  let operationFailed = true;
  try {
    const { client } = await mcpFixture(t, { cwd: root, environment, version: "test" });
    const reply = await client.callTool({ name: "spawn", arguments: { akumaName: "acp-worker", alias: "lane", bare: true } });
    assert.equal(reply.isError, false);
    assert.equal(reply._meta?.["keiyaku/disposition"], "failed");
    const value = Keiyaku.verbs.spawn.output.parse(reply.structuredContent);
    assert.ok(value.kind === "failed");
    assert.equal(value.requestedAlias, "@lane");
    assert.deepEqual(value.failures.map(({ stage }) => stage), ["alias"]);
    const head = `! ${value.akumaId} born · alias failed · do not respawn`;
    assert.equal((reply.content as { text: string }[])[0]?.text.split("\n")[0], head);
    assert.equal((await readSoul(pathsForAkumaId(root, value.akumaId)))?.id, value.akumaId);

    const told = await client.callTool({ name: "tell", arguments: { akuma: value.akumaId, prompt: "plain input" } });
    assert.equal(told.isError, false, JSON.stringify(told));
    assert.match(JSON.stringify(told.content), new RegExp(`▸ ${value.akumaId} +told`, "u"));
    const waited = await client.callTool({ name: "wait", arguments: { selectors: [value.akumaId], for: "30s" } });
    assert.equal(waited.isError, false, JSON.stringify(waited));
    const member = modelOutputSchemas.wait.parse(waited.structuredContent).members[0];
    assert.ok(member?.state === "done");
    assert.equal(member.akuma, value.akumaId);
    assert.equal(member.answer, '{"ok":true}');

    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
    const result = await client.callTool({
      name: "ask",
      arguments: { akuma: value.akumaId, prompt: "structured", schema, timeout: "30s" },
    });
    assert.equal(result.isError, false);
    const answer = result.structuredContent as { kind: string; answer?: unknown };
    assert.equal(answer.kind, "answered");
    assert.deepEqual(answer.answer, { ok: true });
    assert.equal((await Akuma.select(root, value.akumaId).idle({ timeoutMs: 30_000 })).reason, "completed");
    operationFailed = false;
  } finally {
    try {
      await cleanupSpawnCapableFixtureForTest(t, {
        fixturePath: root,
        pidReceiptPath,
        timeoutMs: 30_000,
        operationFailed,
      });
    } finally {
      restoreReceipt();
    }
  }
});

test("MCP carries a terminal-negative verification and a retryable publication", async (t) => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keis.of(repo).bind({
    terms: document("exit 7"), target: null, gates: ["reviewed"],
  }));
  const worktreePath = bound.worktreePath!;
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  const environment = { HOME: repository.path, USERPROFILE: repository.path, KEIYAKU_HOME: repository.path };
  const facet = Keiyaku.for({ cwd: repository.path, environment, home: repository.path });
  await withGitShim(
    [
      'if [ "$1" = "update-ref" ]; then',
      "  cat >/dev/null",
      '  printf "forced publication failure\\n" >&2',
      "  exit 42",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    async (gitPath) => {
      const { client } = await mcpFixture(t, {
        cwd: repository.path,
        environment: { ...environment, KEIYAKU_GIT_PATH: gitPath },
        version: "test",
      });
      const response = await client.callTool({ name: "verify", arguments: { contract: bound.contractId } });
      assert.equal(response.isError, false);
      assert.equal(response._meta?.["keiyaku/disposition"], "unsatisfied");
      const value = modelOutputSchemas.verify.parse(response.structuredContent);
      assert.equal(value.kind, "accepted");
      assert.equal(value.checks[0]?.kind, "terminal");
      assert.equal(value.checks[0]?.verdict, "unsatisfied");
      assert.equal(value.checks[0]?.admission, "unrecorded");
      assert.equal(value.placement, undefined);

      const amended = await client.callTool({
        name: "amend",
        arguments: { contract: bound.contractId, edits: document("exit 0") },
      });
      assert.equal(amended._meta?.["keiyaku/disposition"], "retryable");
      assert.equal(amended.isError, true);
      assert.equal(amended.structuredContent, undefined);
      const blocks = amended.content as { type: string; text: string }[];
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0]?.text.split("\n")[0], "retryable");
      assert.doesNotMatch(blocks[0]!.text, /"category"/u);

      rmSync(worktreePath, { recursive: true, force: true });
      mkdirSync(join(repository.path, ".keiyaku", "akuma"), { recursive: true });
      writeFileSync(join(repository.path, ".keiyaku", "akuma", "alias.json"), "unavailable aliases\n");
      const status = await client.callTool({ name: "status", arguments: { selector: bound.contractId } });
      assert.equal(status.isError, false, JSON.stringify(status));
      const native = await facet.status({ selector: bound.contractId });
      assert.deepEqual(status.structuredContent, JSON.parse(JSON.stringify(native)));
      assert.equal(native.kind, "contract");
      if (native.kind === "contract") {
        assert.deepEqual(native.associations?.map((link) => "kind" in link && link.kind === "unavailable" && link.source), ["aliases"]);
        assert.ok(native.associations?.every((link) => "diagnostic" in link && link.diagnostic.length > 0));
        assert.equal(native.workspace.kind, "unavailable");
        if (native.workspace.kind === "unavailable") assert.equal(native.workspace.path, worktreePath);
      }
      assert.match(JSON.stringify(status.content), /association unavailable|aliases unavailable/u);
    },
  );
});
