import { MAX_AKUMA_NAME_BYTES, normalizeIdentityStem, validateAkumaName } from "./normalize.js";

declare const AKUMA_ALIAS: unique symbol;
declare const AKUMA_GLOB: unique symbol;

export type AkumaAlias = string & { readonly [AKUMA_ALIAS]: true };
export type AkumaGlob = string & { readonly [AKUMA_GLOB]: true };

const AKUMA_GLOB_SUFFIX = /^[0-9a-f*]+$/u;

const LEGACY_AKUMA_ALIAS_PATTERN = /^@[a-z][a-z0-9-]{0,63}$/u;

// Old alias spellings remain readable, but new bindings use canonical Akuma names.
export function parseReadableAkumaAlias(value: string): AkumaAlias {
  if (LEGACY_AKUMA_ALIAS_PATTERN.test(value)) return value as AkumaAlias;
  return parseAkumaAlias(value);
}

export function parseAkumaAlias(value: string): AkumaAlias {
  if (!value.startsWith("@")) throw new TypeError("Akuma alias selector must start with @");
  try {
    validateAkumaName(value.slice(1));
  } catch {
    throw new TypeError(
      `Akuma alias name must be a normalized Akuma name of at most ${MAX_AKUMA_NAME_BYTES} UTF-8 bytes`,
    );
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
