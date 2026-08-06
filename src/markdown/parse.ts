import { fenceClosing, lexMarkdown } from "./lex.js";
import {
  MarkdownParseError,
  type DocumentNode,
  type FenceState,
  type FrontmatterNode,
  type ListItemNode,
  type ListMarkerToken,
  type MarkdownBlockNode,
  type MarkdownToken,
  type SectionNode,
  type SourceSpan,
  type TextNode,
} from "./types.js";

type ParserOptions = Readonly<{ allowSections: boolean }>;

function spanFrom(first: SourceSpan, last: SourceSpan): SourceSpan {
  return { start: first.start, end: last.end };
}

function isSection(
  token: MarkdownToken | undefined,
): token is Extract<MarkdownToken, { type: "header" }> & Readonly<{ level: 1 | 2 }> {
  return token?.type === "header" && token.leadingSpaces === 0 && (token.level === 1 || token.level === 2);
}

function withoutTrailingLineEnding(value: string): string {
  return value.endsWith("\r\n") ? value.slice(0, -2) : value.endsWith("\n") ? value.slice(0, -1) : value;
}

class Parser {
  private index = 0;

  constructor(
    private readonly tokens: readonly MarkdownToken[],
    private readonly options: ParserOptions,
  ) {}

  parseDocument(source: string, span: SourceSpan, bomLength: 0 | 1): DocumentNode {
    const frontmatter = this.parseFrontmatter();
    return {
      type: "document",
      source,
      span,
      bomLength,
      ...(frontmatter === undefined ? {} : { frontmatter }),
      children: this.parseBlocks(() => false),
    };
  }

  private parseFrontmatter(): FrontmatterNode | undefined {
    const token = this.peek();
    if (token?.type !== "frontmatter") return undefined;
    this.consume();
    return { type: "frontmatter", span: token.span, entries: token.entries };
  }

  private parseBlocks(stop: () => boolean): readonly MarkdownBlockNode[] {
    const blocks: MarkdownBlockNode[] = [];
    while (!this.done() && !stop()) {
      const token = this.peek();
      if (token === undefined) break;
      if (this.options.allowSections && isSection(token)) blocks.push(this.parseSection());
      else if (token.type === "fence") blocks.push(this.parseCodeBlock());
      else if (token.type === "header") blocks.push(this.parseHeading());
      else if (token.type === "list_marker" && (!this.options.allowSections || token.indent <= 3)) blocks.push(this.parseList(token.indent, token.ordered));
      else if (token.type === "blockquote") blocks.push(this.parseBlockquote());
      else if (token.type === "frontmatter") this.consume();
      else blocks.push(this.parseText(stop));
    }
    return blocks;
  }

  private parseSection(): SectionNode {
    const header = this.consume();
    if (!isSection(header)) throw new MarkdownParseError("invalid parser state: expected section");
    const children = this.parseBlocks(() => this.options.allowSections && isSection(this.peek()));
    return {
      type: "section",
      level: header.level,
      title: header.text,
      contentStart: header.span.end,
      span: { start: header.span.start, end: children.at(-1)?.span.end ?? header.span.end },
      children,
    };
  }

  private parseCodeBlock(): MarkdownBlockNode {
    const opener = this.consume();
    if (opener?.type !== "fence") throw new MarkdownParseError("invalid parser state: expected fence");
    const state: FenceState = { delimiter: opener.delimiter, length: opener.length };
    const lines = [withoutTrailingLineEnding(opener.raw)];
    let end = opener.span.end;
    let closed = false;
    while (!this.done()) {
      const token = this.consume();
      if (token === undefined) break;
      lines.push(withoutTrailingLineEnding(token.raw));
      end = token.span.end;
      if (token.type === "fence" && fenceClosing(withoutTrailingLineEnding(token.raw), state)) {
        closed = true;
        break;
      }
    }
    return {
      type: "code_block",
      span: { start: opener.span.start, end },
      delimiter: opener.delimiter,
      fenceLength: opener.length,
      info: opener.info,
      closed,
      lines,
    };
  }

  private parseHeading(): MarkdownBlockNode {
    const token = this.consume();
    if (token?.type !== "header") throw new MarkdownParseError("invalid parser state: expected heading");
    return { type: "heading", span: token.span, level: token.level, text: token.text };
  }

  private parseBlockquote(): MarkdownBlockNode {
    const first = this.peek();
    if (first?.type !== "blockquote") throw new MarkdownParseError("invalid parser state: expected blockquote");
    const lines: string[] = [];
    let last = first;
    while (this.peek()?.type === "blockquote") {
      const token = this.consume() as Extract<MarkdownToken, { type: "blockquote" }>;
      lines.push(token.body);
      last = token;
    }
    return {
      type: "blockquote",
      span: spanFrom(first.span, last.span),
      marker: first.marker,
      lines,
      value: lines.join("\n"),
    };
  }

  private parseList(indent: number, ordered: boolean): MarkdownBlockNode {
    const items: ListItemNode[] = [];
    let first: ListMarkerToken | undefined;
    while (true) {
      const token = this.peek();
      if (token?.type !== "list_marker" || token.indent !== indent || token.ordered !== ordered) break;
      first ??= token;
      this.consume();
      items.push(this.parseListItem(token, indent));
    }
    if (first === undefined || items.length === 0) throw new MarkdownParseError("invalid parser state: expected list");
    return {
      type: "list",
      span: spanFrom(first.span, items.at(-1)!.span),
      ordered,
      indent,
      items,
    };
  }

  private parseListItem(marker: ListMarkerToken, indent: number): ListItemNode {
    const bodyOffset = marker.bodyStart - marker.span.start;
    const itemTokens: MarkdownToken[] = [{
      type: "text",
      raw: marker.raw.slice(bodyOffset),
      span: { start: marker.bodyStart, end: marker.span.end },
      leadingSpaces: 0,
    }];
    let end = marker.span.end;
    while (!this.done()) {
      const token = this.peek();
      if (token === undefined) break;
      if (this.options.allowSections && isSection(token)) break;
      if (token.type === "header" && token.leadingSpaces <= indent) break;
      if (token.type === "fence" && token.leadingSpaces <= indent) break;
      if (token.type === "list_marker" && token.indent <= indent) break;
      this.consume();
      itemTokens.push(token);
      end = token.span.end;
    }
    const childSpan = { start: itemTokens[0]!.span.start, end: itemTokens.at(-1)!.span.end };
    const children = new Parser(itemTokens, { allowSections: false })
      .parseDocument("", childSpan, 0).children;
    return { type: "list_item", span: { start: marker.span.start, end }, marker: marker.marker, indent, children };
  }

  private parseText(stop: () => boolean): TextNode {
    const tokens: MarkdownToken[] = [];
    while (!this.done() && !stop()) {
      const token = this.peek();
      if (token === undefined || token.type === "fence" || token.type === "header" || token.type === "blockquote" || token.type === "frontmatter") break;
      if (token.type === "list_marker" && (!this.options.allowSections || token.indent <= 3)) break;
      tokens.push(token);
      this.consume();
    }
    if (tokens.length === 0) {
      const fallback = this.consume();
      if (fallback === undefined) throw new MarkdownParseError("invalid parser state: expected text");
      tokens.push(fallback);
    }
    const raw = tokens.map((token) => token.raw).join("");
    return {
      type: "text",
      span: spanFrom(tokens[0]!.span, tokens.at(-1)!.span),
      lines: raw.split(/\r?\n/),
      value: withoutTrailingLineEnding(raw),
    };
  }

  private peek(): MarkdownToken | undefined {
    return this.tokens[this.index];
  }

  private consume(): MarkdownToken | undefined {
    const token = this.tokens[this.index];
    this.index += 1;
    return token;
  }

  private done(): boolean {
    return this.index >= this.tokens.length;
  }
}

export function parseToAST(source: string): DocumentNode {
  const bomLength: 0 | 1 = source.startsWith("\uFEFF") ? 1 : 0;
  return new Parser(lexMarkdown(source), { allowSections: true })
    .parseDocument(source, { start: 0, end: source.length }, bomLength);
}
