import { CliUsageError, usageLine } from "../usage.js";
import { archetypeName, parseAkuId } from "../../akuma/identity.js";
import { parseAkumaAlias, parseAkumaGlob, type AkumaAlias } from "../../identity/selector.js";

type Output = Readonly<{ output: "text" | "json" }>;
type Addressed = Readonly<{ akuma: string }>;

export type ParsedAkumaCommand = Output & (
  | Readonly<{
      command: "call";
      archetype: string;
      workdir?: string;
      contract?: string;
      alias?: AkumaAlias;
      mode: "wait" | "detach";
      timeoutMs?: number;
    }>
  | Readonly<{ command: "kill"; akuma: readonly string[] }>
  | Readonly<{ command: "wait"; akuma: readonly string[]; completion?: "any" | "all"; timeoutMs?: number }>
  | (Readonly<{ command: "tell"; interrupt: boolean }> & Addressed)
  | (Readonly<{ command: "history"; last: boolean; before?: number; since?: number }> & Addressed)
  | (Readonly<{ command: "fork"; at: string }> & Addressed)
);

export type AkumaAction = ParsedAkumaCommand["command"];
type FlagValue = string | true;
type AkumaCommandSpec = Readonly<{
  arity: number | "one-or-more";
  stdin: boolean;
  flags: Readonly<Record<string, "boolean" | "value">>;
  usage: string;
  purpose: string;
}>;

const AKUMA_COMMAND_SPECS = {
  call: {
    arity: 1,
    stdin: true,
    flags: {
      contract: "value",
      alias: "value",
      workdir: "value",
      wait: "boolean",
      timeout: "value",
      detach: "boolean",
      json: "boolean",
    },
    usage: "call <akuma> [--contract <kei/...>] [--alias @name] [--workdir <path>] [--wait [--timeout <duration>] | -d | --detach] [--json] -",
    purpose: "Call an Akuma from an Archetype and stdin body.",
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
    usage: "tell <aku/...> [--interrupt] [--json] -",
    purpose: "Record and wake one Akuma, optionally putting down its current Body first.",
  },
  history: {
    arity: 1,
    stdin: false,
    flags: { before: "value", since: "value", last: "boolean", json: "boolean" },
    usage: "history <aku/...> [--before <index> | --since <index> | --last] [--json]",
    purpose: "Read the persistent execution history or the last answer.",
  },
  fork: {
    arity: 1,
    stdin: false,
    flags: { at: "value", json: "boolean" },
    usage: "fork <aku/...> --at <historyId> [--json]",
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

export function isParsedAkumaCommand(command: Readonly<{ command: string }>): command is ParsedAkumaCommand {
  return isAkumaAction(command.command);
}

export function renderAkumaRootRows(): readonly string[] {
  return Object.values(AKUMA_COMMAND_SPECS).flatMap((spec) => [`  ${spec.usage}`, `    ${spec.purpose}`]);
}

export function renderAkumaHelp(action: AkumaAction): string {
  const spec = AKUMA_COMMAND_SPECS[action];
  return `${spec.purpose}\n\n${usageLine(spec.usage)}`;
}

export function renderAkumaUsage(action: AkumaAction): string {
  return usageLine(AKUMA_COMMAND_SPECS[action].usage);
}

export function parseAkumaCatalogPath(value: string): Readonly<{ kind: "archetypes" } | { kind: "akuma"; archetype?: string }> | null {
  if (value === "aku/") return { kind: "archetypes" };
  if (value === "aku/*/*") return { kind: "akuma" };
  const match = /^aku\/(.+)\/$/u.exec(value);
  if (match === null) return null;
  return { kind: "akuma", archetype: archetypeName(match[1]!) };
}

type Scanned = Readonly<{ flags: Readonly<Record<string, FlagValue>>; positionals: readonly string[]; stdin: boolean }>;

function stringFlag(value: FlagValue | undefined, diagnostic: string, fail: (message: string) => never): string {
  if (typeof value !== "string") fail(diagnostic);
  return value as string;
}

function parseDuration(raw: FlagValue, fail: (message: string) => never): number {
  const match = typeof raw === "string" ? /^(0|[1-9][0-9]*)(ms|s|m|h)$/u.exec(raw) : null;
  if (match === null) fail("--timeout requires an integer duration with unit ms, s, m, or h");
  const multipliers = { ms: 1n, s: 1_000n, m: 60_000n, h: 3_600_000n } as const;
  const milliseconds = BigInt(match[1]!) * multipliers[match[2] as keyof typeof multipliers];
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) fail("--timeout duration exceeds the safe millisecond range");
  return Number(milliseconds);
}

function scanAkuma(action: AkumaAction, argv: readonly string[], fail: (message: string) => never): Scanned {
  const spec = AKUMA_COMMAND_SPECS[action];
  const flags: Record<string, FlagValue> = {};
  const positionals: string[] = [];
  let stdin = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "-") {
      if (stdin || index !== argv.length - 1 || !spec.stdin) fail(`stdin marker '-' is not valid for ${action}`);
      stdin = true;
    } else if (token === "-d") {
      if (action !== "call") fail(`option ${token} is not valid for ${action}`);
      if (flags.detach !== undefined) fail("duplicate option: --detach");
      flags.detach = true;
    } else if (!token.startsWith("--")) positionals.push(token);
    else {
      const name = token.slice(2);
      const kind = (spec.flags as Readonly<Record<string, "boolean" | "value">>)[name];
      if (kind === undefined) fail(`option ${token} is not valid for ${action}`);
      if (flags[name] !== undefined) fail(`duplicate option: ${token}`);
      if (kind === "boolean") flags[name] = true;
      else {
        const value = argv[index + 1];
        if (value === undefined || value === "-" || value === "-d" || value.startsWith("--")) {
          fail(`${token} requires a value`);
        }
        flags[name] = value;
        index += 1;
      }
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
    try { parseAkumaGlob(value); }
    catch (error) { fail(error instanceof Error ? error.message : `invalid Akuma glob: ${value}`); }
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
  const completion = flags.any === true ? "any" as const : flags.all === true ? "all" as const : undefined;
  return {
    command: "wait",
    akuma: rawSelectors.map((value) => validateSet(value, fail)),
    ...(completion === undefined ? {} : { completion }),
    ...(flags.timeout === undefined ? {} : { timeoutMs: parseDuration(flags.timeout, fail) }),
    output,
  };
}

function parseHistory(
  akuma: string,
  flags: Readonly<Record<string, FlagValue>>,
  output: "text" | "json",
  fail: (message: string) => never,
): ParsedAkumaCommand {
  if (flags.before !== undefined && flags.since !== undefined) fail("history --before and --since are mutually exclusive");
  if (flags.last === true && (flags.before !== undefined || flags.since !== undefined)) {
    fail("history --last cannot be combined with --before or --since");
  }
  return {
    command: "history",
    akuma,
    last: flags.last === true,
    ...(flags.before === undefined ? {} : { before: positiveIndex(flags.before, "--before", fail) }),
    ...(flags.since === undefined ? {} : { since: positiveIndex(flags.since, "--since", fail) }),
    output,
  };
}

function parseAddressed(
  action: Exclude<AkumaAction, "call">,
  rawSelectors: readonly string[],
  flags: Readonly<Record<string, FlagValue>>,
  output: "text" | "json",
  fail: (message: string) => never,
): ParsedAkumaCommand {
  if (action === "kill") return { command: action, akuma: rawSelectors.map((value) => validateSet(value, fail)), output };
  if (action === "tell") {
    return { command: action, akuma: validateDirect(rawSelectors[0]!, fail), interrupt: flags.interrupt === true, output };
  }
  if (action === "wait") return parseWait(rawSelectors, flags, output, fail);
  const akuma = validateDirect(rawSelectors[0]!, fail);
  if (action === "history") return parseHistory(akuma, flags, output, fail);
  const at = stringFlag(flags.at, "fork requires --at <historyId>", fail);
  if (at.trim().length === 0) fail("fork requires --at <historyId>");
  return { command: action, akuma, at, output };
}

function parseCall(
  flags: Readonly<Record<string, FlagValue>>,
  positionals: readonly string[],
  output: "text" | "json",
  fail: (message: string) => never,
): Extract<ParsedAkumaCommand, { command: "call" }> {
  let alias: AkumaAlias | undefined;
  if (flags.alias !== undefined) {
    try { alias = parseAkumaAlias(stringFlag(flags.alias, "--alias requires @name", fail)); }
    catch (error) { fail(error instanceof Error ? error.message : "invalid Akuma alias"); }
  }
  if (flags.detach === true && flags.wait === true) fail("call --wait and --detach are mutually exclusive");
  if (flags.detach === true && flags.timeout !== undefined) fail("call --timeout and --detach are mutually exclusive");
  const mode = flags.detach === true ? "detach" as const : "wait" as const;
  const timeoutMs = flags.timeout === undefined ? undefined : parseDuration(flags.timeout, fail);
  return {
    command: "call",
    archetype: positionals[0]!,
    ...(typeof flags.contract === "string" ? { contract: flags.contract } : {}),
    ...(alias === undefined ? {} : { alias }),
    ...(typeof flags.workdir === "string" ? { workdir: flags.workdir } : {}),
    mode,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    output,
  };
}

export function parseAkumaCommand(argv: readonly string[]): ParsedAkumaCommand {
  const candidate = argv[0];
  if (!isAkumaAction(candidate)) throw new CliUsageError(`unknown command: ${candidate ?? ""}`);
  const action = candidate;
  const spec = AKUMA_COMMAND_SPECS[action];
  const fail = (message: string): never => { throw new CliUsageError(message, renderAkumaUsage(action)); };
  const { flags, positionals, stdin } = scanAkuma(action, argv, fail);
  if (spec.arity === "one-or-more" ? positionals.length === 0 : positionals.length !== spec.arity) {
    fail(`${action} has invalid positional arguments`);
  }
  if (stdin !== spec.stdin) fail(`${action} ${spec.stdin ? "requires" : "reads no"} stdin`);
  const output = flags.json === true ? "json" as const : "text" as const;
  if (action === "call") return parseCall(flags, positionals, output, fail);
  return parseAddressed(action, positionals, flags, output, fail);
}
