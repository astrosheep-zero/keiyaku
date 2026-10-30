import { CliUsageError, commandGuide, usageLine, type CliUsageGuide } from "../usage.js";
import { scanArgs, type ScanFlagKind, type ScanSpec } from "../scan.js";
import { parseDuration as decodeDuration } from "../../duration.js";
import { parseAkumaAlias, parseAkumaGlob, type AkumaAlias } from "../../identity/selector.js";
import {
  ALLOWED_ACTIONS,
  DEFAULT_ALLOWED_ACTIONS,
  decodeAllowedActions,
  type AllowedActions,
} from "../../akuma/allowed.js";
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
        allowed?: AllowedActions;
        bare?: boolean;
        schema?: string;
      }> &
        Readonly<{ prompt?: AkumaPromptSource }>)
    | (Readonly<{ command: "report" }> & Prompted)
    | Readonly<{ command: "kill"; akuma: readonly string[] }>
    | Readonly<{ command: "wait"; akuma: readonly string[]; completion?: "any" | "all"; timeoutMs?: number }>
    | (Readonly<{ command: "tell"; interrupt: boolean }> & Addressed & Prompted)
    | (Readonly<{ command: "ask"; interrupt: boolean; schema?: string; timeoutMs?: number }> & Addressed & Prompted)
    | (Readonly<{
        command: "history";
        last: boolean;
        id?: string;
        before?: number;
        since?: number;
        limit?: number;
        full?: never;
      }> &
        Addressed)
    | Readonly<{ command: "history"; contract: string; full: boolean }>
    | (Readonly<{ command: "fork"; at: string; bare?: boolean }> & Addressed)
  );

export type InvokedAkumaCommand = Exclude<
  ParsedAkumaCommand,
  { command: "history"; contract: string } | { command: "report" }
>;

export type AkumaAction = ParsedAkumaCommand["command"];
type FlagValue = string | true | readonly string[];
type AkumaCommandSpec = Readonly<{
  arity: number | "one-or-more";
  stdin: boolean;
  flags: Readonly<Record<string, ScanFlagKind>>;
  usage: string;
  purpose: string;
  details?: string;
}>;

const EXTRA_ALLOWED_ACTIONS = ALLOWED_ACTIONS.filter((action) => !DEFAULT_ALLOWED_ACTIONS.includes(action));
const SET_SELECTORS = '(<aku/...> | @alias | <kei/...> | "aku/<name-pattern>/<hex-pattern>")...';
const SET_DETAILS =
  "Globs contain * and use lowercase hex digits or * in the suffix. --repo requires at least one Contract (kei/...) selector.";
const SCHEMA_DETAILS =
  "--schema supplies a JSON Schema answer contract to the provider; on observation the CLI parses JSON but does not independently validate schema conformance.";

const AKUMA_COMMAND_SPECS = {
  report: {
    arity: 1,
    stdin: true,
    flags: { json: "boolean" },
    usage: "report (<text> | -) [--json]",
    purpose: "Record progress in the invoking Akuma's Heart without ending work.",
    details:
      "Give one nonblank text argument, or - to read stdin. Requires explicit Akuma, World, Body and Turn execution declarations; no recipient or parent forwarding. Recorded means persisted, not received.",
  },
  call: {
    arity: 1,
    stdin: true,
    flags: {
      contract: "value",
      alias: "value",
      wait: "value",
      allowed: "repeat",
      bare: "boolean",
      json: "boolean",
      schema: "value",
    },
    usage:
      "call <akuma-name> [--contract <kei/...>] [--repo <path>] [--workdir <path>] [--alias <name>] [--allowed <product.action>]... [--bare] [--schema <file>] [--wait <duration>] [<prompt> | -]",
    purpose: "Call an Akuma into the world.",
    details: [
      "Use keiyaku ls aku/ to find visible Akuma names; hidden definitions can still be called by name.",
      "Omit the prompt to birth without a Tell; otherwise give <prompt> as one argument, or use - to read stdin.",
      "--schema and --wait require a prompt.",
      "--bare omits Keiyaku's runtime instruction section for this birth and its later execution; personality, tools, permissions, and report remain unchanged.",
      "Generic ACP needs --bare: it has no verified native runtime-instruction channel. Existing sessions without the section are not retrofitted; ordinary resume retains existing native instructions.",
      "By default, call returns after birth and optional first Tell admission; --wait also waits for its first answer, up to the given duration.",
      "--contract records an association, not the work or execution directory; include the Contract and worktree context in the prompt as needed. --repo requires --contract.",
      "--workdir selects where the Akuma works; relative paths resolve from the invocation directory selected by -C/--cwd, or the process cwd when omitted. Without --workdir, the invocation directory is used.",
      "--alias <name> gives the new Akuma the selector @name instead of aku/<id>; an existing @name is reassigned to this Akuma.",
      `Default actions: ${DEFAULT_ALLOWED_ACTIONS.join(", ")}.`,
      ...(EXTRA_ALLOWED_ACTIONS.length === 0
        ? []
        : [`Also available with --allowed: ${EXTRA_ALLOWED_ACTIONS.join(", ")}.`]),
      "Repeated --allowed adds actions to the selected Akuma's allowed actions; it cannot remove inherited permissions.",
      "If no actions are configured, defaults apply; an explicitly empty list allows none.",
      "An Akuma started by another Akuma can use only actions its parent can use. Use keiyaku status <aku/...|@alias> --json to inspect status.allowed.",
      SCHEMA_DETAILS,
      "With --wait, completed activity streams on stderr and the final answer is written to stdout once.",
    ].join("\n"),
  },
  wait: {
    arity: "one-or-more",
    stdin: false,
    flags: { any: "boolean", all: "boolean", timeout: "value", json: "boolean" },
    usage: `wait ${SET_SELECTORS} [--any | --all] [--timeout <duration>] [--repo <path>]`,
    purpose: "Wait for one or more Akumas to finish work.",
    details: [
      "The default mode is any; --all waits until every selected Akuma completes.",
      SET_DETAILS,
      "An already completed member counts immediately, so repeating a selection can return at once.",
      "Text prints each selected Akuma's status snapshot, then one failure fact for any Akuma it could not read.",
      "An answer is part of that snapshot; wait writes no separate copy of it to stdout.",
      "With --json stdout carries the result document.",
    ].join("\n"),
  },
  tell: {
    arity: 1,
    stdin: true,
    flags: { interrupt: "boolean", schema: "value", wait: "value", json: "boolean" },
    usage: "tell <aku/...|@alias> [--interrupt] (<prompt> | -)",
    purpose: "Tell an Akuma something without waiting for its answer.",
    details: [
      "Give <prompt> as one argument, or use - to read stdin.",
      "--interrupt durably admits the new Tell while asking the current Body to yield; admission remains even if completion cannot be proven.",
      "Use ask to block for the answer or supply a schema.",
    ].join("\n"),
  },
  ask: {
    arity: 1,
    stdin: true,
    flags: { interrupt: "boolean", schema: "value", wait: "value", json: "boolean" },
    usage: "ask <aku/...|@alias> [--interrupt] [--schema <file>] [--wait <duration>] (<prompt> | -)",
    purpose: "Ask an Akuma and block until it answers.",
    details: [
      "Give <prompt> as one argument, or use - to read stdin.",
      "--interrupt durably admits the new Tell while asking the current Body to yield; admission remains even if completion cannot be proven.",
      SCHEMA_DETAILS,
      "--wait bounds how long to block for the answer; the Tell stays admitted past the deadline.",
      "Completed activity streams on stderr and the final answer is written to stdout once.",
    ].join("\n"),
  },
  history: {
    arity: 1,
    stdin: false,
    flags: {
      id: "value",
      before: "value",
      since: "value",
      limit: "value",
      last: "boolean",
      full: "boolean",
      json: "boolean",
    },
    usage:
      "history <aku/...|@alias> [--before <index> | --since <index>] [--limit <count>]\nhistory <aku/...|@alias> --id <historyId>\nhistory <aku/...|@alias> --last\nhistory <kei/...> [--full] [--repo <path>]",
    purpose: "Read an Akuma's answers and activity, or a Contract's history of changes and assigned work.",
    details: [
      "--id reads an exact retained terminal turn (turn/<number>): its answer or failure diagnostic.",
      "--before <index> pages older rows before that sequence; --since <index> pages newer rows after it.",
      "--limit bounds page size (default 12); without --since, the latest rows are shown.",
      "With --since, paging starts at the earliest newer rows.",
      "--last returns only the most recent answer, if one exists; it is not a history page.",
      "Contract history defaults to a causal skeleton; --full prints every event with complete fields.",
    ].join("\n"),
  },
  fork: {
    arity: 1,
    stdin: false,
    flags: { at: "value", bare: "boolean", json: "boolean" },
    usage: "fork <aku/...|@alias> --at <historyId> [--bare] [--repo <path>]",
    purpose: "Create a new Akuma from an answered turn.",
    details: [
      "--at takes a retained answered turn id (turn/<n>); find its historyId in paged keiyaku history <aku/...|@alias> --json. Fork also requires a retained provider fork point.",
      "A fork inherits bare; --bare additionally omits only the child's Keiyaku runtime instructions.",
    ].join("\n"),
  },
  kill: {
    arity: "one-or-more",
    stdin: false,
    flags: { json: "boolean" },
    usage: `kill ${SET_SELECTORS} [--repo <path>]`,
    purpose: "Stop the selected Akuma's current work; it can be woken again with tell.",
    details: SET_DETAILS,
  },
} as const satisfies Readonly<Record<string, AkumaCommandSpec>>;

export function isAkumaAction(value: string | undefined): value is AkumaAction {
  return value !== undefined && Object.hasOwn(AKUMA_COMMAND_SPECS, value);
}

export function isParsedAkumaCommand(command: Readonly<{ command: string }>): command is InvokedAkumaCommand {
  return (
    isAkumaAction(command.command) &&
    command.command !== "report" &&
    !("contract" in command && command.command === "history")
  );
}

export function renderAkumaRootRows(): readonly string[] {
  return Object.entries(AKUMA_COMMAND_SPECS).map(([action, spec]) => `  ${action.padEnd(10)} ${spec.purpose}`);
}

export function renderAkumaHelp(action: AkumaAction): string {
  const spec: AkumaCommandSpec = AKUMA_COMMAND_SPECS[action];
  return `${spec.purpose}\n\n${usageLine(spec.usage)}${spec.details === undefined ? "" : `\n\n${spec.details}`}`;
}

export function akumaUsageGuide(action: AkumaAction): CliUsageGuide {
  return commandGuide(action, AKUMA_COMMAND_SPECS[action].usage);
}

const TELL_ONLY_REFUSALS = {
  "--wait": "tell --wait is not supported; use ask --wait",
  "--schema": "tell --schema is not supported; use ask --schema",
};

/** The prompt is the only stdin reader; the ask-only options are refused tokens, as is `-d`. */
function scanSpec(action: AkumaAction, spec: AkumaCommandSpec): ScanSpec {
  return {
    subject: action,
    flags: spec.flags,
    ...(spec.stdin ? { stdin: "prompt" } : {}),
    stdinRefusal: `stdin marker '-' is not valid for ${action}`,
    refused: {
      "-d": `option -d is not valid for ${action}`,
      ...(action === "tell" ? TELL_ONLY_REFUSALS : {}),
    },
  };
}

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

function positiveIndex(raw: FlagValue, option: string, fail: (message: string) => never): number {
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/u.test(raw)) fail(`${option} requires a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${option} exceeds the safe integer range`);
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
  return value;
}

function parseWait(
  rawSelectors: readonly string[],
  flags: Readonly<Record<string, FlagValue>>,
  output: "text" | "json",
  fail: (message: string) => never,
): ParsedAkumaCommand {
  if (flags.any === true && flags.all === true) fail("wait --any and --all are mutually exclusive");
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
    return { command: "history", contract: selector, full: flags.full === true, output };
  }
  return parseAkumaHistory(selector, flags, output, fail);
}

function refuseHistoryIdConflict(
  flags: Readonly<Record<string, FlagValue>>,
  bounded: boolean,
  fail: (message: string) => never,
): void {
  if (flags.id !== undefined && (flags.last === true || bounded))
    fail("history --id cannot be combined with --last, --before, --since, or --limit");
}

function parseAkumaHistory(
  selector: string,
  flags: Readonly<Record<string, FlagValue>>,
  output: "text" | "json",
  fail: (message: string) => never,
): Extract<ParsedAkumaCommand, { command: "history"; akuma: string }> {
  if (flags.full === true) fail("history --full is only valid for kei/...");
  const bounded = flags.before !== undefined || flags.since !== undefined || flags.limit !== undefined;
  if (flags.before !== undefined && flags.since !== undefined)
    fail("history --before and --since are mutually exclusive");
  refuseHistoryIdConflict(flags, bounded, fail);
  if (flags.last === true && bounded) fail("history --last cannot be combined with --before, --since, or --limit");
  const limit = flags.limit === undefined ? undefined : positiveIndex(flags.limit, "--limit", fail);
  if (limit !== undefined && limit > 5_000) fail("--limit must be no greater than 5000");
  const id =
    flags.id === undefined ? undefined : stringFlag(flags.id, "history --id requires a nonblank historyId", fail);
  if (id !== undefined && parsePublicHistoryId(id) === null) fail("history --id requires turn/<positive safe integer>");
  return {
    command: "history",
    akuma: selector,
    ...(id === undefined ? {} : { id }),
    last: flags.last === true,
    ...(flags.before === undefined ? {} : { before: positiveIndex(flags.before, "--before", fail) }),
    ...(flags.since === undefined ? {} : { since: positiveIndex(flags.since, "--since", fail) }),
    ...(limit === undefined ? {} : { limit }),
    output,
  };
}

function parseAddressed(
  action: Exclude<AkumaAction, "call" | "tell" | "ask" | "report">,
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
  const akuma = rawSelectors[0]!;
  const at = stringFlag(flags.at, "fork requires --at <historyId>", fail);
  return { command: action, akuma, at, ...(flags.bare === true ? { bare: true } : {}), output };
}

function parsePrompted(
  action: "call" | "tell" | "ask",
  positionals: readonly string[],
  stdin: boolean,
  fail: (message: string) => never,
): Readonly<{ subject: string; prompt?: AkumaPromptSource }> {
  if (positionals.length === 0)
    fail(action === "call" ? "call requires an Akuma name" : `${action} requires an Akuma selector`);
  if (positionals.length > 2)
    fail(`${action} accepts at most ${action === "call" ? "a name" : "a selector"} and one prompt`);
  const argument = positionals[1];
  if (stdin && argument !== undefined) fail(`${action} accepts either a prompt argument or stdin, not both`);
  if (action !== "call" && !stdin && argument === undefined) fail(`${action} requires a prompt argument or stdin`);
  return {
    subject: positionals[0]!,
    ...(stdin
      ? { prompt: { kind: "stdin" as const } }
      : argument === undefined
        ? {}
        : { prompt: { kind: "argument" as const, value: argument } }),
  };
}

function parseTell(
  flags: Readonly<Record<string, FlagValue>>,
  subject: string,
  prompt: AkumaPromptSource,
  output: "text" | "json",
): Extract<ParsedAkumaCommand, { command: "tell" }> {
  return {
    command: "tell",
    akuma: subject,
    interrupt: flags.interrupt === true,
    prompt,
    output,
  };
}

function parseAsk(
  flags: Readonly<Record<string, FlagValue>>,
  subject: string,
  prompt: AkumaPromptSource,
  output: "text" | "json",
  fail: (message: string) => never,
): Extract<ParsedAkumaCommand, { command: "ask" }> {
  const schema =
    flags.schema === undefined ? undefined : stringFlag(flags.schema, "ask --schema requires a file", fail);
  return {
    command: "ask",
    akuma: subject,
    interrupt: flags.interrupt === true,
    ...(schema === undefined ? {} : { schema }),
    ...(flags.wait === undefined ? {} : { timeoutMs: parseDuration(flags.wait, "--wait", fail) }),
    prompt,
    output,
  };
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
  prompt: AkumaPromptSource | undefined,
  output: "text" | "json",
  fail: (message: string) => never,
): Extract<ParsedAkumaCommand, { command: "call" }> {
  let alias: AkumaAlias | undefined;
  if (flags.alias !== undefined) {
    try {
      const name = stringFlag(flags.alias, "--alias requires a name", fail);
      alias = parseAkumaAlias(name.startsWith("@") ? name : `@${name}`);
    } catch (error) {
      fail(error instanceof Error ? error.message : "invalid Akuma alias");
    }
  }
  const mode = flags.wait === undefined ? ("detach" as const) : ("wait" as const);
  const timeoutMs = flags.wait === undefined ? undefined : parseDuration(flags.wait, "--wait", fail);
  const allowed = parseAllowedFlag(flags.allowed, fail);
  const schema =
    flags.schema === undefined ? undefined : stringFlag(flags.schema, "call --schema requires a file", fail);
  if (prompt === undefined && schema !== undefined) fail("call --schema requires a prompt");
  if (prompt === undefined && flags.wait !== undefined) fail("call --wait requires a prompt");
  return {
    command: "call",
    archetype,
    ...(typeof flags.contract === "string" ? { contract: flags.contract } : {}),
    ...(alias === undefined ? {} : { alias }),
    mode,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(allowed === undefined ? {} : { allowed }),
    ...(flags.bare === true ? { bare: true } : {}),
    ...(schema === undefined ? {} : { schema }),
    ...(prompt === undefined ? {} : { prompt }),
    output,
  };
}

function parseReport(
  positionals: readonly string[],
  stdin: boolean,
  output: "text" | "json",
  fail: (message: string) => never,
): Extract<ParsedAkumaCommand, { command: "report" }> {
  if (stdin ? positionals.length !== 0 : positionals.length !== 1)
    fail("report requires one text argument or stdin, not both");
  const value = positionals[0];
  if (value !== undefined && value.trim() === "") fail("report requires nonblank text");
  return { command: "report", output, prompt: stdin ? { kind: "stdin" } : { kind: "argument", value: value! } };
}

export function parseAkumaCommand(argv: readonly string[]): ParsedAkumaCommand {
  const candidate = argv[0];
  if (!isAkumaAction(candidate)) throw new CliUsageError(`unknown command: ${candidate ?? ""}`);
  const action = candidate;
  const spec = AKUMA_COMMAND_SPECS[action];
  const fail = (message: string): never => {
    throw new CliUsageError(message, akumaUsageGuide(action));
  };
  const { flags, positionals, stdin } = scanArgs(argv, scanSpec(action, spec), fail);
  const output = flags.json === true ? ("json" as const) : ("text" as const);
  if (action === "report") return parseReport(positionals, stdin !== undefined, output, fail);
  if (action === "call" || action === "tell" || action === "ask") {
    const parsed = parsePrompted(action, positionals, stdin !== undefined, fail);
    return action === "call"
      ? parseCall(flags, parsed.subject, parsed.prompt, output, fail)
      : action === "tell"
        ? parseTell(flags, parsed.subject, parsed.prompt!, output)
        : parseAsk(flags, parsed.subject, parsed.prompt!, output, fail);
  }
  if (spec.arity === "one-or-more" ? positionals.length === 0 : positionals.length !== spec.arity) {
    if (positionals.length === 0)
      fail(
        spec.arity === "one-or-more"
          ? `${action} requires at least one Akuma selector`
          : `${action} requires an Akuma selector`,
      );
    else
      fail(
        spec.arity === 1
          ? `${action} accepts one Akuma selector`
          : `${action} accepts exactly ${spec.arity} Akuma selectors`,
      );
  }
  if (stdin !== undefined) fail(`${action} reads no stdin`);
  return parseAddressed(action, positionals, flags, output, fail);
}
