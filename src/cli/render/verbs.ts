import { AkumaNotBornError, AkumaObservationError } from "../../akuma/akuma-errors.js";
import { AkumaArchetypeError } from "../../akuma/archetype.js";
import type { AkumaCaller } from "../../akuma/caller.js";
import type { ContractId } from "../../index.js";
import { AkumaAddressError, AkumaWorldScopeError } from "../../library/address.js";
import type { VerbCompletion, VerbInput, VerbName, VerbOutput } from "../../library/keiyaku-verbs.js";
import { KeiyakuArcDocumentError, KeiyakuUsageError } from "../../library/keiyaku-coordinates.js";
import { KeiyakuError } from "../../library/outcome.js";
import type { AkumaObservation } from "../../index.js";
import type { KanshiReport } from "../../kanshi/index.js";
import {
  askRawAnswer,
  callRawAnswer,
  historyRawAnswer,
  historyText,
  snapshotText,
  tellText,
  waitText,
} from "./akuma-activity.js";
import { renderCallText, renderForkText, renderKillText, waitedTellProgress } from "./akuma.js";
import { renderAkumaCatalogue, renderArchetypeCatalogue, renderContractCatalogue } from "./catalog.js";
import { renderAccepted, renderContractHistory, renderRetry, type ContractOutcome } from "./contract.js";
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
  return renderRefusal(
    { operation, contract: id, refusal: { kind: "contract-missing", contractId: id } },
    undefined,
    context,
  );
}

function contractAnswer(answer: ContractOutcome, context: TextRenderContext): string {
  switch (answer.kind) {
    case "handoff":
      return renderConflictMaterialized(answer.value, context);
    case "retry":
      return renderRetry(answer, context);
    case "accepted":
      return renderAccepted(answer, context);
    case "refused": {
      let refusal: RenderableRefusal = answer.refusal;
      if (
        (answer.operation === "deliver" || answer.operation === "deliver-preview" || answer.operation === "verify") &&
        refusal.kind === "dirty-workspace"
      ) {
        const submodules = "submodules" in refusal && Array.isArray(refusal.submodules) ? refusal.submodules : [];
        refusal = { ...refusal, option: { flag: "--include-dirty", available: submodules.length === 0 } };
      }
      return renderRefusal(
        {
          operation: answer.operation,
          ...(answer.contract === undefined ? {} : { contract: answer.contract }),
          refusal,
        },
        undefined,
        context,
      );
    }
  }
}

function thrown(name: string, error: unknown, context: TextRenderContext): string {
  if (error instanceof KeiyakuArcDocumentError) {
    return renderRefusal(
      { operation: "arc", contract: error.contract, refusal: { kind: "invalid-document", diagnostic: error.message } },
      undefined,
      context,
    );
  }
  if (error instanceof KeiyakuError) {
    return error.outcome === undefined
      ? `× ${name} failed\n  reason  ${safeText(error.message)}`
      : executionFailureLines(error.outcome, error.category, error.message, context.columns).join("\n");
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

function statusObservation(
  value: AkumaObservation | KanshiReport,
  selector: string | undefined,
  context: TextRenderContext,
): string {
  if ("status" in value) {
    const selectedAlias = alias(selector);
    return snapshotText(value, context, selectedAlias === undefined ? {} : { alias: selectedAlias });
  }
  return renderKanshiText(value, context, selector === undefined ? "world" : "contract");
}

function renderRegion(result: VerbOutput<"region">, context: TextRenderContext): string {
  if (result.kind === "missing" || "row" in result) {
    const id = result.kind === "missing" ? result.id : result.row.id;
    return renderRefusal(
      {
        operation: "region",
        contract: id,
        refusal: { kind: result.kind === "missing" ? "contract-missing" : "terminal", contractId: id },
      },
      undefined,
      context,
    );
  }
  return renderRegionText(result);
}

function renderLs(query: VerbInput<"ls">, result: VerbOutput<"ls">, context: TextRenderContext): string {
  if (query.of === "debt") return renderDebtList("ls", debtScope(query), result as VerbOutput<"debt.ready">, context);
  if (query.of === "kei") return renderContractCatalogue(result as Parameters<typeof renderContractCatalogue>[0]);
  if (query.of === "akuma-name")
    return renderArchetypeCatalogue(result as Parameters<typeof renderArchetypeCatalogue>[0]);
  const caller = query.caller?.kind === "external" ? (query.caller.caller as AkumaCaller) : undefined;
  return renderAkumaCatalogue(result as Parameters<typeof renderAkumaCatalogue>[0], query.akumaName ?? null, caller);
}

function renderStatus(query: VerbInput<"status">, result: VerbOutput<"status">, context: TextRenderContext): string {
  if (Array.isArray(result)) {
    const selectors = (query as { selectors?: readonly string[] }).selectors;
    return result.map((item, i) => statusObservation(item, selectors?.[i], context)).join("\n\n");
  }
  const single = result as Exclude<VerbOutput<"status">, readonly (AkumaObservation | KanshiReport)[]>;
  if ("category" in single) return renderKanshiCategoryText(single, context);
  const selector = (query as { selector?: string }).selector;
  const observed = single;
  if (
    selector?.startsWith("kei/") === true &&
    "contracts" in observed &&
    observed.contracts.kind === "present" &&
    observed.contracts.value.rows.length === 0
  )
    return missing("status", selector, context);
  return statusObservation(observed, selector, context);
}

function renderWait(input: VerbInput<"wait">, result: VerbOutput<"wait">, context: TextRenderContext): string {
  if ("contracts" in result) return contractWaitText(result);
  const selectors = input.selectors;
  const selectedAlias = selectors.length === 1 ? alias(selectors[0]) : undefined;
  return waitText(result, selectedAlias === undefined ? {} : { alias: selectedAlias }, context);
}

function renderHistory(query: VerbInput<"history">, result: VerbOutput<"history">, context: TextRenderContext): string {
  const options = query as { full?: boolean; id?: string; last?: boolean };
  if (query.selector.startsWith("kei/"))
    return result === null
      ? missing("history", query.selector, context)
      : renderContractHistory(result as Parameters<typeof renderContractHistory>[0], { full: options.full === true });
  if (result === null || !("kind" in result)) throw new Error("Akuma history returned a non-Akuma result");
  const id = options.id;
  const last = options.last === true;
  const selectedAlias = alias(query.selector);
  return (
    historyRawAnswer(result, id) ??
    (last && result.kind === "last"
      ? result.answer
      : historyText(
          result,
          {
            ...(selectedAlias === undefined ? {} : { alias: selectedAlias }),
            ...(id === undefined ? {} : { id }),
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
    case "debt.update":
      return renderDebtUpdate(value as VerbOutput<"debt.update">, context);
    case "debt.show": {
      const query = input as VerbInput<"debt.show">;
      return renderDebtShow(value as VerbOutput<"debt.show">, "ids" in query ? query.ids : [query.id], context);
    }
    case "debt.done":
    case "debt.drop":
      return renderDebtLifecycle(name === "debt.done" ? "done" : "drop", value as VerbOutput<"debt.done">, context);
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
      return renderDebtTree(value as VerbOutput<"debt.tree">, context);
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
  return result.observation.reason === "answered"
    ? (askRawAnswer(result, input.schema !== undefined) ?? "")
    : waitedTellProgress(result, alias(input.akuma), context);
}

function renderReport(result: VerbOutput<"report">, context: TextRenderContext): string {
  const actor = context.actor === undefined ? "" : ` ${context.actor}`;
  return result.kind === "recorded"
    ? `recorded${actor} report/${result.report.sequence} · body/${result.report.bodySequence} · turn/${result.report.turnSequence}`
    : `refused report · ${result.reason}`;
}

/** Render native completion values without observing the World or parsing output. */
export function renderVerb<K extends VerbName>(
  name: K,
  input: VerbInput<K>,
  completion: VerbCompletion<VerbOutput<K>>,
  context: TextRenderContext,
): string {
  if (completion.kind === "threw") return thrown(name, completion.error, context);
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
      return contractAnswer(value as ContractOutcome, context);
    case "show": {
      const selected = input as VerbInput<"show">;
      return value === null
        ? missing("show", selected.contract?.startsWith("kei/") === true ? selected.contract : undefined, context)
        : (value as string);
    }
    case "settings":
      return renderSettingsText(value as VerbOutput<"settings">, context.columns);
    case "whoami":
      return renderWhoami(value as VerbOutput<"whoami">);
    case "nuke":
      return renderNukeText(value as VerbOutput<"nuke">);
    case "reconcile": {
      const result = value as VerbOutput<"reconcile">;
      return "kind" in result && result.kind === "missing"
        ? missing("reconcile", result.id, context)
        : renderReconcile(result, context);
    }
    case "region":
      return renderRegion(value as VerbOutput<"region">, context);
    case "ls":
      return renderLs(input as VerbInput<"ls">, value as VerbOutput<"ls">, context);
    case "status":
      return renderStatus(input as VerbInput<"status">, value as VerbOutput<"status">, context);
    case "spawn": {
      const result = value as VerbOutput<"spawn">;
      return callRawAnswer(result, false) ?? renderCallText(result, false, context);
    }
    case "fork":
      return renderForkText(value as VerbOutput<"fork">);
    case "tell":
      return tellText(value as VerbOutput<"tell">, alias((input as VerbInput<"tell">).akuma), context);
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
