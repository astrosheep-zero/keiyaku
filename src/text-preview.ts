const GRAPHEMES = new Intl.Segmenter("und", { granularity: "grapheme" });
const PREVIEW_GRAPHEMES = 160;

/** The content aperture is independent of prefixes and terminal width. */
export function previewLines(text: string, prefix: string, lineLimit = 3, alreadyClipped = false): string[] {
  const source = lineLimit === 1 ? [safeText(text).replace(/\s+/gu, " ").trim()] : text.split(/\r?\n/u, lineLimit + 1);
  const selected = source.slice(0, lineLimit).map(safeText).join("\n");
  let end = selected.length;
  let count = 0;
  for (const { segment, index } of GRAPHEMES.segment(selected)) {
    if (segment !== "\n" && count++ === PREVIEW_GRAPHEMES) {
      end = index;
      break;
    }
  }
  const omitted = alreadyClipped || source.length > lineLimit || end < selected.length;
  return `${selected.slice(0, end)}${omitted ? "…" : ""}`.split("\n").map((line) => `${prefix}${line}`);
}

export function exactIndentedLines(text: string, indent: string): string[] {
  return text.split(/\r?\n/u).map((line) => (line === "" ? "" : `${indent}${safeText(line)}`));
}

const TERMINAL_CONTROLS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export function opaqueCoordinate(value: string): string {
  return value.search(TERMINAL_CONTROLS) < 0 ? value : quotedText(value);
}

export function quotedText(value: string): string {
  return JSON.stringify(value).replaceAll(TERMINAL_CONTROLS, (character) =>
    character
      .split("")
      .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join(""),
  );
}

export function safeText(value: string): string {
  return value.replaceAll(TERMINAL_CONTROLS, (character) =>
    // ZWJ and ZWNJ are legitimate joiners that carry a grapheme cluster's shape; they move no cursor.
    character === "\u200c" || character === "\u200d" ? character : /\s/u.test(character) ? " " : "�",
  );
}
