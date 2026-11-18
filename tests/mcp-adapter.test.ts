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
import { Akuma, Akumas, Keis, Repo, World, Kanshi } from "../src/index.js";
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
import { beginTurn, endTurn } from "../src/akuma/heart/index.js";
import { installHostAcpFixture } from "./support/acp-host-fixture.js";
import {
  cleanupSpawnCapableFixtureForTest,
  installAkumaBodyPidReceipt,
  temporaryDirectory,
} from "./support/process.js";
import { accepted, commitCandidate, document, present, repositoryWithMain } from "./support/library-verbs.js";
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

test("Contract page addresses open exact historical records through invocation, CLI and MCP", async (t) => {
  const repository = repositoryWithMain();
  const home = temporaryDirectory(t, "history-adapters-home-");
  const facet = Keiyaku.for({ cwd: repository.path, environment: {}, home });
  const bound = accepted(await facet.bind({ terms: document(), target: null }));
  accepted(await bound.kei.amend({ edits: "## Replace: Objective\n\nHistorical amendment.\n" }));
  accepted(await bound.kei.arc({ body: "# Later chapter\n\nA later fact.\n" }));
  const { client } = await mcpFixture(t, { cwd: repository.path, environment: {}, version: "test" });
  const exact = await bound.kei.history({ item: "2" });
  assert.ok(exact.kind === "contract-exact" && exact.event.kind === "amend");
  for (const [selection, args] of [
    [{ before: 3, limit: 1 }, ["--before", "3", "--limit", "1"]],
    [{ item: "2" }, ["--id", "2"]],
    [{ item: "99" }, ["--id", "99"]],
  ] as const) {
    const input = { selector: bound.contractId, ...selection };
    const native = await bound.kei.history(selection);
    assert.deepEqual(await facet.history(input), native);
    const json = await cliJson(["-C", repository.path, "history", bound.contractId, ...args], { environment: {} });
    assert.deepEqual(json.value, native);
    const response = await client.callTool({ name: "history", arguments: input });
    const disposition = classifyVerb("history", input, { kind: "returned", value: native });
    assert.equal(response._meta?.["keiyaku/disposition"], disposition);
    assert.equal(response.isError === true, disposition === "refused");
    const rendered = renderVerb("history", input, { kind: "returned", value: native }, { columns: DEFAULT_CLI_COLUMNS, color: false });
    assert.ok((response.content as { text: string }[])[0]?.text.includes(rendered));
    if (native.kind === "contract-exact") assert.match(rendered, /Historical amendment\./u);
    if (native.kind === "contract") {
      assert.deepEqual(native.events, [exact.event]);
      assert.match(rendered, / 2 amended$/mu);
      assert.doesNotMatch(rendered, /Historical amendment\./u);
    }
  }
});

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

test("MCP ls composes one object with the shared applicability checks", () => {
  const schema = mcpInputSchema(Keiyaku.verbs.ls.input);
  for (const valid of [
    { selector: "kei/" },
    { selector: "debt/", lifecycle: "settled", limit: 1 },
    { selector: "kei/", lifecycle: "all" },
    { selector: "aku/*", lifecycle: "settled", mine: true },
    { selector: "aku/*", mine: false },
  ])
    assert.equal(schema.safeParse(valid).success, true, JSON.stringify(valid));
  for (const invalid of [
    { selector: "aku/", lifecycle: "all" },
    { selector: "kei/", mine: false },
    { selector: "debt/", mine: true },
    { selector: "aku/", mine: true },
    { selector: "aku/*", lifecycle: "closed" },
    { selector: "kei/", extra: true },
  ])
    assert.equal(schema.safeParse(invalid).success, false, JSON.stringify(invalid));
});

test("MCP region composes one optional object with the shared contradiction check", () => {
  const schema = mcpInputSchema(Keiyaku.verbs.region.input);
  for (const valid of [{}, { contract: "kei/example" }, { paths: ["src/**"] }])
    assert.equal(schema.safeParse(valid).success, true, JSON.stringify(valid));
  for (const invalid of [
    { contract: "kei/example", paths: ["src/**"] },
    { paths: [] },
    { extra: true },
  ])
    assert.equal(schema.safeParse(invalid).success, false, JSON.stringify(invalid));
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

test("bad spawn workdir agrees on CLI usage and MCP failure category", async (t) => {
  const cwd = temporaryDirectory(t, "mcp-bad-workdir-");
  const workdir = join(cwd, "missing");
  const diagnostic = `workdir is not an existing directory: ${workdir}`;
  const environment = { HOME: cwd, USERPROFILE: cwd, KEIYAKU_HOME: cwd };
  const cli = await runCli(["spawn", "worker", "--workdir", workdir, "--json"], { cwd, environment });
  assert.equal(cli.exit, 64);
  const failure = JSON.parse(cli.stdout);
  assert.equal(failure.category, "invalid-input");
  assert.equal(failure.diagnostic, diagnostic);

  const { client } = await mcpFixture(t, { cwd, environment, version: "test" });
  const response = await client.callTool({ name: "spawn", arguments: { akumaName: "worker", workdir } });
  assert.equal(response.isError, true);
  assert.equal(response._meta?.["keiyaku/disposition"], "usage");
  const projection = JSON.parse((response.content as { text: string }[])[1]!.text);
  assert.equal(projection.category, "invalid-input");
  assert.equal(projection.diagnostic, diagnostic);
  assert.equal(existsSync(join(cwd, ".keiyaku")), false);
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
    ["tell", { akuma: "@worker", prompt: "work", wait: "10m" }],
    ["tell", { akuma: "@worker", prompt: "work", wait: true }],
    ["tell", { akuma: "@worker", prompt: "work", timeout: "0ms" }],
    ["show", {}],
    ["show", { id: "debt/example" }],
    ["show", { ids: ["debt/example"] }],
    ["kill", { akuma: ["@worker"] }],
    ["wait", { selectors: ["kei/example", "aku/worker/12345678"], timeout: "invalid" }],
    ["wait", { selectors: ["kei/example"], timeout: 0 }],
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
  const schemaTools = new Set([
    "bind", "wait", "status", "ls",
    "verify", "spawn", "fork", "debt_add", "ask",
  ]);
  const publishedProperties = (name: string): readonly string[] =>
    Object.keys((tools.find((tool) => tool.name === name)!.inputSchema.properties ?? {}) as Record<string, unknown>).sort();
  assert.deepEqual(publishedProperties("debt_add"), ["body", "cwd", "needs", "priority", "title"]);
  assert.deepEqual(publishedProperties("debt_update"), [
    "body", "cwd", "id", "needs", "note", "priority", "state", "title",
  ]);
  assert.deepEqual(publishedProperties("ls"), ["cwd", "lifecycle", "limit", "mine", "repo", "selector"]);
  const lsLimit = (tools.find((tool) => tool.name === "ls")!.inputSchema.properties as Record<
    string,
    { type?: string; minimum?: number; maximum?: number }
  >).limit!;
  assert.equal(lsLimit.type, "integer");
  assert.equal(lsLimit.minimum, 1);
  assert.equal(lsLimit.maximum, 500);
  assert.deepEqual(tools.find((tool) => tool.name === "ls")!.inputSchema.required, ["selector"]);
  assert.deepEqual(publishedProperties("region"), ["contract", "cwd", "paths", "repo"]);
  assert.equal(tools.find((tool) => tool.name === "region")!.inputSchema.required, undefined);
  let unknown: McpError | undefined;
  await assert.rejects(
    () => client.callTool({ name: "no-such-tool", arguments: {} }),
    (error: unknown) => {
      assert.ok(error instanceof McpError);
      assert.equal(error.code, ErrorCode.InvalidParams);
      unknown = error;
      return true;
    },
  );
  assert.ok(unknown);
  for (const name of [...excluded.map((name) => name.replaceAll(".", "_")), "debt.add"]) {
    await assert.rejects(
      () => client.callTool({ name, arguments: {} }),
      { name: unknown.name, code: unknown.code, message: unknown.message.replace("no-such-tool", name) },
    );
  }
  for (const tool of tools) {
    const entry = Keiyaku.verbs[tool.name.replaceAll("_", ".") as keyof typeof Keiyaku.verbs];
    assert.equal(tool.description, entry.description);
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    for (const keyword of ["anyOf", "oneOf", "allOf"]) assert.equal(tool.inputSchema[keyword], undefined, tool.name);
    const properties = tool.inputSchema.properties as Record<string, { anyOf?: unknown }>;
    for (const [key, schema] of Object.entries(properties)) {
      if (tool.name === "history" && key === "item") continue;
      assert.equal(schema.anyOf, undefined, `${tool.name}.${key}`);
    }
    assert.equal(JSON.stringify(tool.inputSchema).includes('"$ref"'), false);
    new AjvJsonSchemaValidator().getValidator(JSON.parse(JSON.stringify(tool.inputSchema)));
    if (schemaTools.has(tool.name)) {
      assert.ok("normal" in entry);
      assert.ok(tool.outputSchema);
      new AjvJsonSchemaValidator().getValidator(JSON.parse(JSON.stringify(tool.outputSchema)));
      assert.equal(modelOutputSchemas[tool.name.replaceAll("_", ".") as keyof typeof modelOutputSchemas], entry.normal);
    } else assert.equal(tool.outputSchema, undefined);
    assert.equal(tool.annotations?.readOnlyHint, entry.effect === "read");
    assert.equal(tool.annotations?.destructiveHint, entry.effect === "destroy");
  }
  for (const [name, key, type] of [["deliver", "dryRun", "boolean"], ["wait", "timeout", "string"], ["show", "selector", "string"], ["kill", "akuma", "string"]]) {
    const properties = tools.find((tool) => tool.name === name)!.inputSchema.properties as Record<string, { type?: string }>;
    assert.equal(properties[key!]!.type, type);
  }
  for (const name of ["spawn", "tell"]) {
    const properties = tools.find(tool => tool.name === name)!.inputSchema.properties!;
    assert.equal(Object.hasOwn(properties, "wait"), false);
  }
  assert.deepEqual(tools.find(tool => tool.name === "wait")!.inputSchema.required, ["selectors"]);
  assert.ok(tools.find(tool => tool.name === "show")!.inputSchema.required?.includes("selector"));
  assert.ok(tools.find(tool => tool.name === "kill")!.inputSchema.required?.includes("akuma"));
  assert.ok(tools.find(tool => tool.name === "fork")!.inputSchema.required?.includes("at"));
  const forkOutput = tools.find(tool => tool.name === "fork")!.outputSchema!;
  assert.deepEqual(forkOutput.required, ["kind", "childAkumaId"]);
  assert.deepEqual((forkOutput.properties as Record<string, unknown>).kind, { type: "string", const: "forked" });
  for (const name of ["ls", "report", "reconcile"])
    assert.ok(tools.some((tool) => tool.name === name));
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
  const id = accepted(Keiyaku.verbs["debt.add"].output.parse(added.structuredContent)).id;
  const updated = await client.callTool({ name: "debt_update", arguments: { id, note: "repair notes" } });
  assert.equal(updated.isError, false);
  assert.equal(updated._meta?.["keiyaku/disposition"], "accepted");
  assert.equal(updated.structuredContent, undefined);
  const facet = Keiyaku.for({ cwd, environment, home: cwd });
  const detail = await facet.show({ selector: id });
  assert.ok(detail.kind === "debt-complete" && detail.items[0]?.kind === "found");
  assert.equal(detail.items[0].note, "repair notes");
  const listed = await client.callTool({ name: "ls", arguments: { selector: "debt/" } });
  assert.equal(listed.isError, false);
  assert.deepEqual(listed.structuredContent, JSON.parse(JSON.stringify(await facet.ls({ selector: "debt/" }))));
  const excessive = await client.callTool({ name: "ls", arguments: { selector: "debt/", limit: 501 } });
  assert.equal(excessive.isError, true);
  assert.equal(excessive._meta?.["keiyaku/disposition"], "usage");
  assert.equal(excessive.structuredContent, undefined);

  const first = mkdtempSync(join(tmpdir(), "kei-mcp-first-"));
  const second = mkdtempSync(join(tmpdir(), "kei-mcp-second-"));
  t.after(() => {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  });
  const processCwd = process.cwd();
  const processEnv = { ...process.env };
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
  const world = await World.at(first);
  const repo = await Repo.at({ path: otherRepo.path });
  const prerequisite = accepted(await Keis.of(repo).bind({ terms: document(), target: null, gates: [] }));
  const bound = accepted(await Keis.of(repo).bind({ terms: document(), target: null, gates: ["reviewed"], after: [prerequisite.contractId] }));
  // MCP carries the same empty amendment: no field named means no replacement is synthesized.
  const unchanged = await client.callTool({ name: "amend", arguments: {
    repo: otherRepo.path, contract: bound.contractId,
  } });
  assert.equal(unchanged.isError, false, JSON.stringify(unchanged));
  assert.equal(unchanged._meta?.["keiyaku/disposition"], "accepted");
  const retained = present(await bound.kei.state());
  assert.deepEqual(retained.terms.after, [prerequisite.contractId]);
  assert.deepEqual(retained.terms.gates, ["reviewed"]);
  const worker = await bornLineageAkuma({ root: world, akumaName: "worker", draw: "a2000014", createdAt: "2026-08-10T00:00:00.000Z" });
  mkdirSync(join(world, ".keiyaku", "akumas"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "akumas", "worker.md"), "---\nprovider: claude\n---\nWorker.\n");
  assert.equal((await publishDispatch({ repository: await repositoryAt(otherRepo.path), akumaId: worker.id, contractId: bound.contractId })).kind, "dispatched");
  const last = await client.callTool({ name: "history", arguments: { cwd: first, selector: worker.id, item: "answer" } });
  assert.equal(last.isError, false, JSON.stringify(last));
  await moveAlias({ world, alias: parseAkumaAlias("@mcp-status"), akumaId: worker.id });
  const statusTool = (await client.listTools()).tools.find(tool => tool.name === "status")!;
  const validateStatus = new AjvJsonSchemaValidator().getValidator(JSON.parse(JSON.stringify(statusTool.inputSchema)));
  assert.equal(validateStatus({ selector: "@mcp-status" }).valid, true);
  assert.equal(validateStatus({ id: worker.id }).valid, false);
  const catalogue = await Akumas.of(world).list({ repo, limit: 1, selection: "all" });
  assert.deepEqual(catalogue.rows?.[0]?.contract, { kind: "associated", contractId: bound.contractId });
  for (const [name, input, expected] of [
    ["ls", { selector: "kei/", limit: 1 }, await Keis.of(repo).list({ limit: 1 })],
    ["ls", { selector: "aku/*", limit: 1, lifecycle: "all" }, catalogue],
    ["ls", { selector: "aku/" }, await Akumas.akumaNames({ cwd: world, home: cwd })],

    ["status", { selector: bound.contractId }, await Kanshi.of({ world, repo }).contract(bound.contractId)],
    ["status", { selector: worker.id }, await Akumas.of(world).status({ akuma: worker.id, repo })],
    ["status", { selector: "@mcp-status" }, await Akumas.of(world).status({ akuma: worker.id, repo })],
    ["status", { selector: `@${bound.contractId.slice(4)}` }, await Kanshi.of({ world, repo }).contract(bound.contractId)],
    ["kanshi", {}, await Kanshi.of({ world, repo }).board()],
  ] as const) {
    const response = await client.callTool({ name, arguments: { cwd: first, repo: otherRepo.path, ...input } });
    assert.equal(response.isError, false, name);
    if (schemaTools.has(name)) {
      if (expected.kind === "contract-absent") assert.fail("explicit Repo must observe a Contract family");
      const stripPanels = (key: string, value: unknown) => key === "observedAt" ? undefined : value;
      assert.deepEqual(
        JSON.parse(JSON.stringify(response.structuredContent, stripPanels)),
        JSON.parse(JSON.stringify(expected, stripPanels)),
        name,
      );
    } else assert.equal(response.structuredContent, undefined);
  }
  await moveAlias({ world, alias: parseAkumaAlias(`@${bound.contractId.slice(4)}`), akumaId: worker.id });
  const ambiguousStatus = await client.callTool({ name: "status", arguments: {
    cwd: first, repo: otherRepo.path, selector: `@${bound.contractId.slice(4)}`,
  } });
  assert.equal(ambiguousStatus.isError, true);
  assert.equal(ambiguousStatus._meta?.["keiyaku/disposition"], "usage");
  assert.match(JSON.stringify(ambiguousStatus.content), /ambiguous selector/u);
  const killingFacet = Keiyaku.for({ cwd: first, repo: otherRepo.path, environment, home: cwd });
  const killInput = { akuma: worker.id };
  const nativeKill = await killingFacet.kill(killInput);
  assert.deepEqual(nativeKill.results, [{ id: worker.id, outcome: "already-stopped" }]);
  const directKill = await client.callTool({ name: "kill", arguments: { cwd: first, ...killInput } });
  assert.equal(directKill.isError, false);
  assert.equal((directKill.content as { text: string }[])[0]?.text,
    renderVerb("kill", killInput, { kind: "returned", value: nativeKill }, { columns: DEFAULT_CLI_COLUMNS, color: false }));
  const peer = await bornLineageAkuma({ root: world, akumaName: "worker", draw: "a2000015", createdAt: "2026-08-10T00:00:00.000Z" });
  await publishDispatch({ repository: await repositoryAt(otherRepo.path), akumaId: peer.id, contractId: bound.contractId });
  const contractKillInput = { akuma: bound.contractId };
  const expandedKill = await killingFacet.run("kill", contractKillInput);
  assert.deepEqual(expandedKill.results, [worker.id, peer.id].map(id => ({ id, outcome: "already-stopped" })));
  const contractKill = await client.callTool({ name: "kill", arguments: { cwd: first, repo: otherRepo.path, ...contractKillInput } });
  assert.equal(contractKill.isError, false);
  assert.equal((contractKill.content as { text: string }[])[0]?.text,
    renderVerb("kill", contractKillInput, { kind: "returned", value: expandedKill }, { columns: DEFAULT_CLI_COLUMNS, color: false }));
  const missing = await client.callTool({ name: "status", arguments: { repo: otherRepo.path, selector: "kei/missing-mcp-status" } });
  assert.equal(missing.structuredContent, undefined);
  assert.equal(missing.isError, true);
  assert.equal((missing.content as { text: string }[])[0]?.text.split("\n")[0], "refused");
  assert.deepEqual(await Keiyaku.for({ cwd, repo: otherRepo.path, environment, home: cwd }).run("status", { selector: "kei/missing-mcp-status" }),
    { kind: "contract-missing", id: "kei/missing-mcp-status" });
  assert.equal(missing._meta?.["keiyaku/disposition"], "refused");
  assert.equal(process.cwd(), processCwd);
  assert.deepEqual({ ...process.env }, processEnv);
  otherRepo.run(["update-ref", "refs/heads/keiyaku-state", "HEAD"]);
  const failedStatus = await client.callTool({ name: "status", arguments: { repo: otherRepo.path, selector: bound.contractId } });
  assert.equal(failedStatus.isError, true);
  assert.equal(failedStatus._meta?.["keiyaku/disposition"], "failed");
  assert.equal(failedStatus.structuredContent, undefined);
  const cliFailedStatus = await runCli(["-C", otherRepo.path, "status", bound.contractId, "--json"], { environment });
  assert.equal(cliFailedStatus.exit, 3);
  assert.equal(JSON.parse(cliFailedStatus.stdout).kind, "contract-failed");
  const failedWorld = await client.callTool({ name: "kanshi", arguments: { repo: otherRepo.path } });
  assert.equal(failedWorld.isError, false);
  assert.equal(failedWorld.structuredContent, undefined);
  assert.match(JSON.stringify(failedWorld.content), /unavailable/u);
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
    assert.equal(Object.hasOwn(projected, "holder"), id === bound.contractId);
    assert.equal(Object.hasOwn(projected, "roster"), id === bound.contractId);
    assert.equal(Object.hasOwn(projected, "contract"), id === worker.id);
    assert.match(JSON.stringify(response.content), /association unavailable/u);
    const native = await facet.status({ selector: id });
    if (native.kind === "contract") {
      assert.deepEqual(native.holder, { kind: "unavailable" });
      assert.deepEqual(native.roster, { kind: "unavailable" });
      assert.deepEqual(projected.holder, native.holder);
      assert.deepEqual(projected.roster, native.roster);
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
  const absentDebt = await client.callTool({ name: "ls", arguments: { cwd: temporaryDirectory(t, "mcp-absent-debt-"), selector: "debt/" } });
  assert.equal(absentDebt.isError, true);
  await World.at(repository.path);
  for (const selector of ["kei/", "aku/", "aku/*", "debt/"] as const) {
    const response = await client.callTool({ name: "ls", arguments: { selector } });
    assert.equal(response.isError, false);
    assert.equal((response.structuredContent as { kind: string }).kind, ({ "kei/": "contract-catalogue", "aku/": "akuma-name-catalogue", "aku/*": "akuma-catalogue", "debt/": "debt-catalogue" })[selector]);
    assert.equal((response.structuredContent as { rows?: unknown }).rows, undefined);
  }
  const bound = accepted(await facet.bind({ terms: document(), target: null, gates: ["reviewed"] }));
  const nativeGuidance = await bound.kei.guidance();
  assert.ok(nativeGuidance.kind === "present");
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
  const child = accepted(await facet.debtAdd({ title: "Complete child", needs: [parent] })).id;
  const directText = async (input: VerbInput<"show">): Promise<string> => {
    const response = await client.callTool({ name: "show", arguments: input });
    assert.equal(response.isError, false);
    assert.equal(response.structuredContent, undefined);
    return (response.content as { type: string; text?: string }[]).filter(item => item.type === "text").map(item => item.text).join("\n");
  };
  assert.equal(await directText({ selector: bound.contractId }), nativeGuidance.guidance);
  assert.equal(await directText({ selector: `@${bound.contractId.slice("kei/".length)}` }), nativeGuidance.guidance);
  const nativeDebt = await facet.show({ selector: parent });
  const textDebt = await directText({ selector: parent });
  assert.equal(textDebt, renderVerb("show", { selector: parent }, { kind: "returned", value: nativeDebt }, { columns: DEFAULT_CLI_COLUMNS, color: false }));
  const cliDebt = await runCli(["-C", repository.path, "show", parent], { environment });
  assert.equal(cliDebt.exit, 0);
  assert.equal(cliDebt.stdout.trimEnd(), textDebt.trimEnd());
  for (const evidence of [...body.split("\n"), ...note.split("\n"), prerequisite])
    assert.ok(textDebt.includes(evidence), evidence);
  const jsonDebt = await runCli(["-C", repository.path, "show", parent, "--json"], { environment });
  assert.equal(jsonDebt.exit, 0, jsonDebt.stderr);
  const scriptDebt = Keiyaku.verbs.show.normal.parse(JSON.parse(jsonDebt.stdout));
  assert.ok(scriptDebt.kind === "debt-complete");
  assert.equal(scriptDebt.items[0]?.body, body);
  assert.equal(scriptDebt.items[0]?.note, note);
  assert.equal(scriptDebt.items[0]?.needs?.[0]?.id, prerequisite);
  const jsonChild = await runCli(["-C", repository.path, "show", child, "--json"], { environment });
  assert.equal(jsonChild.exit, 0, jsonChild.stderr);
  assert.deepEqual(JSON.parse(jsonChild.stdout), await facet.show({ selector: child }));
  const textChild = await directText({ selector: child });
  assert.ok(textChild.includes(`needs ${parent}`));
  const missing = await client.callTool({ name: "show", arguments: { selector: "debt/missing" } });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent, undefined);
  assert.match(JSON.stringify(missing.content), /debt missing/u);
  const omitted = await client.callTool({ name: "show", arguments: { cwd: bound.worktreePath } });
  assert.equal(omitted.isError, true);
  assert.equal(omitted._meta?.["keiyaku/disposition"], "usage");
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
  const history = await Akuma.select(world, born.allocated.id).history();
  const report = history.rows.find((row) => row.kind === "report");
  assert.ok(report?.kind === "report");
  assert.equal(report.text, input.text);
  assert.equal(report.bodySequence, born.body.sequence);
  assert.equal(report.turnSequence, turn.sequence);
  for (const [id, expected] of [[`report/${report.sequence}`, input.text], [String(report.sequence), `report: ${input.text}`]] as const) {
    const exact = await client.callTool({ name: "history", arguments: { selector: born.allocated.id, item: id } });
    assert.deepEqual(exact.content, [{ type: "text", text: expected }]);
    const cli = await runCli(["-C", root, "history", born.allocated.id, "--id", id], {
      environment: { HOME: root, USERPROFILE: root, KEIYAKU_HOME: root },
    });
    assert.equal(cli.exit, 0, cli.stderr);
    assert.equal(cli.stdout, expected);
  }
  assert.deepEqual(result.content, [{
    type: "text",
    text: renderVerb("report", input, {
      kind: "returned", value: { kind: "recorded", reportId: `report/${report.sequence}` },
    }, { columns: DEFAULT_CLI_COLUMNS, color: false, actor: born.allocated.id }),
  }]);
});

test("SDK deliver selects native preview or placement with one text-only tool", async (t) => {
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
  const invalid = await client.callTool({ name: "deliver", arguments: {
    cwd: join(home, "missing"), repo: join(home, "missing-repo"),
    dryRun: true, message: "unused",
  } });
  assert.equal(invalid._meta?.["keiyaku/disposition"], "usage");
  assert.deepEqual(await bound.kei.history(), before.history);
  assert.equal(repository.run(["for-each-ref", "--format=%(refname) %(objectname)"]), before.refs);
  assert.equal(repository.run(["-C", bound.worktreePath, "status", "--porcelain=v1"]), before.status);
  writeFileSync(join(bound.worktreePath, "dirty.txt"), "unfinished work\n");
  const dirty = await client.callTool({ name: "deliver", arguments: {
    repo: repository.path, contract: bound.contractId,
  } });
  assert.equal(dirty._meta?.["keiyaku/disposition"], "refused");
  assert.equal(dirty.structuredContent, undefined);
  const dirtyText = (dirty.content as { text: string }[]).map((block) => block.text).join("\n");
  assert.ok(dirtyText.includes('option  deliver {"includeDirty":true}'));
  assert.match(dirtyText, /captures complete non-ignored worktree bytes/u);
  assert.doesNotMatch(dirtyText, /keiyaku |--/u);
  const delivered = await client.callTool({ name: "deliver", arguments: {
    repo: repository.path, contract: bound.contractId, includeDirty: true,
  } });
  assert.equal(delivered.isError, false);
  assert.equal(delivered._meta?.["keiyaku/disposition"], "accepted");
  assert.equal(delivered.structuredContent, undefined);
  assert.ok(native.kind === "ready");
  assert.equal(repository.run(["show", "refs/heads/main:dirty.txt"]).trim(), "unfinished work");
  assert.equal(present(await bound.kei.state()).terminal?.kind, "claimed");
  assert.equal(existsSync(bound.worktreePath), false);
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
      const value = await Keiyaku.for({ cwd: repository.path, environment: shimmed, home }).run("amend", input);
      assert.ok(value.kind === "retry" && value.reason === "publication-failed", JSON.stringify(value));
      assert.match(value.diagnostic, /forced publication failure/u);
      const { client } = await mcpFixture(t, { cwd: repository.path, environment: shimmed, version: "test" });
      const response = await client.callTool({ name: "amend", arguments: input });
      assert.equal(
        response._meta?.["keiyaku/disposition"],
        classifyVerb("amend", input, { kind: "returned", value }),
      );
      assert.equal(response.isError, true);
      assert.equal(response.structuredContent, undefined);
      const blocks = response.content as { type: string; text: string }[];
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0]?.text.split("\n")[0], "retryable");
      assert.doesNotMatch(blocks[0]!.text, /"category"/u);
    },
  );
});

test("cancelled SDK wait retires without changing its Contract", async (t) => {
  const repository = repositoryWithMain();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(
    await Keis.of(repo).bind({ terms: document(), target: null, gates: ["reviewed"] }),
  );
  const handle = bound.kei;
  const before = present(await handle.state());
  const adapter = createKeiyakuMcpServer({
    cwd: repository.path,
    environment: { HOME: repository.path, USERPROFILE: repository.path, KEIYAKU_HOME: repository.path },
    version: "test",
  });
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([adapter.server.connect(serverTransport), client.connect(clientTransport)]);
  await client.listTools();
  const reconcileInput = { contract: before.id };
  const reconciled = await client.callTool({ name: "reconcile", arguments: reconcileInput });
  const nativeReconcile = await Keiyaku.for({
    cwd: repository.path,
    environment: { HOME: repository.path, USERPROFILE: repository.path, KEIYAKU_HOME: repository.path },
    home: repository.path,
  }).run("reconcile", reconcileInput);
  assert.equal(reconciled.isError, false);
  assert.equal(reconciled.structuredContent, undefined);
  assert.deepEqual(reconciled.content, [{
    type: "text",
    text: renderVerb("reconcile", reconcileInput, { kind: "returned", value: nativeReconcile }, {
      columns: DEFAULT_CLI_COLUMNS, color: false,
    }),
  }]);
  const guidance = await client.callTool({ name: "show", arguments: { selector: before.id } });
  const nativeGuidance = await handle.guidance();
  assert.equal(guidance.structuredContent, undefined);
  assert.equal(guidance.isError, false);
  assert.ok(nativeGuidance.kind === "present");
  assert.equal((guidance.content as { type: string; text: string }[])[0]?.text, nativeGuidance.guidance);
  const bindInput = { terms: document(), target: null, gates: ["reviewed"] };
  const boundOverMcp = await client.callTool({ name: "bind", arguments: bindInput });
  assert.equal(boundOverMcp.isError, false);
  assert.equal(Object.hasOwn(boundOverMcp.structuredContent!, "kei"), false);
  const wire = accepted(Keiyaku.verbs.bind.output.parse(boundOverMcp.structuredContent));
  assert.equal(Object.hasOwn(wire, "kei"), false);
  const mintedInput = { selector: wire.contractId };
  const minted = await client.callTool({ name: "show", arguments: mintedInput });
  assert.equal(minted.isError, false);
  const mintedGuidance = await Keiyaku.for({ cwd: repository.path, environment: {} }).run("show", mintedInput);
  assert.ok(mintedGuidance.kind === "present");
  const missingInput = { selector: "kei/missing-mcp-contract" };
  const absent = await client.callTool({ name: "show", arguments: missingInput });
  assert.equal(absent.structuredContent, undefined);
  assert.equal(absent.isError, true);
  assert.equal((absent.content as { text: string }[])[0]?.text.split("\n")[0], "refused");
  assert.deepEqual(await Keiyaku.for({ cwd: repository.path, environment: {} }).run("show", missingInput), { kind: "missing" });
  assert.equal(absent._meta?.["keiyaku/disposition"], classifyVerb("show", missingInput, { kind: "returned", value: { kind: "missing" } }));
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(() =>
    client.callTool({ name: "wait", arguments: { selectors: [before.id] } }, undefined, {
      signal: preAborted.signal,
    }),
  );
  const late = new AbortController();
  const finished = await client.callTool(
    { name: "wait", arguments: { selectors: [before.id], timeout: "0ms" } },
    undefined,
    { signal: late.signal },
  );
  late.abort();
  assert.equal(finished.isError, false);
  const controller = new AbortController();
  const wait = client.callTool({ name: "wait", arguments: { selectors: [before.id] } }, undefined, {
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  controller.abort();
  const settlement = await wait.then(value => ({ value }), error => ({ error }));
  assert.ok("error" in settlement, JSON.stringify(settlement));
  await adapter.close();
  await client.close();
  assert.deepEqual(present(await handle.state()), before);
});

test("verification keeps positive and terminal-negative answers distinct from infrastructure failure", async (t) => {
  for (const scenario of ["satisfied", "unsatisfied", "infrastructure"] as const) await t.test(scenario, async (t) => {
    const infrastructure = scenario === "infrastructure";
    const repository = repositoryWithMain();
    const repo = await Repo.at({ path: repository.path });
    const bound = accepted(await Keis.of(repo).bind({
      terms: document(scenario === "satisfied" ? "exit 0" : "exit 7"), target: null, gates: scenario === "satisfied" ? ["reviewed", "verified"] : ["reviewed"],
    }));
    t.after(async () => {
      await bound.kei.abandon();
      rmSync(repository.path, { recursive: true, force: true });
    });
    if (infrastructure) {
      const settings = join(bound.worktreePath!, ".keiyaku", "settings.json");
      mkdirSync(join(bound.worktreePath!, ".keiyaku"), { recursive: true });
      writeFileSync(settings, JSON.stringify({ worktree: { create: [
        { name: "prepare", argv: [process.execPath, "-e", "process.exit(7)"], timeoutMs: 5_000 },
      ] } }));
      repository.run(["-C", bound.worktreePath!, "add", ".keiyaku/settings.json"]);
      repository.run(["-C", bound.worktreePath!, "commit", "--quiet", "-m", "failing scratch setup"]);
    }
    const environment = { HOME: repository.path, USERPROFILE: repository.path, KEIYAKU_HOME: repository.path };
    const { client } = await mcpFixture(t, { cwd: repository.path, environment, version: "test" });
    const input = { contract: bound.contractId };
    const run = t.mock.method(Keiyaku.prototype, "run");
    const response = await client.callTool({ name: "verify", arguments: input });
    assert.equal(run.mock.callCount(), 1);
    const native = await run.mock.calls[0]!.result;
    assert.equal(response.isError, infrastructure);
    assert.equal(response._meta?.["keiyaku/disposition"], infrastructure ? "failed" : scenario === "satisfied" ? "accepted" : "unsatisfied");
    if (infrastructure) {
      assert.equal(response.structuredContent, undefined);
      assert.equal((response.content as { text: string }[])[0]?.text.split("\n")[0], "failed");
    } else {
      assert.deepEqual(response.structuredContent, JSON.parse(JSON.stringify(native)));
      const value = response.structuredContent as { kind: string; checks: { verdict: string; admission: string; kind?: string }[]; placement?: unknown };
      assert.equal(value.kind, "accepted");
      assert.equal(value.checks[0]?.kind, "terminal");
      assert.equal(value.checks[0]?.verdict, scenario);
      assert.equal(value.checks[0]?.admission, scenario === "satisfied" ? "admitted" : "unrecorded");
      assert.deepEqual(value.placement, scenario === "satisfied" ? { kind: "delivery-missing" } : undefined);
    }
  });
});

test("MCP waits omit timeout for terminal Contracts and idle Akumas", { timeout: 15_000 }, async (t) => {
  const repository = repositoryWithMain();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  const world = await World.at(repository.path);
  const bound = accepted(await Keis.of(await Repo.at({ path: world })).bind({
    terms: document(), target: null, gates: ["reviewed"],
  }));
  accepted(await bound.kei.abandon());
  const worker = await bornLineageAkuma({
    root: world, akumaName: "worker", draw: "feed0025", createdAt: "2026-10-30T00:00:00.000Z",
  });
  const environment = { HOME: world, USERPROFILE: world, KEIYAKU_HOME: world };
  const { client } = await mcpFixture(t, { cwd: world, environment, version: "test" });
  for (const selector of [bound.contractId, worker.id]) {
    const response = await client.callTool({ name: "wait", arguments: { selectors: [selector] } }, undefined, { signal: t.signal });
    assert.equal(response.isError, false, JSON.stringify(response));
    const result = modelOutputSchemas.wait.parse(response.structuredContent);
    assert.equal(result.reason, "completed");
  }
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
    const response = await client.callTool({ name: "wait", arguments: { selectors: [born.allocated.id], timeout: "0ms" } });
    assert.equal(response.isError, false);
    const value = modelOutputSchemas.wait.parse(response.structuredContent);
    const member = value.members[0];
    assert.ok(member?.kind === "akuma" && member.observation.kind === "observed");
    assert.equal(member.observation.outcome?.kind, outcome.kind);
    assert.match(member.observation.outcome?.historyId ?? "", /^turn\/\d+$/u);
  }
  const peer = await bornLineageAkuma({ root: world, akumaName: "worker", draw: "feed0024", createdAt: "2026-10-30T00:00:00.000Z" });
  writeFileSync(peer.paths.heart, "not a Heart database\n");
  const input = { selectors: [born.allocated.id, peer.id], completion: "all" as const, timeout: "150ms" };
  const response = await client.callTool({ name: "wait", arguments: input });
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent, undefined);
  assert.match(JSON.stringify(response.content), /not a database/u);
});

test("SDK wire ask passes JSON Schema and returns identity-decoded answer", async (t) => {
  const root = temporaryDirectory(t, "kei-mcp-ask-");
  const home = temporaryDirectory(t, "kei-mcp-ask-home-");
  const world = await World.at(root);
  installHostAcpFixture(world);
  const agent = join(root, "host-acp.mjs");
  const source = readFileSync(agent, "utf8");
  assert.ok(source.includes('text: "acp-answer"'));
  writeFileSync(agent, source.replace('text: "acp-answer"', `text: text.includes("null") ? "null" : text.includes("scalar") ? "42" : text.includes("invalid") ? "not-json" : ${JSON.stringify('{"ok":true}')}`));
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
    const spawned = await client.callTool({
      name: "spawn",
      arguments: { akumaName: "acp-worker", prompt: "structured", bare: true },
    });
    assert.equal(spawned.isError, false, JSON.stringify(spawned));
    const child = Keiyaku.verbs.spawn.normal.parse(spawned.structuredContent);
    assert.equal(child.action?.kind, "started");
    assert.match(child.action.historyId, /^turn\/[1-9][0-9]*$/u);
    const waited = await client.callTool({ name: "wait", arguments: { selectors: [child.akumaId], timeout: "30s" } });
    assert.equal(waited.isError, false);
    const completion = modelOutputSchemas.wait.parse(waited.structuredContent);
    assert.ok(completion.members[0]?.kind === "akuma" && completion.members[0].observation.kind === "observed");
    const told = await client.callTool({
      name: "tell", arguments: { akuma: child.akumaId, prompt: "structured" },
    });
    assert.equal(told.isError, false, JSON.stringify(told));
    assert.match(JSON.stringify(told.content), /started turn\/[1-9][0-9]*/u);
    const toldWait = await client.callTool({ name: "wait", arguments: { selectors: [child.akumaId], timeout: "30s" } });
    assert.equal(toldWait.isError, false, JSON.stringify(toldWait));
    assert.equal(modelOutputSchemas.wait.parse(toldWait.structuredContent).reason, "completed");
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
    for (const [prompt, type, expected] of [["scalar", "number", 42], ["null", "null", null]] as const) {
      const response = await client.callTool({ name: "ask", arguments: {
        akuma: allocated.id, prompt, schema: { type }, timeout: "30s",
      } });
      assert.equal(response.isError, false);
      assert.equal(response._meta?.["keiyaku/disposition"], "accepted");
      assert.equal((response.structuredContent as { answer: unknown }).answer, expected);
      assert.deepEqual(response.content, [{ type: "text", text: JSON.stringify(expected) }]);
      await Akuma.select(world, allocated.id).idle({ timeoutMs: 30_000 });
    }
    const invalid = await client.callTool({ name: "ask", arguments: {
      akuma: allocated.id, prompt: "invalid", schema, timeout: "30s",
    } });
    assert.equal(invalid.structuredContent, undefined);
    assert.equal(invalid._meta?.["keiyaku/disposition"], "failed");
    assert.equal(invalid.isError, true);
    assert.equal((invalid.content as { text: string }[])[0]?.text.split("\n")[0], "failed");
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
