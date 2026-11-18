import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Real ACP stdio agent without live Tell capability. */
export function installHostAcpFixture(world: string): void {
  const executable = join(world, "host-acp.mjs");
  writeFileSync(
    executable,
    `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from ${JSON.stringify(import.meta.resolve("@agentclientprotocol/sdk"))};
const app = acp.agent({ name: "host-fixture" })
  .onRequest(acp.methods.agent.initialize, ({ params }) => ({ protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: true } }))
  .onRequest(acp.methods.agent.session.new, () => ({ sessionId: "fixture" }))
  .onRequest(acp.methods.agent.session.load, () => ({}))
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const text = params.prompt.filter(block => block.type === "text").map(block => block.text).join("");
    const name = text.includes("second") ? "second" : text.includes("first") ? "first" : undefined;
    if (name) {
      writeFileSync(join(process.cwd(), name + ".ready"), String(process.pid));
      await new Promise(resolve => { const timer = setInterval(() => { if (existsSync(join(process.cwd(), name + ".release"))) { clearInterval(timer); resolve(); } }, 10); });
    }
    await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "acp-answer" } } });
    return { stopReason: "end_turn" };
  });
app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
`,
  );
  mkdirSync(join(world, ".keiyaku", "akumas"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "akumas", "acp-worker.md"), "---\nprovider: fixture-acp\n---\n");
  mkdirSync(join(world, "plugins"), { recursive: true });
  writeFileSync(
    join(world, "plugins", "host-proof.mjs"),
    `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export default { manifest: { id: "host-proof", apiVersion: 1 }, activate(ctx) {
  const log = async signal => {
    appendFileSync(ctx.config.log, JSON.stringify({ kind: signal.kind, pid: process.pid, body: signal.bodySequence }) + "\\n");
    const target = join(ctx.world, "hold-body-end");
    if (signal.kind === "akuma.body-ended" && existsSync(target) && readFileSync(target, "utf8") === String(signal.bodySequence)) {
      writeFileSync(join(ctx.world, "body-end.ready"), "ready");
      await new Promise(resolve => {
        const timer = setInterval(() => {
          if (!existsSync(join(ctx.world, "body-end.release"))) return;
          clearInterval(timer);
          resolve();
        }, 10);
      });
    }
  };
  return { signals: { "akuma.born": log, "akuma.turn-started": log, "akuma.body-ended": log } };
} };
`,
  );
  writeFileSync(
    join(world, ".keiyaku", "settings.json"),
    JSON.stringify({
      providers: {
        "fixture-acp": {
          kind: "acp",
          executable: process.execPath,
          config: { argvBefore: [executable], argvAfter: [], systemPromptArg: "--system-prompt" },
        },
      },
      plugins: {
        "host-proof": {
          package: "./plugins/host-proof.mjs",
          config: { log: join(world, "host-proof.jsonl") },
        },
      },
    }),
  );
}
