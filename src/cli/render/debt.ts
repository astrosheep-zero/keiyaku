import type { CliOutcome } from "../streams.js";
import type {
  BlockedDebtList,
  BlockedDebtRow,
  DebtBatchResult,
  DebtContextResult,
  DebtDecompositionTree,
  DebtDetail,
  DebtDoctorIssue,
  DebtDoctorReport,
  DebtList,
  DebtMutationResult,
  DebtQueryResult,
  DebtQueryRow,
  DebtRef,
  DebtRefusal,
  DebtRow,
  DebtTreeNode,
  DebtUpdateResult,
  DebtView,
} from "../../debt/index.js";
import { debtMark } from "./marks.js";
import { outcomeLines, receiptPayload, receiptRow, refusalLines } from "./receipt.js";
import {
  DEFAULT_CLI_COLUMNS,
  displayColumns,
  emptyCatalogue,
  renderTextBlock,
  safeText,
  type TextRenderContext,
} from "./terminal.js";

export { debtMark } from "./marks.js";

type DebtListOutcome = DebtList | BlockedDebtList | DebtQueryResult;
/** One addressed show selection: native details, or a refusal naming a missing addressed read. */
export type DebtShowResult = DebtDetail | DebtDetail[] | Extract<DebtMutationResult, { kind: "refused" }>;
/** Presentation-only list scope the leaf acquired; never part of a product value. */
export type DebtListScope = "world" | "current" | Readonly<{ namespace: string }>;
/** The union of native Debt SDK answers one leaf renders directly; the CLI adds no result envelope. */
type DebtNativeResult =
  | DebtMutationResult
  | DebtUpdateResult
  | DebtBatchResult
  | DebtShowResult
  | DebtList
  | BlockedDebtList
  | DebtQueryResult
  | DebtDecompositionTree
  | DebtDoctorReport
  | DebtContextResult;
type DebtFailure =
  | Extract<DebtMutationResult, { kind: "refused" | "retry" }>
  | Extract<DebtContextResult, { kind: "refused" | "retry" }>;
type DebtWord = DebtRow["disposition"] | DebtView["state"] | DebtRef["state"];
type DebtEntity = Readonly<{
  id: string;
  priority: number | null;
  word?: DebtWord;
  facts?: string;
  title: string | null;
}>;
type RefusalProjection = Readonly<{
  diagnostic: string;
  facts?: readonly string[];
}>;

const DEFAULT_CONTEXT: TextRenderContext = { columns: DEFAULT_CLI_COLUMNS, color: false };

/** Debt dispositions and relation states are snake_case facts; people read them as words. */
export function dispositionText(word: string): string {
  return word === "drop" ? "dropped" : word.replaceAll("_", " ");
}

function priorityText(priority: number | null): string {
  return priority === null ? "P?" : `P${priority}`;
}

function scanUnit(id: string, priority: number | null, word: DebtWord | undefined): string {
  return word === undefined
    ? `${debtMark("ready")} ${id} · ${priorityText(priority)}`
    : `${debtMark(word)} ${id} · ${dispositionText(word)} · ${priorityText(priority)}`;
}

function entityLines(entity: DebtEntity, columns: number, indent = ""): readonly string[] {
  const scan = `${indent}${scanUnit(entity.id, entity.priority, entity.word)}${entity.facts === undefined ? "" : ` · ${entity.facts}`}`;
  if (entity.title === null || entity.title.length === 0) return [scan];
  const title = safeText(entity.title);
  const inline = `${scan} — ${title}`;
  if (displayColumns(inline) <= columns) return [inline];
  return [scan, ...renderTextBlock(title, `${indent}  `, columns, "—")];
}

function stateEntity(debt: DebtView | (DebtRef & { priority?: number | null })): DebtEntity {
  return {
    id: debt.id,
    priority: "priority" in debt && debt.priority !== undefined ? debt.priority : null,
    word: debt.state,
    title: debt.title,
  };
}

function projectRefusal(refusal: DebtRefusal): RefusalProjection {
  const diagnostic = refusal.kind.replaceAll("-", " ");
  if (refusal.kind === "debt-missing") return { diagnostic, facts: [`debt  ${refusal.debtId}`] };
  if (refusal.kind === "invalid-lifecycle-transition") {
    return { diagnostic, facts: [`debt  ${refusal.debtId}`, `state  ${refusal.state} · verb  ${refusal.verb}`] };
  }
  if (refusal.kind === "invalid-namespace-context") return { diagnostic, facts: [`path  ${refusal.path}`] };
  if (refusal.kind === "relation-owned-by-other") {
    return {
      diagnostic,
      facts: [
        `debt  ${refusal.debtId}`,
        `related debt  ${refusal.related}`,
        `declaring debt  ${refusal.declaringDebt}`,
      ],
    };
  }
  return refusal.diagnostic === undefined ? { diagnostic } : { diagnostic, facts: [`detail  ${refusal.diagnostic}`] };
}

function renderFailure(verb: string, result: DebtFailure, columns: number): string {
  if (result.kind === "retry") {
    return [...outcomeLines("?", verb, "retry", undefined, columns), result.reason].join("\n");
  }
  const facts = projectRefusal(result.refusal);
  return refusalLines(verb, [`reason  ${facts.diagnostic}`, ...(facts.facts ?? [])], columns).join("\n");
}

function edge(label: string, ref: DebtRef, mark?: string): string {
  const prefix = mark === undefined ? `  ${label}` : `  ${mark} ${label}`;
  return `${prefix} ${ref.id} · ${dispositionText(ref.state)}`;
}

export function debtFrameHead(view: string, scope: string): string {
  return `${view.toUpperCase()} // ${scope}`;
}

function updatedAge(updatedAt: string): string {
  const elapsed = Math.max(0, performance.timeOrigin + performance.now() - Date.parse(updatedAt));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function compactFacts(item: DebtRow): string {
  return [
    `updated ${updatedAge(item.updatedAt)}`,
    ...(item.children === undefined ? [] : [`children ${item.children.live} live · ${item.children.total} total`]),
  ].join(" · ");
}

function listEntity(item: DebtRow, omitDisposition: boolean): DebtEntity {
  return {
    id: item.id,
    priority: item.priority,
    ...(omitDisposition ? {} : { word: item.disposition }),
    facts: compactFacts(item),
    title: item.title,
  };
}

function renderListRow(
  item: DebtRow | BlockedDebtRow | DebtQueryRow,
  columns: number,
  omitDisposition: boolean,
): readonly string[] {
  const lines = [...entityLines(listEntity(item, omitDisposition), columns)];
  if ("blockers" in item) {
    for (const blocker of item.blockers) lines.push(`  needs ${blocker.id} · ${dispositionText(blocker.state)}`);
  }
  return lines;
}

export function renderDebtList(
  action: "ls" | "ready" | "blocked" | "query",
  scope: DebtListScope,
  result: DebtListOutcome,
  context: TextRenderContext = DEFAULT_CONTEXT,
): string {
  const columns = context.columns;
  if (result.kind !== "accepted") return renderFailure(action, result, columns);
  const view = action === "ls" ? "debts" : action;
  const footer = result.value.hasMore ? ["…"] : [];
  const scopeText =
    scope === "world"
      ? "world"
      : scope === "current"
        ? "current namespace"
        : `namespace ${scope.namespace.replace(/^debt\//u, "").replace(/\/$/u, "") || "root"}`;
  const heading = debtFrameHead(view, scopeText);
  if (result.value.rows.length === 0) return emptyCatalogue(view);
  return [
    heading,
    ...result.value.rows.flatMap((item) => renderListRow(item, columns, action === "ready")),
    ...footer,
  ].join("\n");
}

function textTimestamp(timestamp: string): string {
  return timestamp.replace(/\.\d+(?=Z$)/u, "");
}

function renderShowDetail(result: DebtDetail, columns: number): string {
  const debt = result.debt;
  const lines = [
    ...entityLines(stateEntity(debt), columns),
    `  created  ${textTimestamp(debt.createdAt)}`,
    `  updated  ${textTimestamp(debt.updatedAt)}`,
    ...(debt.createdBy === undefined ? [] : [`  created by  ${debt.createdBy}`]),
  ];
  for (const need of result.needs.filter((item) => !item.released)) lines.push(edge("needs", need, "!"));
  for (const need of result.needs.filter((item) => item.released)) lines.push(edge("needs", need, "✓"));
  for (const item of result.blocks) lines.push(edge("blocks", item));
  if (result.parent !== null) lines.push(edge("parent", result.parent));
  for (const item of result.children) lines.push(edge("child", item));
  for (const item of result.supersedes) lines.push(edge("supersedes", item));
  for (const item of result.supersededBy) lines.push(edge("superseded-by", item));
  for (const item of result.related) lines.push(edge("related", item));
  if (debt.note.length > 0) receiptPayload(lines, "note", debt.note);
  if (debt.body.length > 0) receiptPayload(lines, "body", debt.body);
  return lines.join("\n");
}

export function renderDebtShow(result: DebtShowResult, context: TextRenderContext = DEFAULT_CONTEXT): string {
  const columns = context.columns;
  if (Array.isArray(result)) return result.map((detail) => renderShowDetail(detail, columns)).join("\n\n");
  if ("kind" in result) return renderFailure("show", result, columns);
  return renderShowDetail(result, columns);
}

function treeLines(node: DebtTreeNode, columns: number, depth = 0): readonly string[] {
  const indent = "  ".repeat(depth);
  if (node.cycle === true) return [`${indent}! ${node.debt.id} · cycle`];
  return [
    ...entityLines(stateEntity(node.debt), columns, indent),
    ...node.children.flatMap((child) => treeLines(child, columns, depth + 1)),
  ];
}

function doctorIssue(issue: DebtDoctorIssue): string {
  if (issue.kind === "missing-target") return `! missing-target ${issue.debtId} ${issue.relation} ${issue.target}`;
  if (issue.kind === "self-relation") return `! self-relation ${issue.debtId} ${issue.relation}`;
  return `! cycle ${issue.relation} ${issue.debts.join(" ")}`;
}

export function renderDoctor(report: DebtDoctorReport): string {
  if (report.issues.length === 0) return "✓ doctor  healthy";
  const noun = report.issues.length === 1 ? "issue" : "issues";
  return [`! doctor  ${report.issues.length} ${noun}`, ...report.issues.map(doctorIssue)].join("\n");
}

const PAST_VERBS: Readonly<Record<string, string>> = {
  add: "added",
  done: "done",
  drop: "dropped",
  update: "updated",
};

function renderAcceptedMutation(
  verb: string,
  debt: DebtView,
  columns: number,
  changes: Extract<DebtUpdateResult, { kind: "accepted" }>["value"]["changedFields"] = [],
): string {
  const lines: string[] = [];
  receiptRow(lines, "✓", PAST_VERBS[verb] ?? verb, [{ text: debt.id, opaque: true }], columns);
  lines.push(...entityLines(stateEntity(debt), columns));
  for (const change of changes) lines.push(`  ${change.field}  ${change.action}`);
  return lines.join("\n");
}

function renderMutation(action: string, result: DebtMutationResult, columns: number): string {
  if (result.kind !== "accepted") return renderFailure(action, result, columns);
  return renderAcceptedMutation(action, result.value, columns);
}

export function renderDebtUpdate(result: DebtUpdateResult, context: TextRenderContext = DEFAULT_CONTEXT): string {
  const columns = context.columns;
  if (result.kind !== "accepted") return renderFailure("update", result, columns);
  return renderAcceptedMutation("update", result.value.debt, columns, result.value.changedFields);
}

function renderBatchItem(verb: string, item: DebtBatchResult["items"][number], columns: number): string {
  if (item.outcome.kind === "accepted") return `✓ ${PAST_VERBS[verb] ?? verb}  ${item.id}`;
  if (item.outcome.kind === "retry") return `? ${verb}  ${item.id}  ${item.outcome.reason}`;
  const facts = projectRefusal(item.outcome.refusal);
  const rest = (facts.facts ?? []).filter((fact) => fact !== `debt  ${item.id}`);
  return refusalLines(verb, [`debt  ${item.id}`, `reason  ${facts.diagnostic}`, ...rest], columns).join("\n");
}

function renderBatch(verb: string, batch: DebtBatchResult, columns: number): string {
  return batch.items.map((item) => renderBatchItem(verb, item, columns)).join("\n");
}

export function renderDebtTree(result: DebtDecompositionTree, context: TextRenderContext = DEFAULT_CONTEXT): string {
  return result.kind === "accepted"
    ? treeLines(result.value, context.columns).join("\n")
    : renderFailure("tree", result, context.columns);
}

export function renderDebtContext(result: DebtContextResult, context: TextRenderContext = DEFAULT_CONTEXT): string {
  if (result.kind !== "accepted") return renderFailure("context", result, context.columns);
  const value = result.value.namespace.length === 0 ? "root" : result.value.namespace.join("/");
  return `context ${value} · ${result.value.source}`;
}

/** One single-Debt mutation answer; `verb` is the literal action the leaf invoked. */
export function renderDebtMutation(
  verb: string,
  result: DebtMutationResult,
  context: TextRenderContext = DEFAULT_CONTEXT,
): string {
  return renderMutation(verb, result, context.columns);
}

/** One lifecycle answer: a single mutation or a plural batch, both native shapes. */
export function renderDebtLifecycle(
  verb: string,
  result: DebtMutationResult | DebtBatchResult,
  context: TextRenderContext = DEFAULT_CONTEXT,
): string {
  return "items" in result ? renderBatch(verb, result, context.columns) : renderMutation(verb, result, context.columns);
}

export function debtOutcome(result: DebtNativeResult): CliOutcome {
  if ("issues" in result) return result.issues.length === 0 ? "accepted" : "failed";
  if ("items" in result) {
    const kinds = result.items.map((item) => item.outcome.kind);
    return kinds.includes("retry") ? "retryable" : kinds.includes("refused") ? "refused" : "accepted";
  }
  if ("kind" in result) {
    if (result.kind === "retry") return "retryable";
    if (result.kind === "refused") return "refused";
  }
  return "accepted";
}
