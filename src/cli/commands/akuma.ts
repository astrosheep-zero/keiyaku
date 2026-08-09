import { CliUsageError, usageLine } from "../usage.js";

type Output = Readonly<{ output: "text" | "json" }>;
type Addressed = Readonly<{ id: string }>;

export type ParsedAkumaCommand = Output & (
  | Readonly<{ command: "call"; persona: string; cwd?: string; contract?: string }>
  | (Readonly<{ command: "follow" | "kill" }> & Addressed)
  | (Readonly<{ command: "wait"; timeoutMs?: number }> & Addressed)
  | (Readonly<{ command: "tell" | "interrupt" }> & Addressed)
  | (Readonly<{ command: "history"; last: boolean }> & Addressed)
  | (Readonly<{ command: "fork"; at: string }> & Addressed)
);

export type AkumaAction = ParsedAkumaCommand["command"];
type FlagValue = string | true;
type AkumaCommandSpec = Readonly<{
  arity: number;
  stdin: boolean;
  flags: Readonly<Record<string, "boolean" | "value">>;
  usage: string;
  purpose: string;
}>;

const AKUMA_COMMAND_SPECS = {
  call: {
    arity: 0,
    stdin: true,
    flags: { persona: "value", cwd: "value", contract: "value", json: "boolean" },
    usage: "call --persona <name> [--cwd <path>] [--contract <contract-id>] [--json] -",
    purpose: "Summon an Akuma from a Persona and stdin body.",
  },
  follow: {
    arity: 1,
    stdin: false,
    flags: { json: "boolean" },
    usage: "follow <aku/...> [--json]",
    purpose: "Read one Akuma's retained public event stream.",
  },
  wait: {
    arity: 1,
    stdin: false,
    flags: { timeout: "value", json: "boolean" },
    usage: "wait <aku/...> [--timeout <duration>] [--json]",
    purpose: "Wait for one Akuma or return its current snapshot at the timeout.",
  },
  tell: {
    arity: 1,
    stdin: true,
    flags: { json: "boolean" },
    usage: "tell <aku/...> [--json] -",
    purpose: "Record and wake one Akuma with an stdin body.",
  },
  interrupt: {
    arity: 1,
    stdin: true,
    flags: { json: "boolean" },
    usage: "interrupt <aku/...> [--json] -",
    purpose: "Put down the current body and deliver an stdin body.",
  },
  history: {
    arity: 1,
    stdin: false,
    flags: { last: "boolean", json: "boolean" },
    usage: "history <aku/...> [--last] [--json]",
    purpose: "Read retained turns or the last answered response.",
  },
  fork: {
    arity: 1,
    stdin: false,
    flags: { at: "value", json: "boolean" },
    usage: "fork <aku/...> --at <historyId> [--json]",
    purpose: "Fork one Akuma at a retained answered history point.",
  },
  kill: {
    arity: 1,
    stdin: false,
    flags: { json: "boolean" },
    usage: "kill <aku/...> [--json]",
    purpose: "Record death and put down one Akuma.",
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
    } else if (!token.startsWith("--")) positionals.push(token);
    else {
      const name = token.slice(2);
      const kind = (spec.flags as Readonly<Record<string, "boolean" | "value">>)[name];
      if (kind === undefined) fail(`option ${token} is not valid for ${action}`);
      if (flags[name] !== undefined) fail(`duplicate option: ${token}`);
      if (kind === "boolean") flags[name] = true;
      else {
        const value = argv[index + 1];
        if (value === undefined || value === "-" || value.startsWith("--")) fail(`${token} requires a value`);
        flags[name] = value;
        index += 1;
      }
    }
  }
  return { flags, positionals, stdin };
}

function parseAddressed(
  action: Exclude<AkumaAction, "call">,
  id: string,
  flags: Readonly<Record<string, FlagValue>>,
  output: "text" | "json",
  fail: (message: string) => never,
): ParsedAkumaCommand {
  if (action === "tell" || action === "interrupt" || action === "follow" || action === "kill") {
    return { command: action, id, output };
  }
  if (action === "wait") {
    const raw = flags.timeout;
    if (raw === undefined) return { command: action, id, output };
    return { command: action, id, timeoutMs: parseDuration(raw, fail), output };
  }
  if (action === "history") return { command: action, id, last: flags.last === true, output };
  const at = stringFlag(flags.at, "fork requires --at <historyId>", fail);
  if (at.trim().length === 0) fail("fork requires --at <historyId>");
  return { command: action, id, at, output };
}

export function parseAkumaCommand(argv: readonly string[]): ParsedAkumaCommand {
  const candidate = argv[0];
  if (!isAkumaAction(candidate)) throw new CliUsageError(`unknown command: ${candidate ?? ""}`);
  const action = candidate;
  const spec = AKUMA_COMMAND_SPECS[action];
  const fail = (message: string): never => { throw new CliUsageError(message, renderAkumaUsage(action)); };
  const { flags, positionals, stdin } = scanAkuma(action, argv, fail);
  if (positionals.length !== spec.arity) fail(`${action} has invalid positional arguments`);
  if (stdin !== spec.stdin) fail(`${action} ${spec.stdin ? "requires" : "reads no"} stdin`);
  const output = flags.json === true ? "json" as const : "text" as const;
  if (action === "call") {
    const persona = stringFlag(flags.persona, "call requires --persona <name>", fail);
    return {
      command: action,
      persona,
      ...(typeof flags.cwd === "string" ? { cwd: flags.cwd } : {}),
      ...(typeof flags.contract === "string" ? { contract: flags.contract } : {}),
      output,
    };
  }
  return parseAddressed(action, positionals[0]!, flags, output, fail);
}
