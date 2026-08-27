import { isParsedAkumaCommand } from "./commands/akuma.js";
import type { InvokedAkumaCommand } from "./commands/akuma.js";
import type { InstallInvocationResult } from "./commands/install.js";
import type { AkumaInvocationResult } from "./commands/akuma-invoke.js";
import type { TaskInvocationResult } from "./commands/task-invoke.js";
import type { ParsedCommand, ParsedExecution } from "./parse.js";
import { CliUsageError } from "./parse.js";
import type { InvocationResult } from "./result.js";
import type { Settings } from "../settings.js";

export function invocationStart(command: ParsedCommand): string | undefined {
  if (command.output === "json") return undefined;
  if (command.command === "bind") return "⧖ preparing keiyaku";
  if (command.command === "deliver") return "⧖ delivering";
  if (command.command === "audit") return "⧖ auditing";
  if (command.command === "reconcile") return "⧖ reconciling";
  return command.command === "install" ? "⧖ installing skills" : undefined;
}

function writeCliStream(stream: NodeJS.WritableStream, body: string): void {
  stream.write(body.endsWith("\n") ? body : `${body}\n`);
}

export async function writeTask(
  command: Extract<ParsedCommand, { command: "task" }>,
  result: TaskInvocationResult,
): Promise<number> {
  const { renderTaskIncompleteDiagnostic, renderTaskText, taskExitCode } = await import("./render/task.js");
  const context = {
    columns: process.stdout.isTTY === true && Number.isInteger(process.stdout.columns) ? process.stdout.columns : 80,
    color: false,
  };
  if (command.output === "json") writeCliStream(process.stdout, JSON.stringify(result));
  else if (
    command.action === "compose" &&
    typeof result === "object" &&
    result !== null &&
    "kind" in result &&
    result.kind === "incomplete"
  ) {
    const diagnostic = renderTaskIncompleteDiagnostic(result);
    if (diagnostic.length > 0) writeCliStream(process.stderr, diagnostic);
    process.stdout.write(result.draft);
  } else writeCliStream(process.stdout, renderTaskText(command, result, context));
  return taskExitCode(result);
}

function displayContext() {
  return {
    columns: process.stdout.isTTY === true && Number.isInteger(process.stdout.columns) ? process.stdout.columns : 80,
    color: process.stdout.isTTY === true && process.env.NO_COLOR === undefined,
  };
}

async function writeAkuma(
  command: InvokedAkumaCommand | Extract<ParsedCommand, { command: "status" }>,
  result: AkumaInvocationResult,
): Promise<number> {
  const { renderAkumaJson, akumaExitCode, akumaRawAnswer, renderAkumaText } = await import("./render/akuma.js");
  const output =
    command.output === "json" ? renderAkumaJson(result) : renderAkumaText(command, result, displayContext());
  const exact =
    command.output === "text" &&
    (akumaRawAnswer(result) !== undefined ||
      (command.command === "history" && command.last && result.action === "history" && result.mode === "last"));
  if (exact) process.stdout.write(output);
  else writeCliStream(process.stdout, output);
  return akumaExitCode(result);
}

function isAkumaOutput(
  command: ParsedCommand,
  result: unknown,
): command is InvokedAkumaCommand | Extract<ParsedCommand, { command: "status" }> {
  if (isParsedAkumaCommand(command)) return true;
  return (
    command.command === "status" &&
    typeof result === "object" &&
    result !== null &&
    "kind" in result &&
    result.kind === "akuma"
  );
}

function invocationJson(result: InvocationResult): unknown {
  switch (result.kind) {
    case "guidance":
      return { contract: result.contract, guidance: result.guidance };
    case "catalog":
      return result.catalog;
    case "nuke":
      return result.result;
    case "region":
      return result.region;
    case "contract-history":
      return result.history;
    case "status":
      return result.report;
    case "status-set":
      return result.entries;
    default:
      return result;
  }
}

async function invocationExitCode(result: InvocationResult): Promise<number> {
  if (result.kind === "nuke") return (await import("./render/nuke.js")).nukeExitCode(result.result);
  if (result.kind === "observation") {
    const { worldObservationFailureText } = await import("./render/board.js");
    return worldObservationFailureText(result) === undefined ? 0 : 1;
  }
  return result.kind === "refused" ? 1 : result.kind === "retry" ? 2 : 0;
}

async function writeResult(command: ParsedCommand, result: unknown): Promise<number> {
  if (command.command === "install") {
    const { installExitCode, renderInstallText } = await import("./commands/install.js");
    const value = result as InstallInvocationResult;
    writeCliStream(process.stdout, command.output === "json" ? JSON.stringify(value) : renderInstallText(value));
    return installExitCode(value);
  }
  if (command.command === "task") return await writeTask(command, result as TaskInvocationResult);
  if (command.command === "settings") {
    const { renderSettingsText, settingsJsonValue } = await import("./render/settings.js");
    const value = (result as { value: Settings }).value;
    writeCliStream(
      process.stdout,
      command.output === "json"
        ? JSON.stringify(settingsJsonValue(value))
        : renderSettingsText(value, displayContext().columns),
    );
    return 0;
  }
  if (isAkumaOutput(command, result)) return await writeAkuma(command, result as AkumaInvocationResult);
  const contractResult = result as InvocationResult;
  const { renderText } = await import("./render/text.js");
  const json = command.output === "json";
  const body = json ? JSON.stringify(invocationJson(contractResult)) : renderText(contractResult, displayContext());
  writeCliStream(process.stdout, body);
  return invocationExitCode(contractResult);
}

function writeWorldScopeRefusal(
  error: Readonly<{ refusal: { kind: string; world: string; ids: readonly string[] } }>,
  output: "text" | "json",
): number {
  const body =
    output === "json"
      ? JSON.stringify(error.refusal)
      : `${error.refusal.kind} ${error.refusal.world} ${error.refusal.ids.join(" ")}`;
  writeCliStream(process.stderr, body);
  return 1;
}

export async function runCliCommand(invocation: ParsedExecution): Promise<number> {
  const command = invocation.command;
  try {
    const start = invocationStart(command);
    const { invoke } = await import("./invoke.js");
    const result = await invoke(invocation, {
      cwd: process.cwd(),
      ...(start === undefined
        ? {}
        : {
            onOperationStart: () => {
              writeCliStream(process.stderr, start);
            },
          }),
    });
    return await writeResult(command, result);
  } catch (error) {
    if (command.command !== "install") {
      const { AkumaWorldScopeError } = await import("../library/address.js");
      if (error instanceof AkumaWorldScopeError) return writeWorldScopeRefusal(error, command.output);
    }
    if (command.command === "bind") {
      const { BindDraftError } = await import("./draft.js");
      if (error instanceof BindDraftError) {
        writeCliStream(
          process.stderr,
          error.original instanceof Error ? error.original.message : String(error.original),
        );
        const { renderBindDraftReceipt } = await import("./render/refusal.js");
        writeCliStream(process.stderr, renderBindDraftReceipt(error.draft));
        return error.original instanceof CliUsageError ? 1 : 3;
      }
    }
    writeCliStream(process.stderr, error instanceof Error ? error.message : String(error));
    return error instanceof CliUsageError ? 1 : 3;
  }
}
