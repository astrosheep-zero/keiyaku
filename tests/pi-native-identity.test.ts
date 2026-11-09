import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { CreateAgentSessionOptions, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { harnessOwner } from "@astrosheep/square";
import { deliveryOwner } from "../src/library/keiyaku-attribution.js";
import { createPiProvider, type PiSdk } from "../src/akuma/providers/pi/index.js";

const PI_SESSION_VARIABLE = "PI_SESSION_ID";

type NativeBashTool = NonNullable<CreateAgentSessionOptions["customTools"]>[number];

function packageProvenance(specifier: string): string {
  const entry = fileURLToPath(import.meta.resolve(specifier));
  const manifest = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  return `${manifest.name}@${manifest.version} (${entry})`;
}

async function nativePiSdk(): Promise<{ sdk: PiSdk; options: () => Record<string, unknown> | undefined }> {
  let captured: Record<string, unknown> | undefined;
  const manager = {
    getLeafId: () => null,
    createBranchedSession: () => "/sessions/child.jsonl",
  };
  const session = {
    sessionFile: "/sessions/native.jsonl",
    sessionId: "native-child-session",
    sessionManager: manager,
    agent: {
      subscribe: () => () => {},
      steer: () => {},
    },
    subscribe: () => () => {},
    bindExtensions: async () => {},
    prompt: async () => {},
    abort: async () => {},
    extensionRunner: { emit: async () => {}, onError: () => () => {} },
    dispose: () => {},
  };
  return {
    options: () => captured,
    sdk: {
      createBashToolDefinition: (await import("@earendil-works/pi-coding-agent")).createBashToolDefinition,
      createAgentSessionFromServices: async (options) => {
        captured = options as unknown as Record<string, unknown>;
        return { session } as never;
      },
      createAgentSessionServices: async () => ({ resourceLoader: { getExtensions: () => ({ errors: [] }) } }) as never,
      getAgentDir: () => "/agent",
      SessionManager: { create: () => manager, open: () => manager } as never,
    },
  };
}

/**
 * Boot one fake Pi session wired to Keiyaku's real identity-scoped Bash tool.
 * The attempt is always retired, so a setup or assertion failure inside `body`
 * cannot leak a live session or its child processes.
 */
async function withNativeBashTool<T>(
  root: string,
  body: (tool: NativeBashTool) => Promise<T>,
): Promise<T> {
  const fake = await nativePiSdk();
  const provider = createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk);
  const attempt = provider.start({
    body: "work",
    launchTells: [],
    cwd: root,
    options: {},
    signal: new AbortController().signal,
    execution: { akumaId: "aku/pi/1234abcd", world: root },
    session: { kind: "fresh" },
  });
  try {
    const drive = await attempt.result;
    await drive.completion;
    const customTools = fake.options()?.customTools as
      | NonNullable<CreateAgentSessionOptions["customTools"]>
      | undefined;
    const tool = customTools?.[0];
    assert.ok(tool);
    return await body(tool);
  } finally {
    await attempt.closed;
  }
}

function nativeSessionContext(sessionId: string, sessionFile = `/sessions/${sessionId}.jsonl`): ExtensionToolContext {
  return {
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile },
  } as never;
}


test("Pi Bash preserves native session identity and the current execution coordinates", async (t) => {
  t.diagnostic(`Pi runtime: ${packageProvenance("@earendil-works/pi-coding-agent")}`);
  const root = mkdtempSync(join(tmpdir(), "keiyaku-pi-native-identity-"));
  const previousSession = process.env[PI_SESSION_VARIABLE];
  process.env[PI_SESSION_VARIABLE] = "ancestor-session";
  try {
    await withNativeBashTool(root, async (tool) => {
      const result = await tool.execute(
        "native-identity",
        { command: `printf '%s' "$PI_SESSION_ID|$PI_SESSION_FILE|$KEIYAKU_ACTOR_ID|$KEIYAKU_ACTOR_WORLD"` },
        new AbortController().signal,
        undefined,
        nativeSessionContext("native-child-session", "/sessions/native.jsonl"),
      );
      assert.deepEqual(result.content, [{ type: "text", text: `native-child-session|/sessions/native.jsonl|aku/pi/1234abcd|${root}` }]);
      assert.equal(process.env[PI_SESSION_VARIABLE], "ancestor-session");
    });
  } finally {
    if (previousSession === undefined) delete process.env[PI_SESSION_VARIABLE];
    else process.env[PI_SESSION_VARIABLE] = previousSession;
    rmSync(root, { recursive: true, force: true });
  }
});

test("parent and child native Pi environments resolve distinct delivery Owners", (t) => {
  t.diagnostic(`Square runtime: ${packageProvenance("@astrosheep/square")}`);
  const parent = deliveryOwner({ PI_SESSION_ID: "parent-session" });
  const child = deliveryOwner({ PI_SESSION_ID: "child-session" });
  assert.equal(parent, harnessOwner({ channel: "pi", session: "parent-session" }));
  assert.equal(child, harnessOwner({ channel: "pi", session: "child-session" }));
  assert.notEqual(parent, child);
});
