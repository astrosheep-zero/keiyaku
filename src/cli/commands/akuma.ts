import { CliUsageError, isBlankInput, usageLine } from "../usage.js";
import { parseAkuId } from "../../akuma/identity.js";
import { parseDuration as decodeDuration } from "../../duration.js";
import { parseAkumaAlias, parseAkumaGlob, type AkumaAlias } from "../../identity/selector.js";
import { decodeAllowedActions, type AllowedActions } from "../../akuma/allowed.js";
import { parsePublicHistoryId } from "../../akuma/identity.js";

type Output = Readonly<{ output: "text" | "json" }>;
type Addressed = Readonly<{ akuma: string }>;
export type AkumaPromptSource = Readonly<{ kind: "argument"; value: string }> | Readonly<{ kind: "stdin" }>;
type Prompted = Readonly<{ prompt: AkumaPromptSource }>;

export type ParsedAkumaCommand = Output &
  (
    | (Readonly<{
        command: "call";
        archetype: string;
        contract?: string;
        alias?: AkumaAlias;
        mode: "wait" | "detach";
        timeoutMs?: number;
        readonly?: true;
        allowed?: AllowedActions;
      }> &
        Prompted)
    | Readonly<{ command: "kill"; akuma: readonly string[] }>
    | Readonly<{ command: "wait"; akuma: readonly string[]; completion?: "any" | "all"; timeoutMs?: number }>
    | (Readonly<{ command: "tell"; interrupt: boolean }> & Addressed & Prompted)
    | (Readonly<{ command: "history"; last: boolean; id?: string; before?: number; since?: number; limit?: number }> &
        Addressed)
    | Readonly<{ command: "history"; contract: string }>
    | (Readonly<{ command: "fork"; at: string }> & Addressed)
  );

export type InvokedAkumaCommand = Exclude<ParsedAkumaCommand, { command: "history"; contract: string }>;

export type AkumaAction = ParsedAkumaCommand["command"];
type FlagValue = string | true | readonly string[];
type AkumaCommandSpec = Readonly<{
  arity: number | "one-or-more";
  stdin: boolean;
  flags: Readonly<Record<string, "boolean" | "value" | "repeatable">>;
  usage: string;
  purpose: string;
  details?: string;
}>;

const AKUMA_COMMAND_SPECS = {
  call: {
    arity: 1,
    stdin: true,
    flags: {
      contract: "value",
      alias: "value",
      wait: "value",
      detach: "boolean",
      readonly: "boolean",
      allowed: "repeatable",
      json: "boolean",
    },
    usage:
      "call <akuma-name> [--contract <kei/...>] [--alias @name] [--readonly] [--allowed <product.action>]... [--wait <duration> | -d | --detach] [--json] (<prompt> | -)",
    purpose: "Birth an Akuma from <akuma-name> with one prompt.",
    details: [
      "Give <prompt> as one argument, or use - to read stdin.",
      "Default: --wait 5m. An explicit --wait replaces that duration; -d and --detach return after birth.",
      "--contract dispatches the born Akuma to that Contract.",
      "--alias assigns the world-local @name selector to the born Akuma.",
      "--readonly adds the one-way read-only birth restriction.",
      "Repeated --allowed adds actions to the Archetype defaults.",
      "With --contract, Dispatch succeeds first. If @name exists, the alias then moves.",
    ].join("\n"),
  },
  wait: {
    arity: "one-or-more",
    stdin: false,
    flags: { any: "boolean", all: "boolean", timeout: "value", json: "boolean" },
    usage: "wait <akuma-selector>... [--any | --all] [--timeout <duration>] [--json]",
    purpose: "Wait for one Akuma or an explicitly selected Akuma set.",
  },
  tell: {
    arity: 1,
    stdin: true,
    flags: { interrupt: "boolean", json: "boolean" },
    usage: "tell <aku/...|@alias> [--interrupt] [--json] (<prompt> | -)",
    purpose: "Send one prompt to an existing Akuma and wake it.",
    details: [
      "Give <prompt> as one argument, or use - to read stdin.",
      "--interrupt ends the current Body before recording the prompt and waking its successor.",
    ].join("\n"),
  },
  history: {
    arity: 1,
    stdin: false,
    flags: { id: "value", before: "value", since: "value", limit: "value", last: "boolean", json: "boolean" },
    usage:
      "history <aku/...|@alias> [--id <historyId> | --before <index> | --since <index>] [--limit <count>] [--last] [--json]\nhistory <kei/...> [--json]",
    purpose: "Read Akuma execution history or one complete Contract journal and Dispatch timeline.",
  },
  fork: {
    arity: 1,
    stdin: false,
    flags: { at: "value", json: "boolean" },
    usage: "fork <aku/...|@alias> --at <historyId> [--json]",
    purpose: "Fork one Akuma at a retained answered history point.",
  },
  kill: {
    arity: "one-or-more",
    stdin: false,
    flags: { json: "boolean" },
    usage: "kill <akuma-selector>... [--json]",
    purpose: "Put down the current Body of an Akuma selector snapshot.",
  },
} as const satisfies Readonly<Record<string, AkumaCommandSpec>>;

export function isAkumaAction(value: string | undefined): value is AkumaAction {
  return value !== undefined && Object.hasOwn(AKUMA_COMMAND_SPECS, value);
}

export function isParsedAkumaCommand(command: Readonly<{ command: string }>): command is InvokedAkumaCommand {
  return isAkumaAction(command.command) && !("contract" in command && command.command === "history");
}

export function renderAkumaRootRows(): readonly string[] {
  return Object.entries(AKUMA_COMMAND_SPECS).map(([action, spec]) => `  keiyaku ${action}  ${spec.purpose}`);
}

export function renderAkumaHelp(action: AkumaAction): string {
  const spec: AkumaCommandSpec = AKUMA_COMMAND_SPECS[action];
  return `${spec.purpose}\n\n${usageLine(spec.usage)}${spec.details === undefined ? "" : `\n\n${spec.details}`}`;
}

export function renderAkumaUsage(action: AkumaAction): string {
  return usageLine(AKUMA_COMMAND_SPECS[action].usage);
}

type Scanned = Readonly<{ flags: Readonly<Record<string, FlagValue>>; positionals: readonly string[]; stdin: boolean }>;

function stringFlag(value: FlagValue | undefined, diagnostic: string, fail: (message: string) => never): string {
  if (typeof value !== "string") fail(diagnostic);
  return value as string;
}

function parseDuration(raw: FlagValue, option: string, fail: (message: string) => never): number {
  if (typeof raw !== "string") fail(`${option} requires an integer duration with unit ms, s, m, or h`);
  const duration = decodeDuration(raw);
  if (duration.kind === "invalid") fail(`${option} requires an integer duration with unit ms, s, m, or h`);
  if (duration.kind === "overflow") fail(`${option} duration exceeds the safe millisecond range`);
  return duration.milliseconds;
}

function scanNamedOption(
  input: Readonly<{
    action: AkumaAction;
    spec: AkumaCommandSpec;
    argv: readonly string[];
    index: number;
  }>,
  flags: Record<string, FlagValue>,
  fail: (message: string) => never,
): number {
  const token = input.argv[input.index]!;
  const name = token.slice(2);
  const kind = input.spec.flags[name];
  if (kind === undefined) fail(`option ${token} is not valid for ${input.action}`);
  if (kind !== "repeatable" && flags[name] !== undefined) fail(`duplicate option: ${token}`);
  if (kind === "boolean") {
    flags[name] = true;
    return input.index;
  }
  const value = input.argv[input.index + 1];
  if (value === undefined || value === "-" || value === "-d" || value.startsWith("--")) {
    fail(`${token} requires a value`);
  }
  if (isBlankInput(value)) fail(`${token} requires a nonblank value`);
  flags[name] = kind === "repeatable" ? [...(Array.isArray(flags[name]) ? flags[name] : []), value] : value;
  return input.index + 1;
}

function scanAkuma(action: AkumaAction, argv: readonly string[], fail: (message: string) => never): Scanned {
  const spec = AKUMA_COMMAND_SPECS[action];
  const flags: Record<string, FlagValue> = {};
  const positionals: string[] = [];
  let stdin = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "-") {
      if (!spec.stdin) fail(`stdin marker '-' is not valid for ${action}`);
      if (stdin) fail("stdin marker '-' may appear only once");
      stdin = true;
    } else if (token === "-d") {
      if (action !== "call") fail(`option ${token} is not valid for ${action}`);
      if (flags.detach !== undefined) fail("duplicate option: --detach");
      flags.detach = true;
    } else if (!token.startsWith("--")) {
      if (isBlankInput(token)) fail(`${action} requires a nonblank value`);
      positionals.push(token);
    } else {
      index = scanNamedOption({ action, spec, argv, index }, flags, fail);
    }
  }
  return { flags, positionals, stdin };
}

function positiveIndex(raw: FlagValue, option: string, fail: (message: string) => never): number {
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/u.test(raw)) fail(`${option} requires a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${option} exceeds the safe integer range`);
  return value;
}

function validateDirect(value: string, fail: (message: string) => never): string {
  try {
    if (value.startsWith("@")) parseAkumaAlias(value);
    else parseAkuId(value);
  } catch (error) {
    fail(error instanceof Error ? error.message : "invalid Akuma selector");
  }
  return value;
}

function validateSet(value: string, fail: (message: string) => never): string {
  if (value.startsWith("kei/")) return value;
  if (value.includes("*")) {
    try {
      parseAkumaGlob(value);
    } catch (error) {
      fail(error instanceof Error ? error.message : `invalid Akuma glob: ${value}`);
    }
    return value;
  }
  return validateDirect(value, fail);
}

function parseWait(
  rawSelectors: readonly string[],
  flags: Readonly<Record<string, FlagValue>>,
  output: "text" | "json",
  fail: (message: string) => never,
): ParsedAkumaCommand {
  if (flags.any === true && flags.all === true) fail("wait --any and --all are mutually exclusive");
  if (rawSelectors.length > 1 && flags.any !== true && flags.all !== true) {
    fail("wait requires --any or --all when selecting multiple Akuma");
  }
  const completion = flags.any === true ? ("any" as const) : flags.all === true ? ("all" as const) : undefined;
  return {
    command: "wait",
    akuma: rawSelectors.map((value) => validateSet(value, fail)),
    ...(completion === undefined ? {} : { completion }),
    ...(flags.timeout === undefined ? {} : { timeoutMs: parseDuration(flags.timeout, "--timeout", fail) }),
    output,
  };
}

function parseHistory(
  selector: string,
  flags: Readonly<Record<string, FlagValue>>,
  output: "text" | "json",
  fail: (message: string) => never,
): Extract<ParsedAkumaCommand, { command: "history" }> {
  if (selector.startsWith("kei/")) {
    if ([flags.id, flags.before, flags.since, flags.limit, flags.last].some((value) => value !== undefined)) {
      fail("history kei/... does not accept --id, --before, --since, --limit, or --last");
    }
    return { command: "history", contract: selector, output };
  }
  return parseAkumaHistory(selector, flags, output, fail);
}

function parseAkumaHistory(
  selector: string,
  flags: Readonly<Record<string, FlagValue>>,
  output: "text" | "json",
  fail: (message: string) => never,
): Extract<ParsedAkumaCommand, { command: "history"; akuma: string }> {
  const bounded = flags.before !== undefined || flags.since !== undefined || flags.limit !== undefined;
  if (flags.before !== undefined && flags.since !== undefined)
    fail("history --before and --since are mutually exclusive");
  if (flags.id !== undefined && (flags.last === true || bounded))
    fail("history --id cannot be combined with --last, --before, --since, or --limit");
  if (flags.last === true && bounded) fail("history --last cannot be combined with --before, --since, or --limit");
  const limit = flags.limit === undefined ? undefined : positiveIndex(flags.limit, "--limit", fail);
  if (limit !== undefined && limit > 5_000) fail("--limit must be no greater than 5000");
  const id =
    flags.id === undefined ? undefined : stringFlag(flags.id, "history --id requires a nonblank historyId", fail);
  if (id !== undefined && parsePublicHistoryId(id) === null) fail("history --id requires turn/<positive safe integer>");
  return {
    command: "history",
    akuma: validateDirect(selector, fail),
    ...(id === undefined ? {} : { id }),
    last: flags.last === true,
    ...(flags.before === undefined ? {} : { before: positiveIndex(flags.before, "--before", fail) }),
    ...(flags.since === undefined ? {} : { since: positiveIndex(flags.since, "--since", fail) }),
    ...(limit === undefined ? {} : { limit }),
    output,
  };
}

function parseAddressed(
  action: Exclude<AkumaAction, "call" | "tell">,
  rawSelectors: readonly string[],
  flags: Readonly<Record<string, FlagValue>>,
  output: "text" | "json",
  fail: (message: string) => never,
): ParsedAkumaCommand {
  if (action === "kill")
    return { command: action, akuma: rawSelectors.map((value) => validateSet(value, fail)), output };
  if (action === "wait") return parseWait(rawSelectors, flags, output, fail);
  if (action === "history") {
    const selector = rawSelectors[0]!;
    if (selector.includes("*")) fail("history accepts one complete aku/..., @alias, or kei/... selector");
    return parseHistory(selector, flags, output, fail);
  }
  const akuma = validateDirect(rawSelectors[0]!, fail);
  const at = stringFlag(flags.at, "fork requires --at <historyId>", fail);
  return { command: action, akuma, at, output };
}

function parsePrompted(
  action: "call" | "tell",
  positionals: readonly string[],
  stdin: boolean,
  fail: (message: string) => never,
): Readonly<{ subject: string; prompt: AkumaPromptSource }> {
  if (positionals.length < 1 || positionals.length > 2) fail(`${action} has invalid positional arguments`);
  const argument = positionals[1];
  if (stdin && argument !== undefined) fail(`${action} accepts either a prompt argument or stdin, not both`);
  if (!stdin && argument === undefined) fail(`${action} requires a prompt argument or stdin`);
  return {
    subject: positionals[0]!,
    prompt: stdin ? { kind: "stdin" } : { kind: "argument", value: argument! },
  };
}

function parseTell(
  flags: Readonly<Record<string, FlagValue>>,
  subject: string,
  prompt: AkumaPromptSource,
  output: "text" | "json",
  fail: (message: string) => never,
): Extract<ParsedAkumaCommand, { command: "tell" }> {
  return { command: "tell", akuma: validateDirect(subject, fail), interrupt: flags.interrupt === true, prompt, output };
}

function parseAllowedFlag(raw: FlagValue | undefined, fail: (message: string) => never): AllowedActions | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) fail("--allowed requires a value");
  const selected = raw as readonly string[];
  try {
    return decodeAllowedActions(selected, "--allowed");
  } catch (error) {
    fail(error instanceof Error ? error.message : "invalid --allowed action");
  }
}

function parseCall(
  flags: Readonly<Record<string, FlagValue>>,
  archetype: string,
  prompt: AkumaPromptSource,
  output: "text" | "json",
  fail: (message: string) => never,
): Extract<ParsedAkumaCommand, { command: "call" }> {
  let alias: AkumaAlias | undefined;
  if (flags.alias !== undefined) {
    try {
      alias = parseAkumaAlias(stringFlag(flags.alias, "--alias requires @name", fail));
    } catch (error) {
      fail(error instanceof Error ? error.message : "invalid Akuma alias");
    }
  }
  if (flags.detach === true && flags.wait !== undefined) fail("call --wait and --detach are mutually exclusive");
  const mode = flags.detach === true ? ("detach" as const) : ("wait" as const);
  const timeoutMs = flags.wait === undefined ? undefined : parseDuration(flags.wait, "--wait", fail);
  const allowed = parseAllowedFlag(flags.allowed, fail);
  return {
    command: "call",
    archetype,
    ...(typeof flags.contract === "string" ? { contract: flags.contract } : {}),
    ...(alias === undefined ? {} : { alias }),
    mode,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(flags.readonly === true ? { readonly: true } : {}),
    ...(allowed === undefined ? {} : { allowed }),
    prompt,
    output,
  };
}

export function parseAkumaCommand(argv: readonly string[]): ParsedAkumaCommand {
  const candidate = argv[0];
  if (!isAkumaAction(candidate)) throw new CliUsageError(`unknown command: ${candidate ?? ""}`);
  const action = candidate;
  const spec = AKUMA_COMMAND_SPECS[action];
  const fail = (message: string): never => {
    throw new CliUsageError(message, renderAkumaUsage(action));
  };
  const { flags, positionals, stdin } = scanAkuma(action, argv, fail);
  const output = flags.json === true ? ("json" as const) : ("text" as const);
  if (action === "call" || action === "tell") {
    const parsed = parsePrompted(action, positionals, stdin, fail);
    return action === "call"
      ? parseCall(flags, parsed.subject, parsed.prompt, output, fail)
      : parseTell(flags, parsed.subject, parsed.prompt, output, fail);
  }
  if (spec.arity === "one-or-more" ? positionals.length === 0 : positionals.length !== spec.arity) {
    fail(`${action} has invalid positional arguments`);
  }
  if (stdin) fail(`${action} reads no stdin`);
  return parseAddressed(action, positionals, flags, output, fail);
}
