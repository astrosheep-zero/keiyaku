import { isBlankInput } from "./usage.js";

/** One surface's option table, named the way its refusal text names the surface. */
export type ScanFlagKind = "boolean" | "value" | "raw-value" | "repeat";

export type ScanSpec<Reader extends string = string> = Readonly<{
  /** Names this surface in refusal text: `bind`, `call`, `task add`. */
  subject: string;
  flags: Readonly<Record<string, ScanFlagKind>>;
  /** The reader that consumes `-` input; absent makes `-` invalid here. */
  stdin?: Reader;
  /** Refusal text for `-` on a surface that reads no stdin. */
  stdinRefusal: string;
  /** Option whose `-` value is stdin input, named as the reader it selects. */
  stdinValue?: Reader;
  /** Tokens this surface refuses everywhere, each with its own option-position refusal text. */
  refused?: Readonly<Record<string, string>>;
}>;

export type ScannedArgs<Reader extends string = string> = Readonly<{
  flags: Record<string, string | true | readonly string[]>;
  positionals: readonly string[];
  stdin?: Reader;
}>;

/** The one `-` reader for this invocation; a second `-` is the duplicate refusal. */
function selectStdin<Reader extends string>(
  spec: ScanSpec<Reader>,
  stdin: Reader | undefined,
  fail: (message: string) => never,
): Reader {
  if (spec.stdin === undefined) fail(spec.stdinRefusal);
  if (stdin !== undefined) fail("stdin marker '-' may appear only once");
  return spec.stdin;
}

/** A value token this surface refuses: `-`, or one of its own refused tokens. */
function refusedValue(kind: ScanFlagKind, value: string, spec: ScanSpec): boolean {
  if (kind === "raw-value") return false;
  return value === "-" || spec.refused?.[value] !== undefined;
}

/** The admitted value after `--name`: absent, dash-like, and blank values carry their own refusals. */
function optionValue(
  token: string,
  value: string | undefined,
  kind: ScanFlagKind,
  spec: ScanSpec,
  fail: (message: string) => never,
): string {
  if (value === undefined || value.startsWith("--") || refusedValue(kind, value, spec))
    fail(`${token} requires a value`);
  if (kind !== "raw-value" && isBlankInput(value)) fail(`${token} requires a nonblank value`);
  return value;
}

/** One `--name` option: a boolean, a repeated value, or a single value. Returns its consumed tokens. */
function assignOption(
  option: Readonly<{ token: string; name: string; kind: ScanFlagKind; value: string | undefined }>,
  spec: ScanSpec,
  flags: Record<string, string | true | readonly string[]>,
  fail: (message: string) => never,
): number {
  const { token, name, kind, value } = option;
  if (flags[name] !== undefined && kind !== "repeat") fail(`duplicate option: ${token}`);
  if (kind === "boolean") {
    flags[name] = true;
    return 0;
  }
  const admitted = optionValue(token, value, kind, spec, fail);
  flags[name] = kind === "repeat" ? [...(Array.isArray(flags[name]) ? flags[name] : []), admitted] : admitted;
  return 1;
}

/**
 * One argument scan for every CLI grammar: `--name value` options, `--` positional-only mode,
 * `-` stdin, and the surface's own refusal text. A refused token is refused in option position with
 * its own text, and in value position as the missing-value refusal.
 */
export function scanArgs<Reader extends string = string>(
  argv: readonly string[],
  spec: ScanSpec<Reader>,
  fail: (message: string) => never,
): ScannedArgs<Reader> {
  const flags: Record<string, string | true | readonly string[]> = {};
  const positionals: string[] = [];
  let stdin: Reader | undefined;
  let positionalOnly = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!positionalOnly && token === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && spec.refused?.[token] !== undefined) fail(spec.refused[token]!);
    if (!positionalOnly && token === "-") {
      stdin = selectStdin(spec, stdin, fail);
      continue;
    }
    if (positionalOnly || !token.startsWith("--")) {
      if (isBlankInput(token)) fail(`${spec.subject} requires a nonblank value`);
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    const kind = spec.flags[name];
    if (kind === undefined) fail(`option ${token} is not valid for ${spec.subject}`);
    const reader = spec.stdinValue;
    const value = kind === "boolean" ? undefined : argv[index + 1];
    if (reader !== undefined && reader === name && value === "-") {
      if (stdin !== undefined) fail("stdin marker '-' may appear only once");
      flags[name] = "";
      stdin = reader;
      index += 1;
      continue;
    }
    index += assignOption({ token, name, kind, value }, spec, flags, fail);
  }
  return { flags, positionals, ...(stdin === undefined ? {} : { stdin }) };
}
