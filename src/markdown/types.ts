export type SourceSpan = Readonly<{ start: number; end: number }>;

export interface FrontmatterMap {
  readonly [key: string]: FrontmatterValue;
}

export type FrontmatterValue =
  | string
  | number
  | boolean
  | null
  | readonly FrontmatterValue[]
  | FrontmatterMap;

export type FenceState = Readonly<{ delimiter: "`" | "~"; length: number }>;

type Spanned = Readonly<{ span: SourceSpan }>;

export type HeaderToken = Spanned & Readonly<{
  type: "header";
  raw: string;
  leadingSpaces: number;
  level: number;
  text: string;
}>;

export type FenceToken = Spanned & Readonly<{
  type: "fence";
  raw: string;
  leadingSpaces: number;
  delimiter: "`" | "~";
  length: number;
  info: string;
}>;

export type ListMarkerToken = Spanned & Readonly<{
  type: "list_marker";
  raw: string;
  leadingSpaces: number;
  indent: number;
  marker: string;
  ordered: boolean;
  body: string;
  bodyStart: number;
}>;

export type BlockquoteToken = Spanned & Readonly<{
  type: "blockquote";
  raw: string;
  leadingSpaces: number;
  marker: string;
  body: string;
}>;

export type TextToken = Spanned & Readonly<{
  type: "text";
  raw: string;
  leadingSpaces: number;
}>;

export type FrontmatterToken = Spanned & Readonly<{
  type: "frontmatter";
  raw: string;
  entries: Readonly<Record<string, FrontmatterValue>>;
}>;

export type MarkdownToken =
  | HeaderToken
  | FenceToken
  | ListMarkerToken
  | BlockquoteToken
  | TextToken
  | FrontmatterToken;

export type FrontmatterNode = Spanned & Readonly<{
  type: "frontmatter";
  entries: Readonly<Record<string, FrontmatterValue>>;
}>;

export type DocumentNode = Spanned & Readonly<{
  type: "document";
  source: string;
  bomLength: 0 | 1;
  frontmatter?: FrontmatterNode;
  children: readonly MarkdownBlockNode[];
}>;

export type SectionNode = Spanned & Readonly<{
  type: "section";
  level: 1 | 2;
  title: string;
  contentStart: number;
  children: readonly MarkdownBlockNode[];
}>;

export type ListNode = Spanned & Readonly<{
  type: "list";
  ordered: boolean;
  indent: number;
  items: readonly ListItemNode[];
}>;

export type ListItemNode = Spanned & Readonly<{
  type: "list_item";
  marker: string;
  indent: number;
  children: readonly MarkdownBlockNode[];
}>;

export type CodeBlockNode = Spanned & Readonly<{
  type: "code_block";
  delimiter: "`" | "~";
  fenceLength: number;
  info: string;
  closed: boolean;
  lines: readonly string[];
}>;

export type BlockquoteNode = Spanned & Readonly<{
  type: "blockquote";
  marker: string;
  lines: readonly string[];
  value: string;
}>;

export type TextNode = Spanned & Readonly<{
  type: "text";
  lines: readonly string[];
  value: string;
}>;

export type HeadingNode = Spanned & Readonly<{
  type: "heading";
  level: number;
  text: string;
}>;

export type MarkdownBlockNode =
  | SectionNode
  | ListNode
  | CodeBlockNode
  | BlockquoteNode
  | TextNode
  | HeadingNode;

export type MarkdownNode = DocumentNode | MarkdownBlockNode | ListItemNode;

export class MarkdownParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkdownParseError";
  }
}
