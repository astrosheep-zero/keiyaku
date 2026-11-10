import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { classifyVerb, type VerbOutput } from "../src/library/keiyaku-verbs.js";
import { createKeiyakuMcpServer } from "../src/mcp/adapter.js";
import { Keiyaku, KeiyakuUsageError } from "../src/library/keiyaku.js";
import { projectFailure } from "../src/library/outcome.js";
import { renderVerb } from "../src/cli/render/verbs.js";
import { DEFAULT_CLI_COLUMNS } from "../src/cli/render/terminal.js";
import { Akuma, Keis, Repo, World } from "../src/index.js";
import { bornDirectAkuma } from "./support/akuma-fixtures.js";
import { installHostAcpFixture } from "./support/acp-host-fixture.js";
import {
  cleanupSpawnCapableFixtureForTest,
  installAkumaBodyPidReceipt,
  temporaryDirectory,
} from "./support/process.js";
import { accepted, document, present, repositoryWithMain } from "./support/library-verbs.js";

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
  assert.deepEqual(
    tools.map((tool) => tool.name),
    Object.keys(Keiyaku.verbs).map((name) => name.replaceAll(".", "_")),
  );
  for (const tool of tools) {
    const entry = Keiyaku.verbs[tool.name.replaceAll("_", ".") as keyof typeof Keiyaku.verbs];
    assert.equal(tool.description, entry.description);
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(tool.inputSchema.required?.includes("input"));
    const output = z.toJSONSchema(entry.output, { io: "input" });
    assert.equal(tool.outputSchema?.type, "object");
    assert.deepEqual(tool.outputSchema, { ...output, type: "object" });
    assert.equal(tool.annotations?.readOnlyHint, entry.effect === "read");
    assert.equal(tool.annotations?.destructiveHint, entry.effect === "destroy");
  }
  for (const name of ["ls", "wait", "history", "nuke", "report"])
    assert.equal(tools.filter((tool) => tool.name === name).length, 1);
  assert.equal(existsSync(join(cwd, ".keiyaku")), false);
  const native = await Keiyaku.at({ cwd, environment, home: cwd }).run("whoami", {});
  const result = await client.callTool({ name: "whoami", arguments: { input: {} } });
  assert.deepEqual(result.structuredContent, JSON.parse(JSON.stringify(native)));
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
  const settings = await client.callTool({ name: "settings", arguments: { input: {} } });
  assert.equal(settings.isError, false);
  assert.deepEqual(settings.structuredContent, JSON.parse(JSON.stringify(
    await Keiyaku.at({ cwd, environment, home: cwd }).run("settings", {}),
  )));
  const bad = await client.callTool({ name: "whoami", arguments: { input: {}, extra: true } });
  assert.equal(bad.isError, true);
  assert.equal(bad._meta?.["keiyaku/disposition"], "usage");
  assert.equal(bad.structuredContent, undefined);
  const failureText = (bad.content as { type: string; text: string }[])[1];
  assert.equal(failureText?.type, "text");
  assert.deepEqual(
    JSON.parse(failureText!.text),
    projectFailure(new KeiyakuUsageError("expected input and optional nonblank cwd and repo")),
  );
  await assert.rejects(() => client.callTool({ name: "no-such-tool", arguments: { input: {} } }));
  await assert.rejects(() => client.callTool({ name: "debt.add", arguments: { input: { title: "Fix the roof" } } }), /Unknown tool: debt\.add/);
  const added = await client.callTool({ name: "debt_add", arguments: { input: { title: "Fix the roof" } } });
  const published = tools.find((tool) => tool.name === "debt_add")?.outputSchema;
  assert.ok(published);
  // Client.callTool validates successful structuredContent against the tools/list outputSchema.
  assert.ok(published.anyOf);
  assert.equal(added.isError, false);
  const refusal = await client.callTool({ name: "nuke", arguments: { input: {} } });
  const nativeRefusal = await Keiyaku.at({ cwd, environment, home: cwd }).run("nuke", {});
  assert.equal(refusal.isError, true);
  assert.equal(refusal._meta?.["keiyaku/disposition"], classifyVerb("nuke", {}, { kind: "returned", value: nativeRefusal }));
  assert.deepEqual(refusal.structuredContent, JSON.parse(JSON.stringify(nativeRefusal)));
  const id = (added.structuredContent as { kind: "accepted"; id: string }).id;
  const shown = await client.callTool({ name: "debt_show", arguments: { input: { id } } });
  assert.equal(shown.isError, false);
  const list = await client.callTool({ name: "ls", arguments: { input: { of: "debt" } } });
  assert.equal(list.isError, false);
  assert.match(JSON.stringify(list.structuredContent), /Fix the roof/);
  const plural = await client.callTool({ name: "debt_show", arguments: { input: { ids: [id] } } });
  assert.deepEqual(plural.structuredContent, JSON.parse(JSON.stringify(
    await Keiyaku.at({ cwd, environment, home: cwd }).run("debt.show", { ids: [id] }),
  )));
  const done = await client.callTool({ name: "debt_done", arguments: { input: { ids: [id] } } });
  assert.equal(done.isError, false);
  assert.deepEqual(done.structuredContent, { items: [{ kind: "accepted" }] });

  const first = mkdtempSync(join(tmpdir(), "kei-mcp-first-"));
  const second = mkdtempSync(join(tmpdir(), "kei-mcp-second-"));
  t.after(() => {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  });
  const processCwd = process.cwd();
  const processEnv = { ...process.env };
  const [a, b] = await Promise.all([
    client.callTool({ name: "debt_add", arguments: { cwd: relative(cwd, first), input: { title: "First world" } } }),
    client.callTool({ name: "debt_add", arguments: { cwd: second, input: { title: "Second world" } } }),
  ]);
  assert.equal(a.isError, false);
  assert.equal(b.isError, false);
  const [listA, listB] = await Promise.all([
    client.callTool({ name: "ls", arguments: { cwd: first, input: { of: "debt" } } }),
    client.callTool({ name: "ls", arguments: { cwd: second, input: { of: "debt" } } }),
  ]);
  assert.match(JSON.stringify(listA.structuredContent), /First world/);
  assert.doesNotMatch(JSON.stringify(listA.structuredContent), /Second world/);
  assert.match(JSON.stringify(listB.structuredContent), /Second world/);
  const otherRepo = repositoryWithMain();
  t.after(() => rmSync(otherRepo.path, { recursive: true, force: true }));
  const foreign = await Keiyaku.at({ cwd: otherRepo.path, environment, home: cwd }).run("debt.add", { title: "Foreign repo world" });
  assert.equal(foreign.kind, "accepted");
  const badCoordinate = await client.callTool({ name: "ls", arguments: { cwd: " ", input: { of: "debt" } } });
  assert.equal(badCoordinate._meta?.["keiyaku/disposition"], "usage");
  const explicitRepo = await client.callTool({
    name: "ls",
    arguments: { cwd: first, repo: otherRepo.path, input: { of: "debt" } },
  });
  assert.equal(explicitRepo.isError, false);
  assert.deepEqual(explicitRepo.structuredContent, listA.structuredContent);
  assert.doesNotMatch(JSON.stringify(explicitRepo.structuredContent), /Foreign repo world/);
  assert.equal(process.cwd(), processCwd);
  assert.deepEqual({ ...process.env }, processEnv);
});

test("cancelled SDK wait retires without changing its Contract", async (t) => {
  const repository = repositoryWithMain();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(
    await Keis.of(repo).bind({ markdown: document(), target: null, gates: ["reviewed"], workspace: "worktree" }),
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
  const guidance = await client.callTool({ name: "show", arguments: { input: { contract: before.id } } });
  const nativeGuidance = await handle.guidance();
  assert.deepEqual(guidance.structuredContent, JSON.parse(JSON.stringify(nativeGuidance)));
  assert.equal(guidance.isError, false);
  assert.ok(nativeGuidance.kind === "present");
  assert.equal((guidance.content as { type: string; text: string }[])[0]?.text, nativeGuidance.guidance);
  const bindInput = { markdown: document(), target: null, gates: ["reviewed"], workspace: "worktree" as const };
  const boundOverMcp = await client.callTool({ name: "bind", arguments: { input: bindInput } });
  assert.equal(boundOverMcp.isError, false);
  const wire = boundOverMcp.structuredContent as Record<string, unknown>;
  assert.equal(wire.kind, "accepted");
  assert.equal(typeof wire.contractId, "string");
  assert.equal(typeof wire.worktreePath, "string");
  assert.equal(Object.hasOwn(wire, "kei"), false);
  assert.deepEqual(wire, Keiyaku.verbs.bind.output.parse(wire));
  const missingInput = { contract: "kei/missing-mcp-contract" };
  const absent = await client.callTool({ name: "show", arguments: { input: missingInput } });
  assert.deepEqual(absent.structuredContent, { kind: "missing" });
  assert.equal(absent._meta?.["keiyaku/disposition"], classifyVerb("show", missingInput, { kind: "returned", value: { kind: "missing" } }));
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(() =>
    client.callTool({ name: "wait", arguments: { input: { selectors: [before.id] } } }, undefined, {
      signal: preAborted.signal,
    }),
  );
  const late = new AbortController();
  const finished = await client.callTool(
    { name: "wait", arguments: { input: { selectors: [before.id], timeoutMs: 0 } } },
    undefined,
    { signal: late.signal },
  );
  late.abort();
  assert.equal(finished.isError, false);
  const controller = new AbortController();
  const wait = client.callTool({ name: "wait", arguments: { input: { selectors: [before.id] } } }, undefined, {
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  controller.abort();
  await assert.rejects(wait);
  await adapter.close();
  await client.close();
  assert.deepEqual(present(await handle.state()), before);
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
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
    const result = await client.callTool({
      name: "ask",
      arguments: { input: { akuma: allocated.id, prompt: "structured", schema, timeoutMs: 30_000 } },
    });
    assert.equal(result.isError, false);
    const answer = result.structuredContent as VerbOutput<"ask">;
    assert.equal(answer.kind, "answered");
    assert.ok(answer.kind === "answered" && "answer" in answer);
    assert.deepEqual(answer.answer, { ok: true });
    assert.equal(result._meta?.["keiyaku/disposition"], classifyVerb("ask", { akuma: allocated.id, prompt: "structured", schema, timeoutMs: 30_000 }, { kind: "returned", value: answer }));
    assert.equal((await Akuma.select(world, allocated.id).idle({ timeoutMs: 30_000 })).reason, "completed");
    for (const [prompt, extra, expectedKind, expectedAnswer, expectedText] of [
      ["empty", {}, "answered", "", ""],
      ["null", { schema: { type: "null" } }, "answered", null, "null"],
      ["invalid", { schema }, "invalid-output", "not-json", undefined],
    ] as const) {
      const input = { akuma: allocated.id, prompt, timeoutMs: 30_000, ...extra };
      const response = await client.callTool({ name: "ask", arguments: { input } });
      const value = response.structuredContent as VerbOutput<"ask">;
      assert.equal(value.kind, expectedKind);
      assert.ok((value.kind === "answered" || value.kind === "invalid-output") && "answer" in value);
      assert.equal(value.answer, expectedAnswer);
      assert.equal(typeof value.tellId, "string");
      const disposition = classifyVerb("ask", input, { kind: "returned", value });
      assert.equal(response._meta?.["keiyaku/disposition"], disposition);
      assert.equal(response.isError, disposition !== "accepted");
      if (expectedText !== undefined) assert.deepEqual(response.content, [{ type: "text", text: expectedText }]);
      else assert.equal(disposition, "failed");
      assert.equal((await Akuma.select(world, allocated.id).idle({ timeoutMs: 30_000 })).reason, "completed");
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
