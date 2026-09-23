const GRAPHEMES = new Intl.Segmenter("und", { granularity: "grapheme" });
const WORD_GRAPHEME = /^[\p{Letter}\p{Number}\p{Mark}]+$/u;
const EMOJI_GRAPHEME = new RegExp("^\\p{RGI_Emoji}$", "v");
const SUFFIX = /^[\p{Letter}\p{Number}]+$/u;

function graphemes(value: string): readonly string[] {
  return [...GRAPHEMES.segment(value)].map(({ segment }) => segment);
}

export const MAX_AKUMA_NAME_BYTES = 64;

export function isCanonicalAkumaName(value: string): boolean {
  return value.length > 0 && normalizeIdentityStem({ source: value }) === value;
}

export function validateAkumaName(value: string): string {
  if (!isCanonicalAkumaName(value) || Buffer.byteLength(value, "utf8") > MAX_AKUMA_NAME_BYTES) {
    throw new TypeError(
      `Akuma name must be one normalized human identity segment of at most ${MAX_AKUMA_NAME_BYTES} UTF-8 bytes`,
    );
  }
  return value;
}

export function normalizeIdentityStem(input: Readonly<{ source: string }>): string {
  const source = input.source.normalize("NFKC").toLowerCase().normalize("NFKC");
  let result = "";
  let separator = false;
  for (const segment of graphemes(source)) {
    if (!WORD_GRAPHEME.test(segment) && !EMOJI_GRAPHEME.test(segment)) {
      separator ||= result.length > 0;
      continue;
    }
    if (separator) result += "-";
    result += segment;
    separator = false;
  }
  return result;
}

export function fitIdentityStemWords(
  input: Readonly<{
    stem: string;
    maxCodePoints: number;
  }>,
): string {
  if (!Number.isSafeInteger(input.maxCodePoints) || input.maxCodePoints < 1) {
    throw new Error("identity stem code point budget must be a positive safe integer");
  }
  const words = input.stem.split("-");
  let fitted = truncateGraphemes(words[0]!, input.maxCodePoints);
  let count = [...fitted].length;
  for (const word of words.slice(1)) {
    const candidate = count + 1 + [...word].length;
    if (candidate > input.maxCodePoints) break;
    fitted += `-${word}`;
    count = candidate;
  }
  if (fitted.length === 0) throw new Error("identity stem is empty after fitting");
  return fitted;
}

function truncateGraphemes(value: string, maxCodePoints: number): string {
  let result = "";
  let count = 0;
  for (const { segment } of GRAPHEMES.segment(value)) {
    const size = [...segment].length;
    if (count + size > maxCodePoints) break;
    result += segment;
    count += size;
  }
  return result;
}

export function fitIdentityStem(
  input: Readonly<{
    stem: string;
    maxBytes: number;
    suffix?: string;
  }>,
): string {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) {
    throw new Error("identity stem byte budget must be a positive safe integer");
  }
  if (input.suffix !== undefined && !SUFFIX.test(input.suffix)) {
    throw new Error("identity suffix must contain only letters or numbers");
  }
  const suffix = input.suffix === undefined ? "" : `-${input.suffix}`;
  const budget = input.maxBytes - Buffer.byteLength(suffix);
  if (budget < 1) throw new Error("identity stem byte budget cannot contain its suffix");

  let stem = "";
  for (const segment of graphemes(input.stem)) {
    if (Buffer.byteLength(stem + segment) > budget) break;
    stem += segment;
  }
  stem = stem.replace(/-+$/u, "");
  if (stem.length === 0) throw new Error("identity stem is empty after fitting");
  return stem + suffix;
}
