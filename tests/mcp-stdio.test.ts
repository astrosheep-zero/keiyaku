import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Keis, Repo } from "../src/index.js";
import { accepted, document, present, repositoryWithMain } from "./support/library-verbs.js";

test("packaged stdio server launches from its documented Pi configuration", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "kei-mcp-stdio-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(manifest.bin["keiyaku-mcp"], "build/src/mcp/index.js");
  assert.ok(manifest.dependencies["@modelcontextprotocol/sdk"]);
  const bin = resolve(manifest.bin["keiyaku-mcp"]);
  const help = execFileSync(process.execPath, [bin, "--help"], { cwd: root, encoding: "utf8" });
  const config = JSON.parse(help.slice(help.indexOf("{\n"), help.indexOf("\n\nExposure")));
  const server = config.mcpServers.keiyaku;
  assert.equal(server.command, "keiyaku-mcp");
  assert.equal(server.exposure, "direct");
  assert.equal(server.timeout, 600);
  assert.match(help, /timeoutMs/);
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  if (process.platform !== "win32") symlinkSync(bin, join(binDir, server.command));
  const transport = new StdioClientTransport({
    command: process.platform === "win32" ? process.execPath : server.command,
    args: process.platform === "win32" ? [bin, ...(server.args ?? [])] : (server.args ?? []),
    cwd: root,
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      KEIYAKU_HOME: root,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
  });
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === "report"));
  const result = await client.callTool({ name: "whoami", arguments: {} });
  assert.equal(result.isError, false);
  const created = await client.callTool({ name: "debt_add", arguments: { cwd: root, title: "Stdio flat business input" } });
  assert.equal(created.isError, false, JSON.stringify(created));
  const id = (created.structuredContent as { id: string }).id;
  const detail = await client.callTool({ name: "show", arguments: { ids: [id] } });
  assert.equal(detail.isError, false, JSON.stringify(detail));
  assert.equal(detail.structuredContent, undefined);
  assert.match(JSON.stringify(detail.content), /Stdio flat business input/u);
  await client.close();
  const processOnEof = spawn(process.execPath, [bin], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
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

test("SIGTERM retires a pending stdio wait without changing its Contract", async (t) => {
  if (process.platform === "win32") return;
  const repository = repositoryWithMain();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(
    await Keis.of(repo).bind({ markdown: document(), target: null, gates: ["reviewed"] }),
  );
  const before = present(await bound.kei.state());
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("build/src/mcp/index.js")],
    cwd: repository.path,
    env: {
      ...process.env,
      HOME: repository.path,
      USERPROFILE: repository.path,
      KEIYAKU_HOME: repository.path,
    } as Record<string, string>,
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
