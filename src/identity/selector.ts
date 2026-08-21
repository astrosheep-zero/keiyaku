declare const AKUMA_ALIAS: unique symbol;
declare const AKUMA_GLOB: unique symbol;

export type AkumaAlias = string & { readonly [AKUMA_ALIAS]: true };
export type AkumaGlob = string & { readonly [AKUMA_GLOB]: true };

const AKUMA_ALIAS_PATTERN = /^@[a-z][a-z0-9-]{0,63}$/u;
const AKUMA_GLOB_SUFFIX = /^[0-9a-f*]+$/u;

export function parseAkumaAlias(value: string): AkumaAlias {
  if (!AKUMA_ALIAS_PATTERN.test(value)) {
    throw new TypeError("Akuma alias must match ^@[a-z][a-z0-9-]{0,63}$");
  }
  return value as AkumaAlias;
}

export function parseAkumaGlob(value: string): AkumaGlob {
  const segments = value.split("/");
  const archetype = segments[1] ?? "";
  const archetypeProbe = archetype.replaceAll("*", "x");
  if (
    segments.length !== 3 ||
    segments[0] !== "aku" ||
    !value.includes("*") ||
    archetype.length === 0 ||
    normalizeIdentityStem({ source: archetypeProbe }) !== archetypeProbe ||
    !AKUMA_GLOB_SUFFIX.test(segments[2] ?? "")
  ) {
    throw new TypeError("Akuma glob must be aku/<akuma-pattern>/<hex-pattern> and contain *");
  }
  return value as AkumaGlob;
}

export function matchesAkumaGlob(glob: AkumaGlob, value: string): boolean {
  const pattern = parseAkumaGlob(glob)
    .replaceAll(/[.+?^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("*", "[^/]*");
  return new RegExp(`^${pattern}$`, "u").test(value);
}
import { normalizeIdentityStem } from "./normalize.js";
