import { KeiyakuError, KeiyakuUsageError } from "../../index.js";
import { KeiyakuArcDocumentError } from "../../library/keiyaku.js";
import type {
  AkumaObservation,
  DeliveryPreviewOutcome,
  ContractHistory,
  ContractId,
  DeliverOutcome,
  ReviewOutcome,
  VerifyOutcome,
} from "../../index.js";
import type { KanshiReport } from "../../kanshi/index.js";
import { validateContractMarkdown } from "../../library/input.js";
import { SettingsError } from "../../settings.js";
import { resolveInvocationCwd } from "../coordinates.js";
import { BindDraftError, preserveBindDraft } from "../draft.js";
import { snapshotText } from "../render/akuma-activity.js";
import { renderAkumaCatalogue, renderArchetypeCatalogue, renderContractCatalogue } from "../render/catalog.js";
import { renderAccepted, renderContractHistory, renderRetry, type ContractOutcome } from "../render/contract.js";
import { renderKanshiCategoryText, renderKanshiText } from "../render/kanshi.js";
import { nukeOutcome, renderNukeText } from "../render/nuke.js";
import { reconcileHasFailure, renderReconcile } from "../render/reconcile.js";
import { renderConflictMaterialized, renderRefusal, type RenderableRefusal } from "../render/refusal.js";
import { renderRegionText } from "../render/region.js";
import { renderSettingsText, settingsJsonValue } from "../render/settings.js";
import type { TextRenderContext } from "../render/terminal.js";
import type { CliRuntime } from "../runtime.js";
import { type CliOutcome, displayContext, emit, writeJson, writeStdout } from "../streams.js";
import { debtOutcome, renderDebtList } from "../render/debt.js";
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
  project?: (refusal: RenderableRefusal) => RenderableRefusal,
): Readonly<{ operation: string; contract?: ContractId; refusal: RenderableRefusal }> {
  const refusal: RenderableRefusal = project === undefined ? answer.refusal : project(answer.refusal);
  return {
    operation: answer.operation,
    ...(answer.contract === undefined ? {} : { contract: answer.contract }),
    refusal,
  };
}

/** The CLI's own presentation of a refused dirty delivery: the available opt-in is not SDK evidence. */
function deliverRefusalProjection(refusal: RenderableRefusal): RenderableRefusal {
  if (refusal.kind !== "dirty-workspace") return refusal;
  const submodules = "submodules" in refusal && Array.isArray(refusal.submodules) ? refusal.submodules : [];
  return { ...refusal, option: { flag: "--include-dirty", available: submodules.length === 0 } };
}

function renderContractAnswer(
  answer: ContractOutcome,
  project: ((refusal: RenderableRefusal) => RenderableRefusal) | undefined,
  context: TextRenderContext,
): string {
  switch (answer.kind) {
    case "handoff":
      return renderConflictMaterialized(answer.value, context);
    case "refused":
      return renderRefusal(refusedInvocation(answer, project), undefined, context);
    case "retry":
      return renderRetry(answer, context);
    case "accepted":
      return renderAccepted(answer, context);
  }
}

async function finishContractAnswer(
  answer: ContractOutcome,
  output: "text" | "json",
  project?: (refusal: RenderableRefusal) => RenderableRefusal,
): Promise<CliOutcome> {
  const outcome = answer.kind === "refused" ? "refused" : answer.kind === "retry" ? "retryable" : "accepted";
  return emit(output, answer, () => renderContractAnswer(answer, project, displayContext()), outcome);
}

async function runBind(
  command: Extract<ContractMutation, { command: "bind" }>,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  if (command.forkOf !== undefined) {
    const answer = await runtime.facet.bind({
      forkOf: command.forkOf,
      ...(command.target === undefined ? {} : { target: command.target }),
      ...(command.actor === undefined ? {} : { actor: command.actor }),
    });
    return await finishContractAnswer(answer, command.output);
  }
  const markdown = await runtime.readStdin();
  try {
    const answer = await runtime.facet.bind({
      markdown,
      ...(command.debt === undefined ? {} : { debt: command.debt as `debt/${string}` }),
      ...(command.target === undefined ? {} : { target: command.target }),
      ...(command.actor === undefined ? {} : { actor: command.actor }),
      ...(command.after === undefined ? {} : { after: command.after }),
      ...(command.gates === undefined ? {} : { gates: command.gates }),
    });
    if (answer.kind !== "refused") return await finishContractAnswer(answer, command.output);
    const draft = await bindDraftReceipt(runtime.draftWorld, markdown);
    const text = () => renderRefusal(refusedInvocation(answer), draft, displayContext());
    return emit(command.output, answer, text, "refused");
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
  const answer = await runtime.facet.amend({
    ...(command.contract === undefined ? {} : { contract: command.contract }),
    ...(markdown === undefined ? {} : { markdown }),
    ...(command.actor === undefined ? {} : { actor: command.actor }),
    ...(after === undefined ? {} : { after }),
    ...(command.gates === undefined ? {} : { gates: command.gates }),
  });
  return await finishContractAnswer(answer, command.output);
}

async function runDeliver(
  command: Extract<ContractMutation, { command: "deliver" }>,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  const driver = command.output === "text" ? await runtime.progress() : undefined;
  let answer: DeliverOutcome | DeliveryPreviewOutcome;
  try {
    const progress = { ...(driver === undefined ? {} : { observe: driver.observe }) };
    const signal = { ...(runtime.signal === undefined ? {} : { signal: runtime.signal }) };
    answer = command.dryRun
      ? await runtime.facet.previewDelivery(
          {
            ...(command.contract === undefined ? {} : { contract: command.contract }),
            includeDirty: command.includeDirty,
            showDiff: command.showDiff,
            ...signal,
          },
          progress,
        )
      : await runtime.facet.deliver(
          {
            ...(command.contract === undefined ? {} : { contract: command.contract }),
            ...(command.message === undefined ? {} : { message: command.message }),
            includeDirty: command.includeDirty,
            materializeConflict: command.materializeConflict,
            overwrite: command.overwrite,
            ...signal,
          },
          progress,
        );
  } finally {
    if (driver !== undefined) await driver.finish().catch(() => undefined);
  }
  return await finishContractAnswer(answer, command.output, deliverRefusalProjection);
}

async function runVerify(
  command: Extract<ContractMutation, { command: "verify" }>,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  const driver = command.output === "text" ? await runtime.progress() : undefined;
  let answer: VerifyOutcome;
  try {
    answer = await runtime.facet.verify(
      {
        ...(command.contract === undefined ? {} : { contract: command.contract }),
        ...(command.index === undefined ? {} : { index: command.index }),
        includeDirty: command.includeDirty,
        ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
      },
      { ...(driver === undefined ? {} : { observe: driver.observe }) },
    );
  } finally {
    if (driver !== undefined) await driver.finish().catch(() => undefined);
  }
  return await finishContractAnswer(answer, command.output, deliverRefusalProjection);
}

async function runReview(
  command: Extract<ContractMutation, { command: "review" }>,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  const summary = command.summaryFromStdin === true ? await runtime.readStdin() : command.summary;
  if (command.summaryFromStdin === true && isBlankInput(summary ?? ""))
    throw new CliUsageError("review requires a nonblank summary");
  const driver = command.output === "text" ? await runtime.progress() : undefined;
  let answer: ReviewOutcome;
  try {
    answer = await runtime.facet.review(
      {
        ...(command.contract === undefined ? {} : { contract: command.contract }),
        verdict: command.verdict,
        ...(summary === undefined ? {} : { summary }),
        ...(command.actor === undefined ? {} : { actor: command.actor }),
        ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
      },
      { ...(driver === undefined ? {} : { observe: driver.observe }) },
    );
  } finally {
    if (driver !== undefined) await driver.finish().catch(() => undefined);
  }
  return await finishContractAnswer(answer, command.output);
}

async function runArc(
  command: Extract<ContractMutation, { command: "arc" }>,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  const markdown = await runtime.readStdin();
  try {
    const answer = await runtime.facet.arc({
      ...(command.contract === undefined ? {} : { contract: command.contract }),
      markdown,
      ...(command.actor === undefined ? {} : { actor: command.actor }),
    });
    return await finishContractAnswer(answer, command.output);
  } catch (error) {
    if (!(error instanceof KeiyakuArcDocumentError)) throw error;
    const refusal: RenderableRefusal = { kind: "invalid-document", diagnostic: error.message };
    const refused = { kind: "refused", operation: "arc", contract: error.contract, refusal };
    return emit(command.output, refused, () => renderRefusal(refused, undefined, displayContext()), "refused");
  }
}

async function runAbandon(
  command: Extract<ContractMutation, { command: "abandon" }>,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  const answer = await runtime.facet.abandon({
    ...(command.contract === undefined ? {} : { contract: command.contract }),
    ...(command.actor === undefined ? {} : { actor: command.actor }),
    ...(command.note === undefined ? {} : { note: command.note }),
  });
  return await finishContractAnswer(answer, command.output);
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
  const value = await runtime.facet.settings();
  return emit(output, settingsJsonValue(value), () => renderSettingsText(value, displayContext().columns), "accepted");
}

async function runNuke(
  command: Extract<ParsedContractCommand, { command: "nuke" }>,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  const result = await runtime.facet.nuke({
    ...(command.confirm === undefined ? {} : { confirm: command.confirm }),
  });
  return emit(command.output, result, () => renderNukeText(result), nukeOutcome(result));
}

async function runLs(
  command: Extract<ParsedContractCommand, { command: "ls" }>,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  const query = command.query;
  if (query.kind === "contracts") {
    const list = await runtime.facet.ls({
      of: "kei",
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
    return emit(command.output, list, () => renderContractCatalogue(list), "accepted");
  }
  if (query.kind === "archetypes") {
    const list = await runtime.facet.ls({
      of: "akuma-name",
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
    return emit(command.output, list, () => renderArchetypeCatalogue(list), "accepted");
  }
  if (query.kind === "debts") {
    const listed = await runtime.facet.ls({
      of: "debt",
      namespace: query.namespace ?? [],
      ...(query.selection === undefined ? {} : { selection: query.selection }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
    return emit(
      command.output,
      listed,
      () =>
        renderDebtList(
          "ls",
          { namespace: query.namespace?.length ? `debt/${query.namespace.join("/")}/` : "debt/" },
          listed,
          displayContext(),
        ),
      debtOutcome(listed),
    );
  }
  const caller = await runtime.facet.resolveLsCaller(query.caller);
  const listed = await runtime.facet.ls({
    of: "aku",
    ...(query.akumaName === undefined ? {} : { akumaName: query.akumaName }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
    ...(caller === undefined ? {} : { caller }),
  });
  return emit(command.output, listed, () => renderAkumaCatalogue(listed, query.akumaName ?? null, caller), "accepted");
}

function renderStatusObservation(value: AkumaObservation | KanshiReport, selector?: string): string {
  if ("status" in value) {
    const alias = selector?.startsWith("@") === true ? selector : undefined;
    return snapshotText(value, displayContext(), ...(alias === undefined ? [{}] : [{ alias }]));
  }
  return renderKanshiText(value, displayContext(), selector === undefined ? "world" : "contract");
}

async function runShow(
  command: Extract<ParsedContractCommand, { command: "show" }>,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  const guidance = await runtime.facet.show(command.contract === undefined ? {} : { contract: command.contract });
  if (guidance === null) {
    const refusal = statusRefusal(command.command, command.contract as ContractId);
    return emit(command.output, null, () => renderRefusal(refusal, undefined, displayContext()), "refused");
  }
  return emit(command.output, guidance, () => guidance, "accepted");
}

async function runStatus(
  command: Extract<ParsedContractCommand, { command: "status" }>,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  if (command.category !== undefined) {
    const report = await runtime.facet.status({
      category: command.category,
      ...(command.limit === undefined ? {} : { limit: command.limit }),
    });
    if (!("category" in report)) throw new Error("status did not return a category observation");
    return emit(command.output, report, () => renderKanshiCategoryText(report, displayContext()), "accepted");
  }
  if ("selectors" in command && command.selectors !== undefined) {
    const selectors = command.selectors;
    const values = await runtime.facet.status({ selectors });
    if (!Array.isArray(values)) throw new Error("status did not return a selection observation");
    return emit(
      command.output,
      values,
      () => values.map((value, index) => renderStatusObservation(value, selectors[index])).join("\n\n"),
      "accepted",
    );
  }
  const selector = command.contract;
  const value = await runtime.facet.status(selector === undefined ? {} : { selector });
  if (Array.isArray(value) || "category" in value) throw new Error("status did not return an identity observation");
  const observation = value as AkumaObservation | KanshiReport;
  if (
    selector?.startsWith("kei/") === true &&
    "contracts" in observation &&
    observation.contracts.kind === "present" &&
    observation.contracts.value.rows.length === 0
  ) {
    const refusal = statusRefusal("status", selector as ContractId);
    return emit(command.output, refusal.refusal, () => renderRefusal(refusal, undefined, displayContext()), "refused");
  }
  return emit(command.output, observation, () => renderStatusObservation(observation, selector), "accepted");
}

async function runRegion(
  command: Extract<ParsedContractCommand, { command: "region" }>,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  const result = await runtime.facet.region({
    ...(command.contract === undefined ? {} : { contract: command.contract }),
    ...(command.paths === undefined ? {} : { paths: command.paths }),
  });
  if (result.kind === "missing" || "row" in result) {
    const contract = result.kind === "missing" ? result.id : result.row.id;
    const refusal: RenderableRefusal = {
      kind: result.kind === "missing" ? "contract-missing" : "terminal",
      contractId: contract,
    };
    if (command.output === "json") writeJson(refusal);
    else writeStdout(renderRefusal({ operation: "region", contract, refusal }, undefined, displayContext()));
    return "refused";
  }
  return emit(command.output, result, () => renderRegionText(result), "accepted");
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
  const history = await runtime.facet.history({ selector: command.contract });
  if (history === null) {
    const contract = command.contract as ContractId;
    const refusal: RenderableRefusal = { kind: "contract-missing", contractId: contract };
    if (command.output === "json") writeJson(refusal);
    else writeStdout(renderRefusal({ operation: "history", contract, refusal }, undefined, displayContext()));
    return "refused";
  }
  return emit(
    command.output,
    history,
    () => renderContractHistory(history as ContractHistory, { full: command.full }),
    "accepted",
  );
}

async function runReconcile(
  command: Extract<ParsedContractCommand, { command: "reconcile" }>,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  const report = await runtime.facet.reconcile({
    ...(command.contract === undefined ? {} : { contract: command.contract }),
    retryHooks: command.retryHooks,
  });
  if ("kind" in report && report.kind === "missing") {
    const refusal = statusRefusal("reconcile", report.id);
    if (command.output === "json") writeJson(refusal.refusal);
    else writeStdout(renderRefusal(refusal, undefined, displayContext()));
    return "refused";
  }
  if (command.output === "json") writeJson(report);
  else writeStdout(renderReconcile(report, displayContext()));
  return reconcileHasFailure(report) ? "failed" : "accepted";
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
