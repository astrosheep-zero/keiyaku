import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Akuma } from "../../src/akuma/index.js";
import { ALLOWED_ACTIONS } from "../../src/akuma/allowed.js";
import { AkumaHandle } from "../../src/akuma/akuma-handle.js";
import { driveAkumaBody, type TellWakeRuntime } from "../../src/akuma/body.js";
import { HeldAkumaLeash, initializeHeart } from "../../src/akuma/heart/index.js";
import { allocateAkumaDirectory } from "../../src/akuma/identity.js";
import {
  createProviderAttempt,
  type DriveInput,
  type ProviderAdapter,
  type Session,
} from "../../src/akuma/provider.js";
import { World } from "../../src/world.js";

type FixtureSession = Omit<Session, "admission" | "forceDispose"> &
  Readonly<{ admission?: Session["admission"]; forceDispose?: Session["forceDispose"] }>;

export function fixtureAttempt(
  input: Readonly<{ signal: AbortSignal }>,
  establish: () => Promise<FixtureSession>,
  fence = "tell-fixture-turn",
) {
  return createProviderAttempt(input.signal, async (custody) => {
    const fixture = await establish();
    const session: Session = {
      ...fixture,
      admission: fixture.admission ?? { fence },
      forceDispose: fixture.forceDispose ?? fixture.abort,
    };
    let settleClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      settleClosed = resolve;
    });
    void session.completion.then(settleClosed, settleClosed);
    custody.own({
      closed,
      abort: async () => {
        await session.abort();
        settleClosed();
      },
      forceDispose: async () => {
        await session.forceDispose();
        settleClosed();
      },
    });
    return session;
  });
}

export function answering(answer: string): ProviderAdapter {
  return {
    admitOptions(options) {
      return { kind: "admitted", options };
    },
    start(input) {
      return fixtureAttempt(input, async () => ({
        admission: { fence: "tell-answer" },
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: "session" as const, coordinate: { sessionId: "tell-session" } };
          },
        },
        completion: Promise.resolve({ kind: "answered" as const, answer, historyId: "tell-history" }),
        async abort() {},
      }));
    },
  };
}

export async function settleFixtureBodies(bodies: readonly Promise<unknown>[]): Promise<void> {
  await Promise.all(bodies.map((body) => body.catch(() => undefined)));
}

export function fixtureRuntime(
  bodies: Promise<unknown>[],
  fixtures: ReadonlyMap<string, Readonly<{ adapter: ProviderAdapter; now: string }>>,
): TellWakeRuntime {
  return {
    async spawn(paths) {
      const fixture = fixtures.get(paths.directory);
      if (fixture === undefined) throw new Error(`missing fixture adapter for ${paths.directory}`);
      const body = driveAkumaBody({ paths }, fixture.adapter, { now: () => fixture.now });
      bodies.push(body);
      return {
        pid: 0,
        exited: body.then(
          () => ({ code: 0, signal: null, log: { path: paths.log, from: 0, to: 0 } }),
          () => ({ code: 1, signal: null, log: { path: paths.log, from: 0, to: 0 } }),
        ),
        async terminate() {},
        release() {},
      };
    },
  };
}

export function installTellRuntime(runtime: TellWakeRuntime): () => void {
  const originalTell = AkumaHandle.prototype.tell;
  AkumaHandle.prototype.tell = function (body, tellId, recordedAt, existingRuntime, schemaJson) {
    return originalTell.call(this, body, tellId, recordedAt, existingRuntime ?? runtime, schemaJson);
  };
  return () => {
    AkumaHandle.prototype.tell = originalTell;
  };
}

export async function bornWorld(root: string, suffix: string) {
  const world = await World.at(root);
  mkdirSync(join(root, ".keiyaku"), { recursive: true });
  writeFileSync(join(root, ".keiyaku", "settings.json"), JSON.stringify({ plugins: { square: { enabled: false } } }));
  const allocated = await allocateAkumaDirectory({ worldRoot: world, archetype: "claude", draw: () => suffix });
  await initializeHeart(allocated.paths);
  const holder = (await HeldAkumaLeash.try(allocated.paths))!;
  try {
    await holder.birth(allocated.paths, {
      id: allocated.id,
      archetype: "claude",
      provider: { name: "claude", kind: "claude-agent-sdk" },
      options: {},
      cwd: world,
      origin: { kind: "direct" },
      allowed: ALLOWED_ACTIONS,
      createdAt: "2026-08-10T00:00:00.000Z",
    });
  } finally {
    holder.release();
  }
  return { world, allocated, akuma: Akuma.select(world, allocated.id) };
}

/** A fresh admitting adapter; session custody still uses the real ProviderAttempt. */
export function fixtureAdapter(establish: (input: DriveInput) => Promise<FixtureSession>): ProviderAdapter {
  return {
    admitOptions: (options) => ({ kind: "admitted", options }),
    start: (input) => fixtureAttempt(input, () => establish(input)),
  };
}
