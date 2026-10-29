import { AkumaNotBornError, AkumaObservationError } from "../akuma/akuma-errors.js";
import { executionForEnvironment, localExecutionContext, type LibraryExecution } from "../akuma/requests.js";
import { AkumaArchetypeError, type ActorId } from "../index.js";
import { AkumaAddressError, AkumaWorldScopeError } from "../library/address.js";
import { encodeFailureWire, KeiyakuError } from "../library/outcome.js";
import type { ExecutionObserver } from "../protocol/execution-observation.js";
import { isParsedAkumaCommand, runAkumaCommand } from "./commands/akuma.js";
import { admitBindMarkdown, runContractCommand, runContractHistoryCommand } from "./commands/contract.js";
import { installOutcome, installHarnesses, renderInstallText } from "./commands/install.js";
import { runDebtCommand } from "./commands/debt.js";
import { runWhoami } from "./commands/whoami.js";
import { resolveInvocationCoordinates } from "./coordinates.js";
import { BindDraftError } from "./draft.js";
import {
  assertExplicitRepoUse,
  CliUsageError,
  usageGuideForCommand,
  type ParsedCommand,
  type ParsedInvocation,
} from "./parse.js";
import { createExecutionProgressRenderer } from "./render/execution-progress.js";
import { executionFailureLines } from "./render/receipt.js";
import { renderRefusal, renderStructuredRefusal } from "./render/refusal.js";
import { DEFAULT_CLI_COLUMNS, safeText } from "./render/terminal.js";
import { cliExitCode, displayContext, emit, writeJson, writeStderr, writeStdout, type CliOutcome } from "./streams.js";

export type ParsedCommandInvocation = Extract<ParsedInvocation, { command: ParsedCommand }>;

type ExecutionProgressDriver = Readonly<{ observe: ExecutionObserver; finish: () => Promise<void> }>;

/** Everything one invocation's leaves need at the process edge; Product JSON never sees this. */
export type CliRuntime = Readonly<{
  environment: NodeJS.ProcessEnv;
  execution: LibraryExecution;
  home?: string;
  readStdin: () => Promise<string>;
  signal: AbortSignal;
  progress: () => Promise<ExecutionProgressDriver>;
  actor?: ActorId;
}>;

export type CliRuntimeInput = Readonly<{
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  readStdin?: () => Promise<string>;
  actor?: ActorId;
  signal?: AbortSignal;
}>;

function processStdin(): Promise<string> {
  return (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  })();
}

function memoized(reader: () => Promise<string>): () => Promise<string> {
  let value: Promise<string> | undefined;
  return () => (value ??= reader());
}

function homeFromEnvironment(environment: NodeJS.ProcessEnv): string | undefined {
  const mapped = environment.KEIYAKU_HOME?.trim();
  return mapped === undefined || mapped.length === 0 ? undefined : mapped;
}

/** Builds the one live progress observer for an invocation; the leaf owns when it finishes. */
export async function writeExecutionProgress(
  stream: NodeJS.WritableStream = process.stderr,
): Promise<ExecutionProgressDriver> {
  const terminal = stream as NodeJS.WritableStream & Readonly<{ isTTY?: boolean; columns?: number }>;
  const renderer = createExecutionProgressRenderer({
    stream: terminal,
    context: {
      columns:
        terminal.isTTY === true && Number.isInteger(terminal.columns)
          ? (terminal.columns ?? DEFAULT_CLI_COLUMNS)
          : DEFAULT_CLI_COLUMNS,
      color: false,
    },
  });
  return { observe: (event) => renderer.observe(event), finish: () => renderer.finish() };
}

function cliCancellation(signal: AbortSignal | undefined): Readonly<{ signal: AbortSignal; close(): void }> {
  if (signal !== undefined) return { signal, close: () => undefined };
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

/** Bind's document admission runs before coordinate resolution so a malformed document refuses first. */
async function admitBindInput(
  command: ParsedCommand,
  invocation: ParsedCommandInvocation,
  runtime: CliRuntime,
  processCwd: string,
): Promise<void> {
  if (command.command !== "bind" || command.forkOf !== undefined) return;
  await admitBindMarkdown({
    markdown: await runtime.readStdin(),
    processCwd,
    ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
  });
}

async function runInstall(
  command: Extract<ParsedCommand, { command: "install" }>,
  environment: NodeJS.ProcessEnv,
): Promise<CliOutcome> {
  const result = await installHarnesses(command.harnesses, environment);
  return emit(command.output, result, () => renderInstallText(result), installOutcome(result));
}

type AkumaFailureProjection = Readonly<{ body: string; outcome: CliOutcome }>;

/** Projection of one native Akuma addressing/observation failure into its stated refusal body. */
export async function akumaFailureProjection(
  error: unknown,
  command: ParsedCommand,
): Promise<AkumaFailureProjection | undefined> {
  if (error instanceof AkumaNotBornError) {
    return {
      body:
        command.output === "json"
          ? error.message
          : renderStructuredRefusal(
              command.command,
              "Akuma not found",
              [`id  ${safeText(error.id)}`],
              usageGuideForCommand(command),
            ),
      outcome: "refused",
    };
  }
  if (error instanceof AkumaAddressError) {
    const body =
      error.refusal.kind === "akuma-alias-not-found"
        ? renderStructuredRefusal(
            command.command,
            "Akuma alias not found",
            [`alias  ${safeText(error.refusal.alias)}`],
            usageGuideForCommand(command),
          )
        : renderStructuredRefusal(
            command.command,
            "invalid Akuma address",
            [`selector  ${safeText(error.refusal.selector)}`],
            usageGuideForCommand(command),
          );
    return { body: command.output === "json" ? error.message : body, outcome: "refused" };
  }
  if (error instanceof AkumaWorldScopeError) {
    return {
      body:
        command.output === "json"
          ? JSON.stringify(error.refusal)
          : renderStructuredRefusal(
              command.command,
              "Akuma not in this World",
              [
                `ids  ${error.refusal.ids.map((id) => safeText(id)).join(" · ")}`,
                `world  ${safeText(error.refusal.world)}`,
              ],
              usageGuideForCommand(command),
            ),
      outcome: "refused",
    };
  }
  if (error instanceof AkumaObservationError) {
    return {
      body:
        command.output === "json"
          ? error.message
          : `× Akuma observation failed  ${safeText(error.id)} — ${safeText(error.diagnostic)}`,
      outcome: "failed",
    };
  }
  return undefined;
}

function writeBindDraftFailure(error: BindDraftError, command: ParsedCommand): CliOutcome {
  const refusal = {
    kind: "invalid-document" as const,
    diagnostic: error.original instanceof Error ? error.original.message : String(error.original),
  };
  if (command.output === "json") writeJson({ kind: "refused", operation: "bind", refusal, draft: error.draft });
  else writeStdout(renderRefusal({ operation: "bind", refusal }, error.draft, displayContext()));
  return error.original instanceof CliUsageError ? "usage" : "refused";
}

async function writeFailure(error: unknown, command: ParsedCommand): Promise<CliOutcome> {
  if (error instanceof BindDraftError) return writeBindDraftFailure(error, command);
  if (error instanceof KeiyakuError) {
    const diagnostic = error.message;
    if (command.output === "json") writeJson(encodeFailureWire(error));
    else if (error.outcome !== undefined) {
      writeStdout(
        executionFailureLines(error.outcome, error.category, diagnostic, displayContext().columns).join("\n"),
      );
    } else writeStderr(`× ${command.command} failed\n  reason  ${safeText(diagnostic)}`);
    return "failed";
  }
  const akumaFailure = await akumaFailureProjection(error, command);
  if (akumaFailure !== undefined) {
    writeStderr(akumaFailure.body);
    return akumaFailure.outcome;
  }
  if (error instanceof AkumaArchetypeError && command.command === "call") {
    const missing = error.reason === "was not found";
    const diagnostic = missing ? "Akuma not found" : error.reason;
    return emit(
      command.output,
      {
        kind: "refused",
        diagnostic,
        archetype: error.archetype,
        searched: error.searched,
        ...(missing ? { available: "keiyaku ls aku/" } : {}),
      },
      () =>
        renderStructuredRefusal(
          "call",
          `${diagnostic} · ${error.archetype}`,
          [...error.searched.map((path) => `searched  ${path}`), ...(missing ? ["available  keiyaku ls aku/"] : [])],
          usageGuideForCommand(command),
        ),
      "refused",
    );
  }
  if (command.output === "json") writeJson(encodeFailureWire(error));
  else {
    const diagnostic = error instanceof Error ? error.message : String(error);
    writeStderr(
      error instanceof CliUsageError ? diagnostic : `× ${command.command} failed\n  reason  ${safeText(diagnostic)}`,
    );
  }
  return error instanceof CliUsageError ? "usage" : "failed";
}

function executionForCommand(
  command: ParsedCommand,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<LibraryExecution> {
  return command.command === "whoami"
    ? Promise.resolve(localExecutionContext())
    : executionForEnvironment(environment, signal);
}

export async function runCliCommand(invocation: ParsedCommandInvocation, input: CliRuntimeInput = {}): Promise<number> {
  return cliExitCode(await runCommand(invocation, input));
}

async function runCommand(invocation: ParsedCommandInvocation, input: CliRuntimeInput): Promise<CliOutcome> {
  const command = invocation.command;
  assertExplicitRepoUse(command, invocation.repo);
  const environment = input.environment ?? process.env;
  const home = homeFromEnvironment(environment);
  const cancellation = cliCancellation(input.signal);
  let progress: Promise<ExecutionProgressDriver> | undefined;
  try {
    const runtime: CliRuntime = {
      environment,
      execution: await executionForCommand(command, environment, cancellation.signal),
      ...(home === undefined ? {} : { home }),
      readStdin: memoized(input.readStdin ?? processStdin),
      signal: cancellation.signal,
      progress: () => (progress ??= writeExecutionProgress()),
      ...(input.actor === undefined ? {} : { actor: input.actor }),
    };
    if (command.command === "install") return await runInstall(command, environment);
    await admitBindInput(command, invocation, runtime, input.cwd ?? process.cwd());
    const coordinates = await resolveInvocationCoordinates(
      {
        processCwd: input.cwd ?? process.cwd(),
        ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
        ...(invocation.repo === undefined ? {} : { repo: invocation.repo }),
        ...(invocation.workdir === undefined ? {} : { workdir: invocation.workdir }),
        command,
      },
      environment,
    );
    if (command.command === "whoami") return await runWhoami(command, coordinates, environment, cancellation.signal);
    if (command.command === "debt") return await runDebtCommand(command, coordinates, runtime);
    if (isParsedAkumaCommand(command)) return await runAkumaCommand(command, coordinates, invocation.workdir, runtime);
    if (command.command === "history" && "contract" in command)
      return await runContractHistoryCommand(command, coordinates);
    return await runContractCommand(command, coordinates, runtime);
  } catch (error) {
    if (error instanceof CliUsageError && error.guide === undefined) {
      throw new CliUsageError(error.diagnostic, usageGuideForCommand(command));
    }
    return await writeFailure(error, command);
  } finally {
    cancellation.close();
  }
}
