import assert from "node:assert/strict";
import {
  chmodSync,
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
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { classifyVerb, type VerbInput, type VerbName, type VerbOutput } from "../src/library/keiyaku-verbs.js";
import { createKeiyakuMcpServer, mcpInputSchema, normalizeMcpSchema } from "../src/mcp/adapter.js";
import { Keiyaku, KeiyakuUsageError } from "../src/library/keiyaku.js";
import { projectFailure } from "../src/library/outcome.js";
import { renderVerb } from "../src/cli/render/verbs.js";
import { DEFAULT_CLI_COLUMNS } from "../src/cli/render/terminal.js";
import { Akuma, Akumas, Keis, Repo, World, Kanshi } from "../src/index.js";
import { publishDispatch } from "../src/dispatch/index.js";
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
import { executeWaitAkuma } from "../src/akuma/akuma-wait.js";
import { installHostAcpFixture } from "./support/acp-host-fixture.js";
import {
  cleanupSpawnCapableFixtureForTest,
  installAkumaBodyPidReceipt,
  temporaryDirectory,
} from "./support/process.js";
import { accepted, commitCandidate, document, present, repositoryWithMain } from "./support/library-verbs.js";
import { runCli } from "./support/cli-fixtures.js";
import { assertWireConformance } from "./support/schema-parity.js";

test("coordinate composition preserves native branches and rejects collisions at construction", () => {
  const schema = mcpInputSchema(Keiyaku.verbs.bind.input);
  assert.equal(schema.safeParse({ cwd: "/invocation", repo: "/contract", markdown: "terms" }).success, true);
  assert.equal(schema.safeParse({ repo: "/contract", forkOf: "kei/source" }).success, true);
  assert.equal(schema.safeParse({ markdown: "terms", forkOf: "kei/source" }).success, false);
  assert.equal(schema.safeParse({ input: { markdown: "terms" } }).success, false);
  assert.equal(schema.safeParse({ forkOf: "kei/source", extra: true }).success, false);
  assert.throws(() => mcpInputSchema(z.union([
    z.strictObject({ markdown: z.string() }).readonly(),
    z.strictObject({ repo: z.string() }).readonly(),
  ])), /coordinate collides.*repo/u);
  assert.throws(() => mcpInputSchema(z.strictObject({ cwd: z.string() })), /coordinate collides.*cwd/u);
});

test("MCP spawn uses akumaName, accepts a bare alias, and points a missing name to ls", async (t) => {
  const cwd = temporaryDirectory(t, "mcp-akuma-name-");
  const environment = { HOME: cwd, USERPROFILE: cwd, KEIYAKU_HOME: cwd };
  const adapter = createKeiyakuMcpServer({ cwd, environment, version: "test" });
  const client = new Client({ name: "akuma-name-surface", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), adapter.server.connect(b)]);
  t.after(async () => { await client.close(); await adapter.close(); });
  const { tools } = await client.listTools();
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

  const adapter = createKeiyakuMcpServer({ cwd, environment, version: "test" });
  const client = new Client({ name: "bad-workdir", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), adapter.server.connect(b)]);
  t.after(async () => { await client.close(); await adapter.close(); });
  const response = await client.callTool({ name: "spawn", arguments: { akumaName: "worker", workdir } });
  assert.equal(response.isError, true);
  assert.equal(response._meta?.["keiyaku/disposition"], "usage");
  const projection = JSON.parse((response.content as { text: string }[])[1]!.text);
  assert.equal(projection.category, "invalid-input");
  assert.equal(projection.diagnostic, diagnostic);
  assert.equal(existsSync(join(cwd, ".keiyaku")), false);
});

test("schema cleanup retains authored property names and values", () => {
  const schema = normalizeMcpSchema(JSON.parse(JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object", readOnly: true,
    properties: {
      readOnly: { type: "boolean", readOnly: true },
      payload: { const: { readOnly: true, $schema: "authored" } },
    },
  })));
  assert.deepEqual(schema, {
    type: "object",
    properties: { readOnly: { type: "boolean" }, payload: { const: { readOnly: true, $schema: "authored" } } },
  });
});

test("input publication keeps shared structure, enum choices, and authored property unions", () => {
  const propertyUnion = { anyOf: [{ type: "string" }, { type: "null" }] };
  const branch = (choice: string, pattern: string, description: string, required: string[]) => ({
    type: "object",
    additionalProperties: false,
    required,
    properties: {
      choice: { type: "string", const: choice, description },
      selectors: { type: "array", minItems: 1, items: { type: "string", pattern } },
      nested: { type: "object", properties: { value: { type: "string", pattern } } },
      parent: propertyUnion,
    },
  });
  assert.deepEqual(normalizeMcpSchema(JSON.parse(JSON.stringify({ anyOf: [
    branch("a", "^a", "", ["choice", "selectors"]),
    branch("b", "^b", "Choose a branch", ["choice"]),
  ] })), true), {
    type: "object",
    additionalProperties: false,
    required: ["choice"],
    properties: {
      choice: { type: "string", enum: ["a", "b"], description: "Choose a branch" },
      selectors: { type: "array", minItems: 1, items: { type: "string" } },
      nested: { type: "object", properties: { value: { type: "string" } } },
      parent: propertyUnion,
    },
  });
});

test("real flat and native calls reject contradictory intent before coordinate I/O or Akuma allocation", async (t) => {
  const cwd = temporaryDirectory(t, "mcp-pre-io-");
  const environment = { HOME: cwd, USERPROFILE: cwd, KEIYAKU_HOME: cwd };
  const adapter = createKeiyakuMcpServer({ cwd, environment, version: "test" });
  const client = new Client({ name: "flat-inputs", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), adapter.server.connect(b)]);
  t.after(async () => { await client.close(); await adapter.close(); });
  await client.listTools();
  const facet = Keiyaku.at({ cwd, environment, home: cwd });
  const invalid: readonly (readonly [VerbName, Record<string, unknown>])[] = [
    ["bind", { markdown: "terms", forkOf: "kei/source" }],
    ["bind", { markdown: "terms", actor: "operator" }],
    ["amend", { markdown: "## Context\nChanged\n", actor: "operator" }],
    ["arc", { markdown: "# Chapter", actor: "operator" }],
    ["review", { verdict: "satisfied", summary: "ok", actor: "operator" }],
    ["abandon", { actor: "operator" }],
    ["debt.add", { title: "Unwritten", actor: "operator" }],
    ["ls", { selector: "kei/", mine: true }],
    ["spawn", { akumaName: "worker", writableDirectories: [cwd] }],
    ["spawn", { akumaName: "worker", wait: "10m" }],
    ["spawn", { akumaName: "worker", prompt: "work", wait: "0.5s" }],
    ["spawn", { akumaName: "worker", prompt: "work", wait: "9007199254740992ms" }],
    ["tell", { akuma: "@worker", prompt: "work", wait: "bad" }],
    ["tell", { akuma: "@worker", prompt: "work", wait: true }],
    ["tell", { akuma: "@worker", prompt: "work", timeoutMs: 0 }],
    ["show", { ids: ["debt/example"] }],
    ["kill", { akuma: ["@worker"] }],
    ["wait", { selectors: ["kei/example", "aku/worker/12345678"] }],
    ["history", { selector: "@worker", id: "turn/1", last: true }],
    ["history", { selector: "@worker", last: true, limit: 1 }],
    ["history", { selector: "@worker", before: 2, since: 1 }],
    ["debt.update", { id: "debt/example" }],
    ["debt.update", { id: "debt/example", state: "paused" }],
    ["debt.add", { title: " \n" }],
    ["amend", { contract: "kei/example" }],
    ["whoami", { input: {} }],
    ["kanshi", { extra: true }],
    ["ls", { selector: "aku/", mine: true }],
    ["ls", { selector: "aku/*", caller: "aku/intern/00000001" }],
  ];
  for (const [name, input] of invalid) {
    const args = { cwd, ...input };
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
  const adapter = createKeiyakuMcpServer({ cwd, environment, version: "test" });
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([adapter.server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await adapter.close();
  });
  const { tools } = await client.listTools();
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
      assert.equal(schema.anyOf, undefined, `${tool.name}.${key}`);
    }
    new AjvJsonSchemaValidator().getValidator(JSON.parse(JSON.stringify(tool.inputSchema)));
    if (schemaTools.has(tool.name)) {
      assert.ok("normal" in entry);
      assert.ok(tool.outputSchema);
      new AjvJsonSchemaValidator().getValidator(JSON.parse(JSON.stringify(tool.outputSchema)));
    } else assert.equal(tool.outputSchema, undefined);
    assert.equal(tool.annotations?.readOnlyHint, entry.effect === "read");
    assert.equal(tool.annotations?.destructiveHint, entry.effect === "destroy");
  }
  for (const [name, key, type] of [["deliver", "dryRun", "boolean"], ["tell", "wait", "string"], ["history", "last", "boolean"], ["show", "id", "string"], ["kill", "akuma", "string"]]) {
    const properties = tools.find((tool) => tool.name === name)!.inputSchema.properties as Record<string, { type?: string }>;
    assert.equal(properties[key!]!.type, type);
  }
  assert.ok(!tools.find(tool => tool.name === "show")!.inputSchema.required?.includes("id"));
  assert.ok(tools.find(tool => tool.name === "kill")!.inputSchema.required?.includes("akuma"));
  for (const name of ["ls", "report", "reconcile"])
    assert.ok(tools.some((tool) => tool.name === name));
  assert.equal(existsSync(join(cwd, ".keiyaku")), false);
  const native = await Keiyaku.at({ cwd, environment, home: cwd }).run("whoami", {});
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
  const added = await client.callTool({ name: "debt_add", arguments: { title: "Fix the roof" } });
  const published = tools.find((tool) => tool.name === "debt_add")?.outputSchema;
  assert.ok(published);
  // Client.callTool validates successful structuredContent against the tools/list outputSchema.
  assert.equal(added.isError, false);
  const id = (added.structuredContent as { kind: "accepted"; id: string }).id;
  assert.match(id, /^debt\/fix-the-roof-[0-9a-f]{4}$/u);
  assert.ok(existsSync(join(cwd, ".keiyaku", "debts", `${id.slice(5)}.md`)));
  const childResult = await client.callTool({
    name: "debt_add", arguments: { title: "Check the repair", needs: [id] },
  });
  assert.equal(childResult.isError, false);
  const child = accepted(Keiyaku.verbs["debt.add"].output.parse(childResult.structuredContent)).id;
  const shown = await client.callTool({ name: "show", arguments: { id: child } });
  assert.equal(shown.isError, false);
  assert.equal(shown.structuredContent, undefined);
  assert.ok(JSON.stringify(shown.content).includes(`needs ${id}`));
  const list = await client.callTool({ name: "ls", arguments: { selector: "debt/" } });
  assert.equal(list.isError, false);
  assert.match(JSON.stringify(list.structuredContent), /Fix the roof/);

  const done = await client.callTool({
    name: "debt_update",
    arguments: { id, state: "done", note: "finished", body: "repair notes" },
  });
  assert.equal(done.isError, false);
  assert.equal(done.structuredContent, undefined);
  const completed = await Keiyaku.at({ cwd, environment, home: cwd }).run("show", { id });
  assert.ok(completed.kind === "debt-complete" && completed.items[0]?.kind === "found");
  assert.equal(completed.items[0].state, "done");
  assert.equal(completed.items[0].note, "finished");
  assert.equal(completed.items[0].body, "repair notes");
  const unblocked = await client.callTool({ name: "ls", arguments: { selector: "debt/" } });
  assert.equal(unblocked.isError, false);
  assert.deepEqual(unblocked.structuredContent, {
    kind: "debt-catalogue", rows: [{ id: child, title: "Check the repair", priority: 2, disposition: "ready" }],
  });
  const reopened = await client.callTool({
    name: "debt_update",
    arguments: { id, state: "open", body: "", note: "", needs: [] },
  });
  assert.equal(reopened.isError, false);
  assert.equal(reopened.structuredContent, undefined);
  const reopenedDetail = await Keiyaku.at({ cwd, environment, home: cwd }).run("show", { id });
  assert.ok(reopenedDetail.kind === "debt-complete" && reopenedDetail.items[0]?.kind === "found");
  assert.equal(reopenedDetail.items[0].state, "open");
  assert.equal(reopenedDetail.items[0].body, undefined);
  assert.equal(reopenedDetail.items[0].note, undefined);
  assert.equal(reopenedDetail.items[0].needs, undefined);
  const reopenedList = await client.callTool({ name: "ls", arguments: { selector: "debt/" } });
  assert.equal(reopenedList.isError, false);
  assert.deepEqual(reopenedList.structuredContent, {
    kind: "debt-catalogue",
    rows: [
      { id: child, title: "Check the repair", priority: 2, disposition: "blocked" },
      { id, title: "Fix the roof", priority: 2, disposition: "ready" },
    ],
  });
  const malformedDebt = await client.callTool({
    name: "debt_update", arguments: { id: "debt/one/two", note: "unwritten" },
  });
  assert.equal(malformedDebt.isError, true);
  assert.equal(malformedDebt._meta?.["keiyaku/disposition"], "usage");
  assert.deepEqual(
    (await client.callTool({ name: "ls", arguments: { selector: "debt/" } })).structuredContent,
    reopenedList.structuredContent,
  );
  const facet = Keiyaku.at({ cwd, environment, home: cwd });
  await facet.debtAdd({ title: "Low priority", priority: 3 });
  await facet.debtAdd({ title: "High priority", priority: 0 });
  const dropped = accepted(await facet.debtAdd({ title: "Dropped", priority: 1 }));
  assert.equal((await facet.debtUpdate({ id: dropped.id, state: "drop" })).kind, "accepted");
  for (const input of [
    { limit: 1 },
    { selection: "closed", limit: 1 },
    { selection: "all", limit: 1 },
  ] as const) {
    const listed = await client.callTool({ name: "ls", arguments: { selector: "debt/", ...input } });
    assert.equal(listed.isError, false);
    assert.deepEqual(listed.structuredContent, await facet.ls({ selector: "debt/", ...input }));
  }

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
  const foreign = await Keiyaku.at({ cwd: otherRepo.path, environment, home: cwd }).run("debt.add", { title: "Foreign repo world" });
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
  const prerequisite = accepted(await Keis.of(repo).bind({ markdown: document(), target: null, gates: [] }));
  const bound = accepted(await Keis.of(repo).bind({ markdown: document(), target: null, gates: ["reviewed"], after: [prerequisite.contractId] }));
  const cleared = await client.callTool({ name: "amend", arguments: {
    repo: otherRepo.path, contract: bound.contractId, after: [], gates: [],
  } });
  assert.equal(cleared.isError, false, JSON.stringify(cleared));
  const amended = present(await bound.kei.state());
  assert.deepEqual(amended.terms.after, []);
  assert.deepEqual(amended.terms.gates, []);
  const worker = await bornLineageAkuma({ root: world, akumaName: "worker", draw: "a2000014", createdAt: "2026-08-10T00:00:00.000Z" });
  mkdirSync(join(world, ".keiyaku", "akumas"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "akumas", "worker.md"), "---\nprovider: claude\n---\nWorker.\n");
  assert.equal((await publishDispatch({ repository: await repositoryAt(otherRepo.path), akumaId: worker.id, contractId: bound.contractId })).kind, "dispatched");
  const history = await client.callTool({ name: "history", arguments: { cwd: first, selector: worker.id, limit: 1 } });
  assert.equal(history.isError, false, JSON.stringify(history));
  const last = await client.callTool({ name: "history", arguments: { cwd: first, selector: worker.id, last: true } });
  assert.equal(last.isError, false, JSON.stringify(last));
  const catalogue = await Akumas.of(world).list({ repo, limit: 1 });
  assert.deepEqual(catalogue.rows?.[0]?.contract, { kind: "associated", contractId: bound.contractId });
  for (const [name, input, expected] of [
    ["ls", { selector: "kei/", limit: 1 }, await Keis.of(repo).list({ limit: 1 })],
    ["ls", { selector: "aku/*", limit: 1 }, catalogue],
    ["ls", { selector: "aku/" }, await Akumas.akumaNames({ cwd: world, home: cwd })],

    ["status", { id: bound.contractId }, await Kanshi.of({ world, repo }).contract(bound.contractId)],
    ["status", { id: worker.id }, await Akumas.of(world).status({ akuma: worker.id, repo })],
    ["kanshi", {}, await Kanshi.of({ world, repo }).board()],
  ] as const) {
    const response = await client.callTool({ name, arguments: { cwd: first, repo: otherRepo.path, ...input } });
    assert.equal(response.isError, false, name);
    if (schemaTools.has(name)) {
      const stripPanels = (key: string, value: unknown) => ["observedAt", "targetObservation"].includes(key) ? undefined : value;
      assert.deepEqual(
        JSON.parse(JSON.stringify(response.structuredContent, stripPanels)),
        JSON.parse(JSON.stringify(expected, stripPanels)),
        name,
      );
    } else assert.equal(response.structuredContent, undefined);
  }
  const killingFacet = Keiyaku.at({ cwd: first, repo: otherRepo.path, environment, home: cwd });
  const killInput = { akuma: worker.id };
  const nativeKill = await killingFacet.kill(killInput);
  assert.deepEqual(nativeKill.results, [{ id: worker.id, outcome: "already-stopped" }]);
  const directKill = await client.callTool({ name: "kill", arguments: { cwd: first, ...killInput } });
  assert.equal(directKill.isError, false);
  assert.equal((directKill.content as { text: string }[])[0]?.text,
    renderVerb("kill", killInput, { kind: "returned", value: nativeKill }, { columns: DEFAULT_CLI_COLUMNS, color: false }));
  const cliKill = await runCli(["-C", first, "kill", worker.id, "--json"], { environment });
  assert.equal(cliKill.exit, 0, cliKill.stderr);
  assert.deepEqual(JSON.parse(cliKill.stdout), nativeKill);
  const peer = await bornLineageAkuma({ root: world, akumaName: "worker", draw: "a2000015", createdAt: "2026-08-10T00:00:00.000Z" });
  await publishDispatch({ repository: await repositoryAt(otherRepo.path), akumaId: peer.id, contractId: bound.contractId });
  const contractKillInput = { akuma: bound.contractId };
  const expandedKill = await killingFacet.run("kill", contractKillInput);
  assert.deepEqual(expandedKill.results, [worker.id, peer.id].map(id => ({ id, outcome: "already-stopped" })));
  const contractKill = await client.callTool({ name: "kill", arguments: { cwd: first, repo: otherRepo.path, ...contractKillInput } });
  assert.equal(contractKill.isError, false);
  assert.equal((contractKill.content as { text: string }[])[0]?.text,
    renderVerb("kill", contractKillInput, { kind: "returned", value: expandedKill }, { columns: DEFAULT_CLI_COLUMNS, color: false }));
  const missing = await client.callTool({ name: "status", arguments: { repo: otherRepo.path, id: "kei/missing-mcp-status" } });
  assert.equal(missing.structuredContent, undefined);
  assert.equal(missing.isError, true);
  assert.equal((missing.content as { text: string }[])[0]?.text.split("\n")[0], "refused");
  assert.deepEqual(await Keiyaku.at({ cwd, repo: otherRepo.path, environment, home: cwd }).run("status", { id: "kei/missing-mcp-status" }),
    { kind: "contract-missing", id: "kei/missing-mcp-status" });
  assert.equal(missing._meta?.["keiyaku/disposition"], "refused");
  assert.equal(process.cwd(), processCwd);
  assert.deepEqual({ ...process.env }, processEnv);
  otherRepo.run(["update-ref", "refs/heads/keiyaku-state", "HEAD"]);
  const failedStatus = await client.callTool({ name: "status", arguments: { repo: otherRepo.path, id: bound.contractId } });
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

test("SDK routing keeps optional panel failures in text without publishing unavailable wrappers", async (t) => {
  const repository = repositoryWithMain();
  const world = await World.at(repository.path);
  const environment = { HOME: repository.path, USERPROFILE: repository.path, KEIYAKU_HOME: repository.path };
  const facet = Keiyaku.at({ cwd: repository.path, environment });
  const bound = accepted(await facet.bind({ markdown: document(), target: null, gates: ["reviewed"] }));
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
  const adapter = createKeiyakuMcpServer({ cwd: repository.path, environment, version: "test" });
  const client = new Client({ name: "degraded-routing", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), adapter.server.connect(b)]);
  t.after(async () => { await client.close(); await adapter.close(); });
  await client.listTools();
  for (const id of [bound.contractId, worker.id]) {
    const response = await client.callTool({ name: "status", arguments: { id } });
    assert.equal(response.isError, false, JSON.stringify(response));
    const projected = response.structuredContent!;
    assert.equal(Object.hasOwn(projected, "holder"), false);
    assert.equal(Object.hasOwn(projected, "roster"), false);
    assert.equal(Object.hasOwn(projected, "contract"), false);
    assert.match(JSON.stringify(response.content), /association unavailable/u);
    const native = await facet.status({ id });
    if (native.kind === "contract") {
      assert.deepEqual(native.holder, { kind: "unavailable" });
      assert.deepEqual(native.roster, { kind: "unavailable" });
    } else {
      assert.ok(native.kind === "akuma" && native.contract?.kind === "failed");
    }
  }
  const contracts = await client.callTool({ name: "ls", arguments: { selector: "kei/" } });
  const rows = (contracts.structuredContent as { rows: { id: string; hasAttention: true }[] }).rows;
  assert.deepEqual(rows.map(({ id, hasAttention }) => ({ id, hasAttention })), [{ id: bound.contractId, hasAttention: true }]);
  assert.equal(Object.hasOwn(rows[0]!, "attention"), false);
  const akumas = await client.callTool({ name: "ls", arguments: { selector: "aku/*" } });
  assert.equal(akumas.isError, false);
  assert.equal(Object.hasOwn(akumas.structuredContent!, "aliasesError"), false);
  assert.equal(Object.hasOwn((akumas.structuredContent as { rows: object[] }).rows[0]!, "contract"), false);
  assert.match(JSON.stringify(akumas.content), /aliases unavailable/u);
});

test("MCP show is complete text while native and CLI JSON retain owner detail", async (t) => {
  const repository = repositoryWithMain();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  const environment = { HOME: repository.path, USERPROFILE: repository.path, KEIYAKU_HOME: repository.path };
  const adapter = createKeiyakuMcpServer({ cwd: repository.path, environment, version: "test" });
  const client = new Client({ name: "show-consumers", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([adapter.server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close(); await adapter.close(); });
  await client.listTools();
  const facet = Keiyaku.at({ cwd: repository.path, environment, home: repository.path });
  const absentDebt = await client.callTool({ name: "ls", arguments: { cwd: temporaryDirectory(t, "mcp-absent-debt-"), selector: "debt/" } });
  assert.equal(absentDebt.isError, true);
  await World.at(repository.path);
  for (const [selector, kind] of [["kei/", "contract-catalogue"], ["aku/", "akuma-name-catalogue"], ["aku/*", "akuma-catalogue"], ["debt/", "debt-catalogue"]] as const) {
    const response = await client.callTool({ name: "ls", arguments: { selector } });
    assert.equal(response.isError, false);
    assert.equal((response.structuredContent as { kind: string }).kind, kind);
    assert.equal((response.structuredContent as { rows?: unknown }).rows, undefined);
  }
  const bound = accepted(await facet.bind({ markdown: document(), target: null, gates: ["reviewed"] }));
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
  assert.equal(await directText({ id: bound.contractId }), nativeGuidance.guidance);
  const nativeDebt = await facet.show({ id: parent });
  const textDebt = await directText({ id: parent });
  assert.equal(textDebt, renderVerb("show", { id: parent }, { kind: "returned", value: nativeDebt }, { columns: DEFAULT_CLI_COLUMNS, color: false }));
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
  assert.deepEqual(JSON.parse(jsonChild.stdout), await facet.show({ id: child }));
  const textChild = await directText({ id: child });
  assert.ok(textChild.includes(`needs ${parent}`));
  const missing = await client.callTool({ name: "show", arguments: { id: "debt/missing" } });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent, undefined);
  assert.match(JSON.stringify(missing.content), /debt missing/u);
  const contextual = await client.callTool({ name: "show", arguments: { cwd: bound.worktreePath } });
  assert.equal(contextual.isError, false);
  assert.equal(contextual.structuredContent, undefined);
  assert.equal((contextual.content as { text: string }[])[0]?.text, nativeGuidance.guidance);
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
  const adapter = createKeiyakuMcpServer({
    cwd: root,
    environment: {
      HOME: root, USERPROFILE: root, KEIYAKU_HOME: root,
      KEIYAKU_ACTOR_ID: born.allocated.id, KEIYAKU_ACTOR_WORLD: world,
    },
    version: "test",
  });
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([adapter.server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await adapter.close();
  });
  await client.listTools();
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
    const exact = await client.callTool({ name: "history", arguments: { selector: born.allocated.id, id } });
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
    markdown: document(), gates: [],
  }));
  assert.ok(bound.worktreePath);
  commitCandidate(repository, bound.worktreePath);
  const environment = { HOME: home, USERPROFILE: home, KEIYAKU_HOME: home };
  const adapter = createKeiyakuMcpServer({ cwd: home, environment, version: "test" });
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([adapter.server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close(); await adapter.close(); });
  const { tools } = await client.listTools();
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

test("cancelled SDK wait retires without changing its Contract", async (t) => {
  const repository = repositoryWithMain();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(
    await Keis.of(repo).bind({ markdown: document(), target: null, gates: ["reviewed"] }),
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
  const nativeReconcile = await Keiyaku.at({
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
  const guidance = await client.callTool({ name: "show", arguments: { id: before.id } });
  const nativeGuidance = await handle.guidance();
  assert.equal(guidance.structuredContent, undefined);
  assert.equal(guidance.isError, false);
  assert.ok(nativeGuidance.kind === "present");
  assert.equal((guidance.content as { type: string; text: string }[])[0]?.text, nativeGuidance.guidance);
  const bindInput = { markdown: document(), target: null, gates: ["reviewed"] };
  const boundOverMcp = await client.callTool({ name: "bind", arguments: bindInput });
  assert.equal(boundOverMcp.isError, false);
  const wire = accepted(Keiyaku.verbs.bind.output.parse(boundOverMcp.structuredContent));
  assert.equal(Object.hasOwn(wire, "kei"), false);
  const mintedInput = { id: wire.contractId };
  const minted = await client.callTool({ name: "show", arguments: mintedInput });
  assert.equal(minted.isError, false);
  const mintedGuidance = await Keiyaku.at({ cwd: repository.path, environment: {} }).run("show", mintedInput);
  assert.ok(mintedGuidance.kind === "present");
  const missingInput = { id: "kei/missing-mcp-contract" };
  const absent = await client.callTool({ name: "show", arguments: missingInput });
  assert.equal(absent.structuredContent, undefined);
  assert.equal(absent.isError, true);
  assert.equal((absent.content as { text: string }[])[0]?.text.split("\n")[0], "refused");
  assert.deepEqual(await Keiyaku.at({ cwd: repository.path, environment: {} }).run("show", missingInput), { kind: "missing" });
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
    { name: "wait", arguments: { selectors: [before.id], timeoutMs: 0 } },
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
      markdown: document(scenario === "satisfied" ? "exit 0" : "exit 7"), target: null, gates: scenario === "satisfied" ? ["reviewed", "verified"] : ["reviewed"],
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
    const adapter = createKeiyakuMcpServer({ cwd: repository.path, environment, version: "test" });
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([adapter.server.connect(serverTransport), client.connect(clientTransport)]);
    t.after(async () => { await client.close(); await adapter.close(); });
    await client.listTools();
    const input = { contract: bound.contractId };
    const response = await client.callTool({ name: "verify", arguments: input });
    assert.equal(response.isError, infrastructure);
    assert.equal(response._meta?.["keiyaku/disposition"], infrastructure ? "failed" : scenario === "satisfied" ? "accepted" : "unsatisfied");
    if (infrastructure) {
      assert.equal(response.structuredContent, undefined);
      assert.equal((response.content as { text: string }[])[0]?.text.split("\n")[0], "failed");
    } else {
      const value = response.structuredContent as { kind: string; checks: { verdict: string; admission: string; kind?: string }[] };
      assert.equal(value.kind, "accepted");
      assert.equal(value.checks[0]?.kind, undefined);
      assert.equal(value.checks[0]?.verdict, scenario);
      assert.equal(value.checks[0]?.admission, scenario === "satisfied" ? "admitted" : "unrecorded");
    }
    const cli = await runCli(["-C", repository.path, "verify", bound.contractId, "--json"], { environment });
    assert.equal(cli.exit, infrastructure ? 3 : scenario === "satisfied" ? 0 : 4);
    const result = JSON.parse(cli.stdout) as VerbOutput<"verify">;
    assert.ok(result.kind === "accepted");
    assert.equal(result.checks[0]?.kind, infrastructure ? "stopped" : "terminal");
    if (scenario === "satisfied") {
      assert.ok(result.checks[0]?.kind === "terminal");
      assert.equal(result.checks[0].admission, "reused");
    }
    assert.equal(classifyVerb("verify", input, { kind: "returned", value: result }), infrastructure ? "failed" : scenario === "satisfied" ? "accepted" : "unsatisfied");
  });
});

test("SDK waits distinguish observed failed/canceled work from an unreadable peer", async (t) => {
  const cwd = temporaryDirectory(t, "mcp-wait-outcomes-");
  const world = await World.at(cwd);
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
  const born = await bornBody(world, "feed0023", "2026-10-30T00:00:00.000Z");
  t.after(() => born.holder.release());
  const environment = { HOME: cwd, USERPROFILE: cwd, KEIYAKU_HOME: cwd };
  const adapter = createKeiyakuMcpServer({ cwd, environment, version: "test" });
  const client = new Client({ name: "wait-outcomes", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([adapter.server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close(); await adapter.close(); });
  await client.listTools();
  for (const outcome of [{ kind: "failed", diagnostic: "native failed Turn" }, { kind: "canceled" }] as const) {
    const turn = await beginTurn(born.allocated.paths, { bodySequence: born.body.sequence, startedAt: "2026-10-30T00:00:00.000Z" });
    await endTurn(born.allocated.paths, { turnSequence: turn.sequence, completedAt: "2026-10-30T00:00:01.000Z", outcome });
    const response = await client.callTool({ name: "wait", arguments: { selectors: [born.allocated.id], timeoutMs: 0 } });
    assert.equal(response.isError, false);
    const value = Keiyaku.verbs.wait.normal.parse(response.structuredContent);
    assert.ok(value.kind === "akuma" && value.results[0]?.kind === "observed");
    assert.equal(value.results[0].outcome?.kind, outcome.kind);
  }
  const peer = await bornLineageAkuma({ root: world, akumaName: "worker", draw: "feed0024", createdAt: "2026-10-30T00:00:00.000Z" });
  writeFileSync(peer.paths.heart, "not a Heart database\n");
  const input = { selectors: [born.allocated.id, peer.id], completion: "all" as const, timeoutMs: 150 };
  const response = await client.callTool({ name: "wait", arguments: input });
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent, undefined);
  assert.match(JSON.stringify(response.content), /not a database/u);
  const { reason, results } = await executeWaitAkuma({ path: world, ids: [born.allocated.id, peer.id], completion: "all", timeoutMs: 150 });
  const native = { kind: "akuma" as const, reason, results };
  assert.ok(native.results.some(item => item.kind === "unobserved"));
  assertWireConformance(Keiyaku.verbs.wait.normal, native, false);
  assert.deepEqual(Keiyaku.verbs.wait.output.parse(native), native);
});

test("SDK fork consumes the answered Turn coordinate through a real provider process", async (t) => {
  const root = temporaryDirectory(t, "mcp-fork-");
  const home = temporaryDirectory(t, "mcp-fork-home-");
  const world = await World.at(root);
  const answer = " fork source answer\n  exact\n";
  const executable = join(root, "codex.cjs");
  writeFileSync(executable, `#!/usr/bin/env node
const readline = require("node:readline");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", line => {
  const message = JSON.parse(line);
  const reply = result => send({ id: message.id, result });
  if (message.method === "initialize") return reply({});
  if (message.method === "thread/start") return reply({ thread: { id: "source-thread" } });
  if (message.method === "thread/resume") return reply({ thread: { id: message.params.threadId } });
  if (message.method === "thread/fork") return reply({ thread: { id: "child-thread" } });
  if (message.method !== "turn/start") return;
  reply({ turn: { id: "provider-turn" } });
  send({ method: "item/completed", params: { item: { id: "answer", type: "agentMessage", text: ${JSON.stringify(answer)} } } });
  send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: "provider-turn", status: "completed" } } });
});
`);
  chmodSync(executable, 0o755);
  mkdirSync(join(root, ".keiyaku", "akumas"), { recursive: true });
  writeFileSync(join(root, ".keiyaku", "akumas", "worker.md"), "---\nprovider: fixture-codex\n---\nWorker.\n");
  writeFileSync(join(root, ".keiyaku", "settings.json"), JSON.stringify({ providers: { "fixture-codex": { kind: "codex-app-server", executable } }, plugins: {} }));
  const receipt = join(root, "body-pids");
  const restore = installAkumaBodyPidReceipt(receipt);
  const adapter = createKeiyakuMcpServer({ cwd: root, environment: { HOME: home, USERPROFILE: home, KEIYAKU_HOME: home }, version: "test" });
  const client = new Client({ name: "fork-routing", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  let operationFailed = true;
  try {
    await Promise.all([adapter.server.connect(b), client.connect(a)]);
    await client.listTools();
    const spawned = await client.callTool({ name: "spawn", arguments: { akumaName: "worker", prompt: "work", wait: "30s" } });
    assert.equal(spawned.isError, false, JSON.stringify(spawned));
    const source = Keiyaku.verbs.spawn.normal.parse(spawned.structuredContent);
    assert.equal((await Akuma.select(world, source.akumaId).idle({ timeoutMs: 30_000 })).reason, "completed");
    const history = await client.callTool({ name: "history", arguments: { selector: source.akumaId } });
    const page = (history.content as { text: string }[])[0]!.text;
    const coordinate = /✓ (turn\/\d+)/u.exec(page)?.[1];
    assert.ok(coordinate, page);
    for (const selection of [{ id: coordinate }, { last: true }] as const) {
      const exact = await client.callTool({ name: "history", arguments: { selector: source.akumaId, ...selection } });
      assert.deepEqual(exact.content, [{ type: "text", text: answer }]);
      const cli = await runCli(["-C", root, "history", source.akumaId, ...("id" in selection ? ["--id", selection.id] : ["--last"])], {
        environment: { HOME: home, USERPROFILE: home, KEIYAKU_HOME: home },
      });
      assert.equal(cli.exit, 0, cli.stderr);
      assert.equal(cli.stdout, answer);
    }
    const forked = await client.callTool({ name: "fork", arguments: { akuma: source.akumaId, at: coordinate } });
    assert.equal(forked.isError, false, JSON.stringify(forked));
    const child = Keiyaku.verbs.fork.normal.parse(forked.structuredContent);
    assert.deepEqual(forked.structuredContent, { kind: "forked", childAkumaId: child.childAkumaId });
    assert.equal((await Akuma.select(world, child.childAkumaId).idle({ timeoutMs: 30_000 })).reason, "completed");
    operationFailed = false;
  } finally {
    await client.close();
    await adapter.close();
    try {
      await cleanupSpawnCapableFixtureForTest(t, { fixturePath: root, pidReceiptPath: receipt, timeoutMs: 30_000, operationFailed });
    } finally { restore(); }
  }
});

test("SDK wire ask passes JSON Schema and returns identity-decoded answer", async (t) => {
  const root = temporaryDirectory(t, "kei-mcp-ask-");
  const home = temporaryDirectory(t, "kei-mcp-ask-home-");
  const world = await World.at(root);
  installHostAcpFixture(world);
  const agent = join(root, "host-acp.mjs");
  const source = readFileSync(agent, "utf8");
  assert.ok(source.includes('text: "acp-answer"'));
  writeFileSync(agent, source.replace('text: "acp-answer"', `text: text.includes("empty") ? "" : text.includes("null") ? "null" : text.includes("invalid") ? "not-json" : text.includes("scalar") ? "42" : ${JSON.stringify('{"ok":true}')}`));
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
      arguments: { akumaName: "acp-worker", prompt: "structured", bare: true, wait: "30s" },
    });
    assert.equal(spawned.isError, false, JSON.stringify(spawned));
    const child = Keiyaku.verbs.spawn.normal.parse(spawned.structuredContent);
    assert.deepEqual(child.input, { kind: "answered", answer: '{"ok":true}' });
    const waited = await client.callTool({ name: "wait", arguments: { selectors: [child.akumaId], timeoutMs: 30_000 } });
    assert.equal(waited.isError, false);
    const completion = Keiyaku.verbs.wait.normal.parse(waited.structuredContent);
    assert.ok(completion.kind === "akuma" && completion.results[0]?.kind === "observed");
    const told = await client.callTool({
      name: "tell", arguments: { akuma: child.akumaId, prompt: "structured", wait: "30s" },
    });
    assert.equal(told.isError, false, JSON.stringify(told));
    assert.deepEqual(told.content, [{ type: "text", text: '{"ok":true}' }]);
    assert.equal((await Akuma.select(world, child.akumaId).idle({ timeoutMs: 30_000 })).reason, "completed");
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
    const result = await client.callTool({
      name: "ask",
      arguments: { akuma: allocated.id, prompt: "structured", schema, timeoutMs: 30_000 },
    });
    assert.equal(result.isError, false);
    const answer = result.structuredContent as VerbOutput<"ask">;
    assert.equal(answer.kind, "answered");
    assert.ok(answer.kind === "answered" && "answer" in answer);
    assert.deepEqual(answer.answer, { ok: true });
    assert.equal(result._meta?.["keiyaku/disposition"], classifyVerb("ask", { akuma: allocated.id, prompt: "structured", schema, timeoutMs: 30_000 }, { kind: "returned", value: answer }));
    assert.equal((await Akuma.select(world, allocated.id).idle({ timeoutMs: 30_000 })).reason, "completed");
    for (const [prompt, extra, expectedKind, expectedAnswer, expectedText] of [
      ["empty", { schema: { type: "string" } }, "invalid-output", "", undefined],
      ["scalar", { schema: { type: "number" } }, "answered", 42, "42"],
      ["null", { schema: { type: "null" } }, "answered", null, "null"],
      ["invalid", { schema }, "invalid-output", "not-json", undefined],
    ] as const) {
      const input = { akuma: allocated.id, prompt, timeoutMs: 30_000, ...extra };
      const response = await client.callTool({ name: "ask", arguments: input });
      assert.equal((await Akuma.select(world, allocated.id).idle({ timeoutMs: 30_000 })).reason, "completed");
      if (expectedKind === "answered") {
        const value = response.structuredContent as VerbOutput<"ask">;
        assert.equal(value.kind, expectedKind);
        assert.ok(value.kind === "answered");
        assert.equal(value.answer, expectedAnswer);
        assert.equal(typeof value.tellId, "string");
        assert.equal(response._meta?.["keiyaku/disposition"], "accepted");
        assert.equal(response.isError, false);
        assert.deepEqual(response.content, [{ type: "text", text: expectedText }]);
      } else {
        assert.equal(response.structuredContent, undefined);
        assert.equal(response._meta?.["keiyaku/disposition"], "failed");
        assert.equal(response.isError, true);
        assert.equal((response.content as { text: string }[])[0]?.text.split("\n")[0], "failed");
        const history = await Akuma.select(world, allocated.id).history();
        const last = history.rows.findLast((row) => row.kind === "outcome");
        assert.ok(last?.kind === "outcome" && last.outcome.kind === "failed", JSON.stringify(history));
        const said = history.rows.findLast((row) => row.kind === "said");
        assert.ok(said?.kind === "said");
        assert.equal(said.text, expectedAnswer);
      }
    }
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
