import {
  normalizeTaskQueryPredicate,
  TaskQueryPredicateError,
  type TaskQueryExpression,
  type TaskQueryPredicate,
} from "../../task/query.js";

export type { TaskQueryExpression } from "../../task/query.js";

type Token = Readonly<{
  kind: "word" | "string" | "operator" | "left" | "right" | "end";
  value: string;
  offset: number;
}>;

function syntax(message: string, offset: number): never {
  throw new Error(`${message} at column ${offset + 1}`);
}

function scanString(source: string, offset: number): Readonly<{ token: Token; next: number }> {
  let index = offset + 1;
  let value = "";
  while (index < source.length && source[index] !== '"') {
    const character = source[index]!;
    if (character !== "\\") {
      value += character;
      index += 1;
      continue;
    }
    const escaped = source[index + 1];
    if (escaped === undefined) syntax("unterminated string", offset);
    if (escaped !== "\\" && escaped !== '"') syntax('only \\\\ and \\" escapes are supported', index);
    value += escaped;
    index += 2;
  }
  if (source[index] !== '"') syntax("unterminated string", offset);
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
    if (/\s/u.test(source[index]!)) {
      index += 1;
      continue;
    }
    const offset = index,
      character = source[index]!;
    if (character === "(") {
      tokens.push({ kind: "left", value: character, offset });
      index += 1;
      continue;
    }
    if (character === ")") {
      tokens.push({ kind: "right", value: character, offset });
      index += 1;
      continue;
    }
    if (character === '"') {
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

function parsedPredicate(field: Token, operator: Token, value: Token): TaskQueryPredicate {
  if (field.value === "title" && value.kind !== "string") {
    syntax("title values must use double quotes", value.offset);
  }
  // Acquire textual literals only; the Task owner judges fields, operators and values.
  const literal: unknown =
    field.value === "priority"
      ? Number(value.value)
      : field.value === "parent" && value.value === "none"
        ? null
        : (field.value === "ready" || field.value === "blocked") && (value.value === "true" || value.value === "false")
          ? value.value === "true"
          : value.value;
  try {
    return normalizeTaskQueryPredicate({ field: field.value, operator: operator.value, value: literal });
  } catch (error) {
    if (error instanceof TaskQueryPredicateError) {
      return syntax(error.message, { field, operator, value }[error.part].offset);
    }
    throw error;
  }
}

class Parser {
  private index = 0;
  constructor(private readonly tokens: readonly Token[]) {}
  private current(): Token {
    return this.tokens[this.index]!;
  }
  private take(): Token {
    const token = this.current();
    this.index += 1;
    return token;
  }
  private word(value: string): boolean {
    return this.current().kind === "word" && this.current().value === value;
  }
  parse(): TaskQueryExpression {
    const value = this.or();
    if (this.current().kind !== "end")
      syntax(`unexpected ${JSON.stringify(this.current().value)}`, this.current().offset);
    return value;
  }
  private or(): TaskQueryExpression {
    const terms = [this.and()];
    while (this.word("or")) {
      this.take();
      terms.push(this.and());
    }
    return terms.length === 1 ? terms[0]! : { kind: "or", terms };
  }
  private and(): TaskQueryExpression {
    const terms = [this.not()];
    while (this.word("and")) {
      this.take();
      terms.push(this.not());
    }
    return terms.length === 1 ? terms[0]! : { kind: "and", terms };
  }
  private not(): TaskQueryExpression {
    if (this.word("not")) {
      this.take();
      return { kind: "not", term: this.not() };
    }
    return this.primary();
  }
  private primary(): TaskQueryExpression {
    if (this.current().kind === "left") {
      const opening = this.take();
      const value = this.or();
      if (this.current().kind !== "right") syntax("missing closing parenthesis", opening.offset);
      this.take();
      return value;
    }
    return { kind: "predicate", predicate: this.predicate() };
  }
  private predicate(): TaskQueryPredicate {
    const field = this.take();
    if (field.kind !== "word") syntax("expected query field", field.offset);
    if ((field.value === "ready" || field.value === "blocked") && this.current().kind !== "operator") {
      return parsedPredicate(
        field,
        { kind: "operator", value: "=", offset: field.offset },
        { kind: "word", value: "true", offset: field.offset },
      );
    }
    const operator = this.take();
    if (operator.kind !== "operator") syntax(`expected operator after ${field.value}`, operator.offset);
    const value = this.take();
    if (value.kind !== "word" && value.kind !== "string") syntax(`expected value for ${field.value}`, value.offset);
    return parsedPredicate(field, operator, value);
  }
}

export function parseTaskQueryExpression(source: string): TaskQueryExpression {
  if (source.trim().length === 0) return syntax("query expression must be nonblank", 0);
  return new Parser(lex(source)).parse();
}

export function validateTaskLimit(source: string): void {
  if (!/^[1-9][0-9]*$/u.test(source) || !Number.isSafeInteger(Number(source)))
    throw new Error("--limit requires a positive safe integer");
}

export function validateTaskParent(source: string): void {
  try {
    normalizeTaskQueryPredicate({ field: "under", operator: "=", value: source });
  } catch {
    throw new Error("--parent requires a canonical TaskId");
  }
}
