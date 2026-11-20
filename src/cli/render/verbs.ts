import { AkumaNotBornError, AkumaObservationError } from "../../akuma/akuma-errors.js";
import { AkumaNameError } from "../../akuma/archetype.js";
import type { ContractId } from "../../index.js";
import { AkumaAddressError, AkumaWorldScopeError } from "../../library/address.js";
import {
  classifyVerb,
  type VerbCompletion,
  type VerbDisposition,
  type VerbInput,
  type VerbName,
  type VerbOutput,
} from "../../library/keiyaku-verbs.js";
import { KeiyakuUsageError } from "../../library/keiyaku-coordinates.js";
import { KeiyakuError, projectFailure, type FailureProjection } from "../../library/outcome.js";
import { akumaWaitMemberText, historyText, killResultText, snapshotText, tellText } from "./akuma-activity.js";
import { renderCallText, renderForkText, renderKillText, renderAskText } from "./akuma.js";
import { renderAkumaNameCatalogue, renderContractCatalogue } from "./catalog.js";
import { renderAkumaBoard } from "./kanshi-akuma.js";
import { renderContractResult, type ContractResultName } from "./contract.js";
import { renderContractHistory } from "./contract-history.js";
import { contractWaitMemberText } from "./contract-wait.js";
import { renderDebtList, renderDebtMutation, renderDebtShow, renderDebtUpdate, renderDoctor } from "./debt.js";
import { renderKanshiText, renderStatusSummary } from "./kanshi.js";
import { renderNukeText } from "./nuke.js";
import { resetFailureLines } from "./receipt.js";
import { renderRefusal, renderStructuredRefusal } from "./refusal.js";
import { renderRegionText } from "./region.js";
import { renderSettingsText } from "./settings.js";
import { exactIndentedLines, formatNextCall, safeText, type TextRenderContext } from "./terminal.js";
import { renderWhoami } from "./whoami.js";

export type RenderVerbContext = TextRenderContext & Readonly<{ alias?: string; disposition?: VerbDisposition }>;

export function aliasSelector(selector: string | undefined): string | undefined {
  return selector?.startsWith("@") === true ? selector : undefined;
}

function missing(operation: string, contract: string | undefined): string {
  if (contract === undefined) return renderStructuredRefusal(operation, "contract missing");
  const id = contract as ContractId;
  return renderRefusal({ operation, contract: id, refusal: { kind: "contract-missing" } });
}

function actionFailure(
  name: string,
  failure: FailureProjection,
  input: VerbInput<VerbName>,
  context: TextRenderContext,
): string | undefined {
  if (name === "spawn" && failure.spawn !== undefined)
    return renderCallText(failure.spawn, spawnPresentation(input as VerbInput<"spawn">, context), failure.diagnostic);
  if (failure.frozenWorkdir !== undefined)
    return renderStructuredRefusal(name, "input not admitted", [failure.diagnostic]);
  if (failure.tell !== undefined)
    return [
      `× ${name} failed`,
      tellText(
        failure.tell,
        "prompt" in input && typeof input.prompt === "string" ? input.prompt : "",
        undefined,
        true,
      ),
      `  input ${failure.tell.tellId}`,
      `  reason ${safeText(failure.diagnostic)}`,
    ].join("\n");
  if (failure.kill !== undefined) {
    const alias = name === "kill" ? aliasSelector((input as VerbInput<"kill">).akuma) : undefined;
    return [
      `× ${name} failed`,
      ...failure.kill.map((member) => killResultText(member.id, member.outcome, alias)),
      `  reason ${safeText(failure.diagnostic)}`,
    ].join("\n");
  }
  return undefined;
}

function thrown(name: string, error: unknown, context: TextRenderContext, input: VerbInput<VerbName>): string {
  const failure = projectFailure(error);
  const action = actionFailure(name, failure, input, context);
  if (action !== undefined) return action;
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
  if (name === "spawn" && error instanceof AkumaNameError) {
    const available = error.next === undefined ? undefined : formatNextCall(error.next, context);
    return renderStructuredRefusal("spawn", `${error.absent ? "Akuma not found" : error.reason} · ${error.akumaName}`, [
      ...error.searched.map((path) => `searched  ${path}`),
      ...(available === undefined ? [] : [`available  ${available}`]),
    ]);
  }
  if (error instanceof KeiyakuUsageError) return failure.diagnostic;
  if (error instanceof KeiyakuError && error.outcome?.kind === "world")
    return resetFailureLines(name, error.outcome, failure).join("\n");
  return `× ${name} failed\n  reason  ${safeText(failure.diagnostic)}`;
}

function renderRegion(input: VerbInput<"region">, result: VerbOutput<"region">): string {
  if (result.kind === "contract-missing") return missing("region", result.id);
  if (result.kind === "contract-terminal")
    return renderRefusal({ operation: "region", contract: result.id, refusal: { kind: "terminal" } });
  return renderRegionText(result, input);
}

function renderWait(input: VerbInput<"wait">, result: VerbOutput<"wait">, context: RenderVerbContext): string {
  const selectedAlias = input.selectors.length === 1 ? aliasSelector(input.selectors[0]) : undefined;
  const incomplete =
    (context.disposition ?? classifyVerb("wait", input, { kind: "returned", value: result })) === "incomplete";
  const rows = result.members.map((member) => {
    if ("contract" in member) return contractWaitMemberText(member);
    const row = akumaWaitMemberText(member, selectedAlias);
    if (member.report === undefined) return row;
    return [row, `  ${member.report.report}`, ...exactIndentedLines(member.report.text, "    ")].join("\n");
  });
  const done = result.members.filter(({ state }) =>
    ["done", "idle", "changed", "accepted", "abandoned"].includes(state),
  ).length;
  const head =
    incomplete || rows.length > 1
      ? [
          `${incomplete ? "⧗ " : ""}${done} of ${rows.length} done${result.elapsedMs === undefined ? "" : ` after ${Math.floor(result.elapsedMs / 1000)}s`}`,
        ]
      : [];
  const coordinates = context.recoveryCoordinates;
  const selectors = result.members.flatMap((member) =>
    member.state === "waiting" || member.state === "running"
      ? ["contract" in member ? member.contract : member.akuma]
      : [],
  );
  const resume =
    incomplete &&
    selectors.length > 0 &&
    coordinates !== undefined &&
    !result.members.some(({ state }) => state === "unavailable" || state === "missing")
      ? (() => {
          const completion = input.completion ?? "any";
          const { cwd } = coordinates;
          const repo = selectors.some((selector) => selector.startsWith("kei/")) ? coordinates.repo : undefined;
          const bound = input.for;
          if (context.surface === "mcp")
            return `wait ${JSON.stringify({ cwd, repo, selectors, completion, for: bound })}`;
          const argv = [
            "keiyaku",
            "-C",
            cwd,
            ...(repo === undefined ? [] : ["--repo", repo]),
            "wait",
            ...selectors,
            `--${completion}`,
            ...(bound === undefined ? [] : ["--for", bound]),
          ];
          return argv.every((word) => /^[a-zA-Z0-9_./:@-]+$/u.test(word)) ? argv.join(" ") : undefined;
        })()
      : undefined;
  return [...head, ...rows, ...(resume === undefined || safeText(resume) !== resume ? [] : [`resume: ${resume}`])].join(
    "\n",
  );
}

function renderHistory(query: VerbInput<"history">, result: VerbOutput<"history">): string {
  if (query.selector.startsWith("kei/")) {
    if (result.kind === "contract-missing") return missing("history", result.contractId);
    if (result.kind === "contract-unknown-history")
      return `${result.contractId} has no matching history at ${"item" in query ? query.item : ""}`;
    if (result.kind !== "contract" && result.kind !== "contract-exact")
      throw new Error("Contract history returned a non-Contract result");
    return renderContractHistory(result);
  }
  if (
    result.kind === "contract" ||
    result.kind === "contract-exact" ||
    result.kind === "contract-unknown-history" ||
    result.kind === "contract-missing"
  )
    throw new Error("Akuma history returned a non-Akuma result");
  const id = "item" in query ? query.item : undefined;
  const selectedAlias = aliasSelector(query.selector);
  return historyText(result, {
    ...(selectedAlias === undefined ? {} : { alias: selectedAlias }),
    ...(id === undefined ? {} : { id }),
    ...("since" in query && query.since !== undefined ? { since: query.since } : {}),
  });
}

type DebtVerbName = Extract<VerbName, `debt.${string}`>;

function renderDebtVerb(name: DebtVerbName, input: VerbInput<DebtVerbName>, value: VerbOutput<DebtVerbName>): string {
  switch (name) {
    case "debt.add":
    case "debt.addDocument":
      return renderDebtMutation("add", value as VerbOutput<"debt.add">);
    case "debt.update": {
      const query = input as VerbInput<"debt.update">;
      return renderDebtUpdate(query.id, value as VerbOutput<"debt.update">);
    }
    case "debt.doctor":
      return renderDoctor(value as VerbOutput<"debt.doctor">);
    default:
      throw new Error(`No shared text renderer for ${String(name)}`);
  }
}

function renderKill(input: VerbInput<"kill">, value: VerbOutput<"kill">): string {
  return renderKillText(value, aliasSelector(input.akuma));
}

function renderInput(input: VerbInput<"ask" | "tell">, result: VerbOutput<"ask" | "tell">): string {
  const selectedAlias = aliasSelector(input.akuma);
  if (!("kind" in result)) return tellText(result, input.prompt, selectedAlias);
  return renderAskText(result, selectedAlias);
}

function spawnPresentation(input: VerbInput<"spawn">, context: TextRenderContext) {
  return {
    ...(context.surface === undefined ? {} : { surface: context.surface }),
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    ...(input.workdir === undefined ? {} : { cwd: input.workdir }),
    ...(input.alias === undefined ? {} : { alias: input.alias }),
    ...(input.contract === undefined ? {} : { contractId: input.contract }),
  };
}

function renderReport(result: VerbOutput<"report">, context: TextRenderContext): string {
  const actor = context.actor === undefined ? "" : ` ${context.actor}`;
  return result.kind === "recorded" ? `recorded${actor} ${result.reportId}` : `refused report · ${result.reason}`;
}

function renderSurveil(input: VerbInput<"surveil">, result: VerbOutput<"surveil">): string {
  const state =
    result.kind === "unchanged" ? "surveillance unchanged" : input.off === true ? "unsurveilled" : "surveilled";
  return `${state} ${safeText(result.id)}`;
}

function renderShow(input: VerbInput<"show">, result: VerbOutput<"show">): string {
  if (result.kind === "present") return result.guidance;
  if (result.kind === "missing") return missing("show", input.selector);
  return renderDebtShow(result);
}

/** Render native completion values without observing the World or parsing output. */
export function renderVerb<K extends VerbName>(
  name: K,
  input: VerbInput<K>,
  completion: VerbCompletion<VerbOutput<K>>,
  context: RenderVerbContext,
): string {
  switch (name) {
    case "bind":
    case "amend":
    case "arc":
    case "deliver":
    case "verify":
    case "review":
    case "abandon":
    case "reconcile":
      return renderContractResult(
        name,
        input as VerbInput<ContractResultName>,
        completion as VerbCompletion<VerbOutput<ContractResultName>>,
        classifyVerb(name, input, completion),
        context,
      );
  }
  if (completion.kind === "threw") return thrown(name, completion.error, context, input);
  const value = completion.value;
  switch (name) {
    case "show":
      return renderShow(input as VerbInput<"show">, value as VerbOutput<"show">);
    case "settings":
      return renderSettingsText(value as VerbOutput<"settings">);
    case "whoami":
      return renderWhoami(value as VerbOutput<"whoami">);
    case "nuke":
      return renderNukeText(value as VerbOutput<"nuke">, input as VerbInput<"nuke">);
    case "region":
      return renderRegion(input as VerbInput<"region">, value as VerbOutput<"region">);
    case "ls": {
      const result = value as VerbOutput<"ls">;
      if (result.kind === "contract-catalogue") return renderContractCatalogue(result);
      if (result.kind === "akuma-name-catalogue") return renderAkumaNameCatalogue(result);
      if (result.kind === "debt-catalogue") return renderDebtList(result);
      const query = input as VerbInput<"ls">;
      return renderAkumaBoard(result, result.observedAt, {
        ...context,
        ...("mine" in query && query.mine === true ? { caller: context.actor ?? "external" } : {}),
      }).join("\n");
    }
    case "kanshi":
      return renderKanshiText(value as VerbOutput<"kanshi">, context);
    case "status": {
      const result = value as VerbOutput<"status">;
      if (result.kind === "active-work-summary") return renderStatusSummary(result);
      const alias = aliasSelector((input as VerbInput<"status">).selector);
      return result.kind === "akuma"
        ? snapshotText(result, context, alias === undefined ? {} : { alias })
        : result.kind === "contract-missing"
          ? missing("status", result.id)
          : renderKanshiText(result, context);
    }
    case "spawn":
      return renderCallText(value as VerbOutput<"spawn">, spawnPresentation(input as VerbInput<"spawn">, context));
    case "fork":
      return renderForkText(value as VerbOutput<"fork">, input as VerbInput<"fork">);
    case "tell":
    case "ask":
      return renderInput(input as VerbInput<"ask" | "tell">, value as VerbOutput<"ask" | "tell">);
    case "kill":
      return renderKill(input as VerbInput<"kill">, value as VerbOutput<"kill">);
    case "wait":
      return renderWait(input as VerbInput<"wait">, value as VerbOutput<"wait">, context);
    case "history":
      return renderHistory(input as VerbInput<"history">, value as VerbOutput<"history">);
    case "report":
      return renderReport(value as VerbOutput<"report">, context);
    case "surveil":
      return renderSurveil(input as VerbInput<"surveil">, value as VerbOutput<"surveil">);
    default:
      return renderDebtVerb(name, input as VerbInput<DebtVerbName>, value as VerbOutput<DebtVerbName>);
  }
}
