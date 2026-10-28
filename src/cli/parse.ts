import {
  isDebtAction,
  parseDebtCommand,
  renderDebtHelp,
  debtUsageGuide,
  type ParsedDebtCommand,
  type DebtAction,
} from "./commands/debt-grammar.js";
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
  type ParsedContractCommand,
} from "./commands/contract-grammar.js";
import {
  CONTRACT_COMMAND_SPECS,
  renderContractHelp as renderContractHelpForOwner,
  type ContractCommand as Command,
  type ContractCommandSpec as CommandSpec,
} from "./commands/contract-help.js";
import { renderOpaqueBlock, renderTextBlock } from "./render/terminal.js";
import { scanArgs, type ScanSpec } from "./scan.js";
import {
  CliUsageError,
  commandGuide,
  isBlankInput,
  ROOT_USAGE_GUIDE,
  unknownCommandGuide,
  usageLine,
  type CliUsageGuide,
} from "./usage.js";
export { CliUsageError } from "./usage.js";
export type { CliUsageGuide } from "./usage.js";

export type { Command };

const ROOT_USAGE = [
  "usage  keiyaku <command> [options]",
  "      keiyaku <command> --help   shows that command's complete usage",
].join("\n");

const INVOCATION_PATH_OPTIONS = new Set(["-C", "--cwd", "--repo", "--workdir"]);
const WHOAMI_USAGE = "whoami [--json]";
const WHOAMI_PURPOSE = "Observe this caller's identity and own Akuma profile.";

export function renderRootHelp(columns?: number): string {
  return renderHelpText(
    [
      "keiyaku — Contract, Debt, and Akuma control for one repository",
      "",
      ROOT_USAGE,
      "",
      "Contract — standing acceptance",
      ...Object.entries(CONTRACT_COMMAND_SPECS)
        .filter(([command]) => command !== "settings")
        .map(([command, spec]) => `  ${command.padEnd(10)} ${spec.purpose}`),
      "",
      "Debt — unresolved-work ledger",
      "  debt       Debt coordination; see `keiyaku debt --help`.",
      "",
      "Akuma — contracted demons",
      ...renderAkumaRootRows(),
      "",
      "Workspace",
      `  ${"install".padEnd(10)} ${INSTALL_ROOT_PURPOSE}`,
      `  ${"settings".padEnd(10)} ${CONTRACT_COMMAND_SPECS.settings.purpose}`,
      `  ${"whoami".padEnd(10)} ${WHOAMI_PURPOSE}`,
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
  if (command.command === "whoami") return commandGuide("whoami", WHOAMI_USAGE);
  if (command.command === "install") return commandGuide("install", INSTALL_USAGE);
  if (command.command === "debt") return debtUsageGuide(command.action);
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
      case "debt":
        return renderDebtHelp(coordinate.action);
      case "install":
        return renderInstallHelp();
      case "whoami":
        return `${WHOAMI_PURPOSE}\n\n${usageLine(WHOAMI_USAGE)}\n\nRead-only; absent, invalid, and unavailable facts remain explicit.`;
      case "akuma":
        return renderAkumaHelp(coordinate.action);
    }
  })();
  return renderHelpText(help, columns);
}

export type ParsedWhoamiCommand = Readonly<{ command: "whoami"; output: "text" | "json" }>;
export type ParsedCommand =
  | ParsedContractCommand
  | ParsedInstallCommand
  | ParsedAkumaCommand
  | ParsedDebtCommand
  | ParsedWhoamiCommand;

type CliHelpCoordinate =
  | Readonly<{ kind: "root" }>
  | Readonly<{ kind: "contract"; command: Command }>
  | Readonly<{ kind: "debt"; action?: DebtAction }>
  | Readonly<{ kind: "install" }>
  | Readonly<{ kind: "whoami" }>
  | Readonly<{ kind: "akuma"; action: AkumaAction }>;

export type ParsedInvocation =
  | Readonly<{ cwd?: string; repo?: string; workdir?: string; command: ParsedCommand }>
  | Readonly<{ help: CliHelpCoordinate }>
  | Readonly<{ version: true }>;

type RepoUse = "none" | "optional" | "required";
type CommandRepoPolicy = Readonly<{ use: RepoUse; acceptsExplicit: boolean }>;

export function commandRepoPolicy(command: ParsedCommand): CommandRepoPolicy {
  switch (command.command) {
    case "bind":
    case "amend":
    case "deliver":
    case "review":
    case "arc":
    case "abandon":
    case "reconcile":
    case "region":
    case "show":
      return { use: "required", acceptsExplicit: true };
    case "ls":
      return { use: command.query.kind === "contracts" ? "required" : "none", acceptsExplicit: false };
    case "status":
    case "whoami":
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
    case "debt":
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

function refuse(command: Command, message: string): never {
  throw new CliUsageError(message, commandGuide(command, CONTRACT_COMMAND_SPECS[command].usage));
}

/** The contract surfaces' one scan spec: `-` carries the edge's own stdin input. */
function contractScanSpec(command: Command, spec: CommandSpec): ScanSpec {
  return {
    subject: command,
    flags: spec.flags,
    ...(spec.stdin === "none" ? {} : { stdin: "input" }),
    stdinRefusal: `${command} reads no stdin`,
  };
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
  const scanned = scanArgs(argv, contractScanSpec(command, spec), (message) => refuse(command, message));
  const stdin = scanned.stdin !== undefined;

  if (spec.positional === "none" && scanned.positionals.length > 0) {
    refuse(command, `${command} accepts no contract`);
  }
  if (spec.positional === "optional" && scanned.positionals.length > 1 && command !== "status") {
    refuse(command, `${command} accepts at most one contract`);
  }
  if (spec.stdin === "required" && !stdin) {
    refuse(command, `${command} requires stdin`);
  }

  const output = scanned.flags.json === true ? ("json" as const) : ("text" as const);
  const actor = typeof scanned.flags.actor === "string" ? scanned.flags.actor : undefined;
  return {
    command,
    flags: scanned.flags,
    positionals: scanned.positionals,
    stdin,
    output,
    ...(actor === undefined ? {} : { actor }),
  };
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
  if (root === "debt") {
    const action = isDebtAction(words[1]) ? words[1] : undefined;
    return { kind: "debt", ...(action === undefined ? {} : { action }) };
  }
  if (root === "install") return { kind: "install" };
  if (root === "whoami") return { kind: "whoami" };
  if (isAkumaAction(root)) return { kind: "akuma", action: root };
  if (root !== undefined && Object.hasOwn(CONTRACT_COMMAND_SPECS, root)) {
    return { kind: "contract", command: root as Command };
  }
  return { kind: "root" };
}

function parseWhoami(argv: readonly string[]): ParsedWhoamiCommand {
  const fail = (message: string): never => {
    throw new CliUsageError(message, commandGuide("whoami", WHOAMI_USAGE));
  };
  const scanned = scanArgs(
    argv,
    { subject: "whoami", flags: { json: "boolean" }, stdinRefusal: "whoami reads no stdin" },
    fail,
  );
  if (scanned.positionals.length > 0) fail("whoami accepts no arguments");
  return { command: "whoami", output: scanned.flags.json === true ? "json" : "text" };
}

export function parseArgv(argv: readonly string[]): ParsedInvocation {
  const invocation = invocationOptions(argv);
  const help = helpCoordinate(invocation.commandArgv);
  if (help !== null) return { help };
  // A bare invocation asks for orientation: the root help index, not a refusal.
  if (invocation.commandArgv.length === 0) return { help: { kind: "root" } };
  if (invocation.commandArgv.length === 1 && invocation.commandArgv[0] === "debt") return { help: { kind: "debt" } };
  if (invocation.commandArgv.length === 1 && invocation.commandArgv[0] === "--version") return { version: true };
  const whoami = invocation.commandArgv[0] === "whoami" ? parseWhoami(invocation.commandArgv) : undefined;
  const debt = invocation.commandArgv[0] === "debt" ? parseDebtCommand(invocation.commandArgv.slice(1)) : undefined;
  const install =
    invocation.commandArgv[0] === "install" ? parseInstallCommand(invocation.commandArgv.slice(1)) : undefined;
  const akuma = isAkumaAction(invocation.commandArgv[0]) ? parseAkumaCommand(invocation.commandArgv) : undefined;
  const command = whoami ?? debt ?? akuma ?? install ?? parseContractCommand(scanArgv(invocation.commandArgv));
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
