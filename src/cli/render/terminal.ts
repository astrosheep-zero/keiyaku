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

function characterColumns(character: string): number {
  const point = character.codePointAt(0);
  if (point === undefined || point === 0 || /\p{Mark}/u.test(character) || point === 0xfe0f) return 0;
  if (point < 0x20 || (point >= 0x7f && point < 0xa0)) return 0;
  if (point === 0x303f) return 1;
  return WIDE_RANGES.some(([first, last]) => point >= first && point <= last) ? 2 : 1;
}

export function displayColumns(value: string): number {
  let columns = 0;
  for (const character of value) columns += characterColumns(character);
  return columns;
}

export function takeDisplayColumns(value: string, maximum: number): Readonly<{ text: string; rest: string }> {
  const characters = [...GRAPHEMES.segment(value)].map(({ segment }) => segment);
  let columns = 0;
  let index = 0;
  for (; index < characters.length; index += 1) {
    const width = displayColumns(characters[index]!);
    if (columns + width > maximum) break;
    columns += width;
  }
  return { text: characters.slice(0, index).join(""), rest: characters.slice(index).join("") };
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

export function safeText(value: string): string {
  return value.replaceAll(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => (/\s/u.test(character) ? " " : "�"));
}

type CheckoutNotFollowable = Readonly<{
  reason: "staged" | "conflict" | "untracked";
  path: string;
  target: string;
  paths: readonly string[];
}>;

export function checkoutNotFollowableLines(refusal: CheckoutNotFollowable): readonly string[] {
  const lines = [
    "! checkout-not-followable",
    `  checkout: ${safeText(refusal.path)}`,
    `  target: ${safeText(refusal.target)}`,
    `  reason: ${refusal.reason}`,
  ];
  if (refusal.paths.length === 0) {
    lines.push("  paths: (none)");
  } else {
    lines.push("  paths:");
    lines.push(...refusal.paths.map((path) => `    - ${JSON.stringify(path)}`));
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

export function tone(value: string, kind: "dim" | "alert", color: boolean): string {
  if (!color) return value;
  return kind === "dim" ? `\u001b[2m${value}\u001b[0m` : `\u001b[31m${value}\u001b[0m`;
}
