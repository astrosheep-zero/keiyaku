import { resolve } from "node:path";
import { AkumaNotBornError, AkumaObservationError } from "../akuma/akuma-errors.js";
import { AkumaArchetypeError, Keiyaku, KeiyakuUsageError } from "../index.js";
import { AkumaAddressError, AkumaWorldScopeError } from "../library/address.js";
import { projectFailure, KeiyakuError } from "../library/outcome.js";
import { classifyVerb, type VerbInput, type VerbName } from "../library/keiyaku-verbs.js";
import type { ExecutionObserver } from "../protocol/execution-observation.js";
import { isParsedAkumaCommand, runAkumaCommand } from "./commands/akuma.js";
import { admitBindMarkdown, runContractCommand, runContractHistoryCommand } from "./commands/contract.js";
import { installOutcome, installHarnesses, renderInstallText } from "./commands/install.js";
import { runDebtCommand } from "./commands/debt.js";
import { runReport } from "./commands/report.js";
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
import { renderVerb } from "./render/verbs.js";
import { renderRefusal } from "./render/refusal.js";
import { DEFAULT_CLI_COLUMNS, safeText } from "./render/terminal.js";
import { cliExitCode, displayContext, emit, writeJson, writeStderr, writeStdout, type CliOutcome } from "./streams.js";
import { usageAcceptanceLines } from "./usage.js";

export type ParsedCommandInvocation = Extract<ParsedInvocation, { command: ParsedCommand }>;

type ExecutionProgressDriver = Readonly<{ observe: ExecutionObserver; finish: () => Promise<void> }>;

/** Everything one invocation's leaves need at the process edge; Product JSON never sees this. */
export type CliRuntime = Readonly<{
  environment: NodeJS.ProcessEnv;
  facet: Keiyaku;
  readStdin: () => Promise<string>;
  draftWorld: () => Promise<string>;
  signal: AbortSignal;
  progress: () => Promise<ExecutionProgressDriver>;
}>;

export type CliRuntimeInput = Readonly<{
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  readStdin?: () => Promise<string>;
  signal?: AbortSignal;
}>;

async function processStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
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

type FacetCommand = Exclude<ParsedCommand, { command: "install" }>;

// A thrown completion does not consult input; acquisition may have failed before
// there was a wire input. The name still selects operation-specific judgment.
function thrownCompletion(error: unknown, command: FacetCommand) {
  const name = (
    command.command === "debt"
      ? command.action === "ls"
        ? "ls"
        : command.action === "add" && command.stdin === "document"
          ? "debt.addDocument"
          : `debt.${command.action}`
      : command.command === "deliver" && command.dryRun
        ? "deliver.preview"
        : command.command
  ) as VerbName;
  const input = undefined as unknown as VerbInput<VerbName>;
  const completion = { kind: "threw", error } as const;
  return {
    outcome: classifyVerb(name, input, completion),
    text: () => renderVerb(name, input, completion, displayContext()),
  };
}

/** Install is a CLI-only operation, not a facet verb. */
function writeInstallFailure(error: unknown, command: Extract<ParsedCommand, { command: "install" }>): CliOutcome {
  if (command.output === "json") writeJson(projectFailure(error));
  else writeStderr(`× install failed\n  reason  ${safeText(error instanceof Error ? error.message : String(error))}`);
  return "failed";
}

function writeBindDraftFailure(error: BindDraftError, command: ParsedCommand): CliOutcome {
  const refusal = {
    kind: "invalid-document" as const,
    diagnostic: error.original instanceof Error ? error.original.message : String(error.original),
  };
  if (command.output === "json") writeJson({ kind: "refused", reason: refusal, draft: error.draft });
  else writeStdout(renderRefusal({ operation: "bind", refusal }, error.draft, displayContext()));
  return error.original instanceof CliUsageError ? "usage" : "refused";
}

function writeAkumaFailure(
  error: AkumaNotBornError | AkumaAddressError | AkumaWorldScopeError | AkumaObservationError,
  command: FacetCommand,
  shared: ReturnType<typeof thrownCompletion>,
): CliOutcome {
  if (command.output === "json")
    writeStderr(error instanceof AkumaWorldScopeError ? JSON.stringify(error.refusal) : error.message);
  else {
    const guide = error instanceof AkumaObservationError ? [] : usageAcceptanceLines(usageGuideForCommand(command));
    writeStderr([shared.text(), ...guide].join("\n"));
  }
  return shared.outcome;
}

function writeArchetypeFailure(
  error: AkumaArchetypeError,
  command: FacetCommand,
  shared: ReturnType<typeof thrownCompletion>,
): CliOutcome {
  const missing = error.reason === "was not found";
  if (command.output === "json") {
    writeJson({
      kind: "refused",
      diagnostic: missing ? "Akuma not found" : error.reason,
      akumaName: error.akumaName,
      searched: error.searched,
      ...(missing ? { available: "keiyaku ls aku/" } : {}),
    });
  } else writeStdout([shared.text(), ...usageAcceptanceLines(usageGuideForCommand(command))].join("\n"));
  return shared.outcome;
}

async function writeFailure(error: unknown, command: ParsedCommand): Promise<CliOutcome> {
  if (error instanceof BindDraftError) return writeBindDraftFailure(error, command);
  if (error instanceof CliUsageError) {
    if (command.output === "json") writeJson(projectFailure(error));
    else writeStderr(error.message);
    return "usage";
  }
  if (command.command === "install") return writeInstallFailure(error, command);
  const shared = thrownCompletion(error, command);
  if (
    error instanceof AkumaNotBornError ||
    error instanceof AkumaAddressError ||
    error instanceof AkumaWorldScopeError ||
    error instanceof AkumaObservationError
  )
    return writeAkumaFailure(error, command, shared);
  if (error instanceof AkumaArchetypeError && command.command === "spawn")
    return writeArchetypeFailure(error, command, shared);
  if (command.output === "json") writeJson(projectFailure(error));
  else if (error instanceof KeiyakuError && error.outcome !== undefined) writeStdout(shared.text());
  else writeStderr(shared.text());
  return shared.outcome;
}

export async function runCliCommand(invocation: ParsedCommandInvocation, input: CliRuntimeInput = {}): Promise<number> {
  return cliExitCode(await runCommand(invocation, input));
}

function invocationCoordinates(
  invocation: ParsedCommandInvocation,
  input: CliRuntimeInput,
  environment: NodeJS.ProcessEnv,
) {
  return resolveInvocationCoordinates(
    {
      processCwd: input.cwd ?? process.cwd(),
      ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
      ...(invocation.repo === undefined ? {} : { repo: invocation.repo }),
      command: invocation.command,
    },
    environment,
  );
}

// eslint-disable-next-line complexity -- dispatch keeps acquisition, the facet, and process outcome in one edge.
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
      facet: Keiyaku.at({
        cwd: resolve(input.cwd ?? process.cwd(), invocation.cwd ?? "."),
        environment,
        ...(home === undefined ? {} : { home }),
        ...(invocation.repo === undefined ? {} : { repo: invocation.repo }),
      }),
      readStdin: memoized(input.readStdin ?? processStdin),
      draftWorld: async () => (await invocationCoordinates(invocation, input, environment)).establishWorld(),
      signal: cancellation.signal,
      progress: () => (progress ??= writeExecutionProgress()),
    };
    if (command.command === "install") {
      const result = await installHarnesses(command.harnesses, environment);
      return emit(command.output, result, () => renderInstallText(result), installOutcome(result));
    }
    if (command.command === "bind" && command.forkOf === undefined) {
      await admitBindMarkdown({
        markdown: await runtime.readStdin(),
        processCwd: input.cwd ?? process.cwd(),
        ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
      });
    }
    if (command.command === "report") return await runReport(command, runtime);
    if (command.command === "whoami") return await runWhoami(command, runtime);
    if (command.command === "history" && "contract" in command)
      return await runContractHistoryCommand(command, runtime);
    if (isParsedAkumaCommand(command)) return await runAkumaCommand(command, invocation.workdir, runtime);
    if (command.command === "debt") return await runDebtCommand(command, runtime);
    return await runContractCommand(command, runtime);
  } catch (error) {
    if (error instanceof KeiyakuUsageError) {
      const usage = new CliUsageError(error.message, usageGuideForCommand(command));
      if (command.command === "ls" && command.query.kind === "akuma" && command.query.caller?.kind === "mine")
        return await writeFailure(usage, command);
      throw usage;
    }
    if (error instanceof CliUsageError && error.guide === undefined) {
      throw new CliUsageError(error.diagnostic, usageGuideForCommand(command));
    }
    return await writeFailure(error, command);
  } finally {
    cancellation.close();
  }
}
