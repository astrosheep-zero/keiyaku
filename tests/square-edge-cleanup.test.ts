import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Square } from "@astrosheep/square";
import { recognizeAndListen } from "../src/cli/square-edge.js";
import { AKUMA_REQUESTS_ENV } from "../src/akuma/provider.js";
import { invokeAkuma } from "../src/cli/commands/akuma-invoke.js";
import { parseArgv } from "../src/cli/parse.js";
import { writeFileSync } from "node:fs";

async function committedSquare(root: string) {
  const squarePath = join(root, ".square", "KEIYAKU.square");
  const registry = join(root, "registry.ndjsonl");
  const routes = join(root, "routes.ndjsonl");
  mkdirSync(join(root, ".square"), { recursive: true });
  const square = await Square.build({ path: squarePath, markdown: "" });
  await square.close();
  const environment = {
    ...process.env,
    CODEX_THREAD_ID: "caller",
    SQUARE_PARTICIPANT_NAME: "Alice",
    SQUARE_REGISTRY: registry,
    SQUARE_ROUTES: routes,
  };
  const previousRegistry = process.env.SQUARE_REGISTRY;
  const previousRoutes = process.env.SQUARE_ROUTES;
  process.env.SQUARE_REGISTRY = registry;
  process.env.SQUARE_ROUTES = routes;
  try {
    const listener = await recognizeAndListen(root, environment, { id: "aku/test" } as never);
    assert.ok(listener?.committed);
    return {
      listener: listener!,
      environment,
      restore: () => {
        if (previousRegistry === undefined) delete process.env.SQUARE_REGISTRY;
        else process.env.SQUARE_REGISTRY = previousRegistry;
        if (previousRoutes === undefined) delete process.env.SQUARE_ROUTES;
        else process.env.SQUARE_ROUTES = previousRoutes;
      },
    };
  } catch (error) {
    if (previousRegistry === undefined) delete process.env.SQUARE_REGISTRY;
    else process.env.SQUARE_REGISTRY = previousRegistry;
    if (previousRoutes === undefined) delete process.env.SQUARE_ROUTES;
    else process.env.SQUARE_ROUTES = previousRoutes;
    throw error;
  }
}

test("Square rollback independently attempts ignore and done", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-square-cleanup-"));
  try {
    const { listener, restore } = await committedSquare(root);
    t.mock.method(
      Square.prototype,
      "join",
      async () =>
        ({
          ignore: async () => {
            throw new Error("ignore injected");
          },
          done: async () => {
            throw new Error("done injected");
          },
        }) as never,
    );
    await assert.rejects(listener.rollback(), /ignore injected.*done injected/u);
    restore();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Square rollback reports close failure", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-square-close-"));
  try {
    const { listener, restore } = await committedSquare(root);
    t.mock.method(Square.prototype, "close", async () => {
      throw new Error("close injected");
    });
    await assert.rejects(listener.rollback(), /close injected/u);
    restore();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Square rollback reports unbind failure after other cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-square-unbind-"));
  try {
    const { listener, environment, restore } = await committedSquare(root);
    assert.equal(environment.CODEX_THREAD_ID, "caller");
    environment.CODEX_THREAD_ID = "";
    environment.PASEO_AGENT_ID = "";
    await assert.rejects(listener.rollback(), /participant binding was not removed/u);
    restore();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Square rollback preserves normal cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-square-normal-"));
  try {
    const { listener, restore } = await committedSquare(root);
    await listener.rollback();
    restore();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launch failure keeps the primary error and all independent rollback failures", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-square-launch-failure-"));
  const home = join(root, ".home");
  const registry = join(root, "sessions.ndjsonl");
  const routes = join(root, "routes.ndjsonl");
  mkdirSync(join(home, "akuma"), { recursive: true });
  writeFileSync(join(home, "akuma", "worker.md"), "---\nprovider: claude\n---\nWorker.\n");
  const previousRegistry = process.env.SQUARE_REGISTRY;
  const previousRoutes = process.env.SQUARE_ROUTES;
  const previousRequests = process.env[AKUMA_REQUESTS_ENV];
  process.env.SQUARE_REGISTRY = registry;
  process.env.SQUARE_ROUTES = routes;
  delete process.env[AKUMA_REQUESTS_ENV];
  const environment = {
    ...process.env,
    KEIYAKU_HOME: home,
    CODEX_THREAD_ID: "caller",
    SQUARE_PARTICIPANT_NAME: "Alice",
    SQUARE_ROUTES: routes,
  };
  try {
    writeFileSync(
      registry,
      `${JSON.stringify({
        v: 1,
        ts: new Date().toISOString(),
        op: "join",
        channel: "codex",
        session_id: "caller",
        name: "Alice",
        square_path: join(root, ".square", "PUBLIC.square"),
        owner_id: "caller-owner",
      })}\n`,
    );
    const command = parseArgv(["-C", root, "call", "worker", "prompt"]).command;
    await assert.rejects(
      invokeAkuma(command, {
        path: root,
        home,
        environment,
        readStdin: async () => "prompt",
        finishCall: async () => {
          const originalJoin = Square.prototype.join;
          t.mock.method(Square.prototype, "join", async function (name: string) {
            const participant = await originalJoin.call(this, name);
            return {
              ...participant,
              ignore: async () => {
                throw new Error("ignore injected");
              },
              done: async () => {
                throw new Error("done injected");
              },
            } as never;
          });
          t.mock.method(Square.prototype, "close", async () => {
            throw new Error("close injected");
          });
          environment.CODEX_THREAD_ID = "";
          environment.PASEO_AGENT_ID = "";
          throw new Error("launch injected");
        },
      }),
      (error: unknown) => {
        assert.match(error instanceof Error ? error.message : String(error), /launch injected/u);
        assert.match(error instanceof Error ? error.message : String(error), /ignore: ignore injected/u);
        assert.match(error instanceof Error ? error.message : String(error), /done: done injected/u);
        assert.match(error instanceof Error ? error.message : String(error), /close: close injected/u);
        assert.match(
          error instanceof Error ? error.message : String(error),
          /unbind: participant binding was not removed/u,
        );
        assert.equal(
          error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
          "launch injected",
        );
        return true;
      },
    );
  } finally {
    if (previousRegistry === undefined) delete process.env.SQUARE_REGISTRY;
    else process.env.SQUARE_REGISTRY = previousRegistry;
    if (previousRoutes === undefined) delete process.env.SQUARE_ROUTES;
    else process.env.SQUARE_ROUTES = previousRoutes;
    if (previousRequests === undefined) delete process.env[AKUMA_REQUESTS_ENV];
    else process.env[AKUMA_REQUESTS_ENV] = previousRequests;
    rmSync(root, { recursive: true, force: true });
  }
});
