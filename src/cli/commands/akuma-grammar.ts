import { CliUsageError, commandGuide, usageLine, type CliUsageGuide } from "../usage.js";
import { scanArgs, type ScanFlagKind, type ScanSpec } from "../scan.js";
import { parseDuration as decodeDuration } from "../../duration.js";
import { parseAkumaAlias, parseAkumaGlob, type AkumaAlias } from "../../identity/selector.js";
import { parseExactHistorySelector } from "../../akuma/identity.js";

import type { CliRequest, PendingRequest, VerbRequest } from "../parse.js";

export type AkumaPromptSource = Readonly<{ kind: "argument"; value: string }> | Readonly<{ kind: "stdin" }>;
export type ReportCommand = Readonly<{ command: "report"; output: "text" | "json"; prompt: AkumaPromptSource }>;
export type AkumaParseResult = CliRequest | ReportCommand;

export type AkumaAction = keyof typeof AKUMA_COMMAND_SPECS;
type FlagValue = string | true | readonly string[];
type AkumaCommandSpec = Readonly<{
  arity: number | "one-or-more";
  stdin: boolean;
  flags: Readonly<Record<string, ScanFlagKind>>;
  usage: string;
  purpose: string;
  details?: string;
}>;

const SET_SELECTORS = '(<aku/...> | @name | <kei/...> | "aku/<name-pattern>/<hex-pattern>")...';
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
    purpose: "Report progress to your caller and keep working.",
    details:
      "Give <text> as one argument, or - to read stdin. Works only from inside a running Akuma. It does not end your turn or replace your final answer.",
  },
  spawn: {
    arity: 1,
    stdin: true,
    flags: {
      contract: "value",
      alias: "value",
      wait: "value",
      "add-dir": "repeat",
      bare: "boolean",
      json: "boolean",
    },
    usage:
      "spawn <akuma-name> [--contract <kei/...>] [--repo <path>] [--workdir <path>] [--alias <name>] [--add-dir <path>]... [--bare] [--wait <duration>] [<prompt> | -]",
    purpose: "Spawn a new Akuma into the world.",
    details: [
      "Use keiyaku ls aku/ to list available Akuma names.",
      "Omit the prompt to birth without a Tell; otherwise give <prompt> as one argument, or use - to read stdin.",
      "--wait requires a prompt.",
      "--bare omits Keiyaku's runtime instruction section for this birth and its later execution; personality, tools, permissions, and report remain unchanged.",
      "Generic ACP needs --bare: it has no verified native runtime-instruction channel. Existing sessions without the section are not retrofitted; ordinary resume retains existing native instructions.",
      "By default, spawn returns after birth and optional first Tell admission; --wait also waits for its first answer, up to the given duration.",
      "--contract records an association, not the work or execution directory; include the Contract and worktree context in the prompt as needed. --repo requires --contract.",
      "--workdir selects where the Akuma works; relative paths resolve from the invocation directory selected by -C/--cwd, or the process cwd when omitted. Without --workdir, the invocation directory is used.",
      "--add-dir explicitly grants another existing writable directory to Codex native workspace-write tools; repeat for multiple roots. Relative paths resolve from the invocation directory. Other sandbox modes, permission profiles, and providers refuse nonempty grants instead of broadening policy. Existing network policy and writable roots are preserved; the repo and Home are never granted automatically.",
      "--alias <name> gives the new Akuma the selector @name instead of aku/<id>; an existing @name is reassigned to this Akuma.",
      "With --wait, completed activity streams on stderr and the final answer is written to stdout once.",
    ].join("\n"),
  },
  wait: {
    arity: "one-or-more",
    stdin: false,
    flags: { any: "boolean", all: "boolean", timeout: "value", json: "boolean" },
    usage: `wait ${SET_SELECTORS} [--any | --all] [--timeout <duration>] [--repo <path>]`,
    purpose: "Wait for Contract changes or terminal state, or Akumas to finish work.",
    details: [
      "Select Contracts or Akumas, never both in one wait. Contract IDs wait for their next journal change or terminal state, not associated Akumas.",
      "The default mode is any; --all waits for every selected member. Each Contract starts from its current journal head; already accepted or abandoned Contracts complete immediately.",
      SET_DETAILS,
      "An already completed Akuma counts immediately; a deadline only bounds observation.",
      "With --json stdout carries the native result document.",
    ].join("\n"),
  },
  tell: {
    arity: 1,
    stdin: true,
    flags: { interrupt: "boolean", wait: "value", json: "boolean" },
    usage: "tell <aku/...|@name> [--interrupt] [--wait <duration>] (<prompt> | -)",
    purpose: "Tell an Akuma something, optionally observing its answer.",
    details: [
      "Give <prompt> as one argument, or use - to read stdin.",
      "--interrupt admits the Tell and asks current work to yield; the Tell remains admitted even if yielding cannot be confirmed.",
      "--wait bounds how long to block for the answer; the Tell stays admitted past the deadline.",
      "Without --wait, returns after Tell admission.",
      "With observation, completed activity streams on stderr and the final answer is written to stdout once.",
    ].join("\n"),
  },
  ask: {
    arity: 1,
    stdin: true,
    flags: { schema: "value", wait: "value", interrupt: "boolean", json: "boolean" },
    usage: "ask <aku/...|@name> --schema <file> [--wait <duration>] [--interrupt] (<prompt> | -)",
    purpose: "Ask an Akuma for a JSON answer.",
    details: `${SCHEMA_DETAILS}\n--wait is an observation deadline; omitted is unbounded. --interrupt admits input with a request for current work to yield. Give the prompt as one argument, or - for stdin.`,
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
      "history <aku/...|@name> [--before <index> | --since <index>] [--limit <count>]\nhistory <aku/...|@name> --id <historyId>\nhistory <aku/...|@name> --last\nhistory <kei/...> [--full] [--repo <path>]",
    purpose: "Read an Akuma's answers and activity, or a Contract's history of changes and assigned work.",
    details: [
      "--id reads an exact retained terminal turn (turn/<number>) or report (report/<number>).",
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
    usage: "fork <aku/...|@name> --at <historyId> [--bare] [--repo <path>]",
    purpose: "Create a new Akuma from an answered turn.",
    details: [
      "--at takes a retained answered turn id (turn/<n>); find its historyId in paged keiyaku history <aku/...|@name> --json. Fork also requires a retained provider fork point.",
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

/** The prompt is the only stdin reader. */
function scanSpec(action: AkumaAction, spec: AkumaCommandSpec): ScanSpec {
  return {
    subject: action,
    flags: spec.flags,
    ...(spec.stdin ? { stdin: "prompt" } : {}),
    stdinRefusal: `stdin marker '-' is not valid for ${action}`,
    refused: { "-d": `option -d is not valid for ${action}` },
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
): VerbRequest<"wait"> {
  if (flags.any === true && flags.all === true) fail("wait --any and --all are mutually exclusive");
  const completion = flags.any === true ? ("any" as const) : flags.all === true ? ("all" as const) : undefined;
  const selectors = rawSelectors.map((value) => validateSet(value, fail));
  if (selectors.some((value) => value.startsWith("kei/")) && selectors.some((value) => !value.startsWith("kei/")))
    fail("wait cannot mix Contract and Akuma selectors");
  return {
    name: "wait",
    input: {
      selectors,
      ...(completion === undefined ? {} : { completion }),
      ...(flags.timeout === undefined ? {} : { timeoutMs: parseDuration(flags.timeout, "--timeout", fail) }),
    },
    output,
  };
}

function parseHistory(
  selector: string,
  flags: Readonly<Record<string, FlagValue>>,
  output: "text" | "json",
  fail: (message: string) => never,
): VerbRequest<"history"> {
  if (selector.startsWith("kei/")) {
    if ([flags.id, flags.before, flags.since, flags.limit, flags.last].some((value) => value !== undefined)) {
      fail("history kei/... does not accept --id, --before, --since, --limit, or --last");
    }
    return { name: "history", input: { selector, full: flags.full === true }, output };
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
): VerbRequest<"history"> {
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
  if (id !== undefined && parseExactHistorySelector(id) === null)
    fail("history --id requires turn/<positive safe integer> or report/<positive safe integer>");
  return {
    name: "history",
    input: {
      selector,
      ...(id === undefined ? {} : { id }),
      last: flags.last === true,
      ...(flags.before === undefined ? {} : { before: positiveIndex(flags.before, "--before", fail) }),
      ...(flags.since === undefined ? {} : { since: positiveIndex(flags.since, "--since", fail) }),
      ...(limit === undefined ? {} : { limit }),
    },
    output,
  };
}

function parseAddressed(
  action: Exclude<AkumaAction, "spawn" | "tell" | "ask" | "report">,
  rawSelectors: readonly string[],
  flags: Readonly<Record<string, FlagValue>>,
  output: "text" | "json",
  fail: (message: string) => never,
): CliRequest {
  if (action === "kill")
    return { name: action, input: { akuma: rawSelectors.map((value) => validateSet(value, fail)) }, output };
  if (action === "wait") return parseWait(rawSelectors, flags, output, fail);
  if (action === "history") {
    const selector = rawSelectors[0]!;
    if (selector.includes("*")) fail("history accepts one complete aku/..., @name, or kei/... selector");
    return parseHistory(selector, flags, output, fail);
  }
  const akuma = rawSelectors[0]!;
  const at = stringFlag(flags.at, "fork requires --at <historyId>", fail);
  return { name: action, input: { akuma, at, ...(flags.bare === true ? { bare: true } : {}) }, output };
}

function parsePrompted(
  action: "spawn" | "tell" | "ask",
  positionals: readonly string[],
  stdin: boolean,
  fail: (message: string) => never,
): Readonly<{ subject: string; prompt?: AkumaPromptSource }> {
  if (positionals.length === 0)
    fail(action === "spawn" ? "spawn requires an Akuma name" : `${action} requires an Akuma selector`);
  if (positionals.length > 2)
    fail(`${action} accepts at most ${action === "spawn" ? "a name" : "a selector"} and one prompt`);
  const argument = positionals[1];
  if (stdin && argument !== undefined) fail(`${action} accepts either a prompt argument or stdin, not both`);
  if (action !== "spawn" && !stdin && argument === undefined) fail(`${action} requires a prompt argument or stdin`);
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
  action: "tell" | "ask",
  flags: Readonly<Record<string, FlagValue>>,
  subject: string,
  prompt: AkumaPromptSource,
  fail: (message: string) => never,
): Extract<PendingRequest, { name: "tell" | "ask" }> {
  const output = flags.json === true ? "json" : "text";
  const input = {
    akuma: subject,
    ...(flags.interrupt === true ? { interrupt: true } : {}),
    ...(flags.wait === undefined ? {} : { timeoutMs: parseDuration(flags.wait, "--wait", fail) }),
  };
  return action === "tell"
    ? {
        name: action,
        input: { ...input, ...(flags.wait === undefined ? {} : { wait: true }) },
        acquire: { prompt },
        output,
      }
    : {
        name: action,
        input,
        acquire: { prompt, schema: stringFlag(flags.schema, "ask requires --schema <file>", fail) },
        output,
      };
}

function parseSpawn(
  flags: Readonly<Record<string, FlagValue>>,
  akumaName: string,
  prompt: AkumaPromptSource | undefined,
  output: "text" | "json",
  fail: (message: string) => never,
): Extract<PendingRequest, { name: "spawn" }> {
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
  if (prompt === undefined && flags.wait !== undefined) fail("spawn --wait requires a prompt");
  return {
    name: "spawn",
    input: {
      akumaName,
      ...(typeof flags.contract === "string" ? { contract: flags.contract } : {}),
      ...(alias === undefined ? {} : { alias }),
      mode,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(flags["add-dir"] === undefined ? {} : { writableDirectories: flags["add-dir"] as readonly string[] }),
      ...(flags.bare === true ? { bare: true } : {}),
    },
    acquire: { ...(prompt === undefined ? {} : { prompt }) },
    output,
  };
}

function parseReport(
  positionals: readonly string[],
  stdin: boolean,
  output: "text" | "json",
  fail: (message: string) => never,
): ReportCommand {
  if (stdin ? positionals.length !== 0 : positionals.length !== 1)
    fail("report requires one text argument or stdin, not both");
  const value = positionals[0];
  if (value !== undefined && value.trim() === "") fail("report requires nonblank text");
  return { command: "report", output, prompt: stdin ? { kind: "stdin" } : { kind: "argument", value: value! } };
}

export function parseAkumaCommand(argv: readonly string[]): AkumaParseResult {
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
  if (action === "spawn" || action === "tell" || action === "ask") {
    const parsed = parsePrompted(action, positionals, stdin !== undefined, fail);
    return action === "spawn"
      ? parseSpawn(flags, parsed.subject, parsed.prompt, output, fail)
      : parseTell(action, flags, parsed.subject, parsed.prompt!, fail);
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
