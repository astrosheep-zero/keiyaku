import { AkumaNotBornError, AkumaObservationError } from "../../akuma/akuma-errors.js";
import { AkumaArchetypeError } from "../../akuma/archetype.js";
import type { AkumaCaller } from "../../akuma/caller.js";
import type { AkumaList, ArchetypeCatalog, ContractCatalogue, ContractId, DebtCatalogue } from "../../index.js";
import { AkumaAddressError, AkumaWorldScopeError } from "../../library/address.js";
import type { VerbCompletion, VerbInput, VerbName, VerbOutput } from "../../library/keiyaku-verbs.js";
import { KeiyakuArcDocumentError, KeiyakuUsageError } from "../../library/keiyaku-coordinates.js";
import { KeiyakuError, projectFailure } from "../../library/outcome.js";
import type { KanshiCategoryReport } from "../../kanshi/report.js";
import type { StatusItem, StatusResult } from "../../library/keiyaku-status.js";
import {
  askRawAnswer,
  callRawAnswer,
  historyRawAnswer,
  historyText,
  snapshotText,
  tellText,
  waitText,
} from "./akuma-activity.js";
import { renderCallText, renderForkText, renderKillText, renderSpawnFailure, waitedTellProgress } from "./akuma.js";
import { renderAkumaCatalogue, renderArchetypeCatalogue, renderContractCatalogue } from "./catalog.js";
import {
  contractIssueLines,
  renderAccepted,
  renderContractHistory,
  renderRetry,
  type ContractOutcome,
  type ContractMutationName,
} from "./contract.js";
import { renderDeliveryPreview } from "./delivery-preview.js";
import { contractWaitText } from "./contract-wait.js";
import {
  renderDebtContext,
  renderDebtLifecycle,
  renderDebtList,
  renderDebtMutation,
  renderDebtShow,
  renderDebtTree,
  renderDebtUpdate,
  renderDoctor,
  type DebtListScope,
} from "./debt.js";
import { renderKanshiCategoryText, renderKanshiText } from "./kanshi.js";
import { renderNukeText } from "./nuke.js";
import { executionFailureLines } from "./receipt.js";
import { renderReconcile } from "./reconcile.js";
import {
  renderConflictMaterialized,
  renderRefusal,
  renderStructuredRefusal,
  type RenderableRefusal,
} from "./refusal.js";
import { renderRegionText } from "./region.js";
import { renderSettingsText } from "./settings.js";
import { safeText, type TextRenderContext } from "./terminal.js";
import { renderWhoami } from "./whoami.js";

function alias(selector: string | undefined): string | undefined {
  return selector?.startsWith("@") === true ? selector : undefined;
}

function missing(operation: string, contract: string | undefined, context: TextRenderContext): string {
  if (contract === undefined) return renderStructuredRefusal(operation, "contract missing");
  const id = contract as ContractId;
  return renderRefusal({ operation, contract: id, refusal: { kind: "contract-missing" } }, undefined, context);
}

function contractAnswer(
  name: ContractMutationName | "deliver.preview",
  input: VerbInput<ContractMutationName | "deliver.preview">,
  answer: ContractOutcome | VerbOutput<"deliver.preview">,
  context: TextRenderContext,
): string {
  switch (answer.kind) {
    case "ready":
    case "blocked":
      return renderDeliveryPreview(answer, context);
    case "handoff":
      return renderConflictMaterialized(answer, context);
    case "retry":
      return renderRetry(name, answer, context);
    case "accepted": {
      if (name === "deliver.preview") throw new Error("Delivery preview returned a mutation receipt");
      return renderAccepted(name, answer, context, {
        ...("verdict" in input ? { verdict: input.verdict } : {}),
        ...("note" in input && input.note !== undefined ? { note: input.note } : {}),
        ...("message" in input && input.message !== undefined ? { message: input.message } : {}),
      });
    }
    case "refused": {
      let refusal: RenderableRefusal = answer.reason;
      if (
        (name === "deliver" || name === "deliver.preview" || name === "verify") &&
        refusal.kind === "dirty-workspace"
      ) {
        refusal = {
          ...refusal,
          option: { flag: "--include-dirty", available: (refusal.submodules?.length ?? 0) === 0 },
        };
      }
      return renderRefusal(
        { operation: name, ...("contractId" in answer ? { contract: answer.contractId } : {}), refusal },
        undefined,
        context,
      );
    }
  }
}

function thrown(name: string, error: unknown, context: TextRenderContext, input: VerbInput<VerbName>): string {
  const failure = projectFailure(error);
  if (failure.spawn !== undefined)
    return renderSpawnFailure(
      failure.spawn,
      failure.diagnostic,
      context,
      name === "spawn" ? spawnPresentation(input as VerbInput<"spawn">) : {},
    );
  if (error instanceof KeiyakuArcDocumentError) {
    return renderRefusal(
      { operation: "arc", contract: error.contract, refusal: { kind: "invalid-document", diagnostic: error.message } },
      undefined,
      context,
    );
  }
  if (error instanceof KeiyakuError) {
    if (error.outcome === undefined) return `× ${name} failed\n  reason  ${safeText(error.message)}`;
    return [
      ...executionFailureLines(name, error.outcome, failure, context.columns),
      ...(error.outcome.kind === "contract" ? contractIssueLines(error.outcome, context.columns) : []),
    ].join("\n");
  }
  if (error instanceof AkumaNotBornError)
    return renderStructuredRefusal(name, "Akuma not found", [`id  ${safeText(error.id)}`]);
  if (error instanceof AkumaAddressError) {
    const refusal = error.refusal;
    return refusal.kind === "akuma-alias-not-found"
      ? renderStructuredRefusal(name, "Akuma alias not found", [`alias  ${safeText(refusal.alias)}`])
      : renderStructuredRefusal(name, "invalid Akuma address", [`selector  ${safeText(refusal.selector)}`]);
  }
  if (error instanceof AkumaWorldScopeError) {
    return renderStructuredRefusal(name, "Akuma not in this World", [
      `ids  ${error.refusal.ids.map(safeText).join(" · ")}`,
      `world  ${safeText(error.refusal.world)}`,
    ]);
  }
  if (error instanceof AkumaObservationError)
    return `× Akuma observation failed  ${safeText(error.id)} — ${safeText(error.diagnostic)}`;
  if (name === "spawn" && error instanceof AkumaArchetypeError) {
    const absent = error.reason === "was not found";
    return renderStructuredRefusal("spawn", `${absent ? "Akuma not found" : error.reason} · ${error.akumaName}`, [
      ...error.searched.map((path) => `searched  ${path}`),
      ...(absent ? ["available  keiyaku ls aku/"] : []),
    ]);
  }
  const diagnostic = error instanceof Error ? error.message : String(error);
  return error instanceof KeiyakuUsageError ? diagnostic : `× ${name} failed\n  reason  ${safeText(diagnostic)}`;
}

function debtScope(input: Readonly<{ scope?: "namespace" | "world"; namespace?: readonly string[] }>): DebtListScope {
  if (input.scope === "world") return "world";
  if (input.namespace === undefined) return "current";
  return { namespace: input.namespace.length === 0 ? "debt/" : `debt/${input.namespace.join("/")}/` };
}

function statusObservation(value: StatusItem, selector: string | undefined, context: TextRenderContext): string {
  if ("kind" in value && value.kind === "akuma") {
    const selectedAlias = alias(selector);
    return snapshotText(value, context, selectedAlias === undefined ? {} : { alias: selectedAlias });
  }
  if ("kind" in value && value.kind === "contract-missing") return missing("status", value.id, context);
  return renderKanshiText(value, context);
}

function renderRegion(input: VerbInput<"region">, result: VerbOutput<"region">, context: TextRenderContext): string {
  if (result.kind === "contract-missing") return missing("region", result.id, context);
  if (result.kind === "contract-terminal")
    return renderRefusal(
      { operation: "region", contract: result.id, refusal: { kind: "terminal" } },
      undefined,
      context,
    );
  return renderRegionText(result, input);
}

function renderLs(query: VerbInput<"ls">, result: VerbOutput<"ls">, context: TextRenderContext): string {
  switch (query.of) {
    case "debt":
      return renderDebtList("ls", debtScope(query), result as DebtCatalogue, context);
    case "kei":
      return renderContractCatalogue(result as ContractCatalogue);
    case "akuma-name":
      return renderArchetypeCatalogue(result as ArchetypeCatalog);
    case "aku": {
      const caller = query.caller?.kind === "external" ? (query.caller.caller as AkumaCaller) : undefined;
      return renderAkumaCatalogue(result as AkumaList, query.akumaName ?? null, caller);
    }
  }
}

function renderStatus(query: VerbInput<"status">, result: StatusResult, context: TextRenderContext): string {
  if ("items" in result)
    return result.items
      .map((item, i) => statusObservation(item, "selectors" in query ? query.selectors?.[i] : undefined, context))
      .join("\n\n");
  if ("category" in query) return renderKanshiCategoryText(result as KanshiCategoryReport, query.category, context);
  return statusObservation(result as StatusItem, "selector" in query ? query.selector : undefined, context);
}

function renderWait(input: VerbInput<"wait">, result: VerbOutput<"wait">, context: TextRenderContext): string {
  if ("contracts" in result) return contractWaitText(result);
  const selectors = input.selectors;
  const selectedAlias = selectors.length === 1 ? alias(selectors[0]) : undefined;
  return waitText(result, selectedAlias === undefined ? {} : { alias: selectedAlias }, context);
}

function renderHistory(query: VerbInput<"history">, result: VerbOutput<"history">, context: TextRenderContext): string {
  const options = query as { full?: boolean; id?: string; last?: boolean };
  if (query.selector.startsWith("kei/")) {
    if (result.kind === "contract-missing") return missing("history", query.selector, context);
    if (result.kind !== "contract") throw new Error("Contract history returned a non-Contract result");
    return renderContractHistory(result, { full: options.full === true });
  }
  if (result.kind === "contract" || result.kind === "contract-missing")
    throw new Error("Akuma history returned a non-Akuma result");
  const id = options.id;
  const last = options.last === true;
  const selectedAlias = alias(query.selector);
  return (
    historyRawAnswer(result, id) ??
    (last && result.kind === "akuma-last"
      ? result.answer
      : historyText(
          result,
          {
            ...(selectedAlias === undefined ? {} : { alias: selectedAlias }),
            ...(id === undefined ? {} : { id }),
            ...("since" in query && query.since !== undefined ? { since: query.since } : {}),
            last,
          },
          context,
        ))
  );
}

type DebtVerbName = Extract<VerbName, `debt.${string}`>;

function renderDebtVerb(
  name: DebtVerbName,
  input: VerbInput<DebtVerbName>,
  value: VerbOutput<DebtVerbName>,
  context: TextRenderContext,
): string {
  switch (name) {
    case "debt.add":
    case "debt.addDocument":
      return renderDebtMutation("add", value as VerbOutput<"debt.add">, context);
    case "debt.update": {
      const query = input as VerbInput<"debt.update">;
      return renderDebtUpdate(query.id, value as VerbOutput<"debt.update">, context);
    }
    case "debt.show": {
      const query = input as VerbInput<"debt.show">;
      return renderDebtShow("ids" in query ? query.ids : [query.id], value as VerbOutput<"debt.show">, context);
    }
    case "debt.done":
    case "debt.drop":
      return renderDebtLifecycle(
        name === "debt.done" ? "done" : "drop",
        (input as VerbInput<"debt.done">).ids,
        value as VerbOutput<"debt.done">,
        context,
      );
    case "debt.ready":
    case "debt.blocked":
    case "debt.query": {
      const action = name === "debt.ready" ? "ready" : name === "debt.blocked" ? "blocked" : "query";
      const query = input as VerbInput<"debt.ready"> | VerbInput<"debt.blocked"> | VerbInput<"debt.query">;
      return renderDebtList(
        action,
        debtScope(query),
        value as VerbOutput<"debt.ready"> | VerbOutput<"debt.blocked"> | VerbOutput<"debt.query">,
        context,
      );
    }
    case "debt.tree":
      return renderDebtTree((input as VerbInput<"debt.tree">).id, value as VerbOutput<"debt.tree">, context);
    case "debt.doctor":
      return renderDoctor(value as VerbOutput<"debt.doctor">);
    case "debt.context":
      return renderDebtContext(value as VerbOutput<"debt.context">, context);
  }
}

function renderKill(input: VerbInput<"kill">, value: VerbOutput<"kill">, context: TextRenderContext): string {
  const selectors = input.akuma;
  return renderKillText(value, selectors.length === 1 ? alias(selectors[0]) : undefined, context);
}

function renderAsk(input: VerbInput<"ask">, result: VerbOutput<"ask">, context: TextRenderContext): string {
  const selectedAlias = alias(input.akuma);
  return result.kind === "answered"
    ? (askRawAnswer(result, input.schema !== undefined) ?? "")
    : waitedTellProgress(
        result,
        { prompt: input.prompt, ...(selectedAlias === undefined ? {} : { alias: selectedAlias }) },
        context,
      );
}

function spawnPresentation(input: VerbInput<"spawn">) {
  return {
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    ...(input.workdir === undefined ? {} : { cwd: input.workdir }),
    ...(input.alias === undefined ? {} : { alias: input.alias }),
    ...(input.contract === undefined ? {} : { contractId: input.contract }),
  };
}

/** Spawn carries its submitted schema and prompt only through the invocation input. */
function renderSpawn(input: VerbInput<"spawn">, result: VerbOutput<"spawn">, context: TextRenderContext): string {
  const raw = callRawAnswer(result, input.schema !== undefined, false);
  return raw ?? renderCallText(result, false, context, spawnPresentation(input));
}

function renderReport(result: VerbOutput<"report">, context: TextRenderContext): string {
  const actor = context.actor === undefined ? "" : ` ${context.actor}`;
  return result.kind === "recorded" ? `recorded${actor} ${result.reportId}` : `refused report · ${result.reason}`;
}

function renderShow(input: VerbInput<"show">, result: VerbOutput<"show">, context: TextRenderContext): string {
  return result.kind === "missing"
    ? missing("show", input.contract?.startsWith("kei/") === true ? input.contract : undefined, context)
    : result.guidance;
}

/** Render native completion values without observing the World or parsing output. */
export function renderVerb<K extends VerbName>(
  name: K,
  input: VerbInput<K>,
  completion: VerbCompletion<VerbOutput<K>>,
  context: TextRenderContext,
): string {
  if (completion.kind === "threw") return thrown(name, completion.error, context, input);
  const value = completion.value;
  switch (name) {
    case "bind":
    case "amend":
    case "arc":
    case "deliver":
    case "deliver.preview":
    case "verify":
    case "review":
    case "abandon":
      return contractAnswer(
        name,
        input as VerbInput<ContractMutationName | "deliver.preview">,
        value as ContractOutcome | VerbOutput<"deliver.preview">,
        context,
      );
    case "show":
      return renderShow(input as VerbInput<"show">, value as VerbOutput<"show">, context);
    case "settings":
      return renderSettingsText(value as VerbOutput<"settings">, context.columns);
    case "whoami":
      return renderWhoami(value as VerbOutput<"whoami">);
    case "nuke":
      return renderNukeText(value as VerbOutput<"nuke">, input as VerbInput<"nuke">);
    case "reconcile": {
      const result = value as VerbOutput<"reconcile">;
      return result.kind === "missing"
        ? missing("reconcile", result.contractId, context)
        : renderReconcile(result, context);
    }
    case "region":
      return renderRegion(input as VerbInput<"region">, value as VerbOutput<"region">, context);
    case "ls":
      return renderLs(input as VerbInput<"ls">, value as VerbOutput<"ls">, context);
    case "status":
      return renderStatus(input as VerbInput<"status">, value as StatusResult, context);
    case "spawn":
      return renderSpawn(input as VerbInput<"spawn">, value as VerbOutput<"spawn">, context);
    case "fork":
      return renderForkText(value as VerbOutput<"fork">, input as VerbInput<"fork">);
    case "tell": {
      const tellInput = input as VerbInput<"tell">;
      return tellText(value as VerbOutput<"tell">, tellInput.prompt, alias(tellInput.akuma), context);
    }
    case "ask":
      return renderAsk(input as VerbInput<"ask">, value as VerbOutput<"ask">, context);
    case "kill":
      return renderKill(input as VerbInput<"kill">, value as VerbOutput<"kill">, context);
    case "wait":
      return renderWait(input as VerbInput<"wait">, value as VerbOutput<"wait">, context);
    case "history":
      return renderHistory(input as VerbInput<"history">, value as VerbOutput<"history">, context);
    case "debt.add":
    case "debt.addDocument":
    case "debt.update":
    case "debt.show":
    case "debt.done":
    case "debt.drop":
    case "debt.ready":
    case "debt.blocked":
    case "debt.query":
    case "debt.tree":
    case "debt.doctor":
    case "debt.context":
      return renderDebtVerb(name, input as VerbInput<DebtVerbName>, value as VerbOutput<DebtVerbName>, context);
    case "report":
      return renderReport(value as VerbOutput<"report">, context);
    default:
      throw new Error(`No shared text renderer for ${String(name)}`);
  }
}
