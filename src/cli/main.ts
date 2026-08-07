import { invoke } from "./invoke.js";
import { CliUsageError, parseArgv } from "./parse.js";
import { renderText } from "./render/text.js";
import { renderTaskIncompleteDiagnostic, renderTaskText, taskExitCode } from "./render/task.js";
import type { TaskInvocationResult } from "./commands/task.js";
import type { InvocationResult } from "./result.js";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArgv(argv);
    const result = await invoke(parsed, { cwd: process.cwd() });
    if (parsed.command.command === "task") {
      const taskResult = result as TaskInvocationResult;
      if (parsed.command.output === "json") process.stdout.write(`${JSON.stringify(taskResult)}\n`);
      else if (parsed.command.action === "compose" && typeof taskResult === "object" && taskResult !== null && "kind" in taskResult && taskResult.kind === "incomplete") {
        const diagnostic = renderTaskIncompleteDiagnostic(taskResult);
        if (diagnostic.length > 0) process.stderr.write(`${diagnostic}\n`);
        process.stdout.write(taskResult.draft);
      } else process.stdout.write(`${renderTaskText(parsed.command, taskResult)}\n`);
      return taskExitCode(taskResult);
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
