import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { identityCoordinate, identitySegments } from "../identity/coordinates.js";
import { normalizeIdentityStem } from "../identity/normalize.js";
declare const AKU_ID: unique symbol;

export type AkuId = string & { readonly [AKU_ID]: true };

const HEX8 = /^[0-9a-f]{8}$/u;

export type AkumaPaths = Readonly<{
  directory: string;
  heart: string;
  leash: string;
  log: string;
}>;

export type AllocatedAkuma = Readonly<{
  id: AkuId;
  archetype: string;
  suffix: string;
  paths: AkumaPaths;
}>;

export function archetypeName(value: string): string {
  if (value.length === 0 || normalizeIdentityStem({ source: value }) !== value) {
    throw new TypeError("Akuma name must be one normalized human identity segment");
  }
  return value;
}

function suffixSegment(value: string): string {
  if (!HEX8.test(value)) throw new TypeError("Akuma suffix must be lower hex8");
  return value;
}

export function akuId(input: Readonly<{ archetype: string; suffix: string }>): AkuId {
  return identityCoordinate({
    family: "aku",
    segments: [archetypeName(input.archetype), suffixSegment(input.suffix)],
  }) as AkuId;
}

export function parseAkuId(value: string): Readonly<{ id: AkuId; archetype: string; suffix: string }> {
  const segments = identitySegments({ family: "aku", value });
  if (segments.length !== 2) throw new TypeError("Akuma identity must be aku/<akuma>/<hex8>");
  const archetype = archetypeName(segments[0]!);
  const suffix = suffixSegment(segments[1]!);
  return { id: akuId({ archetype, suffix }), archetype, suffix };
}

export function akumaRunRoot(worldRoot: string): string {
  return join(worldRoot, ".keiyaku", "akuma", "run");
}

export function akumaPaths(input: Readonly<{
  runRoot: string;
  archetype: string;
  suffix: string;
}>): AkumaPaths {
  const directory = join(input.runRoot, `${archetypeName(input.archetype)}-${suffixSegment(input.suffix)}`);
  return {
    directory,
    heart: join(directory, "heart.db"),
    leash: join(directory, "leash.db"),
    log: join(directory, "stdio.log"),
  };
}

export function akuIdFromDirectoryName(name: string): Readonly<{ id: AkuId; archetype: string; suffix: string }> {
  if (name.length < 10 || name.at(-9) !== "-") throw new Error(`invalid Akuma run directory ${name}`);
  const archetype = name.slice(0, -9);
  const suffix = name.slice(-8);
  return { id: akuId({ archetype, suffix }), archetype, suffix };
}

export async function ensureAkumaRunRoot(worldRoot: string): Promise<string> {
  const runRoot = akumaRunRoot(worldRoot);
  await mkdir(runRoot, { recursive: true });
  try {
    await writeFile(join(runRoot, ".gitignore"), "*\n", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return runRoot;
}

export async function allocateAkumaDirectory(input: Readonly<{
  worldRoot: string;
  archetype: string;
  draw?: () => string;
}>): Promise<AllocatedAkuma> {
  const archetype = archetypeName(input.archetype);
  const runRoot = await ensureAkumaRunRoot(input.worldRoot);
  for (;;) {
    const suffix = suffixSegment(input.draw?.() ?? randomBytes(4).toString("hex"));
    const paths = akumaPaths({ runRoot, archetype, suffix });
    try {
      await mkdir(paths.directory);
      return { id: akuId({ archetype, suffix }), archetype, suffix, paths };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export function pathsForAkuId(worldRoot: string, id: AkuId): AkumaPaths {
  const parsed = parseAkuId(id);
  return akumaPaths({ runRoot: akumaRunRoot(worldRoot), archetype: parsed.archetype, suffix: parsed.suffix });
}

export function worldRootForAkumaPaths(paths: AkumaPaths): string {
  const runRoot = dirname(paths.directory);
  const worldRoot = dirname(dirname(dirname(runRoot)));
  if (akumaRunRoot(worldRoot) !== runRoot) throw new Error("Akuma paths are outside the run topology");
  return worldRoot;
}
