import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { CreateAgentSessionOptions, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { squareAssignedParticipantName } from "@astrosheep/square";
import { AKUMA_REQUESTS_ENV } from "../src/akuma/provider.js";
import { createPiProvider, type PiSdk } from "../src/akuma/providers/pi/index.js";

const PI_SESSION_VARIABLE = "PI_SESSION_ID";

type NativeRequestTool = NonNullable<CreateAgentSessionOptions["customTools"]>[number];
type NativeToolResult = Awaited<ReturnType<NativeRequestTool["execute"]>>;

function packageProvenance(specifier: string): string {
  const entry = fileURLToPath(import.meta.resolve(specifier));
  const manifest = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  return `${manifest.name}@${manifest.version} (${entry})`;
}

function nativePiSdk(): { sdk: PiSdk; options: () => Record<string, unknown> | undefined } {
  let captured: Record<string, unknown> | undefined;
  const manager = {
    getLeafId: () => null,
    createBranchedSession: () => "/sessions/child.jsonl",
  };
  const session = {
    sessionFile: "/sessions/native.jsonl",
    sessionId: "native-child-session",
    sessionManager: manager,
    subscribe: () => () => {},
    prompt: async () => {},
    abort: async () => {},
    dispose: () => {},
  };
  return {
    options: () => captured,
    sdk: {
      createAgentSession: async (options) => {
        captured = options as unknown as Record<string, unknown>;
        return { session } as never;
      },
      DefaultResourceLoader: class {
        async reload() {}
      } as never,
      getAgentDir: () => "/agent",
      ModelRuntime: { create: async () => ({ getModel: () => ({ id: "model" }) }) } as never,
      SessionManager: { create: () => manager, open: () => manager } as never,
    },
  };
}

/**
 * Boot one fake Pi session wired to Keiyaku's real request-channel tool. The
 * attempt is always retired, so a setup or assertion failure inside `body`
 * cannot leak a live session or its child processes.
 */
async function withNativeRequestTool<T>(
  input: Readonly<{ root: string; requests: string }>,
  body: (tool: NativeRequestTool) => Promise<T>,
): Promise<T> {
  const fake = nativePiSdk();
  const provider = createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk);
  const attempt = provider.start({
    body: "work",
    launchTells: [],
    cwd: input.root,
    options: {},
    signal: new AbortController().signal,
    requests: { dir: input.requests },
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

function nativeSessionContext(sessionId: string, sessionFile = `/sessions/${sessionId}.jsonl`): ExtensionContext {
  return {
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile },
  } as never;
}

function observedNativeIdentity(result: NativeToolResult): Readonly<{ session: string; requests: string }> {
  const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  const parsed = JSON.parse(text) as { session?: unknown; requests?: unknown };
  assert.equal(typeof parsed.session, "string");
  assert.equal(typeof parsed.requests, "string");
  return { session: parsed.session as string, requests: parsed.requests as string };
}

test("the Pi request channel preserves the native session identity instead of an ancestor value", async (t) => {
  t.diagnostic(`Pi runtime: ${packageProvenance("@earendil-works/pi-coding-agent")}`);
  const root = mkdtempSync(join(tmpdir(), "keiyaku-pi-native-identity-"));
  const requests = join(root, "requests");
  const previousSession = process.env[PI_SESSION_VARIABLE];
  process.env[PI_SESSION_VARIABLE] = "ancestor-session";
  try {
    await withNativeRequestTool({ root, requests }, async (tool) => {
      const result = await tool.execute(
        "native-identity",
        { command: `printf '%s' "$PI_SESSION_ID|$${AKUMA_REQUESTS_ENV}"` },
        new AbortController().signal,
        undefined,
        nativeSessionContext("native-child-session", "/sessions/native.jsonl"),
      );
      assert.deepEqual(result.content, [{ type: "text", text: `native-child-session|${requests}` }]);
      assert.equal(process.env[PI_SESSION_VARIABLE], "ancestor-session");
    });
  } finally {
    if (previousSession === undefined) delete process.env[PI_SESSION_VARIABLE];
    else process.env[PI_SESSION_VARIABLE] = previousSession;
    rmSync(root, { recursive: true, force: true });
  }
});

test("parent and child native Pi environments resolve distinct Square initiators", (t) => {
  t.diagnostic(`Square runtime: ${packageProvenance("@astrosheep/square")}`);
  const parent = squareAssignedParticipantName({ PI_SESSION_ID: "parent-session" });
  const child = squareAssignedParticipantName({ PI_SESSION_ID: "child-session" });
  assert.equal(typeof parent, "string");
  assert.equal(typeof child, "string");
  assert.notEqual(parent, child);
  assert.equal(parent, squareAssignedParticipantName({ PI_SESSION_ID: "parent-session" }));
  assert.equal(
    squareAssignedParticipantName({ PI_SESSION_ID: "parent-session", SQUARE_PARTICIPANT_NAME: "Alice" }),
    "Alice",
  );
  assert.equal(
    squareAssignedParticipantName({ PI_SESSION_ID: "child-session", SQUARE_PARTICIPANT_NAME: "Alice" }),
    "Alice",
  );
});

test("composed native tool contexts attribute to their own Square initiator, never the inherited ancestor", async (t) => {
  t.diagnostic(`Pi runtime: ${packageProvenance("@earendil-works/pi-coding-agent")}`);
  t.diagnostic(`Square runtime: ${packageProvenance("@astrosheep/square")}`);
  const root = mkdtempSync(join(tmpdir(), "keiyaku-pi-square-attribution-"));
  const requests = join(root, "requests");
  const previousSession = process.env[PI_SESSION_VARIABLE];
  process.env[PI_SESSION_VARIABLE] = "inherited-ancestor";
  try {
    await withNativeRequestTool({ root, requests }, async (tool) => {
      const command =
        `node -e 'process.stdout.write(JSON.stringify({ session: process.env.${PI_SESSION_VARIABLE}, ` +
        `requests: process.env.${AKUMA_REQUESTS_ENV} }))'`;
      const observe = async (sessionId: string) =>
        observedNativeIdentity(
          await tool.execute(
            "native-attribution",
            { command },
            new AbortController().signal,
            undefined,
            nativeSessionContext(sessionId),
          ),
        );

      const parent = await observe("parent-session");
      const child = await observe("child-session");
      const parentAgain = await observe("parent-session");

      assert.equal(parent.session, "parent-session");
      assert.equal(child.session, "child-session");
      assert.equal(parent.requests, requests);
      assert.equal(child.requests, requests);
      assert.equal(process.env[PI_SESSION_VARIABLE], "inherited-ancestor");

      const parentName = squareAssignedParticipantName({ [PI_SESSION_VARIABLE]: parent.session });
      const childName = squareAssignedParticipantName({ [PI_SESSION_VARIABLE]: child.session });
      const parentNameAgain = squareAssignedParticipantName({ [PI_SESSION_VARIABLE]: parentAgain.session });
      const ancestorName = squareAssignedParticipantName({ [PI_SESSION_VARIABLE]: "inherited-ancestor" });
      assert.equal(typeof parentName, "string");
      assert.equal(typeof childName, "string");
      assert.notEqual(parentName, childName);
      assert.equal(parentNameAgain, parentName);
      assert.notEqual(parentName, ancestorName);
      assert.notEqual(childName, ancestorName);
      assert.equal(
        squareAssignedParticipantName({ [PI_SESSION_VARIABLE]: child.session, SQUARE_PARTICIPANT_NAME: "Alice" }),
        "Alice",
      );
    });
  } finally {
    if (previousSession === undefined) delete process.env[PI_SESSION_VARIABLE];
    else process.env[PI_SESSION_VARIABLE] = previousSession;
    rmSync(root, { recursive: true, force: true });
  }
});
