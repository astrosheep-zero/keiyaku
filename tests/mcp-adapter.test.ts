import assert from "node:assert/strict";
import { mkdtempSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { classifyVerb, type VerbOutput } from "../src/library/keiyaku-verbs.js";
import { createKeiyakuMcpServer } from "../src/mcp/adapter.js";
import { Keiyaku, KeiyakuUsageError } from "../src/library/keiyaku.js";
import { projectFailure } from "../src/library/outcome.js";
import { renderVerb } from "../src/cli/render/verbs.js";
import { DEFAULT_CLI_COLUMNS } from "../src/cli/render/terminal.js";
import { Akuma, Akumas, Keis, Repo, World, kanshi, listArchetypeDefinitions } from "../src/index.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { repositoryAt } from "../src/git/repository.js";
import { bornBody, bornDirectAkuma, bornLineageAkuma } from "./support/akuma-fixtures.js";
import { beginTurn } from "../src/akuma/heart/index.js";
import { installHostAcpFixture } from "./support/acp-host-fixture.js";
import {
  cleanupSpawnCapableFixtureForTest,
  installAkumaBodyPidReceipt,
  temporaryDirectory,
} from "./support/process.js";
import { accepted, commitCandidate, document, present, repositoryWithMain } from "./support/library-verbs.js";
import { runCli } from "./support/cli-fixtures.js";

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
    "bind", "wait", "kei_status", "aku_status", "kei_ls", "aku_ls", "debt_query",
    "verify", "spawn", "fork", "debt_add", "ask", "debt_show",
  ]);
  let unknown: McpError | undefined;
  await assert.rejects(
    () => client.callTool({ name: "no-such-tool", arguments: { input: {} } }),
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
      () => client.callTool({ name, arguments: { input: {} } }),
      { name: unknown.name, code: unknown.code, message: unknown.message.replace("no-such-tool", name) },
    );
  }
  for (const tool of tools) {
    const entry = Keiyaku.verbs[tool.name.replaceAll("_", ".") as keyof typeof Keiyaku.verbs];
    assert.equal(tool.description, entry.description);
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(tool.inputSchema.required?.includes("input"));
    if (schemaTools.has(tool.name)) {
      const output = z.toJSONSchema(entry.output, { io: "input" });
      assert.deepEqual(tool.outputSchema, { ...output, type: "object" });
    } else assert.equal(tool.outputSchema, undefined);
    assert.equal(tool.annotations?.readOnlyHint, entry.effect === "read");
    assert.equal(tool.annotations?.destructiveHint, entry.effect === "destroy");
  }
  for (const name of ["debt_query", "report", "reconcile"])
    assert.ok(tools.some((tool) => tool.name === name));
  assert.equal(existsSync(join(cwd, ".keiyaku")), false);
  const native = await Keiyaku.at({ cwd, environment, home: cwd }).run("whoami", {});
  const result = await client.callTool({ name: "whoami", arguments: { input: {} } });
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
  const bad = await client.callTool({ name: "whoami", arguments: { input: {}, extra: true } });
  assert.equal(bad.isError, true);
  assert.equal(bad._meta?.["keiyaku/disposition"], "usage");
  assert.equal(bad.structuredContent, undefined);
  assert.equal((bad.content as { text: string }[])[0]?.text.split("\n")[0], "usage");
  const failureText = (bad.content as { type: string; text: string }[])[1];
  assert.equal(failureText?.type, "text");
  assert.deepEqual(
    JSON.parse(failureText!.text),
    projectFailure(new KeiyakuUsageError("expected input and optional nonblank cwd and repo")),
  );
  const added = await client.callTool({ name: "debt_add", arguments: { input: { title: "Fix the roof" } } });
  const published = tools.find((tool) => tool.name === "debt_add")?.outputSchema;
  assert.ok(published);
  // Client.callTool validates successful structuredContent against the tools/list outputSchema.
  assert.ok(published.anyOf);
  assert.equal(added.isError, false);
  const id = (added.structuredContent as { kind: "accepted"; id: string }).id;
  const shown = await client.callTool({ name: "debt_show", arguments: { input: { id } } });
  assert.equal(shown.isError, false);
  const list = await client.callTool({ name: "debt_query", arguments: { input: {} } });
  assert.equal(list.isError, false);
  assert.match(JSON.stringify(list.structuredContent), /Fix the roof/);
  const plural = await client.callTool({ name: "debt_show", arguments: { input: { ids: [id] } } });
  assert.deepEqual(plural.structuredContent, JSON.parse(JSON.stringify(
    await Keiyaku.at({ cwd, environment, home: cwd }).run("debt.show", { ids: [id] }),
  )));
  const done = await client.callTool({ name: "debt_update", arguments: { input: { id, state: "done", note: "finished" } } });
  assert.equal(done.isError, false);
  assert.equal(done.structuredContent, undefined);
  const completed = await Keiyaku.at({ cwd, environment, home: cwd }).run("debt.show", { id });
  assert.ok(completed.kind === "present" && completed.items[0]?.kind === "found");
  assert.equal(completed.items[0].state, "done");
  assert.equal(completed.items[0].note, "finished");

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
    client.callTool({ name: "debt_query", arguments: { cwd: first, input: {} } }),
    client.callTool({ name: "debt_query", arguments: { cwd: second, input: {} } }),
  ]);
  assert.match(JSON.stringify(listA.structuredContent), /First world/);
  assert.doesNotMatch(JSON.stringify(listA.structuredContent), /Second world/);
  assert.match(JSON.stringify(listB.structuredContent), /Second world/);
  const otherRepo = repositoryWithMain();
  t.after(() => rmSync(otherRepo.path, { recursive: true, force: true }));
  const foreign = await Keiyaku.at({ cwd: otherRepo.path, environment, home: cwd }).run("debt.add", { title: "Foreign repo world" });
  assert.equal(foreign.kind, "accepted");
  const badCoordinate = await client.callTool({ name: "debt_query", arguments: { cwd: " ", input: {} } });
  assert.equal(badCoordinate._meta?.["keiyaku/disposition"], "usage");
  const explicitRepo = await client.callTool({
    name: "debt_query",
    arguments: { cwd: first, repo: otherRepo.path, input: {} },
  });
  assert.equal(explicitRepo.isError, false);
  assert.deepEqual(explicitRepo.structuredContent, listA.structuredContent);
  assert.doesNotMatch(JSON.stringify(explicitRepo.structuredContent), /Foreign repo world/);
  const world = await World.at(first);
  const repo = await Repo.at({ path: otherRepo.path });
  const bound = accepted(await Keis.of(repo).bind({ markdown: document(), target: null, gates: ["reviewed"] }));
  const worker = await bornLineageAkuma({ root: world, akumaName: "worker", draw: "a2000014", createdAt: "2026-08-10T00:00:00.000Z" });
  mkdirSync(join(world, ".keiyaku", "akumas"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "akumas", "worker.md"), "---\nprovider: claude\n---\nWorker.\n");
  assert.equal((await publishDispatch({ repository: await repositoryAt(otherRepo.path), akumaId: worker.id, contractId: bound.contractId })).kind, "dispatched");
  const catalogue = await Akumas.of(world).list({ repo, limit: 1 });
  assert.deepEqual(catalogue.rows?.[0]?.contract, { kind: "associated", contractId: bound.contractId });
  for (const [name, input, expected] of [
    ["kei_ls", { limit: 1 }, await Keis.of(repo).list({ limit: 1 })],
    ["aku_ls", { limit: 1 }, catalogue],
    ["aku_names", {}, await listArchetypeDefinitions({ project: world, home: cwd })],

    ["kei_status", { id: bound.contractId }, await kanshi({ world, repo, contract: bound.contractId })],
    ["aku_status", { id: worker.id }, await Akumas.of(world).status({ akuma: worker.id, repo })],
    ["status", {}, await kanshi({ world, repo })],
  ] as const) {
    const response = await client.callTool({ name, arguments: { cwd: first, repo: otherRepo.path, input } });
    assert.equal(response.isError, false, name);
    if (schemaTools.has(name)) {
      assert.deepEqual(
        JSON.parse(JSON.stringify(response.structuredContent, (key, value: unknown) => key === "observedAt" ? undefined : value)),
        JSON.parse(JSON.stringify(expected, (key, value: unknown) => key === "observedAt" ? undefined : value)),
        name,
      );
    } else assert.equal(response.structuredContent, undefined);
  }
  const missing = await client.callTool({ name: "kei_status", arguments: { repo: otherRepo.path, input: { id: "kei/missing-mcp-status" } } });
  assert.equal(missing.structuredContent, undefined);
  assert.equal(missing.isError, true);
  assert.equal((missing.content as { text: string }[])[0]?.text.split("\n")[0], "refused");
  assert.deepEqual(await Keiyaku.at({ cwd, repo: otherRepo.path, environment, home: cwd }).run("kei.status", { id: "kei/missing-mcp-status" }),
    { kind: "contract-missing", id: "kei/missing-mcp-status" });
  assert.equal(missing._meta?.["keiyaku/disposition"], "refused");
  assert.equal(process.cwd(), processCwd);
  assert.deepEqual({ ...process.env }, processEnv);
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
  const result = await client.callTool({ name: "report", arguments: { input } });
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
  const preview = await client.callTool({ name: "deliver", arguments: { repo: repository.path, input } });
  assert.equal(preview.structuredContent, undefined);
  assert.deepEqual(preview.content, [{ type: "text", text: renderVerb("deliver", input,
    { kind: "returned", value: native }, { columns: DEFAULT_CLI_COLUMNS, color: false }) }]);
  assert.equal(preview._meta?.["keiyaku/disposition"], classifyVerb("deliver", input, { kind: "returned", value: native }));
  const invalid = await client.callTool({ name: "deliver", arguments: {
    cwd: join(home, "missing"), repo: join(home, "missing-repo"),
    input: { dryRun: true, message: "unused" },
  } });
  assert.equal(invalid._meta?.["keiyaku/disposition"], "usage");
  assert.deepEqual(await bound.kei.history(), before.history);
  assert.equal(repository.run(["for-each-ref", "--format=%(refname) %(objectname)"]), before.refs);
  assert.equal(repository.run(["-C", bound.worktreePath, "status", "--porcelain=v1"]), before.status);
  const delivered = await client.callTool({ name: "deliver", arguments: {
    repo: repository.path, input: { contract: bound.contractId },
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
  const reconcileInput = { contract: before.id };
  const reconciled = await client.callTool({ name: "reconcile", arguments: { input: reconcileInput } });
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
  const guidance = await client.callTool({ name: "show", arguments: { input: { contract: before.id } } });
  const nativeGuidance = await handle.guidance();
  assert.equal(guidance.structuredContent, undefined);
  assert.equal(guidance.isError, false);
  assert.ok(nativeGuidance.kind === "present");
  assert.equal((guidance.content as { type: string; text: string }[])[0]?.text, nativeGuidance.guidance);
  const bindInput = { markdown: document(), target: null, gates: ["reviewed"], workspace: "worktree" as const };
  const boundOverMcp = await client.callTool({ name: "bind", arguments: { input: bindInput } });
  assert.equal(boundOverMcp.isError, false);
  const wire = accepted(Keiyaku.verbs.bind.output.parse(boundOverMcp.structuredContent));
  assert.equal(Object.hasOwn(wire, "kei"), false);
  const mintedInput = { contract: wire.contractId };
  const minted = await client.callTool({ name: "show", arguments: { input: mintedInput } });
  assert.equal(minted.isError, false);
  const mintedGuidance = await Keiyaku.at({ cwd: repository.path, environment: {} }).run("show", mintedInput);
  assert.ok(mintedGuidance.kind === "present");
  const missingInput = { contract: "kei/missing-mcp-contract" };
  const absent = await client.callTool({ name: "show", arguments: { input: missingInput } });
  assert.equal(absent.structuredContent, undefined);
  assert.equal(absent.isError, true);
  assert.equal((absent.content as { text: string }[])[0]?.text.split("\n")[0], "refused");
  assert.deepEqual(await Keiyaku.at({ cwd: repository.path, environment: {} }).run("show", missingInput), { kind: "missing" });
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

test("red verification answers normally while infrastructure failure is an error", async (t) => {
  for (const infrastructure of [false, true]) await t.test(infrastructure ? "setup failure" : "negative verdict", async (t) => {
    const repository = repositoryWithMain();
    const repo = await Repo.at({ path: repository.path });
    const bound = accepted(await Keis.of(repo).bind({
      markdown: document("exit 7"), target: null, gates: ["reviewed"], workspace: "worktree",
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
    const response = await client.callTool({ name: "verify", arguments: { input } });
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
    assert.equal(result.checks[0]?.kind, infrastructure ? "environment-hook-failure" : "terminal");
    assert.equal(classifyVerb("verify", input, { kind: "returned", value: result }), infrastructure ? "failed" : "unsatisfied");
  });
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
      ["empty", { schema: { type: "string" } }, "invalid-output", "", undefined],
      ["null", { schema: { type: "null" } }, "answered", null, "null"],
      ["invalid", { schema }, "invalid-output", "not-json", undefined],
    ] as const) {
      const input = { akuma: allocated.id, prompt, timeoutMs: 30_000, ...extra };
      const response = await client.callTool({ name: "ask", arguments: { input } });
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
