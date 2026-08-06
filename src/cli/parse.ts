export type Command =
  | "bind"
  | "amend"
  | "deliver"
  | "review"
  | "arc"
  | "abandon"
  | "status"
  | "audit"
  | "reconcile";

type Output = Readonly<{ output: "text" | "json" }>;
type Actor = Readonly<{ actor?: string }>;

export type ParsedBind = Output & Actor & Readonly<{
  command: "bind";
  target?: string;
  workspace?: "here";
  after?: readonly string[];
  gates?: string;
}>;
export type ParsedAmend = Output & Actor & Readonly<{
  command: "amend";
  contract?: string;
  after?: readonly string[];
  clearAfter?: true;
  gates?: string;
}>;
export type ParsedDeliver = Output & Actor & Readonly<{
  command: "deliver";
  contract?: string;
}>;
export type ParsedReview = Output & Actor & Readonly<{
  command: "review";
  contract?: string;
  verdict: "satisfied" | "unsatisfied";
  summary?: string;
  summaryFromStdin?: true;
}>;
export type ParsedArc = Output & Actor & Readonly<{
  command: "arc";
  contract?: string;
}>;
export type ParsedAbandon = Output & Actor & Readonly<{
  command: "abandon";
  contract?: string;
  note?: string;
}>;
export type ParsedStatus = Output & Readonly<{ command: "status"; contract?: string }>;
export type ParsedAudit = Output & Readonly<{
  command: "audit";
  contract?: string;
  showDiffBody: boolean;
  actor?: string;
}>;
export type ParsedReconcile = Output & Readonly<{ command: "reconcile"; contract?: string }>;

export type ParsedCommand =
  | ParsedBind
  | ParsedAmend
  | ParsedDeliver
  | ParsedReview
  | ParsedArc
  | ParsedAbandon
  | ParsedStatus
  | ParsedAudit
  | ParsedReconcile;

export type ParsedInvocation = Readonly<{
  cwd?: string;
  command: ParsedCommand;
}>;

export const COMMANDS: ReadonlySet<Command> = new Set([
  "bind", "amend", "deliver", "review", "arc", "abandon", "status", "audit", "reconcile",
]);
type FlagKind = "boolean" | "value" | "repeat-value";
type FlagSpecs = Readonly<Record<string, FlagKind>>;

const FLAG_SPECS: Readonly<Record<Command, FlagSpecs>> = {
  bind: { actor: "value", target: "value", here: "boolean", after: "repeat-value", gates: "value", json: "boolean" },
  amend: { actor: "value", after: "repeat-value", "clear-after": "boolean", gates: "value", json: "boolean" },
  deliver: { actor: "value", json: "boolean" },
  review: { actor: "value", satisfied: "boolean", unsatisfied: "boolean", summary: "value", json: "boolean" },
  arc: { actor: "value", json: "boolean" },
  abandon: { actor: "value", note: "value", json: "boolean" },
  status: { json: "boolean" },
  audit: { "show-diff-body": "boolean", actor: "value", json: "boolean" },
  reconcile: { json: "boolean" },
};

export class CliUsageError extends Error {
  constructor(message: string) {
    super(`${message}\nusage: keiyaku-v4 <command> [<contract>] [--flag ...] [-]`);
    this.name = "CliUsageError";
  }
}

function optionalFlag(flags: Readonly<Record<string, string | true | readonly string[]>>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function noContract(command: Command, positionals: readonly string[]): void {
  if (positionals.length !== 0) throw new CliUsageError(`${command} accepts no contract`);
}

function optionalContract(command: Command, positionals: readonly string[]): string | undefined {
  if (positionals.length > 1) throw new CliUsageError(`${command} accepts at most one contract`);
  return positionals[0];
}

function acceptsStdin(command: Command): boolean {
  return command === "bind" || command === "amend" || command === "review" || command === "arc";
}

type ParsedParts = Readonly<{
  command: Command;
  flags: Readonly<Record<string, string | true | readonly string[]>>;
  positionals: readonly string[];
  stdin: boolean;
  output: "text" | "json";
  actor?: string;
}>;

type ScanState = {
  flags: Record<string, string | true | readonly string[]>;
  positionals: string[];
  stdin: boolean;
};

function scanStdin(command: Command, state: ScanState, index: number, length: number): void {
  if (state.stdin || index !== length - 1 || !acceptsStdin(command)) {
    throw new CliUsageError("stdin marker '-' is legal only as the final bind/amend/arc/review argument");
  }
  state.stdin = true;
}

function scanOption(command: Command, argv: readonly string[], state: ScanState, index: number): number {
  const token = argv[index]!;
  const name = token.slice(2);
  const kind = FLAG_SPECS[command][name];
  if (kind === undefined) throw new CliUsageError(`option ${token} is not valid for ${command}`);
  if (state.flags[name] !== undefined && kind !== "repeat-value") throw new CliUsageError(`duplicate option: ${token}`);
  if (kind === "boolean") {
    state.flags[name] = true;
    return index;
  }
  const value = argv[index + 1];
  if (value === undefined || value === "-" || value.startsWith("--")) throw new CliUsageError(`${token} requires a value`);
  if (kind === "repeat-value") {
    const values = state.flags[name];
    state.flags[name] = [...(Array.isArray(values) ? values : values === undefined ? [] : [values]), value];
  } else {
    state.flags[name] = value;
  }
  return index + 1;
}

function scanArgv(argv: readonly string[]): ParsedParts {
  const candidate = argv[0];
  if (!candidate || !COMMANDS.has(candidate as Command)) {
    throw new CliUsageError(`unknown command: ${candidate ?? ""}`);
  }
  const command = candidate as Command;
  const state: ScanState = { flags: {}, positionals: [], stdin: false };

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "-C") throw new CliUsageError("-C is legal only as a global invocation prefix");
    if (token === "-") {
      scanStdin(command, state, index, argv.length);
      continue;
    }
    if (token.startsWith("--")) {
      index = scanOption(command, argv, state, index);
      continue;
    }
    state.positionals.push(token);
  }

  const output = state.flags.json === true ? "json" as const : "text" as const;
  const actor = optionalFlag(state.flags, "actor");
  return { command, ...state, output, ...(actor === undefined ? {} : { actor }) };
}

function parseBind(parts: ParsedParts): ParsedBind {
  if (!parts.stdin) throw new CliUsageError("bind requires ContractBody stdin");
  noContract("bind", parts.positionals);
  const target = optionalFlag(parts.flags, "target");
  const after = parts.flags.after === undefined ? [] : Array.isArray(parts.flags.after) ? parts.flags.after : [parts.flags.after];
  const gates = optionalFlag(parts.flags, "gates");
  return {
    command: "bind",
    ...(target === undefined ? {} : { target }),
    ...(parts.flags.here === true ? { workspace: "here" as const } : {}),
    ...(parts.flags.after === undefined ? {} : { after }),
    ...(gates === undefined ? {} : { gates }),
    ...(parts.actor === undefined ? {} : { actor: parts.actor }),
    output: parts.output,
  };
}

function parseAmend(parts: ParsedParts): ParsedAmend {
  if (!parts.stdin) throw new CliUsageError("amend requires ContractBody stdin");
  const contract = optionalContract("amend", parts.positionals);
  const after = parts.flags.after === undefined ? [] : Array.isArray(parts.flags.after) ? parts.flags.after : [parts.flags.after];
  if (parts.flags["clear-after"] === true && after.length > 0) throw new CliUsageError("--clear-after and --after are mutually exclusive");
  const gates = optionalFlag(parts.flags, "gates");
  return {
    command: "amend",
    ...(contract === undefined ? {} : { contract }),
    ...(parts.flags.after === undefined ? {} : { after }),
    ...(parts.flags["clear-after"] === true ? { clearAfter: true as const } : {}),
    ...(gates === undefined ? {} : { gates }),
    ...(parts.actor === undefined ? {} : { actor: parts.actor }),
    output: parts.output,
  };
}

function parseDeliver(parts: ParsedParts): ParsedDeliver {
  const contract = optionalContract("deliver", parts.positionals);
  return {
    command: "deliver",
    ...(contract === undefined ? {} : { contract }),
    ...(parts.actor === undefined ? {} : { actor: parts.actor }),
    output: parts.output,
  };
}

function parseReview(parts: ParsedParts): ParsedReview {
  if (Number(parts.flags.satisfied === true) + Number(parts.flags.unsatisfied === true) !== 1) {
    throw new CliUsageError("review requires exactly one verdict flag");
  }
  const summary = optionalFlag(parts.flags, "summary");
  if (parts.stdin && summary !== undefined) throw new CliUsageError("review stdin '-' and --summary are mutually exclusive");
  const contract = optionalContract("review", parts.positionals);
  return {
    command: "review",
    ...(contract === undefined ? {} : { contract }),
    verdict: parts.flags.satisfied === true ? "satisfied" : "unsatisfied",
    ...(summary === undefined ? {} : { summary }),
    ...(parts.stdin ? { summaryFromStdin: true as const } : {}),
    ...(parts.actor === undefined ? {} : { actor: parts.actor }),
    output: parts.output,
  };
}

function parseArc(parts: ParsedParts): ParsedArc {
  if (!parts.stdin) throw new CliUsageError("arc requires Arc stdin");
  const contract = optionalContract("arc", parts.positionals);
  return {
    command: "arc",
    ...(contract === undefined ? {} : { contract }),
    ...(parts.actor === undefined ? {} : { actor: parts.actor }),
    output: parts.output,
  };
}

function parseAbandon(parts: ParsedParts): ParsedAbandon {
  const contract = optionalContract("abandon", parts.positionals);
  const note = optionalFlag(parts.flags, "note");
  return {
    command: "abandon",
    ...(contract === undefined ? {} : { contract }),
    ...(note === undefined ? {} : { note }),
    ...(parts.actor === undefined ? {} : { actor: parts.actor }),
    output: parts.output,
  };
}

function parseStatus(parts: ParsedParts): ParsedStatus {
  const contract = optionalContract("status", parts.positionals);
  return {
    command: "status",
    ...(contract === undefined ? {} : { contract }),
    output: parts.output,
  };
}

function invocationPrefix(argv: readonly string[]): Readonly<{ cwd?: string; commandArgv: readonly string[] }> {
  if (argv[0] !== "-C") return { commandArgv: argv };
  const cwd = argv[1];
  if (cwd === undefined || cwd === "-C") throw new CliUsageError("-C requires a path");
  return { cwd, commandArgv: argv.slice(2) };
}

function parseCommand(parts: ParsedParts): ParsedCommand {
  switch (parts.command) {
    case "bind": return parseBind(parts);
    case "amend": return parseAmend(parts);
    case "deliver": return parseDeliver(parts);
    case "review": return parseReview(parts);
    case "arc": return parseArc(parts);
    case "abandon": return parseAbandon(parts);
    case "status": return parseStatus(parts);
    case "audit": {
      const contract = optionalContract("audit", parts.positionals);
      return {
        command: "audit",
        ...(contract === undefined ? {} : { contract }),
        showDiffBody: parts.flags["show-diff-body"] === true,
        ...(parts.actor === undefined ? {} : { actor: parts.actor }),
        output: parts.output,
      };
    }
    case "reconcile": {
      const contract = optionalContract("reconcile", parts.positionals);
      return { command: "reconcile", ...(contract === undefined ? {} : { contract }), output: parts.output };
    }
  }
}

export function parseArgv(argv: readonly string[]): ParsedInvocation {
  const invocation = invocationPrefix(argv);
  return {
    ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
    command: parseCommand(scanArgv(invocation.commandArgv)),
  };
}
