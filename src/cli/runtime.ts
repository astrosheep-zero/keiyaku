import { isParsedAkumaCommand } from "./commands/akuma.js";
import type { InvokedAkumaCommand } from "./commands/akuma.js";
import type { InstallInvocationResult } from "./commands/install.js";
import type { AkumaInvocationResult } from "./commands/akuma-invoke.js";
import type { TaskInvocationResult } from "./commands/task-invoke.js";
import type { ParsedCommand, ParsedExecution } from "./parse.js";
import { CliUsageError, usageGuideForCommand } from "./parse.js";
import { renderUsageMessage } from "./usage.js";
import { DEFAULT_CLI_COLUMNS, safeText } from "./render/terminal.js";
import type { InvocationResult } from "./result.js";
import type { Settings } from "../settings.js";
import type { ExecutionEvent } from "../library/execution.js";

function writeCliStream(stream: NodeJS.WritableStream, body: string): void {
  stream.write(body.endsWith("\n") ? body : `${body}\n`);
}

export async function writeExecutionProgress(
  events: AsyncIterable<ExecutionEvent>,
  stream: NodeJS.WritableStream = process.stderr,
): Promise<void> {
  const { renderExecutionProgress } = await import("./render/execution-progress.js");
  const terminal = stream as NodeJS.WritableStream & Readonly<{ isTTY?: boolean; columns?: number }>;
  await renderExecutionProgress(events, {
    stream: terminal,
    context: {
      columns:
        terminal.isTTY === true && Number.isInteger(terminal.columns)
          ? (terminal.columns ?? DEFAULT_CLI_COLUMNS)
          : DEFAULT_CLI_COLUMNS,
      color: false,
    },
  });
}

function cliCancellation(): Readonly<{ signal: AbortSignal; close(): void }> {
  const controller = new AbortController();
  const cancel = (): void => controller.abort(new Error("CLI cancellation requested"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  return {
    signal: controller.signal,
    close(): void {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    },
  };
}

export async function writeTask(
  command: Extract<ParsedCommand, { command: "task" }>,
  result: TaskInvocationResult,
): Promise<number> {
  const { renderTaskIncompleteDiagnostic, renderTaskText, taskExitCode } = await import("./render/task.js");
  const context = {
    columns:
      process.stdout.isTTY === true && Number.isInteger(process.stdout.columns)
        ? process.stdout.columns
        : DEFAULT_CLI_COLUMNS,
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
    columns:
      process.stdout.isTTY === true && Number.isInteger(process.stdout.columns)
        ? process.stdout.columns
        : DEFAULT_CLI_COLUMNS,
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

type AkumaFailureProjection = Readonly<{ body: string; exitCode: 1 | 3 }>;

export async function akumaFailureProjection(
  error: unknown,
  command: ParsedCommand,
): Promise<AkumaFailureProjection | undefined> {
  const [{ AkumaNotBornError, AkumaObservationError }, { AkumaAddressError, AkumaWorldScopeError }] = await Promise.all(
    [import("../akuma/akuma-errors.js"), import("../library/address.js")],
  );
  if (error instanceof AkumaNotBornError) {
    return {
      body: command.output === "json" ? error.message : `× Akuma not found  ${safeText(error.id)}`,
      exitCode: 1,
    };
  }
  if (error instanceof AkumaAddressError) {
    const body =
      error.refusal.kind === "akuma-alias-not-found"
        ? `× Akuma alias not found  ${safeText(error.refusal.alias)}`
        : `× invalid Akuma  ${safeText(error.refusal.selector)}`;
    return { body: command.output === "json" ? error.message : body, exitCode: 1 };
  }
  if (error instanceof AkumaWorldScopeError) {
    return {
      body:
        command.output === "json"
          ? JSON.stringify(error.refusal)
          : error.refusal.ids.map((id) => `× Akuma not in this World  ${safeText(id)}`).join("\n"),
      exitCode: 1,
    };
  }
  if (error instanceof AkumaObservationError) {
    return {
      body:
        command.output === "json"
          ? error.message
          : `× Akuma observation failed  ${safeText(error.id)} — ${safeText(error.diagnostic)}`,
      exitCode: 3,
    };
  }
  return undefined;
}

async function commandFailureText(error: unknown, command: ParsedCommand): Promise<string> {
  const diagnostic = error instanceof Error ? error.message : String(error);
  if (command.output === "json" || error instanceof CliUsageError) return diagnostic;
  const { KeiyakuRefused } = await import("../library/refusal.js");
  if (error instanceof KeiyakuRefused) {
    if (error.refusal.kind === "contract-missing") {
      return renderUsageMessage(
        diagnostic,
        {
          ...usageGuideForCommand(command),
          given: error.refusal.contractId,
        },
        "selector",
      );
    }
    const { renderRefusalFacts } = await import("./render/refusal.js");
    return [`× ${command.command} refused`, ...renderRefusalFacts(error.refusal, "  ", displayContext().columns)].join(
      "\n",
    );
  }
  return `× ${command.command} failed\n  diagnostic  ${safeText(diagnostic)}`;
}

export async function runCliCommand(invocation: ParsedExecution): Promise<number> {
  const command = invocation.command;
  const cancellation = cliCancellation();
  try {
    const { invoke } = await import("./invoke.js");
    const result = await invoke(invocation, {
      cwd: process.cwd(),
      signal: cancellation.signal,
      progress: writeExecutionProgress,
    });
    return await writeResult(command, result);
  } catch (error) {
    const { executionReceipt } = await import("../library/execution-result.js");
    const receipt = executionReceipt(error);
    if (receipt !== undefined) {
      const diagnostic = error instanceof Error ? error.message : String(error);
      const { postAdmissionFailureCategory } = await import("../library/refusal.js");
      const category = postAdmissionFailureCategory(error);
      const { executionFailureLines } = await import("./render/receipt.js");
      writeCliStream(
        process.stdout,
        command.output === "json"
          ? JSON.stringify({ kind: "execution-failed", category, diagnostic, receipt })
          : executionFailureLines(receipt, category, diagnostic, displayContext().columns).join("\n"),
      );
      return 3;
    }
    const akumaFailure = await akumaFailureProjection(error, command);
    if (akumaFailure !== undefined) {
      writeCliStream(process.stderr, akumaFailure.body);
      return akumaFailure.exitCode;
    }
    if (command.command === "bind") {
      const { BindDraftError } = await import("./draft.js");
      if (error instanceof BindDraftError) {
        writeCliStream(process.stderr, await commandFailureText(error.original, command));
        const { renderBindDraftReceipt } = await import("./render/refusal.js");
        writeCliStream(process.stderr, renderBindDraftReceipt(error.draft));
        return error.original instanceof CliUsageError ? 1 : 3;
      }
    }
    writeCliStream(process.stderr, await commandFailureText(error, command));
    return error instanceof CliUsageError ? 1 : 3;
  } finally {
    cancellation.close();
  }
}
