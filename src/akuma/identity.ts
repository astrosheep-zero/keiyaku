import { z } from "zod";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { identityCoordinate, identitySegments } from "../identity/coordinates.js";
import { isCanonicalAkumaName, validateAkumaName } from "../identity/normalize.js";
declare const AKU_ID: unique symbol;

export type AkumaId = string & { readonly [AKU_ID]: true };

const HEX8 = /^[0-9a-f]{8}$/u;

export function parsePublicHistoryId(value: string): number | null {
  const match = /^turn\/([1-9][0-9]*)$/u.exec(value);
  if (match === null) return null;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) ? sequence : null;
}

export function parseExactHistorySelector(
  value: string,
): Readonly<{ kind: "turn" | "report"; sequence: number }> | null {
  const match = /^(turn|report)\/([1-9][0-9]*)$/u.exec(value);
  if (match === null) return null;
  const sequence = Number(match[2]);
  return Number.isSafeInteger(sequence) ? { kind: match[1] as "turn" | "report", sequence } : null;
}

export const turnHistoryIdSchema = z.templateLiteral(["turn/", z.number().int().positive().safe()]);

const pathText = z.string().refine((value) => value.trim() !== "");
export const akumaPathsSchema = z
  .object({
    directory: pathText,
    heart: pathText,
    leash: pathText,
    log: pathText,
  })
  .strict();
export type AkumaPaths = z.infer<typeof akumaPathsSchema>;

export type AllocatedAkuma = Readonly<{
  id: AkumaId;
  akumaName: string;
  suffix: string;
  paths: AkumaPaths;
}>;

function suffixSegment(value: string): string {
  if (!HEX8.test(value)) throw new TypeError("Akuma suffix must be lower hex8");
  return value;
}

export function akumaId(input: Readonly<{ akumaName: string; suffix: string }>): AkumaId {
  return identityCoordinate({
    family: "aku",
    segments: [validateAkumaName(input.akumaName), suffixSegment(input.suffix)],
  }) as AkumaId;
}

export function parseAkumaId(value: string): Readonly<{ id: AkumaId; akumaName: string; suffix: string }> {
  const segments = identitySegments({ family: "aku", value });
  if (segments.length !== 2) throw new TypeError("Akuma identity must be aku/<akuma>/<hex8>");
  const akumaName = segments[0]!;
  // Existing identities remain addressable after new births gain a name limit.
  if (!isCanonicalAkumaName(akumaName)) throw new TypeError("Akuma name must be one normalized human identity segment");
  const suffix = suffixSegment(segments[1]!);
  return { id: value as AkumaId, akumaName, suffix };
}

export const akumaIdSchema = z.string().transform((value, context) => {
  try {
    const id = parseAkumaId(value).id;
    if (id !== value) throw new Error("not canonical");
    return id;
  } catch {
    context.addIssue({ code: "custom", message: "expected canonical AkumaId" });
    return z.NEVER;
  }
});
export function akumaRunRoot(worldRoot: string): string {
  return join(worldRoot, ".keiyaku", "akuma", "run");
}

export function akumaPaths(
  input: Readonly<{
    runRoot: string;
    akumaName: string;
    suffix: string;
  }>,
): AkumaPaths {
  if (!isCanonicalAkumaName(input.akumaName))
    throw new TypeError("Akuma name must be one normalized human identity segment");
  const directory = join(input.runRoot, `${input.akumaName}-${suffixSegment(input.suffix)}`);
  return {
    directory,
    heart: join(directory, "heart.db"),
    leash: join(directory, "leash.db"),
    log: join(directory, "stdio.log"),
  };
}

export function akumaIdFromDirectoryName(name: string): Readonly<{ id: AkumaId; akumaName: string; suffix: string }> {
  if (name.length < 10 || name.at(-9) !== "-") throw new Error(`invalid Akuma run directory ${name}`);
  const akumaName = name.slice(0, -9);
  const suffix = name.slice(-8);
  return parseAkumaId(`aku/${akumaName}/${suffix}`);
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

export async function allocateAkumaDirectory(
  input: Readonly<{
    worldRoot: string;
    akumaName: string;
    draw?: () => string;
  }>,
): Promise<AllocatedAkuma> {
  const akumaName = validateAkumaName(input.akumaName);
  const runRoot = await ensureAkumaRunRoot(input.worldRoot);
  for (;;) {
    const suffix = suffixSegment(input.draw?.() ?? randomBytes(4).toString("hex"));
    const paths = akumaPaths({ runRoot, akumaName, suffix });
    try {
      await mkdir(paths.directory);
      return { id: akumaId({ akumaName, suffix }), akumaName, suffix, paths };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export function pathsForAkumaId(worldRoot: string, id: AkumaId): AkumaPaths {
  const parsed = parseAkumaId(id);
  return akumaPaths({ runRoot: akumaRunRoot(worldRoot), akumaName: parsed.akumaName, suffix: parsed.suffix });
}

export function worldRootForAkumaPaths(paths: AkumaPaths): string {
  const runRoot = dirname(paths.directory);
  const worldRoot = dirname(dirname(dirname(runRoot)));
  if (akumaRunRoot(worldRoot) !== runRoot) throw new Error("Akuma paths are outside the run topology");
  return worldRoot;
}
