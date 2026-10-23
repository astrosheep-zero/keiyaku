import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import * as nativePi from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadPreparedArchetype } from "../../src/akuma/archetype.js";
import { AkumaOwner } from "../../src/akuma/akuma-owner.js";
import { driveAkumaBody, type BodyLaunch } from "../../src/akuma/body.js";
import { admitCallInitialTell } from "../../src/akuma/call-initial-tell.js";
import { type AkuId } from "../../src/akuma/identity.js";
import { createPiProvider, type PiSdk } from "../../src/akuma/providers/pi/index.js";
import { akumaExecutionEnvironment } from "../../src/akuma/providers/execution-environment.js";
import { executePreparedCall } from "../../src/akuma/publication.js";
import { settings } from "../../src/settings.js";
import { World, type WorldRoot } from "../../src/world.js";
import { registerAkumaTools } from "./tools.js";

/** Experimental entry only: importing this file does not register it in the shipped Pi package. */
export function createPocExtension(loadSdk: () => Promise<PiSdk> = async () => nativePi) {
  return (pi: ExtensionAPI): void => {
    const bodies = new Map<AkuId, { world: WorldRoot; done: Promise<void | "held"> }>();
    let closing = false;

    async function noDetachedFallback(): Promise<never> {
      throw new Error("Pi in-process PoC does not support nested delegation or detached handoff");
    }

    function start(launch: BodyLaunch, world: WorldRoot): void {
      if (closing) throw new Error("Pi in-process PoC is shutting down");
      const id = launch.seed?.id;
      if (id === undefined) throw new Error("PoC launch must carry its birth recipe");
      const adapter = createPiProvider(launch.seed!.provider, async () => {
        const sdk = await loadSdk();
        return {
          ...sdk,
          // Child extensions must not borrow host identity or recursively register this tool.
          createAgentSessionServices: (options) =>
            sdk.createAgentSessionServices({
              ...options,
              resourceLoaderOptions: { ...options.resourceLoaderOptions, noExtensions: true },
            }),
          createBashToolDefinition: (cwd, options) =>
            sdk.createBashToolDefinition(cwd, {
              ...options,
              spawnHook: (context) => {
                const prepared = options?.spawnHook?.(context) ?? context;
                return {
                  ...prepared,
                  env: akumaExecutionEnvironment(
                    prepared.env,
                    {
                      KEIYAKU_ACTOR_ID: id,
                      KEIYAKU_ACTOR_WORLD: world,
                    },
                    prepared.env.AKUMA_REQUESTS,
                    ["PI_SESSION_ID", "PI_SESSION_FILE"],
                  ),
                };
              },
            }),
        };
      });
      const done = driveAkumaBody(launch, adapter, {
        world,
        spawnChild: noDetachedFallback,
        spawnBody: noDetachedFallback,
      });
      bodies.set(id, { world, done });
      void done
        .catch((error: unknown) => console.error(`Pi in-process PoC ${id}:`, error))
        .finally(() => {
          if (bodies.get(id)?.done === done) bodies.delete(id);
        });
    }

    pi.registerTool({
      name: "akuma_call",
      label: "Akuma Call (in-process PoC)",
      description:
        "Start a Pi-backed Akuma inside this Pi process. Returns its ID after birth and first-input admission; use akuma_status, akuma_tell, akuma_ask, akuma_wait, akuma_history or akuma_kill to manage it. Experimental: only Pi definitions, no child extensions or nested delegation. Host shutdown stops owned Bodies; later CLI wake is not host-routed.",
      // TypeBox-compatible literal schema avoids adding a dependency to the experiment.
      parameters: {
        type: "object",
        properties: {
          akuma: { type: "string", minLength: 1, description: "Existing Akuma definition name" },
          body: { type: "string", minLength: 1, description: "Task content" },
          workdir: { type: "string", minLength: 1, description: "Execution directory, relative to this session's cwd" },
        },
        required: ["akuma", "body"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(_toolCallId, raw, signal, _onUpdate, ctx) {
        if (closing) throw new Error("Pi in-process PoC is shutting down");
        const input = raw as { akuma: string; body: string; workdir?: string };
        if (!input.body.trim()) throw new Error("body must not be blank");
        signal?.throwIfAborted();
        const cwd = await realpath(resolve(ctx.cwd, input.workdir ?? "."));
        if (!(await stat(cwd)).isDirectory()) throw new Error(`workdir is not a directory: ${cwd}`);
        const world = await (await World.resolve(ctx.cwd)).establish();
        const definition = await loadPreparedArchetype({
          name: input.akuma,
          project: world,
          settings: await settings({ root: world }),
        });
        if (definition.provider.kind !== "pi")
          throw new Error("Pi in-process PoC requires a Pi-backed Akuma definition");
        let birthLaunch: BodyLaunch | undefined;
        const result = await executePreparedCall({
          archetype: definition.name,
          cwd,
          ...(signal === undefined ? {} : { signal }),
          caller: { kind: "external", integration: "pi", id: ctx.sessionManager.getSessionId() },
          initialTell: { tellId: randomUUID(), body: input.body },
          custody: {
            kind: "local",
            world,
            recipe: {
              provider: definition.provider,
              options: definition.options,
              allowed: definition.allowed,
              ...(definition.description === undefined ? {} : { description: definition.description }),
            },
            spawn: async (launch) => {
              birthLaunch = launch;
              start(launch, world);
            },
            admitInitialTell: async ({ id, initialTell, signal: tellSignal }) => {
              const owner = new AkumaOwner(id, world);
              return await admitCallInitialTell({
                world,
                id,
                initialTell,
                ...(tellSignal === undefined ? {} : { signal: tellSignal }),
                wake: async (tell) => {
                  // The birth Body is already asleep here. Drive the recorded input in this host.
                  start({ ...birthLaunch!, refuseIfHeld: true }, world);
                  // This is an instantaneous receipt, not a fabricated delivery guarantee.
                  return await owner.admittedReceipt(tell.id);
                },
              });
            },
          },
        });
        if (result.failure !== undefined) {
          throw new Error(`Akuma ${result.child.id} was born but first-input setup failed`, { cause: result.failure });
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ id: result.child.id }) }],
          details: { id: result.child.id },
          structuredContent: { id: result.child.id },
        };
      },
    });

    registerAkumaTools(pi, () => closing);

    pi.on("session_shutdown", async () => {
      closing = true;
      const owned = [...bodies.entries()];
      const stopped = await Promise.allSettled(
        owned.map(async ([id, body]) => {
          const receipt = await new AkumaOwner(id, body.world).kill();
          if (!["killed", "already-killed", "already-stopped"].includes(receipt)) {
            throw new Error(`Could not stop ${id}: ${receipt}`);
          }
          await body.done;
        }),
      );
      const failures = stopped.filter((result) => result.status === "rejected");
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "PoC shutdown failed",
        );
    });
  };
}

export default createPocExtension();
