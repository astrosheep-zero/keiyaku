declare const AKUMA_ALIAS: unique symbol;

export type AkumaAlias = string & { readonly [AKUMA_ALIAS]: true };

const AKUMA_ALIAS_PATTERN = /^@[a-z][a-z0-9-]{0,63}$/u;

export function parseAkumaAlias(value: string): AkumaAlias {
  if (!AKUMA_ALIAS_PATTERN.test(value)) {
    throw new TypeError("Akuma alias must match ^@[a-z][a-z0-9-]{0,63}$");
  }
  return value as AkumaAlias;
}
