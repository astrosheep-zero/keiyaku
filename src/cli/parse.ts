import {
  isTaskAction,
  parseTaskCommand,
  renderTaskHelp,
  renderTaskUsage,
  type ParsedTaskCommand,
  type TaskAction,
} from "./commands/task.js";
import {
  isAkumaAction,
  parseAkumaCatalogPath,
  parseAkumaCommand,
  renderAkumaHelp,
  renderAkumaRootRows,
  renderAkumaUsage,
  type AkumaAction,
  type ParsedAkumaCommand,
} from "./commands/akuma.js";
import { INSTALL_USAGE, parseInstallCommand, renderInstallHelp, type ParsedInstallCommand } from "./commands/install.js";
import {
  CONTRACT_COMMAND_SPECS,
  type ContractCommand as Command,
  type ContractCommandSpec as CommandSpec,
  type ParsedAbandon,
  type ParsedAmend,
  type ParsedArc,
  type ParsedAudit,
  type ParsedBind,
  type ParsedDeliver,
  type ParsedLs,
  type ParsedNuke,
  type ParsedReconcile,
  type ParsedRegion,
  type ParsedReview,
  type ParsedSettings,
  type ParsedShow,
  type ParsedStatus,
} from "./commands/contract.js";
import { CliUsageError, isBlankInput, usageLine } from "./usage.js";
export { CliUsageError } from "./usage.js";

export type { Command };

const ROOT_USAGE = "usage: keiyaku [-C <path>] [--repo <path>] <command> [<contract>|@<contract>] [--flag ...] [-]";

export function renderRootHelp(): string {
  return [
    ROOT_USAGE,
    "",
    "global options:",
    "  -C, --cwd <path>  Set the invocation working directory.",
    "  --repo <path>     Select the Git repository coordinate.",
    "",
    "commands:",
    ...Object.values(CONTRACT_COMMAND_SPECS).flatMap((spec) => [`  ${spec.usage}`, `    ${spec.purpose}`]),
    `  ${INSTALL_USAGE}`,
    "    Install the Keiyaku skills into an agent harness.",
    "  task ...",
    "    Task coordination; see `keiyaku task --help`.",
    ...renderAkumaRootRows(),
  ].join("\n");
}

export function renderContractHelp(command: Command): string {
  const spec: CommandSpec = CONTRACT_COMMAND_SPECS[command];
  const help = `${spec.purpose}\n\n${usageLine(spec.usage)}`;
  return spec.help === undefined ? help : `${help}\n\n${spec.help}`;
}

function contractUsage(command: Command): string {
  return usageLine(CONTRACT_COMMAND_SPECS[command].usage);
}

export function renderCommandUsage(command: ParsedCommand): string {
  if (command.command === "install") return renderInstallHelp();
  if (command.command === "task") return renderTaskUsage(command.action);
  if (isAkumaAction(command.command)) return renderAkumaUsage(command.command);
  return contractUsage(command.command);
}

export function renderHelp(coordinate: CliHelpCoordinate): string {
  switch (coordinate.kind) {
    case "root": return renderRootHelp();
    case "contract": return renderContractHelp(coordinate.command);
    case "task": return renderTaskHelp(coordinate.action);
    case "install": return renderInstallHelp();
    case "akuma": return renderAkumaHelp(coordinate.action);
  }
}

export type ParsedCommand =
  | ParsedBind
  | ParsedAmend
  | ParsedDeliver
  | ParsedReview
  | ParsedArc
  | ParsedAbandon
  | ParsedStatus
  | ParsedShow
  | ParsedLs
  | ParsedAudit
  | ParsedReconcile
  | ParsedNuke
  | ParsedSettings
  | ParsedRegion
  | ParsedInstallCommand
  | ParsedAkumaCommand
  | ParsedTaskCommand;

export type CliHelpCoordinate =
  | Readonly<{ kind: "root" }>
  | Readonly<{ kind: "contract"; command: Command }>
  | Readonly<{ kind: "task"; action?: TaskAction }>
  | Readonly<{ kind: "install" }>
  | Readonly<{ kind: "akuma"; action: AkumaAction }>;

export type ParsedExecution = Readonly<{ cwd?: string; repo?: string; command: ParsedCommand }>;
export type ParsedInvocation = ParsedExecution | Readonly<{ help: CliHelpCoordinate }>;

type RepoUse = "none" | "optional" | "required";
export type CommandRepoPolicy = Readonly<{ use: RepoUse; acceptsExplicit: boolean }>;

export function commandRepoPolicy(command: ParsedCommand): CommandRepoPolicy {
  switch (command.command) {
    case "bind":
    case "amend":
    case "deliver":
    case "review":
    case "arc":
    case "abandon":
    case "audit":
    case "reconcile":
    case "show":
    case "region":
      return { use: "required", acceptsExplicit: true };
    case "ls":
      return { use: command.query.kind === "contracts" ? "required" : "none", acceptsExplicit: false };
    case "status":
    case "tell":
      return { use: "optional", acceptsExplicit: false };
    case "history":
      return "contract" in command
        ? { use: "required", acceptsExplicit: true }
        : { use: "optional", acceptsExplicit: false };
    case "fork":
      return { use: "optional", acceptsExplicit: true };
    case "wait":
    case "kill": {
      const contractSelector = command.akuma.some((selector) => selector.startsWith("kei/"));
      return { use: contractSelector ? "required" : "optional", acceptsExplicit: contractSelector };
    }
    case "call":
      return {
        use: command.contract === undefined ? "none" : "required",
        acceptsExplicit: command.contract !== undefined,
      };
    case "settings":
    case "nuke":
    case "task":
    case "install":
      return { use: "none", acceptsExplicit: false };
  }
}

function refuseUnusedRepo(command: ParsedCommand): never {
  if (command.command === "call") throw new CliUsageError("--repo has no consumer without --contract");
  throw new CliUsageError(`--repo has no consumer for ${command.command}`);
}

export function assertExplicitRepoUse(command: ParsedCommand, repo: string | undefined): void {
  if (repo !== undefined && !commandRepoPolicy(command).acceptsExplicit) refuseUnusedRepo(command);
}

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
  if (value === undefined) refuse(command, `${token} requires a value`);
  if (kind !== "raw-value" && (value === "-" || value.startsWith("--"))) {
    refuse(command, `${token} requires a value`);
  }
  if (kind !== "raw-value" && isBlankInput(value)) refuse(command, `${token} requires a nonblank value`);
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
    if (token === "-") {
      scanStdin(command, state, index, argv.length);
      continue;
    }
    if (token.startsWith("--")) {
      index = scanOption(command, argv, state, index);
      continue;
    }
    if (isBlankInput(token)) refuse(command, `${command} requires a nonblank value`);
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
  const task = optionalFlag(parts.flags, "task");
  const target = optionalFlag(parts.flags, "target");
  const after = parts.flags.after === undefined ? [] : Array.isArray(parts.flags.after) ? parts.flags.after : [parts.flags.after];
  const gates = parseGateBundleNames(parts, "bind");
  return {
    command: "bind",
    ...(task === undefined ? {} : { task }),
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
  const gates = parseGateBundleNames(parts, "amend");
  if (!parts.stdin && parts.flags.after === undefined && parts.flags["clear-after"] !== true && gates === undefined) {
    refuse("amend", "amend requires stdin or --after, --clear-after, or --gates");
  }
  return {
    command: "amend",
    ...(contract === undefined ? {} : { contract }),
    ...(parts.flags.after === undefined ? {} : { after }),
    ...(parts.flags["clear-after"] === true ? { clearAfter: true as const } : {}),
    ...(gates === undefined ? {} : { gates }),
    ...(parts.actor === undefined ? {} : { actor: parts.actor }),
    ...(parts.stdin ? { stdin: true as const } : {}),
    output: parts.output,
  };
}

function parseGateBundleNames(parts: ParsedParts, command: "bind" | "amend"): readonly string[] | undefined {
  const value = optionalFlag(parts.flags, "gates");
  if (value === undefined) return undefined;
  const names = value.split(",");
  if (names.some((name) => name.length === 0)) {
    refuse(command, "--gates requires nonempty comma-separated names");
  }
  return names;
}

function parseDeliver(parts: ParsedParts): ParsedDeliver {
  const contract = parts.positionals[0];
  const message = optionalFlag(parts.flags, "message");
  return {
    command: "deliver",
    ...(contract === undefined ? {} : { contract }),
    ...(parts.actor === undefined ? {} : { actor: parts.actor }),
    ...(message === undefined ? {} : { message }),
    includeDirty: parts.flags["include-dirty"] === true,
    materializeConflict: parts.flags["materialize-conflict"] === true,
    output: parts.output,
  };
}

function parseReview(parts: ParsedParts): ParsedReview {
  if (Number(parts.flags.satisfied === true) + Number(parts.flags.unsatisfied === true) !== 1) {
    refuse("review", "review requires exactly one verdict flag");
  }
  const summary = optionalFlag(parts.flags, "summary");
  if (parts.stdin === (summary !== undefined)) {
    refuse("review", "review requires exactly one of --summary <text> or stdin '-'");
  }
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

function parseShow(parts: ParsedParts): ParsedShow {
  const contract = parts.positionals[0];
  return { command: "show", ...(contract === undefined ? {} : { contract }), output: parts.output };
}

function parseRegion(parts: ParsedParts): ParsedRegion {
  const contract = parts.positionals[0];
  const path = optionalFlag(parts.flags, "path");
  const overlap = parts.flags.overlap === true;
  if (path !== undefined && (contract !== undefined || overlap)) refuse("region", "--path cannot combine with a contract or --overlap");
  return {
    command: "region",
    ...(contract === undefined ? {} : { contract }),
    ...(path === undefined ? {} : { path }),
    overlap,
    output: parts.output,
  };
}

function parseLs(parts: ParsedParts): ParsedLs {
  const path = parts.positionals[0]!;
  if (path === "task" || path === "task/") return { command: "ls", query: { kind: "tasks" }, output: parts.output };
  if (path === "kei" || path === "kei/") return { command: "ls", query: { kind: "contracts" }, output: parts.output };
  try {
    const query = parseAkumaCatalogPath(path);
    if (query === null) refuse("ls", "ls requires a supported identity directory selector");
    return { command: "ls", query, output: parts.output };
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    refuse("ls", error instanceof Error ? error.message : "invalid ls directory");
  }
}

function invocationOptions(argv: readonly string[]): Readonly<{ cwd?: string; repo?: string; commandArgv: readonly string[] }> {
  let cwd: string | undefined;
  let repo: string | undefined;
  let stdinSeen = false;
  const commandArgv: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token !== "-C" && token !== "--cwd" && token !== "--repo") {
      commandArgv.push(token);
      if (token === "-") stdinSeen = true;
      continue;
    }
    if (stdinSeen) throw new CliUsageError("stdin marker '-' must be the final argument", renderRootHelp());
    if (token === "--repo" && repo !== undefined) {
      throw new CliUsageError("--repo may appear only once", renderRootHelp());
    }
    if (token !== "--repo" && cwd !== undefined) {
      throw new CliUsageError("-C/--cwd may appear only once", renderRootHelp());
    }
    const value = argv[index + 1];
    if (value === undefined || value === "-" || value.startsWith("-") || isBlankInput(value)) {
      throw new CliUsageError(`${token} requires a path`, renderRootHelp());
    }
    if (token === "--repo") repo = value;
    else cwd = value;
    index += 1;
  }
  return {
    ...(cwd === undefined ? {} : { cwd }),
    ...(repo === undefined ? {} : { repo }),
    commandArgv,
  };
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
  if (root === "install") return { kind: "install" };
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
    case "show": return parseShow(parts);
    case "ls": return parseLs(parts);
    case "audit": {
      const contract = parts.positionals[0];
      return {
        command: "audit",
        ...(contract === undefined ? {} : { contract }),
        includeDirty: parts.flags["include-dirty"] === true,
        showDiff: parts.flags.diff === true,
        ...(parts.actor === undefined ? {} : { actor: parts.actor }),
        output: parts.output,
      };
    }
    case "reconcile": {
      const contract = parts.positionals[0];
      return {
        command: "reconcile",
        ...(contract === undefined ? {} : { contract }),
        retryHooks: parts.flags["retry-hooks"] === true,
        output: parts.output,
      };
    }
    case "nuke": {
      const confirm = optionalFlag(parts.flags, "confirm");
      return { command: "nuke", ...(confirm === undefined ? {} : { confirm }), output: parts.output };
    }
    case "settings": return { command: "settings", output: parts.output };
    case "region": return parseRegion(parts);
  }
}

export function parseArgv(argv: readonly string[]): ParsedInvocation {
  const invocation = invocationOptions(argv);
  const help = helpCoordinate(invocation.commandArgv);
  if (help !== null) return { help };
  if (invocation.commandArgv[0] === "ls"
    && (invocation.commandArgv.length === 1
      || (invocation.commandArgv.length === 2 && invocation.commandArgv[1] === "--json"))) {
    return { help: { kind: "contract", command: "ls" } };
  }
  const task = invocation.commandArgv[0] === "task"
    ? parseTaskCommand(invocation.commandArgv.slice(1))
    : undefined;
  const install = invocation.commandArgv[0] === "install"
    ? parseInstallCommand(invocation.commandArgv.slice(1))
    : undefined;
  const akuma = isAkumaAction(invocation.commandArgv[0])
    ? parseAkumaCommand(invocation.commandArgv)
    : undefined;
  const parsed: ParsedExecution = {
    ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
    ...(invocation.repo === undefined ? {} : { repo: invocation.repo }),
    command: task ?? akuma ?? install ?? parseCommand(scanArgv(invocation.commandArgv)),
  };
  return parsed;
}
