import type { TaskId, TaskPriority, TaskQueryExpression, TaskQueryPredicate, TaskState } from "../../task/index.js";
import { isTaskRelationPredicateField, MAX_TASK_LIMIT, normalizeTaskQuery } from "../../task/query.js";

export type { TaskQueryExpression } from "../../task/index.js";

type Token = Readonly<{ kind: "word" | "string" | "operator" | "left" | "right" | "end"; value: string; offset: number }>;

function syntax(message: string, offset: number): never { throw new Error(`${message} at column ${offset + 1}`); }

function scanString(source: string, offset: number): Readonly<{ token: Token; next: number }> {
  let index = offset + 1;
  let value = "";
  while (index < source.length && source[index] !== "\"") {
    const character = source[index]!;
    if (character !== "\\") {
      value += character;
      index += 1;
      continue;
    }
    const escaped = source[index + 1];
    if (escaped === undefined) syntax("unterminated string", offset);
    if (escaped !== "\\" && escaped !== "\"") syntax("only \\\\ and \\\" escapes are supported", index);
    value += escaped;
    index += 2;
  }
  if (source[index] !== "\"") syntax("unterminated string", offset);
  return { token: { kind: "string", value, offset }, next: index + 1 };
}

function scanOperator(source: string, offset: number): Readonly<{ token: Token; next: number }> | null {
  const pair = source.slice(offset, offset + 2);
  if (pair === "!=" || pair === "<=" || pair === ">=") {
    return { token: { kind: "operator", value: pair, offset }, next: offset + 2 };
  }
  const character = source[offset]!;
  if (character !== "=" && character !== "<" && character !== ">" && character !== "~") return null;
  return { token: { kind: "operator", value: character, offset }, next: offset + 1 };
}

function scanWord(source: string, offset: number): Readonly<{ token: Token; next: number }> {
  let index = offset;
  while (index < source.length && !/[\s()=!<>~"]/u.test(source[index]!)) index += 1;
  if (index === offset) syntax(`unexpected ${JSON.stringify(source[offset])}`, offset);
  return { token: { kind: "word", value: source.slice(offset, index), offset }, next: index };
}

function lex(source: string): readonly Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    if (/\s/u.test(source[index]!)) { index += 1; continue; }
    const offset = index, character = source[index]!;
    if (character === "(") { tokens.push({ kind: "left", value: character, offset }); index += 1; continue; }
    if (character === ")") { tokens.push({ kind: "right", value: character, offset }); index += 1; continue; }
    if (character === "\"") {
      const scanned = scanString(source, offset);
      tokens.push(scanned.token);
      index = scanned.next;
      continue;
    }
    const operator = scanOperator(source, offset);
    if (operator !== null) {
      tokens.push(operator.token);
      index = operator.next;
      continue;
    }
    const word = scanWord(source, offset);
    tokens.push(word.token);
    index = word.next;
  }
  tokens.push({ kind: "end", value: "", offset: source.length });
  return tokens;
}

function canonicalTaskId(token: Token, field: string): TaskId {
  if (!token.value.startsWith("task/")) return syntax(`${field} requires a canonical TaskId`, token.offset);
  return token.value as TaskId;
}
function state(token: Token): TaskState {
  if (token.value !== "open" && token.value !== "in_progress" && token.value !== "on_hold" && token.value !== "done" && token.value !== "drop") {
    return syntax(`invalid state ${JSON.stringify(token.value)}`, token.offset);
  }
  return token.value;
}
function priority(token: Token): TaskPriority {
  const value = Number(token.value);
  if (!Number.isInteger(value) || value < 0 || value > 3) return syntax("priority requires 0..3", token.offset);
  return value as TaskPriority;
}
function boolean(token: Token): boolean {
  if (token.value === "true") return true;
  if (token.value === "false") return false;
  return syntax("boolean predicate requires true or false", token.offset);
}
function timestamp(token: Token, field: string): string {
  const milliseconds = Date.parse(token.value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== token.value) return syntax(`${field} requires a canonical UTC ISO timestamp`, token.offset);
  return token.value;
}

function equalityOperator(token: Token, field: string): "=" | "!=" {
  if (token.value !== "=" && token.value !== "!=") syntax(`${field} supports only = and !=`, token.offset);
  return token.value;
}

function orderedOperator(token: Token, field: string): "=" | "!=" | "<" | "<=" | ">" | ">=" {
  if (token.value === "~") syntax(`${field} operator is invalid`, token.offset);
  return token.value as "=" | "!=" | "<" | "<=" | ">" | ">=";
}

function textOperator(token: Token, field: string): "=" | "!=" | "~" {
  if (token.value !== "=" && token.value !== "!=" && token.value !== "~") {
    syntax(`${field} supports only =, !=, and ~`, token.offset);
  }
  return token.value;
}

function parseTextPredicate(field: "title" | "id", operator: Token, value: Token): TaskQueryPredicate {
  const selected = textOperator(operator, field);
  if (field === "title" && value.kind !== "string") syntax("title values must use double quotes", value.offset);
  if (field === "id" && selected !== "~") canonicalTaskId(value, "id");
  return { field, operator: selected, value: value.value };
}

function parseRelationPredicate(
  field: Token,
  operator: Token,
  value: Token,
): TaskQueryPredicate {
  if (!isTaskRelationPredicateField(field.value)) {
    syntax(`unknown query field ${JSON.stringify(field.value)}`, field.offset);
  }
  return {
    field: field.value,
    operator: equalityOperator(operator, field.value),
    value: canonicalTaskId(value, field.value),
  };
}

function parseBooleanPredicate(field: "ready" | "blocked", operator: Token, value: Token): TaskQueryPredicate {
  return { field, operator: equalityOperator(operator, field), value: boolean(value) };
}

function parseTimestampPredicate(field: "created" | "updated", operator: Token, value: Token): TaskQueryPredicate {
  return { field, operator: orderedOperator(operator, field), value: timestamp(value, field) };
}

class Parser {
  private index = 0;
  constructor(private readonly tokens: readonly Token[]) {}
  private current(): Token { return this.tokens[this.index]!; }
  private take(): Token { const token = this.current(); this.index += 1; return token; }
  private word(value: string): boolean { return this.current().kind === "word" && this.current().value === value; }
  parse(): TaskQueryExpression {
    const value = this.or();
    if (this.current().kind !== "end") syntax(`unexpected ${JSON.stringify(this.current().value)}`, this.current().offset);
    return value;
  }
  private or(): TaskQueryExpression {
    const terms = [this.and()];
    while (this.word("or")) { this.take(); terms.push(this.and()); }
    return terms.length === 1 ? terms[0]! : { kind: "or", terms };
  }
  private and(): TaskQueryExpression {
    const terms = [this.not()];
    while (this.word("and")) { this.take(); terms.push(this.not()); }
    return terms.length === 1 ? terms[0]! : { kind: "and", terms };
  }
  private not(): TaskQueryExpression {
    if (this.word("not")) { this.take(); return { kind: "not", term: this.not() }; }
    return this.primary();
  }
  private primary(): TaskQueryExpression {
    if (this.current().kind === "left") {
      const opening = this.take();
      const value = this.or();
      if (this.current().kind !== "right") syntax("missing closing parenthesis", opening.offset);
      this.take(); return value;
    }
    return { kind: "predicate", predicate: this.predicate() };
  }
  private predicate(): TaskQueryPredicate {
    const field = this.take();
    if (field.kind !== "word") syntax("expected query field", field.offset);
    if ((field.value === "ready" || field.value === "blocked") && this.current().kind !== "operator") {
      return { field: field.value, operator: "=", value: true };
    }
    const operator = this.take();
    if (operator.kind !== "operator") syntax(`expected operator after ${field.value}`, operator.offset);
    const value = this.take();
    if (value.kind !== "word" && value.kind !== "string") syntax(`expected value for ${field.value}`, value.offset);
    return this.typedPredicate(field, operator, value);
  }
  private typedPredicate(field: Token, operator: Token, value: Token): TaskQueryPredicate {
    switch (field.value) {
      case "state": return { field: "state", operator: equalityOperator(operator, "state"), value: state(value) };
      case "priority": return { field: "priority", operator: orderedOperator(operator, "priority"), value: priority(value) };
      case "title": return parseTextPredicate("title", operator, value);
      case "id": return parseTextPredicate("id", operator, value);
      case "parent": return {
        field: "parent",
        operator: equalityOperator(operator, "parent"),
        value: value.value === "none" ? null : canonicalTaskId(value, "parent"),
      };
      case "ready": return parseBooleanPredicate("ready", operator, value);
      case "blocked": return parseBooleanPredicate("blocked", operator, value);
      case "created": return parseTimestampPredicate("created", operator, value);
      case "updated": return parseTimestampPredicate("updated", operator, value);
      default:
        if (isTaskRelationPredicateField(field.value)) return parseRelationPredicate(field, operator, value);
        return syntax(`unknown query field ${JSON.stringify(field.value)}`, field.offset);
    }
  }
}

export function parseTaskQueryExpression(source: string): TaskQueryExpression {
  if (source.trim().length === 0) return syntax("query expression must be nonblank", 0);
  return normalizeTaskQuery(new Parser(lex(source)).parse());
}

export function validateTaskLimit(source: string): void {
  if (!/^[1-9][0-9]*$/u.test(source) || Number(source) > MAX_TASK_LIMIT) {
    throw new Error(`--limit must be an integer from 1 to ${MAX_TASK_LIMIT}`);
  }
}

export function validateTaskParent(source: string): void {
  try {
    normalizeTaskQuery({ kind: "predicate", predicate: { field: "under", operator: "=", value: source } });
  } catch {
    throw new Error("--parent requires a canonical TaskId");
  }
}
