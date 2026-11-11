import assert from "node:assert/strict";
import { mkdtempSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { classifyVerb, type VerbInput, type VerbName, type VerbOutput } from "../src/library/keiyaku-verbs.js";
import { createKeiyakuMcpServer, mcpInputSchema } from "../src/mcp/adapter.js";
import { Keiyaku, KeiyakuUsageError } from "../src/library/keiyaku.js";
import { projectFailure } from "../src/library/outcome.js";
import { renderVerb } from "../src/cli/render/verbs.js";
import { DEFAULT_CLI_COLUMNS } from "../src/cli/render/terminal.js";
import { Akuma, Akumas, Keis, Repo, World, kanshi, listArchetypeDefinitions } from "../src/index.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { repositoryAt } from "../src/git/repository.js";
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

test("flat discovery preserves strict business branches and rejects coordinate collisions at construction", () => {
  const schema = mcpInputSchema(Keiyaku.verbs.bind.input);
  const validate = new AjvJsonSchemaValidator().getValidator(JSON.parse(JSON.stringify(z.toJSONSchema(schema, { io: "input" }))));
  assert.equal(validate({ cwd: "/invocation", repo: "/contract", markdown: "terms" }).valid, true);
  assert.equal(validate({ repo: "/contract", forkOf: "kei/source" }).valid, true);
  assert.equal(validate({ markdown: "terms", forkOf: "kei/source" }).valid, false);
  assert.equal(validate({ input: { markdown: "terms" } }).valid, false);
  assert.equal(validate({ forkOf: "kei/source", extra: true }).valid, false);
  assert.throws(() => mcpInputSchema(z.union([
    z.strictObject({ markdown: z.string() }).readonly(),
    z.strictObject({ repo: z.string() }).readonly(),
  ])), /coordinate collides.*repo/u);
  assert.throws(() => mcpInputSchema(z.strictObject({ cwd: z.string() })), /coordinate collides.*cwd/u);
});

test("real flat and native calls reject contradictory intent before coordinate I/O or Akuma allocation", async (t) => {
  const cwd = temporaryDirectory(t, "mcp-pre-io-");
  const environment = { HOME: cwd, USERPROFILE: cwd, KEIYAKU_HOME: cwd };
  const adapter = createKeiyakuMcpServer({ cwd, environment, version: "test" });
  const client = new Client({ name: "flat-inputs", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), adapter.server.connect(b)]);
  t.after(async () => { await client.close(); await adapter.close(); });
  const { tools } = await client.listTools();
  const facet = Keiyaku.at({ cwd, environment, home: cwd });
  const invalid: readonly (readonly [VerbName, Record<string, unknown>])[] = [
    ["spawn", { akumaName: "worker", mode: "wait" }],
    ["spawn", { akumaName: "worker", prompt: "work", mode: "detach", timeoutMs: 0 }],
    ["spawn", { akumaName: "worker", prompt: "work", mode: "wait", timeoutMs: 0.5 }],
    ["tell", { akuma: "@worker", prompt: "work", timeoutMs: 0 }],
    ["history", { selector: "@worker", id: "turn/1", last: true }],
    ["history", { selector: "@worker", last: true, limit: 1 }],
    ["history", { selector: "@worker", before: 2, since: 1 }],
    ["debt.update", { id: "debt/example" }],
    ["debt.update", { id: "debt/example", appendBody: "", addNeeds: [] }],
    ["debt.update", { id: "debt/example", body: "replace", appendBody: "append" }],
    ["debt.add", { title: " \n" }],
    ["amend", { contract: "kei/example" }],
    ["whoami", { input: {} }],
    ["kanshi", { extra: true }],
    ["ls", { selector: "aku/", caller: { kind: "mine" } }],
  ];
  for (const [name, input] of invalid) {
    const args = { cwd, ...input };
    const response = await client.callTool({ name: name.replaceAll(".", "_"), arguments: args });
    assert.equal(response.isError, true, `${name}: ${JSON.stringify(response)}`);
    assert.equal(response._meta?.["keiyaku/disposition"], "usage", name);
    assert.equal(response.structuredContent, undefined, name);
    await assert.rejects(facet.run(name, input as never), KeiyakuUsageError);
  }
  // Discovery and the invalid spawn in this existing directory leave no marker or allocated child.
  assert.equal(existsSync(join(cwd, ".keiyaku")), false);
  assert.deepEqual(readdirSync(cwd), []);
  const validateSpawn = new AjvJsonSchemaValidator().getValidator(
    JSON.parse(JSON.stringify(tools.find(tool => tool.name === "spawn")!.inputSchema)),
  );
  assert.equal(validateSpawn({ akumaName: "worker", mode: "wait", prompt: "work", timeoutMs: 0 }).valid, true);
  assert.equal(validateSpawn({ akumaName: "worker", mode: "wait" }).valid, false);
  assert.equal(validateSpawn({ akumaName: "worker", mode: "detach", timeoutMs: 0 }).valid, false);
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
    "bind", "wait", "status", "ls", "show",
    "verify", "spawn", "fork", "debt_add", "ask",
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
    new AjvJsonSchemaValidator().getValidator(JSON.parse(JSON.stringify(tool.inputSchema)));
    if (schemaTools.has(tool.name)) {
      assert.ok("normal" in entry);
      const output = z.toJSONSchema(entry.normal, { io: "input", reused: "ref" });
      assert.deepEqual(tool.outputSchema, { ...output, type: "object" });
      new AjvJsonSchemaValidator().getValidator(JSON.parse(JSON.stringify(tool.outputSchema)));
    } else assert.equal(tool.outputSchema, undefined);
    assert.equal(tool.annotations?.readOnlyHint, entry.effect === "read");
    assert.equal(tool.annotations?.destructiveHint, entry.effect === "destroy");
  }
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
    name: "debt_add", arguments: { title: "Check the repair", parent: id, needs: [id] },
  });
  assert.equal(childResult.isError, false);
  const child = accepted(Keiyaku.verbs["debt.add"].output.parse(childResult.structuredContent)).id;
  const tree = await client.callTool({ name: "show", arguments: { id } });
  assert.equal(tree.isError, false);
  assert.match(JSON.stringify(tree.content), /Check the repair/u);
  const shown = await client.callTool({ name: "show", arguments: { id: child } });
  assert.equal(shown.isError, false);
  const childDetail = Keiyaku.verbs.show.output.parse(shown.structuredContent);
  assert.ok(childDetail.kind === "debt-complete" && childDetail.items[0]?.kind === "found");
  assert.deepEqual(childDetail.items[0].needs, [{ id, state: "open" }]);
  const list = await client.callTool({ name: "ls", arguments: { selector: "debt/" } });
  assert.equal(list.isError, false);
  assert.match(JSON.stringify(list.structuredContent), /Fix the roof/);
  const plural = await client.callTool({ name: "show", arguments: { ids: [id] } });
  assert.deepEqual(plural.structuredContent, JSON.parse(JSON.stringify(
    await Keiyaku.at({ cwd, environment, home: cwd }).run("show", { ids: [id] }),
  )));
  const done = await client.callTool({ name: "debt_update", arguments: { id, state: "done", note: "finished" } });
  assert.equal(done.isError, false);
  assert.equal(done.structuredContent, undefined);
  const completed = await Keiyaku.at({ cwd, environment, home: cwd }).run("show", { id });
  assert.ok(completed.kind === "debt-complete" && completed.items[0]?.kind === "found");
  assert.equal(completed.items[0].state, "done");
  assert.equal(completed.items[0].note, "finished");
  const unblocked = await client.callTool({ name: "ls", arguments: { selector: "debt/" } });
  assert.equal(unblocked.isError, false);
  assert.deepEqual(unblocked.structuredContent, {
    kind: "debt-catalogue", rows: [{ id: child, title: "Check the repair", priority: 2, disposition: "ready" }],
  });
  const malformedDebt = await client.callTool({
    name: "debt_update", arguments: { id: "debt/one/two", note: "unwritten" },
  });
  assert.equal(malformedDebt.isError, true);
  assert.equal(malformedDebt._meta?.["keiyaku/disposition"], "usage");
  assert.deepEqual(
    (await client.callTool({ name: "ls", arguments: { selector: "debt/" } })).structuredContent,
    unblocked.structuredContent,
  );
  const facet = Keiyaku.at({ cwd, environment, home: cwd });
  await facet.debtAdd({ title: "Low priority", priority: 3 });
  await facet.debtAdd({ title: "High priority", priority: 0 });
  await facet.debtAdd({ title: "Dropped", state: "drop", priority: 1 });
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
    ["ls", { selector: "aku/" }, await listArchetypeDefinitions({ project: world, home: cwd })],

    ["status", { id: bound.contractId }, await kanshi({ world, repo, contract: bound.contractId })],
    ["status", { id: worker.id }, await Akumas.of(world).status({ akuma: worker.id, repo })],
    ["kanshi", {}, await kanshi({ world, repo })],
  ] as const) {
    const response = await client.callTool({ name, arguments: { cwd: first, repo: otherRepo.path, ...input } });
    assert.equal(response.isError, false, name);
    if (schemaTools.has(name)) {
      assert.deepEqual(
        JSON.parse(JSON.stringify(response.structuredContent, (key, value: unknown) => key === "observedAt" ? undefined : value)),
        JSON.parse(JSON.stringify(expected, (key, value: unknown) => key === "observedAt" ? undefined : value)),
        name,
      );
    } else assert.equal(response.structuredContent, undefined);
  }
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
  assert.equal(failedStatus.isError, false);
  assert.equal((failedStatus.structuredContent as { kind: string }).kind, "contract-failed");
  const failedWorld = await client.callTool({ name: "kanshi", arguments: { repo: otherRepo.path } });
  assert.equal(failedWorld.isError, false);
  assert.equal(failedWorld.structuredContent, undefined);
  assert.match(JSON.stringify(failedWorld.content), /unavailable/u);
});

test("direct text and codemode consumers each recover complete guidance and Debt decomposition", async (t) => {
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
  for (const [selector, kind] of [["kei/", "contract-catalogue"], ["aku/", "archetype-catalogue"], ["aku/*", "akuma-catalogue"], ["debt/", "debt-catalogue"]] as const) {
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
  const parent = accepted(await facet.debtAdd({ title: "Complete parent", body, note })).id;
  const child = accepted(await facet.debtAdd({ title: "Complete child", parent, needs: [parent] })).id;
  const directText = async (input: VerbInput<"show">): Promise<string> => {
    const response = await client.callTool({ name: "show", arguments: input });
    assert.equal(response.isError, false);
    return (response.content as { type: string; text?: string }[]).filter(item => item.type === "text").map(item => item.text).join("\n");
  };
  const codeResult = async (input: VerbInput<"show">) => {
    const response = await client.callTool({ name: "show", arguments: input });
    assert.equal(response.isError, false);
    return Keiyaku.verbs.show.normal.parse(response.structuredContent);
  };
  // These are separate client projections: each contributes only its chosen representation to its caller.
  assert.equal(await directText({ id: bound.contractId }), nativeGuidance.guidance);
  const scriptGuidance = await codeResult({ id: bound.contractId });
  assert.ok(scriptGuidance.kind === "present");
  assert.equal(scriptGuidance.guidance, nativeGuidance.guidance);
  const nativeDebt = await facet.show({ id: parent });
  const textDebt = await directText({ id: parent });
  assert.equal(textDebt, renderVerb("show", { id: parent }, { kind: "returned", value: nativeDebt }, { columns: DEFAULT_CLI_COLUMNS, color: false }));
  const cliDebt = await runCli(["-C", repository.path, "show", parent], { environment });
  assert.equal(cliDebt.exit, 0);
  assert.equal(cliDebt.stdout.trimEnd(), textDebt.trimEnd());
  for (const evidence of [...body.split("\n"), ...note.split("\n"), child, "Complete child"])
    assert.ok(textDebt.includes(evidence), evidence);
  const scriptDebt = await codeResult({ ids: [parent, child] });
  assert.ok(scriptDebt.kind === "debt-complete");
  assert.equal(scriptDebt.items[0]?.body, body);
  assert.equal(scriptDebt.items[0]?.note, note);
  assert.equal(scriptDebt.items[0]?.children?.[0]?.id, child);
  assert.deepEqual(scriptDebt.items[1]?.parent, { id: parent, state: "open" });
  const partial = await client.callTool({ name: "show", arguments: { ids: [parent, "debt/missing"] } });
  assert.equal(partial.isError, true);
  assert.equal(partial.structuredContent, undefined);
  assert.match(JSON.stringify(partial.content), /Complete parent/u);
  const partialNative = await facet.show({ ids: [parent, "debt/missing"] });
  assert.equal(partialNative.kind, "debt-partial");
  assertWireConformance(Keiyaku.verbs.show.output, partialNative);
  assertWireConformance(Keiyaku.verbs.show.normal, partialNative, false);
  const contextual = await client.callTool({ name: "show", arguments: { cwd: bound.worktreePath } });
  assert.equal(contextual.isError, false);
  assert.deepEqual(contextual.structuredContent, nativeGuidance);
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
  const delivered = await client.callTool({ name: "deliver", arguments: {
    repo: repository.path, contract: bound.contractId,
  } });
  assert.equal(delivered.isError, false);
  assert.equal(delivered._meta?.["keiyaku/disposition"], "accepted");
  assert.equal(delivered.structuredContent, undefined);
  assert.ok(native.kind === "ready");
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), native.integration);
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
  assert.deepEqual(guidance.structuredContent, nativeGuidance);
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

test("red verification answers normally while infrastructure failure is an error", async (t) => {
  for (const infrastructure of [false, true]) await t.test(infrastructure ? "setup failure" : "negative verdict", async (t) => {
    const repository = repositoryWithMain();
    const repo = await Repo.at({ path: repository.path });
    const bound = accepted(await Keis.of(repo).bind({
      markdown: document("exit 7"), target: null, gates: ["reviewed"],
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
    assert.equal(response._meta?.["keiyaku/disposition"], infrastructure ? "failed" : "unsatisfied");
    if (infrastructure) {
      assert.equal(response.structuredContent, undefined);
      assert.equal((response.content as { text: string }[])[0]?.text.split("\n")[0], "failed");
    } else {
      const value = response.structuredContent as VerbOutput<"verify">;
      assert.ok(value.kind === "accepted");
      assert.equal(value.checks[0]?.kind, "terminal");
      assert.ok(value.checks[0]?.kind === "terminal" && value.checks[0].verdict === "unsatisfied");
      assert.equal(value.checks[0].admission, "unrecorded");
    }
    const cli = await runCli(["-C", repository.path, "verify", bound.contractId, "--json"], { environment });
    assert.equal(cli.exit, infrastructure ? 3 : 4);
    const result = JSON.parse(cli.stdout) as VerbOutput<"verify">;
    assert.ok(result.kind === "accepted");
    assert.equal(result.checks[0]?.kind, infrastructure ? "stopped" : "terminal");
    assert.equal(classifyVerb("verify", input, { kind: "returned", value: result }), infrastructure ? "failed" : "unsatisfied");
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

test("SDK wire ask passes JSON Schema and returns identity-decoded answer", async (t) => {
  const root = temporaryDirectory(t, "kei-mcp-ask-");
  const home = temporaryDirectory(t, "kei-mcp-ask-home-");
  const world = await World.at(root);
  installHostAcpFixture(world);
  const agent = join(root, "host-acp.mjs");
  const source = readFileSync(agent, "utf8");
  assert.ok(source.includes('text: "acp-answer"'));
  writeFileSync(agent, source.replace('text: "acp-answer"', `text: text.includes("empty") ? "" : text.includes("null") ? "null" : text.includes("invalid") ? "not-json" : ${JSON.stringify('{"ok":true}')}`));
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
      arguments: { akumaName: "acp-worker", prompt: "structured", bare: true, mode: "wait", timeoutMs: 30_000 },
    });
    assert.equal(spawned.isError, false, JSON.stringify(spawned));
    const child = Keiyaku.verbs.spawn.normal.parse(spawned.structuredContent);
    assert.deepEqual(child.input, { kind: "answered", answer: '{"ok":true}' });
    const waited = await client.callTool({ name: "wait", arguments: { selectors: [child.akumaId], timeoutMs: 30_000 } });
    assert.equal(waited.isError, false);
    const completion = Keiyaku.verbs.wait.normal.parse(waited.structuredContent);
    assert.ok(completion.kind === "akuma" && completion.results[0]?.kind === "observed");
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
