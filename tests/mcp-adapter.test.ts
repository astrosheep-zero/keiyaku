import assert from "node:assert/strict";
import {
  mkdtempSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { classifyVerb, type VerbInput, type VerbName, type VerbOutput } from "../src/library/keiyaku-verbs.js";
import { createKeiyakuMcpServer } from "../src/mcp/adapter.js";
import { modelCoordinates, modelInputSchema as mcpInputSchema, modelJsonSchema, modelOutputSchemas } from "../src/library/model-tools.js";
import { Keiyaku, KeiyakuUsageError } from "../src/library/keiyaku.js";
import { projectFailure } from "../src/library/outcome.js";
import { renderVerb } from "../src/cli/render/verbs.js";
import { DEFAULT_CLI_COLUMNS } from "../src/cli/render/terminal.js";
import { Akuma, Akumas, Keis, Repo, World } from "../src/index.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { moveAlias } from "../src/alias/index.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import {
  repositoryAt,
  updateGitTree,
  writeBlob,
  writeStateCommit,
  updateRefsAtomically,
} from "../src/git/repository.js";
import { withGitDecodeChannel, withGitReadObservation } from "../src/git/read-observation.js";
import { bornBody, bornDirectAkuma, bornLineageAkuma } from "./support/akuma-fixtures.js";
import { beginTurn, endTurn, finishBodyIfIdle, readSoul } from "../src/akuma/heart/index.js";
import { pathsForAkumaId } from "../src/akuma/identity.js";
import { installHostAcpFixture } from "./support/acp-host-fixture.js";
import {
  cleanupSpawnCapableFixtureForTest,
  installAkumaBodyPidReceipt,
  temporaryDirectory,
} from "./support/process.js";
import { accepted, commitCandidate, document, repositoryWithMain } from "./support/library-verbs.js";
import { withGitShim } from "./support/git.js";
import { cliJson, runCli } from "./support/cli-fixtures.js";
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

test("CLI and the one MCP surveillance tool change the same opaque Owner on one idle Akuma", async (t) => {
  const root = await World.at(temporaryDirectory(t, "mcp-surveil-"));
  const born = await bornLineageAkuma({ root, akumaName: "worker", draw: "1234abcd", createdAt: new Date().toISOString() });
  const alias = parseAkumaAlias("@lane");
  await moveAlias({ world: root, alias, akumaId: born.id });
  const environment = { KEIYAKU_INITIATOR: "opaque:external/owner" };
  const { client, tools } = await mcpFixture(t, { cwd: root, environment, version: "test" });
  const tool = tools.find(({ name }) => name === "surveil");
  assert.deepEqual(Object.keys(tool?.inputSchema.properties ?? {}).sort(), ["akuma", "cwd", "off"]);
  assert.equal(tools.some(({ name }) => name === "unsurveil"), false);
  const refused = await runCli(["-C", root, "surveil", born.id], { environment: {} });
  assert.equal(refused.exit, 64, refused.stderr);
  const cli = await cliJson(["-C", root, "surveil", alias], { environment });
  assert.equal(cli.exit, 0, cli.stderr);
  assert.deepEqual(cli.value, { id: born.id, kind: "recorded" });
  const response = await client.callTool({ name: "surveil", arguments: { akuma: born.id, off: true } });
  assert.deepEqual(response.structuredContent, { id: born.id, kind: "recorded" });
  const empty = await client.callTool({ name: "status", arguments: { selector: born.id } });
  const observation = Keiyaku.verbs.status.normal.parse(empty.structuredContent);
  assert.equal(observation.kind, "akuma");
  assert.deepEqual(observation.surveillants, { kind: "known", owners: [] });
});

test("MCP spawn uses akumaName, accepts a bare alias, and points a missing name to ls", async (t) => {
  const cwd = temporaryDirectory(t, "mcp-akuma-name-");
  const environment = { HOME: cwd, USERPROFILE: cwd, KEIYAKU_HOME: cwd };
  const { client, tools } = await mcpFixture(t, { cwd, environment, version: "test" });
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
  const cli = await runCli(["spawn", "child", "go"], { cwd, environment });
  assert.equal(cli.exit, 1);
  assert.match(cli.stdout, /available  keiyaku ls aku\//u);
});

test("MCP and CLI report a real returned partial Spawn without losing the born identity", async (t) => {
  const cwd = await World.at(temporaryDirectory(t, "mcp-partial-spawn-"));
  const environment = { HOME: cwd, USERPROFILE: cwd, KEIYAKU_HOME: cwd };
  installHostAcpFixture(cwd);
  mkdirSync(join(cwd, ".keiyaku", "akuma"), { recursive: true });
  const authority = join(cwd, ".keiyaku", "akuma", "alias.json");
  writeFileSync(authority, "malformed Alias authority\n");
  const pidReceiptPath = join(cwd, "body-pids");
  const restoreReceipt = installAkumaBodyPidReceipt(pidReceiptPath);
  let operationFailed = true;
  try {
    const { client } = await mcpFixture(t, { cwd, environment, version: "test" });
    const reply = await client.callTool({ name: "spawn", arguments: { akumaName: "acp-worker", alias: "lane", bare: true } });
    assert.equal(reply.isError, false);
    assert.equal(reply._meta?.["keiyaku/disposition"], "failed");
    const value = Keiyaku.verbs.spawn.output.parse(reply.structuredContent);
    assert.ok(value.kind === "failed");
    assert.equal(value.requestedAlias, "@lane");
    assert.deepEqual(value.failures.map(({ stage }) => stage), ["alias"]);
    const head = `! ${value.akumaId} born · alias failed · do not respawn`;
    assert.equal((reply.content as { text: string }[])[0]?.text.split("\n")[0], head);
    assert.equal((await readSoul(pathsForAkumaId(cwd, value.akumaId)))?.id, value.akumaId);
    const cli = await runCli(["spawn", "acp-worker", "--bare", "--alias", "lane"], { cwd, environment });
    assert.equal(cli.exit, 3, cli.stderr);
    assert.match(cli.stdout, /^! aku\/acp-worker\/[a-f0-9]{8} born · alias failed · do not respawn\n/u);
    assert.match(cli.stdout, /requested Alias @lane/u);
    assert.match(cli.stdout, /invalid Alias JSON/u);
    assert.equal(readFileSync(authority, "utf8"), "malformed Alias authority\n");
    operationFailed = false;
  } finally {
    try {
      await cleanupSpawnCapableFixtureForTest(t, { fixturePath: cwd, pidReceiptPath, timeoutMs: 30_000, operationFailed });
    } finally { restoreReceipt(); }
  }
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

test("real flat and native calls reject contradictory intent before coordinate I/O or Akuma allocation", async (t) => {
  const cwd = temporaryDirectory(t, "mcp-pre-io-");
  const environment = { HOME: cwd, USERPROFILE: cwd, KEIYAKU_HOME: cwd };
  const { client } = await mcpFixture(t, { cwd, environment, version: "test" });
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
  for (const [name, input] of invalid) {
    const args = { cwd: join(cwd, "missing"), repo: join(cwd, "missing-repo"), ...input };
    const response = await client.callTool({ name: name.replaceAll(".", "_"), arguments: args });
    assert.equal(response.isError, true, `${name}: ${JSON.stringify(response)}`);
    assert.equal(response._meta?.["keiyaku/disposition"], "usage", name);
    assert.equal(response.structuredContent, undefined, name);
    const failure = JSON.parse((response.content as { text: string }[])[1]!.text);
    assert.equal(failure.category, "invalid-input", name);
    await assert.rejects(facet.run(name, input as never), KeiyakuUsageError);
  }
  for (const name of ["debt_add", "debt_update", "report"]) {
    const result = await client.callTool({ name, arguments: { cwd: join(cwd, "missing"), repo: "/invalid", ...(name === "debt_add" ? { title: "unwritten" } : name === "debt_update" ? { id: "debt/example", note: "unwritten" } : { text: "unwritten" }) } });
    assert.equal(result._meta?.["keiyaku/disposition"], "usage");
    assert.match(JSON.stringify(result.content), /repo/u);
  }
  // Discovery and the invalid spawn in this existing directory leave no marker or allocated child.
  assert.equal(existsSync(join(cwd, ".keiyaku")), false);
  assert.deepEqual(readdirSync(cwd), []);
});

test("SDK discovery and real invocation share the verb table and renderer", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "kei-mcp-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
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
  // Client.callTool validates successful structuredContent against tools/list outputSchema.
  const added = await client.callTool({ name: "debt_add", arguments: { title: "Fix the roof" } });
  assert.equal(added.isError, false);
  const facet = Keiyaku.for({ cwd, environment, home: cwd });
  const listed = await client.callTool({ name: "ls", arguments: { selector: "debt/" } });
  assert.equal(listed.isError, false);
  assert.deepEqual(listed.structuredContent, JSON.parse(JSON.stringify(await facet.ls({ selector: "debt/" }))));
  const first = mkdtempSync(join(tmpdir(), "kei-mcp-first-"));
  const second = mkdtempSync(join(tmpdir(), "kei-mcp-second-"));
  t.after(() => {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  });
  const [a, b] = await Promise.all([
    client.callTool({ name: "debt_add", arguments: { cwd: relative(cwd, first), title: "First world" } }),
    client.callTool({ name: "debt_add", arguments: { cwd: second, title: "Second world" } }),
  ]);
  assert.equal(a.isError, false);
  assert.equal(b.isError, false);
  const [listA, listB] = await Promise.all([
    client.callTool({ name: "ls", arguments: { cwd: first, selector: "debt/" } }),
    client.callTool({ name: "ls", arguments: { cwd: second, selector: "debt/" } }),
  ]);
  assert.match(JSON.stringify(listA.structuredContent), /First world/);
  assert.doesNotMatch(JSON.stringify(listA.structuredContent), /Second world/);
  assert.match(JSON.stringify(listB.structuredContent), /Second world/);
  const otherRepo = repositoryWithMain();
  t.after(() => rmSync(otherRepo.path, { recursive: true, force: true }));
  const foreign = await Keiyaku.for({ cwd: otherRepo.path, environment, home: cwd }).run("debt.add", { title: "Foreign repo world" });
  assert.equal(foreign.kind, "accepted");
  const badCoordinate = await client.callTool({ name: "ls", arguments: { cwd: " ", selector: "debt/" } });
  assert.equal(badCoordinate._meta?.["keiyaku/disposition"], "usage");
  const explicitRepo = await client.callTool({
    name: "ls",
    arguments: { cwd: first, repo: otherRepo.path, selector: "debt/" },
  });
  assert.equal(explicitRepo.isError, false);
  assert.deepEqual(explicitRepo.structuredContent, listA.structuredContent);
  assert.doesNotMatch(JSON.stringify(explicitRepo.structuredContent), /Foreign repo world/);

});

test("SDK routing preserves optional observation failures and attention in structured output", async (t) => {
  const repository = repositoryWithMain();
  const world = await World.at(repository.path);
  const environment = { HOME: repository.path, USERPROFILE: repository.path, KEIYAKU_HOME: repository.path };
  const facet = Keiyaku.for({ cwd: repository.path, environment });
  const bound = accepted(await facet.bind({ terms: document(), target: null, gates: ["reviewed"] }));
  const worker = await bornLineageAkuma({ root: world, akumaName: "worker", draw: "a2000031", createdAt: "2026-08-10T00:00:00.000Z" });
  const git = await repositoryAt(repository.path);
  assert.equal((await publishDispatch({ repository: git, akumaId: worker.id, contractId: bound.contractId })).kind, "dispatched");
  const snapshot = await withGitDecodeChannel(git, channel => withGitReadObservation(git, channel, observation => observation.snapshot));
  const dispatchPath = [...snapshot.paths.keys()].find(path => path.startsWith("dispatch/"))!;
  const blob = await writeBlob(git, "unavailable optional authority\n");
  const tree = await updateGitTree(git, snapshot.tree, new Map([[dispatchPath, { oid: blob }], ["settlement/task-holders", { oid: blob }]]));
  const commit = await writeStateCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal((await updateRefsAtomically(git, [{ ref: "refs/heads/keiyaku-state", newOid: commit, expectedOid: snapshot.commit }])).kind, "published");
  mkdirSync(join(world, ".keiyaku", "akuma"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "akuma", "alias.json"), "unavailable aliases\n");
  rmSync(bound.worktreePath!, { recursive: true, force: true });
  const { client } = await mcpFixture(t, { cwd: repository.path, environment, version: "test" });
  for (const id of [bound.contractId, worker.id]) {
    const response = await client.callTool({ name: "status", arguments: { selector: id } });
    assert.equal(response.isError, false, JSON.stringify(response));
    const projected = response.structuredContent as Record<string, unknown>;
    assert.equal(Object.hasOwn(projected, "associations"), id === bound.contractId);
    assert.equal(Object.hasOwn(projected, "contract"), id === worker.id);
    assert.match(JSON.stringify(response.content), /association unavailable/u);
    const native = await facet.status({ selector: id });
    if (native.kind === "contract") {
      assert.deepEqual(native.associations?.map((link) => "kind" in link && link.kind === "unavailable" && link.source), ["holder", "roster", "aliases"]);
      assert.ok(native.associations?.every((link) => "diagnostic" in link && link.diagnostic.length > 0));
      assert.deepEqual(projected.associations, native.associations);
      assert.deepEqual(projected.issue, native.issue);
    } else {
      assert.ok(native.kind === "akuma" && native.contract?.kind === "failed");
    }
  }
  const contracts = await client.callTool({ name: "ls", arguments: { selector: "kei/" } });
  const rows = (contracts.structuredContent as { rows: { id: string; attention: unknown }[] }).rows;
  assert.equal(rows[0]?.id, bound.contractId);
  assert.deepEqual(rows[0]?.attention, [{ kind: "workspace-unavailable", path: bound.worktreePath }]);
  const akumas = await client.callTool({ name: "ls", arguments: { selector: "aku/*", lifecycle: "all" } });
  assert.equal(akumas.isError, false);
  assert.equal(Object.hasOwn(akumas.structuredContent!, "aliasesError"), true);
  assert.deepEqual((akumas.structuredContent as { rows: { contract: unknown }[] }).rows[0]!.contract, { kind: "unavailable" });
  assert.match(JSON.stringify(akumas.content), /aliases unavailable/u);
});

test("MCP show is complete text while native and CLI JSON retain owner detail", async (t) => {
  const repository = repositoryWithMain();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  const environment = { HOME: repository.path, USERPROFILE: repository.path, KEIYAKU_HOME: repository.path };
  const { client } = await mcpFixture(t, { cwd: repository.path, environment, version: "test" });
  const facet = Keiyaku.for({ cwd: repository.path, environment, home: repository.path });
  const body = [
    ...Array.from({ length: 120 }, (_, index) => `Parent body section ${index + 1}\n\n  exact indentation`),
    "complete parent body tail",
  ].join("\n");
  const note = [
    ...Array.from({ length: 120 }, (_, index) => `Parent note section ${index + 1}\n\n  note indentation`),
    "complete parent note tail",
  ].join("\n");
  const prerequisite = accepted(await facet.debtAdd({ title: "Complete prerequisite" })).id;
  const parent = accepted(await facet.debtAdd({ title: "Complete parent", body })).id;
  assert.equal((await facet.debtUpdate({ id: parent, note, needs: [prerequisite] })).kind, "accepted");
  const directText = async (input: VerbInput<"show">): Promise<string> => {
    const response = await client.callTool({ name: "show", arguments: input });
    assert.equal(response.isError, false);
    assert.equal(response.structuredContent, undefined);
    return (response.content as { type: string; text?: string }[]).filter(item => item.type === "text").map(item => item.text).join("\n");
  };
  const nativeDebt = await facet.show({ selector: parent });
  const textDebt = await directText({ selector: parent });
  assert.equal(textDebt, renderVerb("show", { selector: parent }, { kind: "returned", value: nativeDebt }, { columns: DEFAULT_CLI_COLUMNS, color: false }));
  for (const evidence of [...body.split("\n"), ...note.split("\n"), prerequisite])
    assert.ok(textDebt.includes(evidence), evidence);
  const jsonDebt = await runCli(["-C", repository.path, "show", parent, "--json"], { environment });
  assert.equal(jsonDebt.exit, 0, jsonDebt.stderr);
  const scriptDebt = Keiyaku.verbs.show.normal.parse(JSON.parse(jsonDebt.stdout));
  assert.ok(scriptDebt.kind === "debt-complete");
  assert.equal(scriptDebt.items[0]?.body, body);
  assert.equal(scriptDebt.items[0]?.note, note);
  assert.equal(scriptDebt.items[0]?.needs?.[0]?.id, prerequisite);
  const missing = await client.callTool({ name: "show", arguments: { selector: "debt/missing" } });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent, undefined);
  assert.match(JSON.stringify(missing.content), /debt missing/u);

});

test("SDK report records the executing actor and renders its attribution", async (t) => {
  const root = temporaryDirectory(t, "kei-mcp-report-");
  const world = await World.at(root);
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
  const born = await bornBody(world, "feed0022", "2026-10-30T00:00:00.000Z");
  t.after(() => born.holder.release());
  const turn = await beginTurn(born.allocated.paths, {
    bodySequence: born.body.sequence,
    startedAt: "2026-10-30T00:00:00.000Z",
  });
  const { client } = await mcpFixture(t, {
    cwd: root,
    environment: {
      HOME: root, USERPROFILE: root, KEIYAKU_HOME: root,
      KEIYAKU_ACTOR_ID: born.allocated.id, KEIYAKU_ACTOR_WORLD: world,
    },
    version: "test",
  });
  const input = { text: "MCP milestone\n  exact text\n" };
  const result = await client.callTool({ name: "report", arguments: input });
  assert.equal(result.isError, false);
  const id = born.allocated.id;
  const history = await Akuma.select(world, id).history();
  const item = history.rows.at(-1)!;
  const report = await Akumas.of(world).history({ akuma: id, id: `report/${item.id}` });
  assert.ok(report.kind === "akuma-report");
  assert.equal(report.text, input.text);
  const status = await client.callTool({ name: "status", arguments: { selector: id } });
  const native = await Akumas.of(world).status({ akuma: id });
  assert.deepEqual(status.structuredContent, native);
  assert.deepEqual(native.recent, history.rows);
  assert.equal(report.bodySequence, born.body.sequence);
  assert.equal(report.turnSequence, turn.sequence);
  for (const [ref, expected] of [[`report/${report.sequence}`, input.text], [String(report.sequence), `report: ${input.text}`]] as const) {
    const exact = await client.callTool({ name: "history", arguments: { selector: id, item: ref } });
    assert.deepEqual(exact.content, [{ type: "text", text: expected }]);

  }
  assert.deepEqual(result.content, [{
    type: "text",
    text: renderVerb("report", input, {
      kind: "returned", value: { kind: "recorded", reportId: `report/${report.sequence}` },
    }, { columns: DEFAULT_CLI_COLUMNS, color: false, actor: born.allocated.id }),
  }]);
});

test("SDK deliver selects native preview without admitting a candidate", async (t) => {
  const home = temporaryDirectory(t, "kei-mcp-deliver-home-");
  const repository = repositoryWithMain();
  const bound = accepted(await Keis.of(await Repo.at({ path: repository.path })).bind({
    terms: document(), gates: [],
  }));
  assert.ok(bound.worktreePath);
  commitCandidate(repository, bound.worktreePath);
  const environment = { HOME: home, USERPROFILE: home, KEIYAKU_HOME: home };
  const { client, tools } = await mcpFixture(t, { cwd: home, environment, version: "test" });
  const tool = tools.find((entry) => entry.name === "deliver");
  assert.ok(tool);
  assert.equal(tool.annotations?.readOnlyHint, false);
  assert.equal(tool.outputSchema, undefined);
  const input = { contract: bound.contractId, dryRun: true as const, showDiff: true };
  const native = await bound.kei.previewDelivery({ showDiff: true });
  const before = {
    history: await bound.kei.history(),
    refs: repository.run(["for-each-ref", "--format=%(refname) %(objectname)"]),
    status: repository.run(["-C", bound.worktreePath, "status", "--porcelain=v1"]),
  };
  const preview = await client.callTool({ name: "deliver", arguments: { repo: repository.path, ...input } });
  assert.equal(preview.structuredContent, undefined);
  assert.deepEqual(preview.content, [{ type: "text", text: renderVerb("deliver", input,
    { kind: "returned", value: native }, { columns: DEFAULT_CLI_COLUMNS, color: false }) }]);
  assert.equal(preview._meta?.["keiyaku/disposition"], classifyVerb("deliver", input, { kind: "returned", value: native }));
  assert.deepEqual(await bound.kei.history(), before.history);
  assert.equal(repository.run(["for-each-ref", "--format=%(refname) %(objectname)"]), before.refs);
  assert.equal(repository.run(["-C", bound.worktreePath, "status", "--porcelain=v1"]), before.status);
  assert.ok(native.kind === "ready");
});

test("SDK amend reports a returned publication retry as retryable", async (t) => {
  const repository = repositoryWithMain();
  const home = temporaryDirectory(t, "kei-mcp-retry-home-");
  const bound = accepted(await Keis.of(await Repo.at({ path: repository.path })).bind({
    terms: document(), target: null, gates: [],
  }));
  const input = { contract: bound.contractId, edits: document("exit 0") };
  const environment = { HOME: home, USERPROFILE: home, KEIYAKU_HOME: home };
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
      const shimmed = { ...environment, KEIYAKU_GIT_PATH: gitPath };
      const { client } = await mcpFixture(t, { cwd: repository.path, environment: shimmed, version: "test" });
      const response = await client.callTool({ name: "amend", arguments: input });
      assert.equal(response._meta?.["keiyaku/disposition"], "retryable");
      assert.equal(response.isError, true);
      assert.equal(response.structuredContent, undefined);
      const blocks = response.content as { type: string; text: string }[];
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0]?.text.split("\n")[0], "retryable");
      assert.doesNotMatch(blocks[0]!.text, /"category"/u);
    },
  );
});

test("SDK verification returns a terminal-negative check as normal routing evidence", async (t) => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keis.of(repo).bind({
    terms: document("exit 7"), target: null, gates: ["reviewed"],
  }));
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  const environment = { HOME: repository.path, USERPROFILE: repository.path, KEIYAKU_HOME: repository.path };
  const { client } = await mcpFixture(t, { cwd: repository.path, environment, version: "test" });
  const response = await client.callTool({ name: "verify", arguments: { contract: bound.contractId } });
  assert.equal(response.isError, false);
  assert.equal(response._meta?.["keiyaku/disposition"], "unsatisfied");
  const value = modelOutputSchemas.verify.parse(response.structuredContent);
  assert.equal(value.kind, "accepted");
  assert.equal(value.checks[0]?.kind, "terminal");
  assert.equal(value.checks[0]?.verdict, "unsatisfied");
  assert.equal(value.checks[0]?.admission, "unrecorded");
  assert.equal(value.placement, undefined);
});

test("SDK waits distinguish observed failed/canceled work from an unreadable peer", async (t) => {
  const cwd = temporaryDirectory(t, "mcp-wait-outcomes-");
  const world = await World.at(cwd);
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
  const born = await bornBody(world, "feed0023", "2026-10-30T00:00:00.000Z");
  t.after(() => born.holder.release());
  const environment = { HOME: cwd, USERPROFILE: cwd, KEIYAKU_HOME: cwd };
  const { client } = await mcpFixture(t, { cwd, environment, version: "test" });
  for (const outcome of [{ kind: "failed", diagnostic: "native failed Turn" }, { kind: "canceled" }] as const) {
    const turn = await beginTurn(born.allocated.paths, { bodySequence: born.body.sequence, startedAt: "2026-10-30T00:00:00.000Z" });
    await endTurn(born.allocated.paths, { turnSequence: turn.sequence, completedAt: "2026-10-30T00:00:01.000Z", outcome });
    const response = await client.callTool({ name: "wait", arguments: { selectors: [born.allocated.id], for: "0ms" } });
    assert.equal(response.isError, false);
    const member = modelOutputSchemas.wait.parse(response.structuredContent).members[0];
    assert.ok(member?.state === "running" && member.last);
    assert.equal(member.last.state, outcome.kind);
    assert.equal(member.last.turn, `turn/${turn.sequence}`);
  }
  const peer = await bornLineageAkuma({ root: world, akumaName: "worker", draw: "feed0024", createdAt: "2026-10-30T00:00:00.000Z" });
  const prepare = DatabaseSync.prototype.prepare;
  let corrupted = false;
  const witness = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    // Explicit selection proves both Souls first. Fail the peer only when the first native Wait round starts.
    if (!corrupted && sql.includes("FROM bodies ORDER BY sequence DESC LIMIT 1")) {
      writeFileSync(peer.paths.heart, "not a Heart database\n");
      corrupted = true;
    }
    return prepare.call(this, sql);
  });
  const input = { selectors: [born.allocated.id, peer.id], completion: "all" as const, for: "150ms" };
  const incomplete = await client.callTool({ name: "wait", arguments: input }).finally(() => witness.mock.restore());
  assert.ok(corrupted, "native Wait observation reached the first member");
  assert.equal(incomplete.isError, false, JSON.stringify(incomplete));
  const value = modelOutputSchemas.wait.parse(incomplete.structuredContent);
  assert.deepEqual(value.members.map(({ state }) => state), ["running", "unavailable"]);
  assert.match(JSON.stringify(incomplete.content), /not a database/u);
  assert.equal((await finishBodyIfIdle(born.allocated.paths, {
    sequence: born.body.sequence, at: "2026-10-30T00:00:02.000Z",
  })).kind, "finished");
  born.holder.release();
  const response = await client.callTool({ name: "wait", arguments: { ...input, selectors: [born.allocated.id] } });
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent, undefined);
  assert.match(JSON.stringify(response.content), /canceled turn\//u);
});

test("SDK wire Tell acknowledges admission, Wait observes it, and Ask decodes its answer", async (t) => {
  const root = temporaryDirectory(t, "kei-mcp-ask-");
  const home = temporaryDirectory(t, "kei-mcp-ask-home-");
  const world = await World.at(root);
  installHostAcpFixture(world);
  const agent = join(root, "host-acp.mjs");
  const source = readFileSync(agent, "utf8");
  assert.ok(source.includes('text: "acp-answer"'));
  writeFileSync(agent, source.replace('text: "acp-answer"', `text: ${JSON.stringify('{"ok":true}')}`));
  const allocated = await bornDirectAkuma({
    root: world,
    akumaName: "acp-worker",
    draw: "a2000013",
    createdAt: "2026-08-10T00:00:00.000Z",
    provider: {
      name: "fixture-acp",
      kind: "acp",
      executable: process.execPath,
      config: { argvBefore: [agent], argvAfter: [], systemPromptArg: "--system-prompt" },
    },
  });
  allocated.leash.release();
  const receipt = join(root, "body-pids");
  const restore = installAkumaBodyPidReceipt(receipt);
  let operationFailed = true;
  const adapter = createKeiyakuMcpServer({ cwd: root, environment: { KEIYAKU_HOME: home }, version: "test" });
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([adapter.server.connect(serverTransport), client.connect(clientTransport)]);
    await client.listTools();
    const told = await client.callTool({ name: "tell", arguments: { akuma: allocated.id, prompt: "plain input" } });
    assert.equal(told.isError, false, JSON.stringify(told));
    assert.match(JSON.stringify(told.content), new RegExp(`▸ ${allocated.id} +told`, "u"));
    const waited = await client.callTool({ name: "wait", arguments: { selectors: [allocated.id], for: "30s" } });
    assert.equal(waited.isError, false, JSON.stringify(waited));
    const member = modelOutputSchemas.wait.parse(waited.structuredContent).members[0];
    assert.ok(member?.state === "done");
    assert.equal(member.akuma, allocated.id);
    assert.equal(member.answer, '{"ok":true}');

    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
    const result = await client.callTool({
      name: "ask",
      arguments: { akuma: allocated.id, prompt: "structured", schema, timeout: "30s" },
    });
    assert.equal(result.isError, false);
    const answer = result.structuredContent as VerbOutput<"ask">;
    assert.equal(answer.kind, "answered");
    assert.ok(answer.kind === "answered" && "answer" in answer);
    assert.deepEqual(answer.answer, { ok: true });
    assert.equal(result._meta?.["keiyaku/disposition"], classifyVerb("ask", { akuma: allocated.id, prompt: "structured", schema, timeout: "30s" }, { kind: "returned", value: answer }));
    assert.equal((await Akuma.select(world, allocated.id).idle({ timeoutMs: 30_000 })).reason, "completed");
    operationFailed = false;
  } finally {
    await client.close();
    await adapter.close();
    try {
      await cleanupSpawnCapableFixtureForTest(t, {
        fixturePath: root,
        pidReceiptPath: receipt,
        timeoutMs: 30_000,
        operationFailed,
      });
    } finally {
      restore();
    }
  }
});
