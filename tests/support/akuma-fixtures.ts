import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ALLOWED_ACTIONS } from "../../src/akuma/allowed.js";
import type { BodyLaunch } from "../../src/akuma/body.js";
import {
  HeldAkumaLeash,
  initializeHeart,
  recordTell as heartRecordTell,
  type Soul,
  type TimelineFact,
} from "../../src/akuma/heart/index.js";
import { allocateAkumaDirectory } from "../../src/akuma/identity.js";
import { World } from "../../src/world.js";

type AllocatedAkuma = Awaited<ReturnType<typeof allocateAkumaDirectory>>;
type ActivityFact = Extract<TimelineFact, { kind: "activity" }>;
type TurnEndFact = Extract<TimelineFact, { kind: "turn-end" }>;

/** Allocate one Akuma directory under a World root and initialize its Heart. */
export async function allocatedHeart(root: string, archetype: string, draw: string) {
  const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype, draw: () => draw });
  await initializeHeart(allocated.paths);
  return allocated;
}

/** Allocate, initialize, and birth one direct-origin Soul under a caller-held leash. */
export async function bornDirectAkuma(
  input: Readonly<{
    root: string;
    archetype: string;
    draw: string;
    createdAt: string;
    allowed?: Soul["allowed"] | undefined;
    provider?: Soul["provider"];
  }>,
) {
  const allocated = await allocatedHeart(input.root, input.archetype, input.draw);
  const soul: Soul = {
    id: allocated.id,
    archetype: input.archetype,
    provider: input.provider ?? { name: "codex-app-server", kind: "codex-app-server" },
    options: {},
    cwd: input.root,
    origin: { kind: "direct" },
    allowed: input.allowed ?? ALLOWED_ACTIONS,
    createdAt: input.createdAt,
  };
  const leash = (await HeldAkumaLeash.try(allocated.paths))!;
  await leash.birth(allocated.paths, soul);
  return { ...allocated, soul, leash };
}

/** Keep the data under test explicit; only the repeated carrier shape lives here. */
export function activityFact(
  sequence: number,
  turnSequence: number,
  at: string,
  event: ActivityFact["event"],
): ActivityFact {
  return { kind: "activity", sequence, turnSequence, at, event };
}

export function turnEndFact(
  sequence: number,
  turnSequence: number,
  completedAt: string,
  outcome: TurnEndFact["outcome"],
): TurnEndFact {
  return { kind: "turn-end", sequence, turnSequence, completedAt, outcome };
}

/** A fresh Heart-initialized World root with an allocated claude Akuma; the caller closes it. */
export async function heartFixture(prefix: string) {
  const root = await World.at(mkdtempSync(join(tmpdir(), prefix)));
  const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1234abcd" });
  await initializeHeart(allocated.paths);
  return { root, allocated, close: () => rmSync(root, { recursive: true, force: true }) };
}

/** The shared direct-origin Soul basis for a Heart fixture; scenario time stays at the call site. */
export async function soulFixture(prefix: string) {
  const value = await heartFixture(prefix);
  const soul: Soul = {
    id: value.allocated.id,
    archetype: "claude",
    description: "Claude fixture",
    provider: { name: "claude", kind: "claude-agent-sdk" },
    options: { model: "claude-sonnet-4-5", systemPrompt: "Be precise." },
    cwd: value.root,
    origin: { kind: "direct" },
    allowed: ALLOWED_ACTIONS,
    createdAt: "2026-08-08T00:00:00.000Z",
  };
  return { ...value, soul };
}

/** One born claude Body under a fresh Heart: the invariant direct-origin, empty-permission,
 * default-options life; createdAt is the scenario's exact time. */
export async function bornBody(root: string, suffix: string, createdAt: string) {
  const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => suffix });
  await initializeHeart(allocated.paths);
  const holder = (await HeldAkumaLeash.try(allocated.paths))!;
  await holder.birth(allocated.paths, {
    id: allocated.id,
    archetype: "claude",
    provider: { name: "claude", kind: "claude-agent-sdk" },
    options: {},
    origin: { kind: "direct" },
    allowed: [],
    cwd: root,
    createdAt,
  });
  const body = await holder.recordBody(allocated.paths, { leashTakenAt: createdAt });
  return { allocated, holder, body };
}

/** Admit one scenario Tell through Heart; identity, body, and time stay explicit. */
export async function recordTell(
  paths: Parameters<typeof heartRecordTell>[0],
  tell: Readonly<{ id: string; body: string; recordedAt: string; initiator?: string }>,
) {
  return await heartRecordTell(paths, { kind: "tell", ...tell });
}

/** Write one old-version schema row so an owner open can prove its hard refusal. */
export function seedLegacySchema(path: string, table: "akuma_schema" | "leash_schema", version: number): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(
      `CREATE TABLE ${table}(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO ${table} VALUES (1, ${version})`,
    );
  } finally {
    database.close();
  }
}

/** A fresh launch object per call; no shared Heart, adapter, options, or lifecycle. */
export function claudeBodyLaunch(
  allocated: AllocatedAkuma,
  cwd: string,
  initialBody: string,
  extra: Omit<BodyLaunch, "paths" | "seed" | "initialBody"> = {},
): BodyLaunch {
  return {
    paths: allocated.paths,
    seed: {
      id: allocated.id,
      archetype: "claude",
      provider: { name: "claude", kind: "claude-agent-sdk" },
      options: {},
      origin: { kind: "direct" },
      allowed: ALLOWED_ACTIONS,
      cwd,
    },
    initialBody,
    ...extra,
  };
}
