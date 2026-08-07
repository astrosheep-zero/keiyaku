const GRAPHEMES = new Intl.Segmenter("und", { granularity: "grapheme" });
const READABLE = /[\p{Letter}\p{Number}\p{Extended_Pictographic}]/u;
const SUFFIX = /^[\p{Letter}\p{Number}]+$/u;

function graphemes(value: string): readonly string[] {
  return [...GRAPHEMES.segment(value)].map(({ segment }) => segment);
}

export function normalizeReadableStem(input: Readonly<{ source: string }>): string {
  const source = input.source.normalize("NFKC").toLowerCase();
  let result = "";
  let separator = false;
  for (const segment of graphemes(source)) {
    if (!READABLE.test(segment)) {
      separator ||= result.length > 0;
      continue;
    }
    if (separator) result += "-";
    result += segment;
    separator = false;
  }
  return result;
}

export function fitReadableStem(input: Readonly<{
  stem: string;
  maxBytes: number;
  suffix?: string;
}>): string {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) {
    throw new Error("readable stem byte budget must be a positive safe integer");
  }
  if (input.suffix !== undefined && !SUFFIX.test(input.suffix)) {
    throw new Error("readable identity suffix must contain only letters or numbers");
  }
  const suffix = input.suffix === undefined ? "" : `-${input.suffix}`;
  const budget = input.maxBytes - Buffer.byteLength(suffix);
  if (budget < 1) throw new Error("readable stem byte budget cannot contain its suffix");

  let stem = "";
  for (const segment of graphemes(input.stem)) {
    if (Buffer.byteLength(stem + segment) > budget) break;
    stem += segment;
  }
  stem = stem.replace(/-+$/u, "");
  if (stem.length === 0) throw new Error("readable stem is empty after fitting");
  return stem + suffix;
}
