import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { akumaWithLauncher, type Akuma } from "../../src/akuma/akuma-instance.js";
import type { BodyLauncher } from "../../src/akuma/body-launch.js";
import { ALLOWED_ACTIONS } from "../../src/akuma/allowed.js";
import { driveAkumaBody } from "../../src/akuma/body.js";
import { HeldAkumaLeash, initializeHeart } from "../../src/akuma/heart/index.js";
import { allocateAkumaDirectory } from "../../src/akuma/identity.js";
import {
  createProviderAttempt,
  type DriveInput,
  type ProviderAdapter,
  type Session,
} from "../../src/akuma/provider.js";
import { World, type WorldRoot } from "../../src/world.js";
import { noBodyLaunch } from "./akuma-fixtures.js";

type FixtureResource = Readonly<{
  closed?: Promise<void>;
  abort?: () => Promise<void>;
  forceDispose?: () => Promise<void>;
}>;

type FixtureSession = Omit<Session, "admission"> &
  Readonly<{ admission?: Session["admission"]; resource?: FixtureResource }>;

export function fixtureAttempt(
  input: Readonly<{ signal: AbortSignal }>,
  establish: () => Promise<FixtureSession>,
  fence = "tell-fixture-turn",
) {
  return createProviderAttempt(input.signal, async (custody) => {
    const fixture = await establish();
    const { admission, resource, ...session } = fixture;
    custody.own({
      closed: resource?.closed ?? fixture.completion.then(() => undefined, () => undefined),
      ...(resource?.abort === undefined ? {} : { abort: resource.abort }),
      forceDispose: resource?.forceDispose ?? resource?.abort ?? (async () => undefined),
    });
    return {
      ...session,
      admission: admission ?? { fence },
    };
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
        resource: { abort: async () => {} },
      }));
    },
  };
}

export async function settleFixtureBodies(bodies: readonly Promise<unknown>[]): Promise<void> {
  await Promise.all(bodies.map((body) => body.catch(() => undefined)));
}

export function fixtureLauncher(
  bodies: Promise<unknown>[],
  fixtures: ReadonlyMap<string, Readonly<{ adapter: ProviderAdapter; now: string }>>,
): BodyLauncher {
  return async (launch) => {
    const fixture = fixtures.get(launch.paths.directory);
    if (fixture === undefined) throw new Error(`missing fixture adapter for ${launch.paths.directory}`);
    // This test host queues behind short observation custody instead of refusing a busy seat.
    const body = driveAkumaBody({ ...launch, refuseIfHeld: false }, fixture.adapter, { spawn: noBodyLaunch, requestSpawn: noBodyLaunch, now: () => fixture.now });
    bodies.push(body);
    return {
      completed: body.then(
        (result) => ({ diagnostic: "fixture Body completed", held: result === "held" }),
        (error: unknown) => ({ diagnostic: error instanceof Error ? error.message : String(error) }),
      ),
      async cancel() {},
      release() {},
    };
  };
}

export async function bornWorld(root: string, suffix: string, spawn: BodyLauncher = noBodyLaunch): Promise<{
  world: WorldRoot;
  allocated: Awaited<ReturnType<typeof allocateAkumaDirectory>>;
  akuma: Akuma;
}> {
  const world = await World.at(root);
  mkdirSync(join(root, ".keiyaku"), { recursive: true });
  writeFileSync(
    join(root, ".keiyaku", "settings.json"),
    JSON.stringify({ plugins: { square: { package: "@astrosheep/keiyaku-plugin-square", enabled: false } } }),
  );
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
  return { world, allocated, akuma: akumaWithLauncher(world, allocated.id, spawn) };
}

/** A fresh admitting adapter; session custody still uses the real ProviderAttempt. */
export function fixtureAdapter(establish: (input: DriveInput) => Promise<FixtureSession>): ProviderAdapter {
  return {
    admitOptions: (options) => ({ kind: "admitted", options }),
    start: (input) => fixtureAttempt(input, () => establish(input)),
  };
}
