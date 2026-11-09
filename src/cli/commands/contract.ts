import { KeiyakuError, KeiyakuUsageError } from "../../index.js";
import { KeiyakuArcDocumentError } from "../../library/keiyaku.js";
import { classifyVerb, type VerbInput, type VerbName, type VerbOutput } from "../../library/keiyaku-verbs.js";
import { renderVerb } from "../render/verbs.js";
import type { ContractId } from "../../index.js";
import { validateContractMarkdown } from "../../library/input.js";
import { SettingsError } from "../../settings.js";
import { resolveInvocationCwd } from "../coordinates.js";
import { BindDraftError, preserveBindDraft } from "../draft.js";
import type { ContractOutcome } from "../render/contract.js";
import { renderRefusal, type RenderableRefusal } from "../render/refusal.js";
import type { CliRuntime } from "../runtime.js";
import { type CliOutcome, displayContext, emit } from "../streams.js";
import { CliUsageError, isBlankInput } from "../usage.js";
import type { ParsedContractCommand } from "./contract-grammar.js";

// ---------------------------------------------------------------------------
// Leaf dispatch: acquisition, one public SDK invocation, direct rendering
// ---------------------------------------------------------------------------

type ContractMutation = Extract<
  ParsedContractCommand,
  { command: "bind" | "amend" | "deliver" | "verify" | "review" | "arc" | "abandon" }
>;

function draftWarning(error: unknown): Readonly<{ warning: string }> {
  return { warning: `bind draft could not be preserved: ${error instanceof Error ? error.message : String(error)}` };
}

/**
 * The one bind-document admission that runs before coordinate resolution, so a malformed document
 * refuses as a draft-bearing refusal instead of a later Repo/Git failure. Reads the memoized stdin.
 */
export async function admitBindMarkdown(
  input: Readonly<{ markdown: string; processCwd?: string; cwd?: string }>,
): Promise<void> {
  if (isBlankInput(input.markdown)) throw new CliUsageError("bind requires a nonblank stdin document");
  try {
    validateContractMarkdown(input.markdown);
  } catch (error) {
    if (error instanceof Error && "executionReceipt" in error) throw error;
    if (!(error instanceof TypeError) && !(error instanceof KeiyakuError && error.category === "invalid-input"))
      throw error;
    throw new BindDraftError(error, await bindDraftReceipt(() => resolveInvocationCwd(input), input.markdown));
  }
}

async function bindDraftReceipt(world: () => Promise<string>, markdown: string) {
  try {
    return await preserveBindDraft(await world(), markdown);
  } catch (error) {
    if (error instanceof Error && "executionReceipt" in error) throw error;
    return draftWarning(error);
  }
}

function refusedInvocation(
  answer: Extract<ContractOutcome, { kind: "refused" }>,
): Readonly<{ operation: string; contract?: ContractId; refusal: RenderableRefusal }> {
  return {
    operation: answer.operation,
    ...(answer.contract === undefined ? {} : { contract: answer.contract }),
    refusal: answer.refusal,
  };
}

function finishVerb<K extends VerbName>(
  name: K,
  input: VerbInput<K>,
  value: VerbOutput<K>,
  output: "text" | "json",
  json: unknown = value,
): CliOutcome {
  const completion = { kind: "returned" as const, value };
  return emit(
    output,
    json,
    () => renderVerb(name, input, completion, displayContext()),
    classifyVerb(name, input, completion),
  );
}

async function runBind(
  command: Extract<ContractMutation, { command: "bind" }>,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  if (command.forkOf !== undefined) {
    const input = {
      forkOf: command.forkOf,
      ...(command.target === undefined ? {} : { target: command.target }),
      ...(command.actor === undefined ? {} : { actor: command.actor }),
    };
    const answer = await runtime.facet.run("bind", input);
    return finishVerb("bind", input, answer, command.output);
  }
  const markdown = await runtime.readStdin();
  try {
    const input = {
      markdown,
      ...(command.debt === undefined ? {} : { debt: command.debt as `debt/${string}` }),
      ...(command.target === undefined ? {} : { target: command.target }),
      ...(command.actor === undefined ? {} : { actor: command.actor }),
      ...(command.after === undefined ? {} : { after: command.after }),
      ...(command.gates === undefined ? {} : { gates: command.gates }),
    };
    const answer = await runtime.facet.run("bind", input);
    if (answer.kind !== "refused") return finishVerb("bind", input, answer, command.output);
    const draft = await bindDraftReceipt(runtime.draftWorld, markdown);
    const text = () => renderRefusal(refusedInvocation(answer), draft, displayContext());
    return emit(command.output, answer, text, classifyVerb("bind", input, { kind: "returned", value: answer }));
  } catch (error) {
    if (error instanceof Error && "executionReceipt" in error) throw error;
    if (error instanceof KeiyakuUsageError) throw error;
    // A selected Settings namespace failure is the Contract owner's invalid input, not a bad draft.
    if (error instanceof KeiyakuError && error.category === "invalid-input" && error.cause instanceof SettingsError)
      throw error;
    if (!(error instanceof TypeError) && !(error instanceof KeiyakuError && error.category === "invalid-input"))
      throw error;
    throw new BindDraftError(error, await bindDraftReceipt(runtime.draftWorld, markdown));
  }
}

async function runAmend(
  command: Extract<ContractMutation, { command: "amend" }>,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  const markdown = command.stdin === true ? await runtime.readStdin() : undefined;
  if (markdown !== undefined && isBlankInput(markdown))
    throw new CliUsageError("amend requires a nonblank stdin document");
  const after = command.clearAfter === true ? [] : command.after;
  const input = {
    ...(command.contract === undefined ? {} : { contract: command.contract }),
    ...(markdown === undefined ? {} : { markdown }),
    ...(command.actor === undefined ? {} : { actor: command.actor }),
    ...(after === undefined ? {} : { after }),
    ...(command.gates === undefined ? {} : { gates: command.gates }),
  };
  const answer = await runtime.facet.run("amend", input);
  return finishVerb("amend", input, answer, command.output);
}

async function runDeliver(
  command: Extract<ContractMutation, { command: "deliver" }>,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  const driver = command.output === "text" ? await runtime.progress() : undefined;
  const run = { signal: runtime.signal, ...(driver === undefined ? {} : { observe: driver.observe }) };
  const withProgress = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } finally {
      if (driver !== undefined) await driver.finish().catch(() => undefined);
    }
  };
  if (command.dryRun) {
    const input = {
      ...(command.contract === undefined ? {} : { contract: command.contract }),
      includeDirty: command.includeDirty,
      showDiff: command.showDiff,
    };
    const answer = await withProgress(() => runtime.facet.run("deliver.preview", input, run));
    return finishVerb("deliver.preview", input, answer, command.output);
  }
  const input = {
    ...(command.contract === undefined ? {} : { contract: command.contract }),
    ...(command.message === undefined ? {} : { message: command.message }),
    includeDirty: command.includeDirty,
    materializeConflict: command.materializeConflict,
    overwrite: command.overwrite,
  };
  const answer = await withProgress(() => runtime.facet.run("deliver", input, run));
  return finishVerb("deliver", input, answer, command.output);
}

async function runVerify(
  command: Extract<ContractMutation, { command: "verify" }>,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  const driver = command.output === "text" ? await runtime.progress() : undefined;
  const input = {
    ...(command.contract === undefined ? {} : { contract: command.contract }),
    ...(command.index === undefined ? {} : { index: command.index }),
    includeDirty: command.includeDirty,
  };
  let answer: VerbOutput<"verify">;
  try {
    answer = await runtime.facet.run("verify", input, {
      signal: runtime.signal,
      ...(driver === undefined ? {} : { observe: driver.observe }),
    });
  } finally {
    if (driver !== undefined) await driver.finish().catch(() => undefined);
  }
  return finishVerb("verify", input, answer, command.output);
}

async function runReview(
  command: Extract<ContractMutation, { command: "review" }>,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  const summary = command.summaryFromStdin === true ? await runtime.readStdin() : command.summary;
  if (summary === undefined || isBlankInput(summary)) throw new CliUsageError("review requires a nonblank summary");
  const driver = command.output === "text" ? await runtime.progress() : undefined;
  const input = {
    ...(command.contract === undefined ? {} : { contract: command.contract }),
    verdict: command.verdict,
    summary,
    ...(command.actor === undefined ? {} : { actor: command.actor }),
  };
  let answer: VerbOutput<"review">;
  try {
    answer = await runtime.facet.run("review", input, {
      signal: runtime.signal,
      ...(driver === undefined ? {} : { observe: driver.observe }),
    });
  } finally {
    if (driver !== undefined) await driver.finish().catch(() => undefined);
  }
  return finishVerb("review", input, answer, command.output);
}

async function runArc(
  command: Extract<ContractMutation, { command: "arc" }>,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  const markdown = await runtime.readStdin();
  const input = {
    ...(command.contract === undefined ? {} : { contract: command.contract }),
    markdown,
    ...(command.actor === undefined ? {} : { actor: command.actor }),
  };
  try {
    const answer = await runtime.facet.run("arc", input);
    return finishVerb("arc", input, answer, command.output);
  } catch (error) {
    if (!(error instanceof KeiyakuArcDocumentError)) throw error;
    const completion = { kind: "threw" as const, error };
    const refusal: RenderableRefusal = { kind: "invalid-document", diagnostic: error.message };
    const refused = { kind: "refused", operation: "arc", contract: error.contract, refusal };
    return emit(
      command.output,
      refused,
      () => renderVerb("arc", input, completion, displayContext()),
      classifyVerb("arc", input, completion),
    );
  }
}

async function runAbandon(
  command: Extract<ContractMutation, { command: "abandon" }>,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  const input = {
    ...(command.contract === undefined ? {} : { contract: command.contract }),
    ...(command.actor === undefined ? {} : { actor: command.actor }),
    ...(command.note === undefined ? {} : { note: command.note }),
  };
  const answer = await runtime.facet.run("abandon", input);
  return finishVerb("abandon", input, answer, command.output);
}

export async function runContractMutation(command: ContractMutation, runtime: CliRuntime): Promise<CliOutcome> {
  switch (command.command) {
    case "deliver":
      return await runDeliver(command, runtime);
    case "verify":
      return await runVerify(command, runtime);
    case "review":
      return await runReview(command, runtime);
    case "abandon":
      return await runAbandon(command, runtime);
    case "bind":
      return await runBind(command, runtime);
    case "amend":
      return await runAmend(command, runtime);
    case "arc":
      return await runArc(command, runtime);
  }
}

function statusRefusal(
  operation: string,
  contract: ContractId,
): Readonly<{
  operation: string;
  contract: ContractId;
  refusal: RenderableRefusal;
}> {
  return { operation, contract, refusal: { kind: "contract-missing", contractId: contract } };
}

async function runSettings(runtime: CliRuntime, output: "text" | "json"): Promise<CliOutcome> {
  const input = {};
  const value = await runtime.facet.run("settings", input);
  return finishVerb("settings", input, value, output);
}

async function runNuke(
  command: Extract<ParsedContractCommand, { command: "nuke" }>,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  const input = { ...(command.confirm === undefined ? {} : { confirm: command.confirm }) };
  const result = await runtime.facet.run("nuke", input);
  return finishVerb("nuke", input, result, command.output);
}

async function runLs(
  command: Extract<ParsedContractCommand, { command: "ls" }>,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  const query = command.query;
  if (query.kind === "contracts") {
    const input = { of: "kei" as const, ...(query.limit === undefined ? {} : { limit: query.limit }) };
    const list = await runtime.facet.run("ls", input);
    return finishVerb("ls", input, list, command.output);
  }
  if (query.kind === "archetypes") {
    const input = { of: "akuma-name" as const, ...(query.limit === undefined ? {} : { limit: query.limit }) };
    const list = await runtime.facet.run("ls", input);
    return finishVerb("ls", input, list, command.output);
  }
  if (query.kind === "debts") {
    const input = {
      of: "debt" as const,
      namespace: query.namespace ?? [],
      ...(query.selection === undefined ? {} : { selection: query.selection }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    };
    const listed = await runtime.facet.run("ls", input);
    return finishVerb("ls", input, listed, command.output);
  }
  const input = {
    of: "aku" as const,
    ...(query.akumaName === undefined ? {} : { akumaName: query.akumaName }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
    ...(query.caller === undefined ? {} : { caller: query.caller }),
  };
  const listed = await runtime.facet.run("ls", input);
  return finishVerb("ls", input, listed, command.output);
}

async function runShow(
  command: Extract<ParsedContractCommand, { command: "show" }>,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  const input = command.contract === undefined ? {} : { contract: command.contract };
  const guidance = await runtime.facet.run("show", input);
  return finishVerb("show", input, guidance, command.output);
}

async function runStatus(
  command: Extract<ParsedContractCommand, { command: "status" }>,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  const input =
    command.category !== undefined
      ? { category: command.category, ...(command.limit === undefined ? {} : { limit: command.limit }) }
      : "selectors" in command && command.selectors !== undefined
        ? { selectors: command.selectors }
        : command.contract === undefined
          ? {}
          : { selector: command.contract };
  const value = await runtime.facet.run("status", input);
  const completion = { kind: "returned" as const, value };
  const outcome = classifyVerb("status", input, completion);
  const json =
    outcome === "refused" && "selector" in input && input.selector !== undefined
      ? statusRefusal("status", input.selector as ContractId).refusal
      : value;
  return emit(command.output, json, () => renderVerb("status", input, completion, displayContext()), outcome);
}

async function runRegion(
  command: Extract<ParsedContractCommand, { command: "region" }>,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  const input =
    command.paths !== undefined
      ? { paths: command.paths }
      : command.contract !== undefined
        ? { contract: command.contract }
        : {};
  const result = await runtime.facet.run("region", input);
  const json =
    result.kind === "missing" || "row" in result
      ? {
          kind: result.kind === "missing" ? "contract-missing" : "terminal",
          contractId: result.kind === "missing" ? result.id : result.row.id,
        }
      : result;
  return finishVerb("region", input, result, command.output, json);
}

type ParsedContractHistory = Readonly<{
  command: "history";
  contract: string;
  full: boolean;
  output: "text" | "json";
}>;

export async function runContractHistoryCommand(
  command: ParsedContractHistory,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  const input = { selector: command.contract, full: command.full };
  const history = await runtime.facet.run("history", input);
  const json = history === null ? { kind: "contract-missing", contractId: command.contract as ContractId } : history;
  return finishVerb("history", input, history, command.output, json);
}

async function runReconcile(
  command: Extract<ParsedContractCommand, { command: "reconcile" }>,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  const input = {
    ...(command.contract === undefined ? {} : { contract: command.contract }),
    retryHooks: command.retryHooks,
  };
  const report = await runtime.facet.run("reconcile", input);
  const json = "kind" in report && report.kind === "missing" ? statusRefusal("reconcile", report.id).refusal : report;
  return finishVerb("reconcile", input, report, command.output, json);
}

export async function runContractCommand(command: ParsedContractCommand, runtime: CliRuntime): Promise<CliOutcome> {
  switch (command.command) {
    case "settings":
      return await runSettings(runtime, command.output);
    case "nuke":
      return await runNuke(command, runtime);
    case "ls":
      return await runLs(command, runtime);
    case "show":
      return await runShow(command, runtime);
    case "status":
      return await runStatus(command, runtime);
    case "region":
      return await runRegion(command, runtime);
    case "reconcile":
      return await runReconcile(command, runtime);
    default:
      return await runContractMutation(command, runtime);
  }
}
