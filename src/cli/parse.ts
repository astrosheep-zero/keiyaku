import type { VerbInput, VerbName } from "../library/keiyaku-verbs.js";
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
  type AkumaParseResult,
  type AkumaPromptSource,
} from "./commands/akuma-grammar.js";
import {
  INSTALL_ROOT_PURPOSE,
  INSTALL_USAGE,
  parseInstallCommand,
  renderInstallHelp,
  type ParsedInstallCommand,
} from "./commands/install.js";
import { parseContractCommand, type ContractTokens } from "./commands/contract-grammar.js";
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
const WHOAMI_PURPOSE = "Observe self, current Turn initiator, and Akuma profile.";

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
      "  --workdir <path>    Set the execution directory for spawn only.",
      "",
      "Outcomes:  exit 0 accepted · 1 refused · 2 retryable · 3 failed · 4 unsatisfied · 64 usage",
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
  const name = commandName(command);
  if (name === "whoami") return commandGuide("whoami", WHOAMI_USAGE);
  if (name === "install") return commandGuide("install", INSTALL_USAGE);
  if ("command" in command && command.command === "debt") return debtUsageGuide(command.action);
  if (isAkumaAction(name)) return akumaUsageGuide(name);
  return commandGuide(name, CONTRACT_COMMAND_SPECS[name as Command].usage);
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
        return `${WHOAMI_PURPOSE}\n\n${usageLine(WHOAMI_USAGE)}\n\nRead-only. For an Akuma, who started its current turn is shown apart from who spawned it. Missing or unreadable facts stay explicit.`;
      case "akuma":
        return renderAkumaHelp(coordinate.action);
    }
  })();
  return renderHelpText(help, columns);
}

type RequestOutput = Readonly<{ output: "text" | "json" }>;
export type CliVerb = Exclude<VerbName, `debt.${string}` | "report" | "whoami">;
export type VerbRequest<K extends CliVerb = CliVerb> = {
  [P in K]: RequestOutput & Readonly<{ name: P; input: VerbInput<P> }>;
}[K];
type DocumentBind = Extract<VerbInput<"bind">, { markdown: string }>;
type Acquisitions = {
  bind: { input: Omit<DocumentBind, "markdown">; acquire: { markdown: true } };
  amend: { input: Omit<VerbInput<"amend">, "markdown">; acquire: { markdown: true } };
  arc: { input: Omit<VerbInput<"arc">, "markdown">; acquire: { markdown: true } };
  review: { input: Omit<VerbInput<"review">, "summary">; acquire: { summary: true } };
  spawn: {
    input: Omit<VerbInput<"spawn">, "prompt">;
    acquire: { prompt?: AkumaPromptSource };
  };
  status: { input: Record<string, never>; acquire: { selector: string } };
  tell: { input: Omit<VerbInput<"tell">, "prompt">; acquire: { prompt: AkumaPromptSource } };
  ask: { input: Omit<VerbInput<"ask">, "prompt" | "schema">; acquire: { prompt: AkumaPromptSource; schema: string } };
};
export type PendingRequest = {
  [K in keyof Acquisitions]: RequestOutput & Readonly<{ name: K }> & Readonly<Acquisitions[K]>;
}[keyof Acquisitions];
export type CliRequest = VerbRequest | PendingRequest;

export type ParsedWhoamiCommand = Readonly<{ command: "whoami"; output: "text" | "json" }>;
export type ParsedCommand =
  | CliRequest
  | ParsedInstallCommand
  | Extract<AkumaParseResult, { command: "report" }>
  | ParsedDebtCommand
  | ParsedWhoamiCommand;

export function commandName(command: ParsedCommand) {
  return "name" in command ? command.name : command.command;
}

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

export function commandRepoPolicy(
  command: ParsedCommand,
): Readonly<{ use: "none" | "optional" | "required"; acceptsExplicit: boolean }> {
  if (!("name" in command)) return { use: command.command === "whoami" ? "optional" : "none", acceptsExplicit: false };
  switch (command.name) {
    case "bind":
    case "amend":
    case "deliver":
    case "verify":
    case "review":
    case "arc":
    case "abandon":
    case "reconcile":
    case "region":
      return { use: "required", acceptsExplicit: true };
    case "show": {
      const debt = command.input.ids?.[0]?.startsWith("debt/") === true;
      return { use: debt ? "none" : "required", acceptsExplicit: !debt };
    }
    case "ls":
      return {
        use: command.input.selector.startsWith("kei")
          ? "required"
          : command.input.selector === "aku" ||
              command.input.selector === "aku/" ||
              command.input.selector.startsWith("debt")
            ? "none"
            : "optional",
        acceptsExplicit: false,
      };
    case "kanshi":
    case "status":
    case "tell":
    case "ask":
      return { use: "optional", acceptsExplicit: false };
    case "history":
      return {
        use: command.input.selector.startsWith("kei/") ? "required" : "optional",
        acceptsExplicit: command.input.selector.startsWith("kei/"),
      };
    case "fork":
      return { use: "optional", acceptsExplicit: true };
    case "wait":
    case "kill": {
      const selectors = command.name === "wait" ? command.input.selectors : command.input.akuma;
      const contractSelector = selectors.some((selector) => selector.startsWith("kei/"));
      return { use: contractSelector ? "required" : "optional", acceptsExplicit: contractSelector };
    }
    case "spawn":
      return {
        use: command.input.contract === undefined ? "none" : "required",
        acceptsExplicit: command.input.contract !== undefined,
      };
    case "settings":
    case "nuke":
      return { use: "none", acceptsExplicit: false };
  }
}

function refuseUnusedRepo(command: ParsedCommand): never {
  if (commandName(command) === "spawn") throw new CliUsageError("--repo has no consumer without --contract");
  throw new CliUsageError(`--repo has no consumer for ${commandName(command)}`);
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

function scanArgv(argv: readonly string[]): ContractTokens {
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
  if (spec.positional === "optional" && scanned.positionals.length > 1 && command !== "status" && command !== "show") {
    refuse(command, `${command} accepts at most one contract`);
  }
  if (spec.stdin === "required" && !stdin) {
    refuse(command, `${command} requires stdin`);
  }

  const output = scanned.flags.json === true ? ("json" as const) : ("text" as const);
  return {
    command,
    flags: scanned.flags,
    positionals: scanned.positionals,
    stdin,
    output,
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
  if (invocation.workdir !== undefined && commandName(command) !== "spawn") {
    throw new CliUsageError(`option --workdir is not valid for ${commandName(command)}`, usageGuideForCommand(command));
  }
  return {
    ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
    ...(invocation.repo === undefined ? {} : { repo: invocation.repo }),
    ...(invocation.workdir === undefined ? {} : { workdir: invocation.workdir }),
    command,
  };
}
