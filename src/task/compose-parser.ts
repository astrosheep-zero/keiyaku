import { parseTaskId, type TaskId } from "./identity.js";
import type { TaskCompositionDiagnostic } from "./operations.js";

export type RelationField = "needs" | "supersedes" | "relates";
export type Assignment = Readonly<{
  field: "as" | "parent" | "pri" | RelationField;
  operator: "=" | "+=" | "-=";
  value: string;
  line: number;
  token: string;
}>;
export type BodyAssignment = Readonly<{
  kind: "clear" | "replace";
  value: string;
  line: number;
  token: string;
}>;
export type ParsedNode = Readonly<{
  index: number;
  line: number;
  kind: "new" | "existing";
  title?: string;
  id?: TaskId;
  assignments: readonly Assignment[];
  body?: BodyAssignment;
}>;
export type ParsedComposition = Readonly<{
  namespace?: readonly string[];
  namespaceSpecified: boolean;
  nodes: readonly ParsedNode[];
  diagnostics: readonly TaskCompositionDiagnostic[];
}>;
type SourceLine = Readonly<{ number: number; start: number; end: number; text: string }>;

function diagnostic(line: number, reason: string, token: string): TaskCompositionDiagnostic {
  return { line, reason, token };
}

function sourceLines(source: string): readonly SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  let number = 1;
  while (start < source.length) {
    let cursor = start;
    while (cursor < source.length && source[cursor] !== "\n" && source[cursor] !== "\r") cursor += 1;
    let end = cursor;
    if (source[cursor] === "\r" && source[cursor + 1] === "\n") end += 2;
    else if (cursor < source.length) end += 1;
    lines.push({ number, start, end, text: source.slice(start, cursor) });
    start = end;
    number += 1;
  }
  if (source.length === 0 || source.endsWith("\n") || source.endsWith("\r")) {
    lines.push({ number, start: source.length, end: source.length, text: "" });
  }
  return lines;
}

function withoutFenceSeparator(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n") || value.endsWith("\r")) return value.slice(0, -1);
  return value;
}

function parseNamespace(value: string): readonly string[] {
  if (value === "/") return [];
  if (value === "") throw new Error("empty compose namespace; use ns=/ for root");
  return parseTaskId(`task/${value}/placeholder`).namespace;
}

function parseAssignment(text: string, line: number): Assignment | null {
  const matched = /^(as|parent|pri|needs|supersedes|relates)\s*(=|\+=|-=)\s*(.*)$/u.exec(text);
  if (matched === null) return null;
  return {
    field: matched[1] as Assignment["field"],
    operator: matched[2] as Assignment["operator"],
    value: matched[3]!,
    line,
    token: text,
  };
}

function parseNode(text: string, line: number, index: number): ParsedNode | TaskCompositionDiagnostic {
  if (text.startsWith("+ ")) {
    const title = text.slice(2);
    return title.trim().length === 0
      ? diagnostic(line, "new task title must be nonblank", text)
      : { index, line, kind: "new", title, assignments: [] };
  }
  if (!text.startsWith("@task/")) return diagnostic(line, "node must begin with + or @task/", text);
  try {
    const id = text.slice(1) as TaskId;
    parseTaskId(id);
    return { index, line, kind: "existing", id, assignments: [] };
  } catch (error) {
    return diagnostic(line, error instanceof Error ? error.message : String(error), text);
  }
}

function withAssignment(node: ParsedNode, assignment: Assignment): ParsedNode {
  return { ...node, assignments: [...node.assignments, assignment] };
}

function withBody(node: ParsedNode, body: BodyAssignment): ParsedNode {
  return { ...node, body };
}

function replaceNode(nodes: ParsedNode[], node: ParsedNode): void {
  nodes[node.index] = node;
}

type BodyParseResult = Readonly<{ handled: boolean; node?: ParsedNode; close?: number; stop?: boolean }>;

function parseBodyAssignment(
  input: Readonly<{
    text: string;
    line: SourceLine;
    index: number;
    lines: readonly SourceLine[];
    source: string;
    current: ParsedNode;
  }>,
  diagnostics: TaskCompositionDiagnostic[],
): BodyParseResult {
  const fence = /^body\s+<<(.+)$/u.exec(input.text);
  if (fence !== null) {
    const token = fence[1]!;
    if (!/^[A-Z][A-Z0-9_]{2,31}$/u.test(token)) {
      diagnostics.push(diagnostic(input.line.number, "body token must match [A-Z][A-Z0-9_]* with length 3..32", token));
      return { handled: true };
    }
    const close = input.lines.findIndex(
      (candidate, candidateIndex) => candidateIndex > input.index && candidate.text === token,
    );
    if (close < 0) {
      diagnostics.push(diagnostic(input.line.number, "body fence is not closed", token));
      return { handled: true, stop: true };
    }
    const body = withoutFenceSeparator(input.source.slice(input.line.end, input.lines[close]!.start));
    if (input.current.body !== undefined) {
      diagnostics.push(diagnostic(input.line.number, "body is assigned more than once", input.text));
      return { handled: true, close };
    }
    return {
      handled: true,
      node: withBody(input.current, { kind: "replace", value: body, line: input.line.number, token }),
      close,
    };
  }
  if (!/^body\s*=\s*$/u.test(input.text)) return { handled: false };
  if (input.current.body !== undefined) {
    diagnostics.push(diagnostic(input.line.number, "body is assigned more than once", input.text));
    return { handled: true };
  }
  return {
    handled: true,
    node: withBody(input.current, { kind: "clear", value: "", line: input.line.number, token: input.text }),
  };
}

export function parseTaskComposition(source: string): ParsedComposition {
  const lines = sourceLines(source);
  const diagnostics: TaskCompositionDiagnostic[] = [];
  const nodes: ParsedNode[] = [];
  let namespace: readonly string[] | undefined;
  let current: ParsedNode | undefined;
  let sawNode = false;
  let sawNamespace = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const text = line.text.trimStart();
    if (text.trim().length === 0) continue;
    if (text.startsWith("ns=")) {
      if (sawNode || sawNamespace)
        diagnostics.push(diagnostic(line.number, "namespace must be the first nonblank line", text));
      else {
        try {
          namespace = parseNamespace(text.slice(3));
        } catch (error) {
          diagnostics.push(diagnostic(line.number, error instanceof Error ? error.message : String(error), text));
        }
      }
      sawNamespace = true;
      continue;
    }
    if (text.startsWith("+ ") || text.startsWith("@task/")) {
      const parsed = parseNode(text, line.number, nodes.length);
      if ("reason" in parsed) {
        diagnostics.push(parsed);
        current = undefined;
      } else {
        nodes.push(parsed);
        current = parsed;
      }
      sawNode = true;
      continue;
    }
    if (current === undefined) {
      diagnostics.push(diagnostic(line.number, "property must follow a task node", text));
      continue;
    }
    const body = parseBodyAssignment({ text, line, index, lines, source, current }, diagnostics);
    if (body.handled) {
      if (body.node !== undefined) {
        current = body.node;
        replaceNode(nodes, current);
      }
      if (body.close !== undefined) index = body.close;
      if (body.stop === true) break;
      continue;
    }
    const assignment = parseAssignment(text, line.number);
    if (assignment === null) diagnostics.push(diagnostic(line.number, "unknown compose property", text));
    else {
      current = withAssignment(current, assignment);
      replaceNode(nodes, current);
    }
  }
  return { ...(namespace === undefined ? {} : { namespace }), namespaceSpecified: sawNamespace, nodes, diagnostics };
}
