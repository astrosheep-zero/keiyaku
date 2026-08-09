import {
  CliUsageError,
  parseArgv,
  renderContractHelp,
  renderRootHelp,
  type CliHelpCoordinate,
  type ParsedCommand,
} from "./parse.js";
import { renderText } from "./render/text.js";
import { renderTaskIncompleteDiagnostic, renderTaskText, taskExitCode } from "./render/task.js";
import { akumaExitCode, renderAkumaJson, renderAkumaText } from "./render/akuma.js";
import { isParsedAkumaCommand, renderAkumaHelp } from "./commands/akuma.js";
import type { AkumaInvocationResult } from "./commands/akuma-invoke.js";
import { renderTaskHelp, type ParsedTaskCommand } from "./commands/task.js";
import type { TaskInvocationResult } from "./commands/task-invoke.js";
import type { InvocationResult } from "./result.js";
import type { SettingsInvocationResult } from "./invoke.js";
import { renderSettingsText, settingsJsonValue } from "./render/settings.js";

function writeTask(command: ParsedTaskCommand, result: TaskInvocationResult): number {
  if (command.output === "json") process.stdout.write(`${JSON.stringify(result)}\n`);
  else if (command.action === "compose" && typeof result === "object" && result !== null && "kind" in result && result.kind === "incomplete") {
    const diagnostic = renderTaskIncompleteDiagnostic(result);
    if (diagnostic.length > 0) process.stderr.write(`${diagnostic}\n`);
    process.stdout.write(result.draft);
  } else process.stdout.write(`${renderTaskText(command, result)}\n`);
  return taskExitCode(result);
}

function writeAkuma(command: Parameters<typeof renderAkumaText>[0], result: AkumaInvocationResult): number {
  const output = command.output === "json" ? renderAkumaJson(command, result) : renderAkumaText(command, result);
  const rawLast = command.command === "history" && command.last && command.output === "text";
  process.stdout.write(rawLast ? output : `${output}\n`);
  return akumaExitCode(result);
}

function renderHelp(coordinate: CliHelpCoordinate): string {
  switch (coordinate.kind) {
    case "root": return renderRootHelp();
    case "contract": return renderContractHelp(coordinate.command);
    case "task": return renderTaskHelp(coordinate.action);
    case "akuma": return renderAkumaHelp(coordinate.action);
  }
}

function writeResult(command: ParsedCommand, result: unknown): number {
  if (command.command === "task") return writeTask(command, result as TaskInvocationResult);
  if (command.command === "settings") {
    const value = (result as SettingsInvocationResult).value;
    process.stdout.write(`${command.output === "json" ? JSON.stringify(settingsJsonValue(value)) : renderSettingsText(value)}\n`);
    return 0;
  }
  if (isParsedAkumaCommand(command)
    || (typeof result === "object" && result !== null && "kind" in result && result.kind === "akuma")) {
    return writeAkuma(command, result as AkumaInvocationResult);
  }
  const contractResult = result as InvocationResult;
  const output = command.output === "json"
    ? JSON.stringify(contractResult.kind === "status" ? contractResult.report : contractResult)
    : renderText(contractResult, {
      columns: process.stdout.isTTY === true && Number.isInteger(process.stdout.columns) ? process.stdout.columns : 80,
      color: process.stdout.isTTY === true && process.env.NO_COLOR === undefined,
    });
  process.stdout.write(`${output}\n`);
  return contractResult.kind === "refused" ? 1 : contractResult.kind === "retry" ? 2 : 0;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArgv(argv);
    if ("help" in parsed) {
      process.stdout.write(`${renderHelp(parsed.help)}\n`);
      return 0;
    }
    const { invoke } = await import("./invoke.js");
    const result = await invoke(parsed, { cwd: process.cwd() });
    return writeResult(parsed.command, result);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof CliUsageError ? 1 : 3;
  }
}
