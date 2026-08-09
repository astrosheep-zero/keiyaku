import {
  isTaskAction,
  parseTaskCommand,
  renderTaskUsage,
  type ParsedTaskCommand,
  type TaskAction,
} from "./commands/task.js";
import {
  isAkumaAction,
  parseAkumaCommand,
  renderAkumaRootRows,
  renderAkumaUsage,
  type AkumaAction,
  type ParsedAkumaCommand,
} from "./commands/akuma.js";
import { CliUsageError, usageLine } from "./usage.js";
export { CliUsageError } from "./usage.js";

type FlagKind = "boolean" | "value" | "repeat-value";
type CommandSpec = Readonly<{
  positional: "none" | "optional";
  stdin: "none" | "optional" | "required";
  flags: Readonly<Record<string, FlagKind>>;
  usage: string;
  purpose: string;
}>;

const CONTRACT_COMMAND_SPECS = {
  bind: {
    positional: "none",
    stdin: "required",
    flags: { actor: "value", target: "value", here: "boolean", after: "repeat-value", gates: "value", json: "boolean" },
    usage: "bind [--target <ref>] [--here] [--after <kei/...> ...] [--gates <name>] [--actor <actor>] [--json] -",
    purpose: "Create one Contract from stdin Markdown.",
  },
  amend: {
    positional: "optional",
    stdin: "required",
    flags: { actor: "value", after: "repeat-value", "clear-after": "boolean", gates: "value", json: "boolean" },
    usage: "amend [<contract>|@<contract>] [--after <kei/...> ... | --clear-after] [--gates <name>] [--actor <actor>] [--json] -",
    purpose: "Apply stdin amendment operations to one Contract.",
  },
  deliver: {
    positional: "optional",
    stdin: "none",
    flags: { actor: "value", message: "value", json: "boolean" },
    usage: "deliver [<contract>|@<contract>] [--message <text>] [--actor <actor>] [--json]",
    purpose: "Deliver one Contract candidate.",
  },
  review: {
    positional: "optional",
    stdin: "optional",
    flags: { actor: "value", satisfied: "boolean", unsatisfied: "boolean", summary: "value", json: "boolean" },
    usage: "review [<contract>|@<contract>] (--satisfied | --unsatisfied) [--summary <text>] [--actor <actor>] [--json] [-]",
    purpose: "Record one review verdict.",
  },
  arc: {
    positional: "optional",
    stdin: "required",
    flags: { actor: "value", json: "boolean" },
    usage: "arc [<contract>|@<contract>] [--actor <actor>] [--json] -",
    purpose: "Record stdin arc Markdown for one Contract.",
  },
  abandon: {
    positional: "optional",
    stdin: "none",
    flags: { actor: "value", note: "value", json: "boolean" },
    usage: "abandon [<contract>|@<contract>] [--note <text>] [--actor <actor>] [--json]",
    purpose: "Abandon one Contract with an optional note.",
  },
  status: {
    positional: "optional",
    stdin: "none",
    flags: { json: "boolean" },
    usage: "status [<contract>|@<contract>|<aku/...>] [--json]",
    purpose: "Read the world status board or one Contract projection.",
  },
  audit: {
    positional: "optional",
    stdin: "none",
    flags: { "show-diff-body": "boolean", actor: "value", json: "boolean" },
    usage: "audit [<contract>|@<contract>] [--show-diff-body] [--actor <actor>] [--json]",
    purpose: "Audit one Contract without mutation.",
  },
  reconcile: {
    positional: "optional",
    stdin: "none",
    flags: { json: "boolean" },
    usage: "reconcile [<contract>|@<contract>] [--json]",
    purpose: "Reconcile one Contract or the invocation world.",
  },
  settings: {
    positional: "none",
    stdin: "none",
    flags: { json: "boolean" },
    usage: "settings [--json]",
    purpose: "Read user and project Settings resources.",
  },
} as const satisfies Readonly<Record<string, CommandSpec>>;

export type Command = keyof typeof CONTRACT_COMMAND_SPECS;

const ROOT_USAGE = "usage: keiyaku-v4 [-C <path>] <command> [<contract>|@<contract>] [--flag ...] [-]";

export function renderRootHelp(): string {
  return [
    ROOT_USAGE,
    "",
    "commands:",
    ...Object.values(CONTRACT_COMMAND_SPECS).flatMap((spec) => [`  ${spec.usage}`, `    ${spec.purpose}`]),
    "  task ...",
    "    Task coordination; see `keiyaku-v4 task --help`.",
    ...renderAkumaRootRows(),
  ].join("\n");
}

export function renderContractHelp(command: Command): string {
  const spec = CONTRACT_COMMAND_SPECS[command];
  return `${spec.purpose}\n\n${usageLine(spec.usage)}`;
}

function contractUsage(command: Command): string {
  return usageLine(CONTRACT_COMMAND_SPECS[command].usage);
}

export function renderCommandUsage(command: ParsedCommand): string {
  if (command.command === "task") return renderTaskUsage(command.action);
  if (isAkumaAction(command.command)) return renderAkumaUsage(command.command);
  return contractUsage(command.command);
}

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
  message?: string;
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
type ParsedStatus = Output & (
  | Readonly<{ command: "status"; contract?: string; akuma?: never }>
  | Readonly<{ command: "status"; contract: string; akuma: true }>
);
export type ParsedAudit = Output & Readonly<{
  command: "audit";
  contract?: string;
  showDiffBody: boolean;
  actor?: string;
}>;
type ParsedReconcile = Output & Readonly<{ command: "reconcile"; contract?: string }>;
export type ParsedSettings = Output & Readonly<{ command: "settings" }>;

export type ParsedCommand =
  | ParsedBind
  | ParsedAmend
  | ParsedDeliver
  | ParsedReview
  | ParsedArc
  | ParsedAbandon
  | ParsedStatus
  | ParsedAudit
  | ParsedReconcile
  | ParsedSettings
  | ParsedAkumaCommand
  | ParsedTaskCommand;

export type CliHelpCoordinate =
  | Readonly<{ kind: "root" }>
  | Readonly<{ kind: "contract"; command: Command }>
  | Readonly<{ kind: "task"; action?: TaskAction }>
  | Readonly<{ kind: "akuma"; action: AkumaAction }>;

export type ParsedExecution = Readonly<{ cwd?: string; command: ParsedCommand }>;
export type ParsedInvocation = ParsedExecution | Readonly<{ help: CliHelpCoordinate }>;

function optionalFlag(flags: Readonly<Record<string, string | true | readonly string[]>>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
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

function refuse(command: Command, message: string): never {
  throw new CliUsageError(message, contractUsage(command));
}

function scanStdin(command: Command, state: ScanState, index: number, length: number): void {
  if (state.stdin) refuse(command, "stdin marker '-' may appear only once");
  if (index !== length - 1) refuse(command, "stdin marker '-' must be the final argument");
  if (CONTRACT_COMMAND_SPECS[command].stdin === "none") refuse(command, `${command} reads no stdin`);
  state.stdin = true;
}

function scanOption(command: Command, argv: readonly string[], state: ScanState, index: number): number {
  const token = argv[index]!;
  const name = token.slice(2);
  const spec: CommandSpec = CONTRACT_COMMAND_SPECS[command];
  const kind = spec.flags[name];
  if (kind === undefined) refuse(command, `option ${token} is not valid for ${command}`);
  if (state.flags[name] !== undefined && kind !== "repeat-value") refuse(command, `duplicate option: ${token}`);
  if (kind === "boolean") {
    state.flags[name] = true;
    return index;
  }
  const value = argv[index + 1];
  if (value === undefined || value === "-" || value.startsWith("--")) refuse(command, `${token} requires a value`);
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
  if (!candidate || !Object.prototype.hasOwnProperty.call(CONTRACT_COMMAND_SPECS, candidate)) {
    throw new CliUsageError(`unknown command: ${candidate ?? ""}`, renderRootHelp());
  }
  const command = candidate as Command;
  const spec: CommandSpec = CONTRACT_COMMAND_SPECS[command];
  const state: ScanState = { flags: {}, positionals: [], stdin: false };

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "-C") refuse(command, "-C is legal only as a global invocation prefix");
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

  if (spec.positional === "none" && state.positionals.length > 0) {
    refuse(command, `${command} accepts no contract`);
  }
  if (spec.positional === "optional" && state.positionals.length > 1) {
    refuse(command, `${command} accepts at most one contract`);
  }
  if (spec.stdin === "required" && !state.stdin) {
    refuse(command, `${command} requires stdin`);
  }

  const output = state.flags.json === true ? "json" as const : "text" as const;
  const actor = optionalFlag(state.flags, "actor");
  return { command, ...state, output, ...(actor === undefined ? {} : { actor }) };
}

function parseBind(parts: ParsedParts): ParsedBind {
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
  const contract = parts.positionals[0];
  const after = parts.flags.after === undefined ? [] : Array.isArray(parts.flags.after) ? parts.flags.after : [parts.flags.after];
  if (parts.flags["clear-after"] === true && after.length > 0) refuse("amend", "--clear-after and --after are mutually exclusive");
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
  const contract = parts.positionals[0];
  const message = optionalFlag(parts.flags, "message");
  return {
    command: "deliver",
    ...(contract === undefined ? {} : { contract }),
    ...(parts.actor === undefined ? {} : { actor: parts.actor }),
    ...(message === undefined ? {} : { message }),
    output: parts.output,
  };
}

function parseReview(parts: ParsedParts): ParsedReview {
  if (Number(parts.flags.satisfied === true) + Number(parts.flags.unsatisfied === true) !== 1) {
    refuse("review", "review requires exactly one verdict flag");
  }
  const summary = optionalFlag(parts.flags, "summary");
  if (parts.stdin && summary !== undefined) refuse("review", "review stdin '-' and --summary are mutually exclusive");
  const contract = parts.positionals[0];
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
  const contract = parts.positionals[0];
  return {
    command: "arc",
    ...(contract === undefined ? {} : { contract }),
    ...(parts.actor === undefined ? {} : { actor: parts.actor }),
    output: parts.output,
  };
}

function parseAbandon(parts: ParsedParts): ParsedAbandon {
  const contract = parts.positionals[0];
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
  const contract = parts.positionals[0];
  if (contract?.startsWith("aku/") === true) {
    return {
      command: "status",
      contract,
      akuma: true,
      output: parts.output,
    };
  }
  return {
    command: "status",
    ...(contract === undefined ? {} : { contract }),
    output: parts.output,
  };
}

function invocationPrefix(argv: readonly string[]): Readonly<{ cwd?: string; commandArgv: readonly string[] }> {
  if (argv[0] !== "-C") return { commandArgv: argv };
  const cwd = argv[1];
  if (cwd === undefined || cwd === "-C") throw new CliUsageError("-C requires a path", renderRootHelp());
  return { cwd, commandArgv: argv.slice(2) };
}

function helpCoordinate(argv: readonly string[]): CliHelpCoordinate | null {
  const help = argv.indexOf("--help");
  if (help < 0) return null;
  const words = argv.slice(0, help);
  const root = words[0];
  if (root === "task") {
    const action = isTaskAction(words[1]) ? words[1] : undefined;
    return { kind: "task", ...(action === undefined ? {} : { action }) };
  }
  if (isAkumaAction(root)) return { kind: "akuma", action: root };
  if (root !== undefined && Object.hasOwn(CONTRACT_COMMAND_SPECS, root)) {
    return { kind: "contract", command: root as Command };
  }
  return { kind: "root" };
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
      const contract = parts.positionals[0];
      return {
        command: "audit",
        ...(contract === undefined ? {} : { contract }),
        showDiffBody: parts.flags["show-diff-body"] === true,
        ...(parts.actor === undefined ? {} : { actor: parts.actor }),
        output: parts.output,
      };
    }
    case "reconcile": {
      const contract = parts.positionals[0];
      return { command: "reconcile", ...(contract === undefined ? {} : { contract }), output: parts.output };
    }
    case "settings": return { command: "settings", output: parts.output };
  }
}

export function parseArgv(argv: readonly string[]): ParsedInvocation {
  const invocation = invocationPrefix(argv);
  const help = helpCoordinate(invocation.commandArgv);
  if (help !== null) return { help };
  const task = invocation.commandArgv[0] === "task"
    ? parseTaskCommand(invocation.commandArgv.slice(1))
    : undefined;
  const akuma = isAkumaAction(invocation.commandArgv[0])
    ? parseAkumaCommand(invocation.commandArgv)
    : undefined;
  return {
    ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
    command: task ?? akuma ?? parseCommand(scanArgv(invocation.commandArgv)),
  };
}
