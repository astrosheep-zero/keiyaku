import {
  isTaskAction,
  parseTaskCommand,
  renderTaskHelp,
  taskUsageGuide,
  type ParsedTaskCommand,
  type TaskAction,
} from "./commands/task-grammar.js";
import {
  akumaUsageGuide,
  isAkumaAction,
  parseAkumaCommand,
  renderAkumaHelp,
  renderAkumaRootRows,
  type AkumaAction,
  type ParsedAkumaCommand,
} from "./commands/akuma-grammar.js";
import {
  INSTALL_ROOT_PURPOSE,
  INSTALL_USAGE,
  parseInstallCommand,
  renderInstallHelp,
  type ParsedInstallCommand,
} from "./commands/install.js";
import {
  parseContractCommand,
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
  type ParsedStatus,
} from "./commands/contract-grammar.js";
import {
  CONTRACT_COMMAND_SPECS,
  renderContractHelp as renderContractHelpForOwner,
  type ContractCommand as Command,
  type ContractCommandSpec as CommandSpec,
} from "./commands/contract-help.js";
import { renderOpaqueBlock, renderTextBlock } from "./render/terminal.js";
import {
  CliUsageError,
  commandGuide,
  isBlankInput,
  ROOT_USAGE_GUIDE,
  unknownCommandGuide,
  type CliUsageGuide,
} from "./usage.js";
export { CliUsageError } from "./usage.js";
export type { CliUsageGuide } from "./usage.js";
export { renderContractHelp } from "./commands/contract-help.js";

export type { Command };

const ROOT_USAGE = [
  "usage  keiyaku <command> [options]",
  "      keiyaku <command> --help   shows that command's complete usage",
].join("\n");

const INVOCATION_PATH_OPTIONS = new Set(["-C", "--cwd", "--repo", "--workdir"]);

export function renderRootHelp(columns?: number): string {
  return renderHelpText(
    [
      "keiyaku — Contract, Task, and Akuma control for one repository",
      "",
      ROOT_USAGE,
      "",
      "Contract — standing acceptance",
      ...Object.entries(CONTRACT_COMMAND_SPECS)
        .filter(([command]) => command !== "settings")
        .map(([command, spec]) => `  ${command.padEnd(10)} ${spec.purpose}`),
      "",
      "Task — plan memory",
      "  task       Task coordination; see `keiyaku task --help`.",
      "",
      "Akuma — contracted demons",
      ...renderAkumaRootRows(),
      "",
      "Workspace",
      `  ${"install".padEnd(10)} ${INSTALL_ROOT_PURPOSE}`,
      `  ${"settings".padEnd(10)} ${CONTRACT_COMMAND_SPECS.settings.purpose}`,
      "",
      "Package",
      "  --version  Print the running package version.",
      "",
      "Global options:",
      "  -C, --cwd <path>    Set the invocation working directory.",
      "  --repo <path>       Select the Git repository coordinate.",
      "  --workdir <path>    Set the execution directory for call only.",
      "",
      "Outcomes:  exit 0 accepted · 1 refused · 2 retry · 3 failed · 64 usage",
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
      const body = line.slice(indent.length);
      if (body.startsWith("usage  ") || indent.startsWith("      ")) {
        return renderOpaqueBlock(body, indent, columns);
      }
      return renderTextBlock(body, indent, columns);
    })
    .join("\n");
}

export function usageGuideForCommand(command: ParsedCommand): CliUsageGuide {
  if (command.command === "install") return commandGuide("install", INSTALL_USAGE);
  if (command.command === "task") return taskUsageGuide(command.action);
  if (isAkumaAction(command.command)) return akumaUsageGuide(command.command);
  return commandGuide(command.command, CONTRACT_COMMAND_SPECS[command.command].usage);
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

export type ParsedInvocation =
  | Readonly<{ cwd?: string; repo?: string; workdir?: string; command: ParsedCommand }>
  | Readonly<{ help: CliHelpCoordinate }>
  | Readonly<{ version: true }>;

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
    case "region":
      return { use: "required", acceptsExplicit: true };
    case "ls":
      return { use: command.query.kind === "contracts" ? "required" : "none", acceptsExplicit: false };
    case "status":
    case "tell":
    case "ask":
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
  throw new CliUsageError(message, commandGuide(command, CONTRACT_COMMAND_SPECS[command].usage));
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
  if (value === undefined || value.startsWith("--")) refuse(command, `${token} requires a value`);
  if (kind !== "raw-value" && value === "-") {
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

function scanContractTokens(command: Command, argv: readonly string[], state: ScanState): void {
  let positionalOnly = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!positionalOnly && token === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && token === "-") {
      scanStdin(command, state);
      continue;
    }
    if (!positionalOnly && token.startsWith("--")) {
      index = scanOption(command, argv, state, index);
      continue;
    }
    if (isBlankInput(token)) refuse(command, `${command} requires a nonblank value`);
    state.positionals.push(token);
  }
}

function scanArgv(argv: readonly string[]): ParsedContractParts {
  const candidate = argv[0];
  if (!candidate || !Object.prototype.hasOwnProperty.call(CONTRACT_COMMAND_SPECS, candidate)) {
    throw new CliUsageError(
      `unknown command: ${candidate ?? ""}`,
      unknownCommandGuide(ROOT_USAGE_GUIDE, candidate ?? ""),
    );
  }
  const command = candidate as Command;
  const spec: CommandSpec = CONTRACT_COMMAND_SPECS[command];
  const state: ScanState = { flags: {}, positionals: [], stdin: false };
  scanContractTokens(command, argv, state);

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
): Readonly<{ cwd?: string; repo?: string; workdir?: string; commandArgv: readonly string[] }> {
  let cwd: string | undefined;
  let repo: string | undefined;
  let workdir: string | undefined;
  const commandArgv: string[] = [];
  let positionalOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!positionalOnly && token === "--") {
      positionalOnly = true;
      commandArgv.push(token);
      continue;
    }
    if (!positionalOnly && INVOCATION_PATH_OPTIONS.has(token)) {
      if (token === "--repo" && repo !== undefined) {
        throw new CliUsageError("--repo may appear only once", ROOT_USAGE_GUIDE);
      }
      if ((token === "-C" || token === "--cwd") && cwd !== undefined) {
        throw new CliUsageError("-C/--cwd may appear only once", ROOT_USAGE_GUIDE);
      }
      if (token === "--workdir" && workdir !== undefined) {
        throw new CliUsageError("--workdir may appear only once", ROOT_USAGE_GUIDE);
      }
      const value = argv[index + 1];
      if (invalidInvocationPath(value)) {
        throw new CliUsageError(`${token} requires a path`, ROOT_USAGE_GUIDE);
      }
      if (token === "--repo") repo = value;
      else if (token === "--workdir") workdir = value;
      else cwd = value;
      index += 1;
      continue;
    }
    commandArgv.push(token);
  }
  return {
    ...(cwd === undefined ? {} : { cwd }),
    ...(repo === undefined ? {} : { repo }),
    ...(workdir === undefined ? {} : { workdir }),
    commandArgv,
  };
}

function invalidInvocationPath(value: string | undefined): boolean {
  return value === undefined || value === "-" || value.startsWith("-") || isBlankInput(value);
}

function helpCoordinate(argv: readonly string[]): CliHelpCoordinate | null {
  const endOptions = argv.indexOf("--");
  const optionEnd = endOptions < 0 ? argv.length : endOptions;
  const help = argv.slice(0, optionEnd).indexOf("--help");
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
  if (invocation.commandArgv.length === 1 && invocation.commandArgv[0] === "--version") return { version: true };
  const task = invocation.commandArgv[0] === "task" ? parseTaskCommand(invocation.commandArgv.slice(1)) : undefined;
  const install =
    invocation.commandArgv[0] === "install" ? parseInstallCommand(invocation.commandArgv.slice(1)) : undefined;
  const akuma = isAkumaAction(invocation.commandArgv[0]) ? parseAkumaCommand(invocation.commandArgv) : undefined;
  const command = task ?? akuma ?? install ?? parseContractCommand(scanArgv(invocation.commandArgv));
  if (invocation.workdir !== undefined && command.command !== "call") {
    throw new CliUsageError(`option --workdir is not valid for ${command.command}`, usageGuideForCommand(command));
  }
  return {
    ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
    ...(invocation.repo === undefined ? {} : { repo: invocation.repo }),
    ...(invocation.workdir === undefined ? {} : { workdir: invocation.workdir }),
    command,
  };
}
