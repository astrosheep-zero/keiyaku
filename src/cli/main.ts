import { AkumaWorldScopeError } from "../index.js";
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
import { akumaExitCode, akumaRawAnswer, renderAkumaJson, renderAkumaText } from "./render/akuma.js";
import { isParsedAkumaCommand, renderAkumaHelp } from "./commands/akuma.js";
import { installExitCode, renderInstallHelp, renderInstallText, type InstallInvocationResult } from "./commands/install.js";
import type { AkumaInvocationResult } from "./commands/akuma-invoke.js";
import { renderTaskHelp, type ParsedTaskCommand } from "./commands/task.js";
import type { TaskInvocationResult } from "./commands/task-invoke.js";
import type { InvocationResult } from "./result.js";
import type { SettingsInvocationResult } from "./invoke.js";
import { renderSettingsText, settingsJsonValue } from "./render/settings.js";
import { renderCatalogText } from "./render/catalog.js";
import { BindDraftError } from "./draft.js";
import { renderBindDraftReceipt } from "./render/refusal.js";

function writeTask(command: ParsedTaskCommand, result: TaskInvocationResult): number {
  const context = {
    columns: process.stdout.isTTY === true && Number.isInteger(process.stdout.columns) ? process.stdout.columns : 80,
    color: false,
  };
  if (command.output === "json") process.stdout.write(`${JSON.stringify(result)}\n`);
  else if (command.action === "compose" && typeof result === "object" && result !== null && "kind" in result && result.kind === "incomplete") {
    const diagnostic = renderTaskIncompleteDiagnostic(result);
    if (diagnostic.length > 0) process.stderr.write(`${diagnostic}\n`);
    process.stdout.write(result.draft);
  } else process.stdout.write(`${renderTaskText(command, result, context)}\n`);
  return taskExitCode(result);
}

function writeAkuma(command: Parameters<typeof renderAkumaText>[0], result: AkumaInvocationResult): number {
  const output = command.output === "json" ? renderAkumaJson(command, result) : renderAkumaText(command, result, {
    columns: process.stdout.isTTY === true && Number.isInteger(process.stdout.columns) ? process.stdout.columns : 80,
    color: process.stdout.isTTY === true && process.env.NO_COLOR === undefined,
  });
  const raw = command.output === "text"
    && ((command.command === "history" && command.last) || akumaRawAnswer(result) !== undefined);
  process.stdout.write(raw ? output : `${output}\n`);
  return akumaExitCode(result);
}

function renderHelp(coordinate: CliHelpCoordinate): string {
  switch (coordinate.kind) {
    case "root": return renderRootHelp();
    case "contract": return renderContractHelp(coordinate.command);
    case "task": return renderTaskHelp(coordinate.action);
    case "install": return renderInstallHelp();
    case "akuma": return renderAkumaHelp(coordinate.action);
  }
}

function writeGuidance(command: ParsedCommand, result: Extract<InvocationResult, { kind: "guidance" }>): number {
  if (command.output === "json") process.stdout.write(`${JSON.stringify({ contract: result.contract, guidance: result.guidance })}\n`);
  else process.stdout.write(result.guidance.endsWith("\n") ? result.guidance : `${result.guidance}\n`);
  return 0;
}

function writeCatalog(command: ParsedCommand, result: Extract<InvocationResult, { kind: "catalog" }>): number {
  process.stdout.write(`${command.output === "json" ? JSON.stringify(result.catalog) : renderCatalogText(result.catalog)}\n`);
  return 0;
}

// eslint-disable-next-line complexity -- output dispatch is the single CLI presentation boundary.
function writeResult(command: ParsedCommand, result: unknown): number {
  if (command.command === "install") {
    const value = result as InstallInvocationResult;
    process.stdout.write(`${command.output === "json" ? JSON.stringify(value) : renderInstallText(value)}\n`);
    return installExitCode(value);
  }
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
  if (contractResult.kind === "guidance") return writeGuidance(command, contractResult);
  if (contractResult.kind === "catalog") return writeCatalog(command, contractResult);
  if (contractResult.kind === "region") {
    const output = command.output === "json" ? JSON.stringify(contractResult.region) : renderText(contractResult);
    process.stdout.write(`${output}\n`);
    return 0;
  }
  const output = command.output === "json"
    ? JSON.stringify(contractResult.kind === "status" ? contractResult.report : contractResult)
    : renderText(contractResult, {
      columns: process.stdout.isTTY === true && Number.isInteger(process.stdout.columns) ? process.stdout.columns : 80,
      color: process.stdout.isTTY === true && process.env.NO_COLOR === undefined,
    });
  process.stdout.write(`${output}\n`);
  return contractResult.kind === "refused" ? 1 : contractResult.kind === "retry" ? 2 : 0;
}

function writeWorldScopeRefusal(error: AkumaWorldScopeError, output: "text" | "json"): number {
  const body = output === "json"
    ? JSON.stringify(error.refusal)
    : `${error.refusal.kind} ${error.refusal.world} ${error.refusal.ids.join(" ")}`;
  process.stderr.write(`${body}\n`);
  return 1;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let output: "text" | "json" = "text";
  try {
    const parsed = parseArgv(argv);
    if ("help" in parsed) {
      process.stdout.write(`${renderHelp(parsed.help)}\n`);
      return 0;
    }
    output = parsed.command.output;
    const { invoke } = await import("./invoke.js");
    const result = await invoke(parsed, { cwd: process.cwd() });
    return writeResult(parsed.command, result);
  } catch (error) {
    if (error instanceof AkumaWorldScopeError) return writeWorldScopeRefusal(error, output);
    const original = error instanceof BindDraftError ? error.original : error;
    process.stderr.write(`${original instanceof Error ? original.message : String(original)}\n`);
    if (error instanceof BindDraftError) process.stderr.write(`${renderBindDraftReceipt(error.draft)}\n`);
    return original instanceof CliUsageError ? 1 : 3;
  }
}
