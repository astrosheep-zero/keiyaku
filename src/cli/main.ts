import {
  CliUsageError,
  parseArgv,
  renderContractHelp,
  renderRootHelp,
  type CliHelpCoordinate,
} from "./parse.js";
import { renderText } from "./render/text.js";
import { renderTaskIncompleteDiagnostic, renderTaskText, taskExitCode } from "./render/task.js";
import { akumaExitCode, akumaJsonValue, renderAkumaText } from "./render/akuma.js";
import { renderAkumaHelp, type ParsedAkumaCommand } from "./commands/akuma.js";
import type { AkumaInvocationResult } from "./commands/akuma-invoke.js";
import { renderTaskHelp, type ParsedTaskCommand } from "./commands/task.js";
import type { TaskInvocationResult } from "./commands/task-invoke.js";
import type { InvocationResult } from "./result.js";

function writeTask(command: ParsedTaskCommand, result: TaskInvocationResult): number {
  if (command.output === "json") process.stdout.write(`${JSON.stringify(result)}\n`);
  else if (command.action === "compose" && typeof result === "object" && result !== null && "kind" in result && result.kind === "incomplete") {
    const diagnostic = renderTaskIncompleteDiagnostic(result);
    if (diagnostic.length > 0) process.stderr.write(`${diagnostic}\n`);
    process.stdout.write(result.draft);
  } else process.stdout.write(`${renderTaskText(command, result)}\n`);
  return taskExitCode(result);
}

function writeAkuma(command: ParsedAkumaCommand, result: AkumaInvocationResult): number {
  process.stdout.write(`${command.output === "json" ? JSON.stringify(akumaJsonValue(result)) : renderAkumaText(command, result)}\n`);
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

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArgv(argv);
    if ("help" in parsed) {
      process.stdout.write(`${renderHelp(parsed.help)}\n`);
      return 0;
    }
    const { invoke } = await import("./invoke.js");
    const result = await invoke(parsed, { cwd: process.cwd() });
    if (parsed.command.command === "task") {
      return writeTask(parsed.command, result as TaskInvocationResult);
    }
    if (parsed.command.command === "akuma") {
      return writeAkuma(parsed.command, result as AkumaInvocationResult);
    }
    const contractResult = result as InvocationResult;
    const output = parsed.command.output === "json"
      ? JSON.stringify(contractResult.kind === "status" ? contractResult.report : contractResult)
      : renderText(contractResult, {
        columns: process.stdout.isTTY === true && Number.isInteger(process.stdout.columns) ? process.stdout.columns : 80,
        color: process.stdout.isTTY === true && process.env.NO_COLOR === undefined,
      });
    process.stdout.write(`${output}\n`);
    return contractResult.kind === "refused" ? 1 : contractResult.kind === "retry" ? 2 : 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof CliUsageError ? 1 : 3;
  }
}
