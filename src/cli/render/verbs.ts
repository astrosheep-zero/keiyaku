import { AkumaNotBornError, AkumaObservationError } from "../../akuma/akuma-errors.js";
import { AkumaArchetypeError } from "../../akuma/archetype.js";
import type { ContractId } from "../../index.js";
import { AkumaAddressError, AkumaWorldScopeError } from "../../library/address.js";
import type { VerbCompletion, VerbInput, VerbName, VerbOutput } from "../../library/keiyaku-verbs.js";
import { KeiyakuArcDocumentError, KeiyakuUsageError } from "../../library/keiyaku-coordinates.js";
import { KeiyakuError, projectFailure } from "../../library/outcome.js";
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
import { renderArchetypeCatalogue, renderContractCatalogue } from "./catalog.js";
import { renderAkumaBoard } from "./kanshi-akuma.js";
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
  renderDebtList,
  renderDebtMutation,
  renderDebtShow,
  renderDebtTree,
  renderDebtUpdate,
  renderDoctor,
  type DebtListScope,
} from "./debt.js";
import { renderKanshiText } from "./kanshi.js";
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
  name: ContractMutationName,
  input: VerbInput<ContractMutationName>,
  answer: ContractOutcome | VerbOutput<"deliver">,
  context: TextRenderContext,
): string {
  const operation = name === "deliver" && "dryRun" in input && input.dryRun ? "deliver --dry-run" : name;
  switch (answer.kind) {
    case "ready":
    case "blocked":
      return renderDeliveryPreview(answer, context);
    case "handoff":
      return renderConflictMaterialized(answer, context);
    case "retry":
      return renderRetry(operation, answer, context);
    case "accepted": {
      return renderAccepted(name, answer, context, {
        ...("verdict" in input ? { verdict: input.verdict } : {}),
        ...("note" in input && input.note !== undefined ? { note: input.note } : {}),
        ...("message" in input && input.message !== undefined ? { message: input.message } : {}),
      });
    }
    case "refused": {
      let refusal: RenderableRefusal = answer.reason;
      if ((name === "deliver" || name === "verify") && refusal.kind === "dirty-workspace") {
        refusal = {
          ...refusal,
          option: { flag: "--include-dirty", available: (refusal.submodules?.length ?? 0) === 0 },
        };
      }
      return renderRefusal(
        { operation, ...("contractId" in answer ? { contract: answer.contractId } : {}), refusal },
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
  const namespace = input.namespace ?? [];
  return { namespace: namespace.length === 0 ? "debt/" : `debt/${namespace.join("/")}/` };
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
    case "debt.query": {
      const query = input as VerbInput<"debt.query">;
      return renderDebtList("query", debtScope(query), value as VerbOutput<"debt.query">, context);
    }
    case "debt.tree":
      return renderDebtTree((input as VerbInput<"debt.tree">).id, value as VerbOutput<"debt.tree">, context);
    case "debt.doctor":
      return renderDoctor(value as VerbOutput<"debt.doctor">);
    default:
      throw new Error(`No shared text renderer for ${String(name)}`);
  }
}

function renderKill(input: VerbInput<"kill">, value: VerbOutput<"kill">, context: TextRenderContext): string {
  const selectors = input.akuma;
  return renderKillText(value, selectors.length === 1 ? alias(selectors[0]) : undefined, context);
}

function renderAsk(
  input: VerbInput<"ask" | "tell">,
  result: VerbOutput<"ask" | "tell">,
  context: TextRenderContext,
): string {
  const selectedAlias = alias(input.akuma);
  if (!("kind" in result) && result.input === undefined) return tellText(result, input.prompt, selectedAlias, context);
  return "kind" in result && result.kind === "answered"
    ? (askRawAnswer(result) ?? "")
    : !("kind" in result) && result.input?.kind === "answered"
      ? result.input.answer
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

/** Spawn's optional observation carries text. */
function renderSpawn(input: VerbInput<"spawn">, result: VerbOutput<"spawn">, context: TextRenderContext): string {
  const raw = callRawAnswer(result, false);
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
  context: TextRenderContext & Readonly<{ alias?: string }>,
): string {
  if (completion.kind === "threw") return thrown(name, completion.error, context, input);
  const value = completion.value;
  switch (name) {
    case "bind":
    case "amend":
    case "arc":
    case "deliver":
    case "verify":
    case "review":
    case "abandon":
      return contractAnswer(
        name,
        input as VerbInput<ContractMutationName>,
        value as ContractOutcome | VerbOutput<"deliver">,
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
    case "kei.ls":
      return renderContractCatalogue(value as VerbOutput<"kei.ls">);
    case "aku.names":
      return renderArchetypeCatalogue(value as VerbOutput<"aku.names">);
    case "aku.ls": {
      const result = value as VerbOutput<"aku.ls">;
      return renderAkumaBoard({ kind: "present", ...result }, result.observedAt, {
        ...context,
        caller: (input as VerbInput<"aku.ls">).caller,
      }).join("\n");
    }
    case "status":
      return renderKanshiText(value as VerbOutput<"status">, context);
    case "kei.status": {
      const result = value as VerbOutput<"kei.status">;
      return result.kind === "contract-missing"
        ? missing("status", result.id, context)
        : renderKanshiText(result, context);
    }
    case "aku.status":
      return snapshotText(value as VerbOutput<"aku.status">, context, context);
    case "spawn":
      return renderSpawn(input as VerbInput<"spawn">, value as VerbOutput<"spawn">, context);
    case "fork":
      return renderForkText(value as VerbOutput<"fork">, input as VerbInput<"fork">);
    case "tell":
    case "ask":
      return renderAsk(input as VerbInput<"ask" | "tell">, value as VerbOutput<"ask" | "tell">, context);
    case "kill":
      return renderKill(input as VerbInput<"kill">, value as VerbOutput<"kill">, context);
    case "wait":
      return renderWait(input as VerbInput<"wait">, value as VerbOutput<"wait">, context);
    case "history":
      return renderHistory(input as VerbInput<"history">, value as VerbOutput<"history">, context);
    case "report":
      return renderReport(value as VerbOutput<"report">, context);
    default:
      return renderDebtVerb(name, input as VerbInput<DebtVerbName>, value as VerbOutput<DebtVerbName>, context);
  }
}
