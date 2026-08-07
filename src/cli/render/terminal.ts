export type TextRenderContext = Readonly<{ columns: number; color: boolean }>;

const WIDE_RANGES = [
  [0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0xa4cf], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1faff], [0x20000, 0x3fffd],
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

export function safeText(value: string): string {
  return value.replaceAll(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => /\s/u.test(character) ? " " : "�");
}

export function renderFacts(primary: string, facts: readonly string[], columns: number): readonly string[] {
  const head = safeText(primary);
  const clean = facts.map(safeText);
  if (clean.length === 0) return [head];
  const inline = `${head}  ${clean.join(" · ")}`;
  if (displayColumns(inline) <= columns) return [inline];
  const lines = [head];
  let current = "  ";
  for (const fact of clean) {
    const candidate = current === "  " ? `${current}${fact}` : `${current} · ${fact}`;
    if (current !== "  " && displayColumns(candidate) > columns) {
      lines.push(current);
      current = `  ${fact}`;
    } else current = candidate;
  }
  lines.push(current);
  return lines;
}

export function renderTextBlock(value: string, indent: string, columns: number): readonly string[] {
  const words = safeText(value).trim().split(/\s+/u).filter((word) => word.length > 0);
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

export function renderVoiceRuler(left: string, right: string, columns: number): string {
  const width = Math.max(20, Math.min(80, columns));
  const occupied = displayColumns(left) + displayColumns(right) + 2;
  if (occupied >= width) return `${left}\n${"─".repeat(Math.max(1, width - displayColumns(right) - 1))} ${right}`;
  return `${left} ${"─".repeat(width - occupied)} ${right}`;
}

export function tone(value: string, kind: "dim" | "alert", color: boolean): string {
  if (!color) return value;
  return kind === "dim" ? `\u001b[2m${value}\u001b[0m` : `\u001b[31m${value}\u001b[0m`;
}
