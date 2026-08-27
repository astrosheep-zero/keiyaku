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
  parseAkumaCommand,
  renderAkumaHelp,
  renderAkumaRootRows,
  renderAkumaUsage,
  type AkumaAction,
  type ParsedAkumaCommand,
} from "./commands/akuma.js";
import { parseInstallCommand, renderInstallHelp, type ParsedInstallCommand } from "./commands/install.js";
import {
  CONTRACT_COMMAND_SPECS,
  parseContractCommand,
  renderContractHelp as renderContractHelpForOwner,
  renderContractUsage,
  type ContractCommand as Command,
  type ContractCommandSpec as CommandSpec,
  type ParsedContractParts,
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
import { renderTextBlock } from "./render/terminal.js";
import { CliUsageError, isBlankInput } from "./usage.js";
export { CliUsageError } from "./usage.js";
export { renderContractHelp } from "./commands/contract.js";

export type { Command };

const ROOT_USAGE = "usage: keiyaku [-C <path>] [--repo <path>] <command> [<contract>|@<contract>] [--flag ...] [-]";

export function renderRootHelp(columns?: number): string {
  return renderHelpText(
    [
      ROOT_USAGE,
      "",
      "global options:",
      "  -C, --cwd <path>  Set the invocation working directory.",
      "  --repo <path>     Select the Git repository coordinate.",
      "",
      "commands:",
      ...Object.entries(CONTRACT_COMMAND_SPECS).map(([command, spec]) => `  keiyaku ${command}  ${spec.purpose}`),
      "  keiyaku install  Install the Keiyaku skills into an agent harness.",
      "  keiyaku task     Task coordination; see `keiyaku task --help`.",
      ...renderAkumaRootRows(),
    ].join("\n"),
    columns,
  );
}

function renderHelpText(help: string, columns: number | undefined): string {
  if (columns === undefined || !Number.isFinite(columns) || columns <= 0) return help;
  return help
    .split("\n")
    .flatMap((line) => {
      if (line.trim().length === 0) return [line];
      const indent = line.match(/^\s*/u)?.[0] ?? "";
      return renderTextBlock(line.slice(indent.length), indent, columns);
    })
    .join("\n");
}

function contractUsage(command: Command): string {
  return renderContractUsage(command);
}

export function renderCommandUsage(command: ParsedCommand): string {
  if (command.command === "install") return renderInstallHelp();
  if (command.command === "task") return renderTaskUsage(command.action);
  if (isAkumaAction(command.command)) return renderAkumaUsage(command.command);
  return contractUsage(command.command);
}

export function renderHelp(coordinate: CliHelpCoordinate, columns?: number): string {
  const help = (() => {
    switch (coordinate.kind) {
      case "root":
        return renderRootHelp();
      case "contract":
        return renderContractHelpForOwner(coordinate.command);
      case "task":
        return renderTaskHelp(coordinate.action);
      case "install":
        return renderInstallHelp();
      case "akuma":
        return renderAkumaHelp(coordinate.action);
    }
  })();
  return renderHelpText(help, columns);
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

type ScanState = {
  flags: Record<string, string | true | readonly string[]>;
  positionals: string[];
  stdin: boolean;
};

function refuse(command: Command, message: string): never {
  throw new CliUsageError(message, contractUsage(command));
}

function scanStdin(command: Command, state: ScanState): void {
  if (state.stdin) refuse(command, "stdin marker '-' may appear only once");
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

function scanArgv(argv: readonly string[]): ParsedContractParts {
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
      scanStdin(command, state);
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
  if (spec.positional === "optional" && state.positionals.length > 1 && command !== "status") {
    refuse(command, `${command} accepts at most one contract`);
  }
  if (spec.stdin === "required" && !state.stdin) {
    refuse(command, `${command} requires stdin`);
  }

  const output = state.flags.json === true ? ("json" as const) : ("text" as const);
  const actor = typeof state.flags.actor === "string" ? state.flags.actor : undefined;
  return { command, ...state, output, ...(actor === undefined ? {} : { actor }) };
}

function invocationOptions(
  argv: readonly string[],
): Readonly<{ cwd?: string; repo?: string; commandArgv: readonly string[] }> {
  let cwd: string | undefined;
  let repo: string | undefined;
  const commandArgv: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token !== "-C" && token !== "--cwd" && token !== "--repo") {
      commandArgv.push(token);
      continue;
    }
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

export function parseArgv(argv: readonly string[]): ParsedInvocation {
  const invocation = invocationOptions(argv);
  const help = helpCoordinate(invocation.commandArgv);
  if (help !== null) return { help };
  if (
    invocation.commandArgv[0] === "ls" &&
    (invocation.commandArgv.length === 1 ||
      (invocation.commandArgv.length === 2 && invocation.commandArgv[1] === "--json"))
  ) {
    return { help: { kind: "contract", command: "ls" } };
  }
  const task = invocation.commandArgv[0] === "task" ? parseTaskCommand(invocation.commandArgv.slice(1)) : undefined;
  const install =
    invocation.commandArgv[0] === "install" ? parseInstallCommand(invocation.commandArgv.slice(1)) : undefined;
  const akuma = isAkumaAction(invocation.commandArgv[0]) ? parseAkumaCommand(invocation.commandArgv) : undefined;
  return {
    ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
    ...(invocation.repo === undefined ? {} : { repo: invocation.repo }),
    command: task ?? akuma ?? install ?? parseContractCommand(scanArgv(invocation.commandArgv)),
  };
}
