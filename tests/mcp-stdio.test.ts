import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Keis, Repo, World } from "../src/index.js";
import { bornLineageAkuma } from "./support/akuma-fixtures.js";
import { accepted, document, present, repositoryWithMain } from "./support/library-verbs.js";

type TestEnvironmentModule = {
  CALLER_ENVIRONMENT_PREFIXES: readonly string[];
  CALLER_ENVIRONMENT_NAMES: readonly string[];
  isolatedTestEnvironment(inherited: NodeJS.ProcessEnv, home: string): Record<string, string>;
};

const { CALLER_ENVIRONMENT_PREFIXES, CALLER_ENVIRONMENT_NAMES, isolatedTestEnvironment } = (await import(
  pathToFileURL(resolve("scripts/test-environment.mjs")).href
)) as TestEnvironmentModule;

function textContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (item === null || typeof item !== "object") return "";
      const { type, text } = item as { type?: unknown; text?: unknown };
      return type === "text" && typeof text === "string" ? text : "";
    })
    .join("\n");
}

function snapshotFiles(root: string): Map<string, Buffer> {
  const snapshot = new Map<string, Buffer>();
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) snapshot.set(relative(root, path), readFileSync(path));
    }
  };
  visit(root);
  return snapshot;
}

test("packaged stdio server launches from its documented standalone configuration", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "kei-mcp-stdio-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(manifest.bin["keiyaku-mcp"], "build/src/mcp/index.js");
  assert.ok(manifest.dependencies["@modelcontextprotocol/sdk"]);
  const bin = resolve(manifest.bin["keiyaku-mcp"]);
  const environment = isolatedTestEnvironment(process.env, root);
  assert.equal(environment.SQUARE_DELIVERY, join(root, "delivery.sqlite"));
  const help = execFileSync(process.execPath, [bin, "--help"], { cwd: root, encoding: "utf8", env: environment });
  const config = JSON.parse(help.slice(help.indexOf("{\n"), help.indexOf("\n\nExposure")));
  const server = config.mcpServers.keiyaku;
  assert.equal(server.command, "keiyaku-mcp");
  assert.equal(server.exposure, "direct");
  assert.equal(server.timeout, 600);
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  if (process.platform !== "win32") symlinkSync(bin, join(binDir, server.command));
  environment.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  const transport = new StdioClientTransport({
    command: process.platform === "win32" ? process.execPath : server.command,
    args: process.platform === "win32" ? [bin, ...(server.args ?? [])] : (server.args ?? []),
    cwd: root,
    env: environment,
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
  });
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === "report"));
  assert.match(help, /Status summarizes active work without a selector/u);
  const status = await client.callTool({ name: "status", arguments: {} });
  assert.equal(status.isError, false);
  assert.equal((status.structuredContent as { kind?: string } | undefined)?.kind, "active-work-summary");
  const result = await client.callTool({ name: "whoami", arguments: {} });
  assert.equal(result.isError, false);
  const created = await client.callTool({ name: "debt_add", arguments: { cwd: root, title: "Stdio flat business input" } });
  assert.equal(created.isError, false, JSON.stringify(created));
  const id = (created.structuredContent as { id: string }).id;
  const detail = await client.callTool({ name: "show", arguments: { selector: id } });
  assert.equal(detail.isError, false, JSON.stringify(detail));
  assert.equal(detail.structuredContent, undefined);
  assert.match(JSON.stringify(detail.content), /Stdio flat business input/u);
  await client.close();
  const processOnEof = spawn(process.execPath, [bin], { cwd: root, stdio: ["pipe", "pipe", "pipe"], env: environment });
  let stdout = "";
  processOnEof.stdout.setEncoding("utf8");
  processOnEof.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  const exit = new Promise<number | null>((resolveExit, reject) => {
    processOnEof.once("error", reject);
    processOnEof.once("exit", resolveExit);
  });
  processOnEof.stdin.end();
  assert.equal(await exit, 0);
  assert.equal(stdout, "");
});

test("packaged stdio fixture cannot reach the launching caller's actor World", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "kei-mcp-isolation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const poisonedRoot = mkdtempSync(join(tmpdir(), "kei-mcp-poisoned-"));
  t.after(() => rmSync(poisonedRoot, { recursive: true, force: true }));
  const poisonedWorld = await World.at(poisonedRoot);
  const poisoned = await bornLineageAkuma({
    root: poisonedWorld,
    akumaName: "probe",
    draw: "1234abcd",
    createdAt: "2026-08-08T00:00:00.000Z",
  });
  writeFileSync(join(poisonedWorld, "parent-bytes.txt"), "poisoned parent bytes\n");
  const before = snapshotFiles(poisonedWorld);
  assert.ok(before.has(relative(poisonedWorld, poisoned.paths.heart)), "the poisoned World owns a real Heart");
  assert.ok(before.has("parent-bytes.txt"));
  const poisonedCallerKeys = [
    ...CALLER_ENVIRONMENT_PREFIXES.map((prefix) => `${prefix}POISONED`),
    ...CALLER_ENVIRONMENT_NAMES,
  ];
  const ambient: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(root, "inherited-home"),
    USERPROFILE: join(root, "inherited-home"),
    KEIYAKU_HOME: join(root, "inherited-home"),
    KEIYAKU_ACTOR_ID: poisoned.id,
    KEIYAKU_ACTOR_WORLD: poisonedWorld,
    SQUARE_DELIVERY: join(poisonedRoot, "inherited-ledger.sqlite"),
    HTTPS_PROXY: "http://127.0.0.1:6152",
    TEST_SENTINEL: "sentinel bytes",
  };
  for (const key of poisonedCallerKeys) ambient[key] = `poisoned-${key}`;
  ambient.KEIYAKU_ACTOR_ID = poisoned.id;
  ambient.KEIYAKU_ACTOR_WORLD = poisonedWorld;
  const ambientBefore = { ...ambient };
  const environment = isolatedTestEnvironment(ambient, root);
  assert.deepEqual(ambient, ambientBefore, "the builder must not mutate its input");
  for (const key of poisonedCallerKeys) assert.equal(environment[key], undefined, key);
  assert.equal(environment.KEIYAKU_ACTOR_ID, undefined);
  assert.equal(environment.KEIYAKU_ACTOR_WORLD, undefined);
  assert.equal(environment.HOME, root);
  assert.equal(environment.USERPROFILE, root);
  assert.equal(environment.KEIYAKU_HOME, root);
  assert.equal(environment.SQUARE_DELIVERY, join(root, "delivery.sqlite"));
  assert.equal(environment.HTTPS_PROXY, "http://127.0.0.1:6152");
  assert.equal(environment.TEST_SENTINEL, "sentinel bytes");
  const client = new Client({ name: "test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("build/src/mcp/index.js")],
    cwd: root,
    env: environment,
    stderr: "pipe",
  });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
  });
  const result = await client.callTool({ name: "whoami", arguments: {} });
  assert.equal(result.isError, false, JSON.stringify(result));
  const text = textContent(result.content);
  assert.match(text, /none \(not an akuma\)/u);
  const rendered = JSON.stringify(result);
  assert.equal(rendered.includes(poisoned.id), false, rendered);
  assert.equal(rendered.includes(poisonedWorld), false, rendered);
  const after = snapshotFiles(poisonedWorld);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [path, bytes] of before) assert.ok(after.get(path)?.equals(bytes), `poisoned parent file changed: ${path}`);

  const actorRoot = join(root, "fixture-world");
  mkdirSync(actorRoot);
  const fixtureWorld = await World.at(actorRoot);
  const fixtureActor = await bornLineageAkuma({
    root: fixtureWorld,
    akumaName: "fixture",
    draw: "5678abcd",
    createdAt: "2026-08-08T00:00:00.000Z",
  });
  const explicitClient = new Client({ name: "test", version: "1" });
  const explicitTransport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("build/src/mcp/index.js")],
    cwd: root,
    env: { ...environment, KEIYAKU_ACTOR_ID: fixtureActor.id, KEIYAKU_ACTOR_WORLD: fixtureWorld },
    stderr: "pipe",
  });
  await explicitClient.connect(explicitTransport);
  t.after(async () => {
    await explicitClient.close();
  });
  const explicit = await explicitClient.callTool({ name: "whoami", arguments: {} });
  assert.equal(explicit.isError, false, JSON.stringify(explicit));
  const explicitText = textContent(explicit.content);
  assert.equal(explicitText.includes(fixtureActor.id), true, explicitText);
  assert.equal(explicitText.includes(fixtureWorld), true, explicitText);
  assert.doesNotMatch(explicitText, /profile\s+unavailable/u);
});

test("SIGTERM retires a pending stdio wait without changing its Contract", async (t) => {
  if (process.platform === "win32") return;
  const repository = repositoryWithMain();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(
    await Keis.of(repo).bind({ terms: document(), target: null, gates: ["reviewed"] }),
  );
  const before = present(await bound.kei.state());
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("build/src/mcp/index.js")],
    cwd: repository.path,
    env: isolatedTestEnvironment(process.env, repository.path),
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  const wait = client.callTool({ name: "wait", arguments: { selectors: [before.id] } });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  assert.ok(transport.pid);
  process.kill(transport.pid, "SIGTERM");
  const settlement = await wait.then(value => ({ value }), error => ({ error }));
  assert.ok("error" in settlement, JSON.stringify(settlement));
  await client.close();
  assert.deepEqual(present(await bound.kei.state()), before);
});
