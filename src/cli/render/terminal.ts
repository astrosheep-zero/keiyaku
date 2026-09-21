export type TextRenderContext = Readonly<{ columns: number; color: boolean }>;

export type GitShortStat = Readonly<{
  filesChanged: number;
  insertions: number;
  deletions: number;
}>;

export function gitShortStat(stat: GitShortStat): string {
  const files = stat.filesChanged === 1 ? "1 file changed" : `${stat.filesChanged} files changed`;
  const parts = [files];
  if (stat.insertions === 1) parts.push("1 insertion(+)");
  else if (stat.insertions !== 0) parts.push(`${stat.insertions} insertions(+)`);
  if (stat.deletions === 1) parts.push("1 deletion(-)");
  else if (stat.deletions !== 0) parts.push(`${stat.deletions} deletions(-)`);
  return parts.join(", ");
}

const GRAPHEMES = new Intl.Segmenter("und", { granularity: "grapheme" });
const NON_ASCII = /[^\x20-\x7e]/u;
const MARK = /\p{Mark}/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const EMOJI_DEFAULT = /\p{Emoji_Presentation}/u;
const ZWJ = 0x200d;
const TEXT_PRESENTATION = 0xfe0e;
const EMOJI_PRESENTATION = 0xfe0f;
const REGIONAL_FIRST = 0x1f1e6;
const REGIONAL_LAST = 0x1f1ff;
const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff]);

const WIDE_RANGES = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
] as const;

/** Columns one code point occupies when its grapheme cluster gives it no wider form. */
function baseColumns(point: number): number {
  if (point === 0 || point < 0x20 || (point >= 0x7f && point < 0xa0)) return 0;
  if (ZERO_WIDTH.has(point) || MARK.test(String.fromCodePoint(point))) return 0;
  if (point === 0x303f) return 1;
  return WIDE_RANGES.some(([first, last]) => point >= first && point <= last) ? 2 : 1;
}

/**
 * Columns one grapheme cluster occupies. A cluster is one terminal cell group even
 * when it is built from many code points, so ZWJ sequences, flags, keycaps and
 * variation selectors never count the width of their parts.
 */
function graphemeColumns(cluster: string): number {
  const points = [...cluster].map((character) => character.codePointAt(0)!);
  if (points.every((point) => point === EMOJI_PRESENTATION || point === TEXT_PRESENTATION)) return 0;
  const first = points[0]!;
  if (points.length > 1 && points.every((point) => point >= REGIONAL_FIRST && point <= REGIONAL_LAST)) return 2;
  // A presentation selector decides a text-default symbol: text stays narrow, emoji widens it.
  if (points.includes(TEXT_PRESENTATION)) return baseColumns(first);
  if (points.includes(EMOJI_PRESENTATION)) return 2;
  // A joined pictographic sequence is one wide cluster; a plain text symbol is not.
  if (points.includes(ZWJ) && PICTOGRAPHIC.test(cluster)) return 2;
  if (EMOJI_DEFAULT.test(cluster)) return 2;
  return baseColumns(first);
}

export function displayColumns(value: string): number {
  if (!NON_ASCII.test(value)) return value.length;
  let columns = 0;
  for (const { segment } of GRAPHEMES.segment(value)) columns += graphemeColumns(segment);
  return columns;
}

export function takeDisplayColumns(value: string, maximum: number): Readonly<{ text: string; rest: string }> {
  const clusters = [...GRAPHEMES.segment(value)].map(({ segment }) => segment);
  let columns = 0;
  let index = 0;
  for (; index < clusters.length; index += 1) {
    const width = graphemeColumns(clusters[index]!);
    if (columns + width > maximum) break;
    columns += width;
  }
  return { text: clusters.slice(0, index).join(""), rest: clusters.slice(index).join("") };
}

export function truncateDisplayText(value: string, maximum: number): string {
  const clean = safeText(value);
  if (displayColumns(clean) <= maximum) return clean;
  if (maximum <= 0) return "";
  if (maximum === 1) return "…";
  return `${takeDisplayColumns(clean, maximum - 1).text.replace(/…+$/u, "")}…`;
}

export function truncateMiddleDisplayText(value: string, maximum: number): string {
  const clean = safeText(value);
  if (displayColumns(clean) <= maximum) return clean;
  if (maximum <= 0) return "";
  if (maximum === 1) return "…";
  const available = maximum - 1;
  const headColumns = Math.ceil(available / 2);
  const tailColumns = available - headColumns;
  const head = takeDisplayColumns(clean, headColumns).text.replace(/…+$/u, "");
  const characters = [...GRAPHEMES.segment(clean)].map(({ segment }) => segment);
  let tailStart = characters.length;
  let used = 0;
  while (tailStart > 0) {
    const candidate = characters[tailStart - 1]!;
    const width = displayColumns(candidate);
    if (used + width > tailColumns) break;
    used += width;
    tailStart -= 1;
  }
  return `${head}…${characters.slice(tailStart).join("").replace(/^…+/u, "")}`;
}

export function renderBoundedTextBlock(
  value: string,
  input: Readonly<{ first: string; continuation: string; columns: number; lines?: number; truncated?: boolean }>,
): readonly string[] {
  const maximumLines = input.lines ?? 3;
  let rest = safeText(value).replace(/\s+/gu, " ").trim();
  const lines: string[] = [];
  for (let index = 0; index < maximumLines && rest.length > 0; index += 1) {
    const prefix = index === 0 ? input.first : input.continuation;
    const budget = Math.max(1, input.columns - displayColumns(prefix));
    if (index === maximumLines - 1) {
      const force = input.truncated === true || displayColumns(rest) > budget;
      lines.push(`${prefix}${force ? truncateDisplayText(`${rest}…`, budget) : rest}`);
      rest = "";
      break;
    }
    if (displayColumns(rest) <= budget) {
      lines.push(`${prefix}${input.truncated === true ? truncateDisplayText(`${rest}…`, budget) : rest}`);
      rest = "";
      break;
    }
    const taken = takeDisplayColumns(rest, budget);
    let split = taken.text.lastIndexOf(" ");
    if (split < Math.floor(taken.text.length / 2)) split = taken.text.length;
    lines.push(`${prefix}${taken.text.slice(0, split).trimEnd()}`);
    rest = `${taken.text.slice(split)}${taken.rest}`.trimStart();
  }
  return lines.length === 0 ? [input.first.trimEnd()] : lines;
}

export function quotedText(value: string): string {
  return JSON.stringify(value).replaceAll(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) =>
    character
      .split("")
      .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join(""),
  );
}

export function safeText(value: string): string {
  return value.replaceAll(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) =>
    // ZWJ and ZWNJ are legitimate joiners that carry a grapheme cluster's shape; they move no cursor.
    character === "\u200c" || character === "\u200d" ? character : /\s/u.test(character) ? " " : "�",
  );
}

type CheckoutNotFollowable = Readonly<{
  reason: "staged" | "dirty-tracked" | "unmerged" | "untracked";
  path: string;
  target: string;
  paths: readonly string[];
}>;

export function checkoutNotFollowableLines(refusal: CheckoutNotFollowable): readonly string[] {
  const lines = [
    "! checkout-not-followable",
    `  checkout  ${safeText(refusal.path)}`,
    `  target  ${safeText(refusal.target)}`,
    `  reason  ${refusal.reason}`,
  ];
  if (refusal.paths.length === 0) {
    lines.push("  paths  none");
  } else {
    lines.push("  paths");
    lines.push(...refusal.paths.map((path) => `    ${safeText(path)}`));
  }
  return lines;
}

export function renderTextBlock(value: string, indent: string, columns: number): readonly string[] {
  const words = safeText(value)
    .trim()
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  if (words.length === 0) return [indent];
  const lines: string[] = [];
  let current = indent;
  for (const word of words) {
    const candidate = current === indent ? `${indent}${word}` : `${current} ${word}`;
    if (current !== indent && displayColumns(candidate) > columns) {
      lines.push(current);
      current = `${indent}${word}`;
    } else current = candidate;
  }
  lines.push(current);
  return lines;
}

export function renderOpaqueBlock(value: string, indent: string, columns: number): readonly string[] {
  let rest = safeText(value);
  if (rest.length === 0) return [indent.trimEnd()];
  const continuation = `${indent}  `;
  const lines: string[] = [];
  let prefix = indent;
  while (rest.length > 0) {
    const budget = columns - displayColumns(prefix);
    if (budget <= 0) {
      if (prefix === continuation) {
        lines.push(`${prefix}${rest}`);
        break;
      }
      lines.push(prefix.trimEnd());
      prefix = continuation;
      continue;
    }
    if (displayColumns(rest) <= budget) {
      lines.push(`${prefix}${rest}`);
      break;
    }
    const taken = takeDisplayColumns(rest, budget);
    if (taken.text.length === 0) {
      lines.push(`${prefix}${rest}`);
      break;
    }
    lines.push(`${prefix}${taken.text}`);
    rest = taken.rest;
    prefix = continuation;
  }
  return lines;
}

export type SemanticTone = "dim" | "recent" | "attention" | "alert";

export const RECENT_TONE_MS = 5 * 60 * 1_000;

export function elapsedMilliseconds(source: string | null | undefined, observedAt: string): number | null {
  if (source === null || source === undefined) return null;
  const sourceMs = Date.parse(source);
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(sourceMs) || !Number.isFinite(observedMs)) return null;
  return Math.max(0, observedMs - sourceMs);
}

export function tone(value: string, kind: SemanticTone, color: boolean): string {
  if (!color) return value;
  const code = kind === "dim" ? 2 : kind === "recent" ? 32 : kind === "attention" ? 33 : 31;
  return `\u001b[${code}m${value}\u001b[0m`;
}

export function plumbFacts(facts: readonly string[], columns: number): readonly string[] {
  const lines: string[] = [];
  let current = "  ";
  for (const fact of facts.map(safeText).filter((value) => value.length > 0)) {
    const candidate = current === "  " ? `  ${fact}` : `${current} · ${fact}`;
    if (current !== "  " && displayColumns(candidate) > columns) {
      lines.push(current);
      current = `  ${fact}`;
    } else current = candidate;
  }
  if (current !== "  ") lines.push(current);
  return lines;
}

export function linkedEntityLines(facts: readonly string[], _columns: number): readonly string[] {
  return facts
    .map(safeText)
    .filter((fact) => fact.length > 0)
    .map((fact) => `  │ ${fact}`);
}

export function identityLine(mark: string, identity: string, extra = ""): string {
  return extra.length === 0 ? `${mark} ${safeText(identity)}` : `${mark} ${safeText(identity)} ${safeText(extra)}`;
}

export function entityLines(
  entity: Readonly<{
    mark: string;
    identity: string;
    state: string;
    title: string;
    facts: readonly string[];
    context: TextRenderContext;
  }>,
): readonly string[] {
  const { mark, identity, state, title, facts, context } = entity;
  if (context.columns <= 72) {
    return [
      `${mark} ${safeText(state)}`,
      `  ${safeText(identity)}`,
      ...(title.length === 0 ? [] : renderTextBlock(title, "  ", context.columns)),
      ...plumbFacts(facts, context.columns),
    ];
  }
  return [
    identityLine(mark, identity, `· ${state}${title.length === 0 ? "" : ` · ${title}`}`),
    ...plumbFacts(facts, context.columns),
  ];
}

export function renderSectionBlock({
  name,
  rows,
  hasMore = false,
}: Readonly<{
  name: string;
  rows: readonly (readonly string[])[];
  hasMore?: boolean;
}>): readonly string[] {
  const lines = [`${name}`, "", ...rows.flat()];
  if (hasMore) lines.push("…");
  return lines;
}
