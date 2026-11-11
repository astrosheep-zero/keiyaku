import type {
  DebtAbsent,
  DebtCatalogue,
  DebtDetail,
  DebtDoctorIssue,
  DebtDoctorReport,
  DebtMutationResult,
  DebtRef,
  DebtRefusal,
  DebtShowResult,
  DebtTreeNode,
  DebtTreeRoot,
  DebtTreeResult,
  DebtUpdateResult,
  DebtWarning,
} from "../../debt/index.js";
import { debtMark } from "./marks.js";
import { outcomeLines, receiptPayload, receiptRow, refusalLines } from "./receipt.js";
import {
  DEFAULT_CLI_COLUMNS,
  displayColumns,
  emptyCatalogue,
  renderOpaqueBlock,
  renderTextBlock,
  safeText,
  type TextRenderContext,
} from "./terminal.js";

export { debtMark } from "./marks.js";

type DebtFailure = Extract<DebtMutationResult | DebtUpdateResult, { kind: "refused" | "retry" }>;
type DebtEntity = Readonly<{
  id: string;
  priority: number;
  mark: string;
  word?: string;
  title: string;
}>;
type RefusalProjection = Readonly<{ diagnostic: string; facts?: readonly string[] }>;

const DEFAULT_CONTEXT: TextRenderContext = { columns: DEFAULT_CLI_COLUMNS, color: false };

export function dispositionText(word: string): string {
  return word === "drop" ? "dropped" : word.replaceAll("_", " ");
}

function entityLines(entity: DebtEntity, columns: number, indent = ""): readonly string[] {
  const parts = [
    `${entity.mark} ${entity.id}`,
    ...(entity.word === undefined ? [] : [dispositionText(entity.word)]),
    `P${entity.priority}`,
  ];
  const scan = `${indent}${parts.join(" · ")}`;
  const title = safeText(entity.title);
  const inline = `${scan} — ${title}`;
  if (displayColumns(inline) <= columns) return [inline];
  return [scan, ...renderTextBlock(title, `${indent}  `, columns, "—")];
}

function projectRefusal(refusal: DebtRefusal): RefusalProjection {
  const diagnostic = refusal.reason.replaceAll("-", " ");
  if (refusal.reason === "debt-missing") return { diagnostic };
  if (refusal.reason === "invalid-lifecycle-transition")
    return { diagnostic, facts: [`state  ${dispositionText(refusal.state)}`] };
  if (refusal.reason === "relation-owned-by-other") return { diagnostic, facts: [`related debt  ${refusal.related}`] };
  return { diagnostic, facts: [`detail  ${refusal.diagnostic}`] };
}

function renderFailure(verb: string, result: DebtFailure, columns: number, id?: string): string {
  if (result.kind === "retry") return [...outcomeLines("?", verb, "retry", id, columns), result.reason].join("\n");
  const facts = projectRefusal(result);
  return refusalLines(
    verb,
    [...(id === undefined ? [] : [`debt  ${id}`]), `reason  ${facts.diagnostic}`, ...(facts.facts ?? [])],
    columns,
  ).join("\n");
}

/** A cleanup problem cannot reverse the confirmed write. */
function warningLines(warning: DebtWarning, columns: number): readonly string[] {
  return ["  ! warning", ...renderOpaqueBlock(warning, "    ", columns)];
}

function edge(label: string, ref: DebtRef): string {
  return `  ${label} ${ref.id} · ${dispositionText(ref.state)}`;
}

export function renderDebtList(result: DebtCatalogue, context: TextRenderContext = DEFAULT_CONTEXT): string {
  const page = result;
  const columns = context.columns;
  if (page.kind === "absent") return "debt world absent";
  const rows = page.rows ?? [];
  const view = "debts";
  if (rows.length === 0) return emptyCatalogue(view);
  return [
    "DEBTS // world",
    ...rows.flatMap((row) => entityLines({ ...row, mark: debtMark(row.disposition), word: row.disposition }, columns)),
    ...(page.more === true ? ["…"] : []),
  ].join("\n");
}

function textTimestamp(timestamp: string): string {
  return timestamp.replace(/\.\d+(?=Z$)/u, "");
}

function renderShowDetail(id: string, debt: DebtDetail, columns: number): string {
  const lines = [
    ...entityLines(
      { id, priority: debt.priority, mark: debtMark(debt.state), word: debt.state, title: debt.title },
      columns,
    ),
    `  created  ${textTimestamp(debt.createdAt)}`,
    `  updated  ${textTimestamp(debt.updatedAt)}`,
    ...(debt.createdBy === undefined ? [] : [`  created by  ${debt.createdBy}`]),
  ];
  for (const need of debt.needs ?? []) lines.push(edge("needs", need));
  if (debt.parent !== undefined) lines.push(edge("parent", debt.parent));
  for (const item of debt.supersedes ?? []) lines.push(edge("supersedes", item));
  for (const item of debt.relates ?? []) lines.push(edge("relates", item));
  if (debt.note !== undefined) receiptPayload(lines, "note", debt.note);
  if (debt.body !== undefined) receiptPayload(lines, "body", debt.body);
  return lines.join("\n");
}

/** Each item corresponds to the same invocation position, including missing targets. */
export function renderDebtShow(
  ids: readonly string[],
  result: DebtShowResult | DebtAbsent,
  context: TextRenderContext = DEFAULT_CONTEXT,
): string {
  if (result.kind === "absent") return "debt world absent";
  return result.items
    .map((item, index) =>
      item.kind === "found"
        ? renderShowDetail(ids[index]!, item, context.columns)
        : refusalLines("show", ["reason  debt missing", `debt  ${ids[index]!}`], context.columns).join("\n"),
    )
    .join("\n\n");
}

function treeLines(id: string, node: DebtTreeRoot | DebtTreeNode, columns: number, depth = 0): readonly string[] {
  const indent = "  ".repeat(depth);
  if ("kind" in node && node.kind === "cycle") return [`${indent}! ${node.id} · cycle`];
  return [
    ...entityLines(
      { id, priority: node.priority, mark: debtMark(node.state), word: node.state, title: node.title },
      columns,
      indent,
    ),
    ...(node.children ?? []).flatMap((child) => treeLines(child.id, child, columns, depth + 1)),
  ];
}

function doctorIssue(issue: DebtDoctorIssue): string {
  if (issue.kind === "missing-target") return `! missing-target ${issue.debtId} ${issue.relation} ${issue.target}`;
  if (issue.kind === "self-relation") return `! self-relation ${issue.debtId} ${issue.relation}`;
  return `! cycle ${issue.relation} ${issue.debts.join(" ")}`;
}

export function renderDoctor(report: DebtDoctorReport | DebtAbsent): string {
  if (report.kind === "absent") return "debt world absent";
  if (report.issues === undefined) return "✓ doctor  healthy";
  const noun = report.issues.length === 1 ? "issue" : "issues";
  return [`! doctor  ${report.issues.length} ${noun}`, ...report.issues.map(doctorIssue)].join("\n");
}

const PAST_VERBS: Readonly<Record<string, string>> = { add: "added", update: "updated" };

export function renderDebtUpdate(
  id: string | undefined,
  result: DebtUpdateResult,
  context: TextRenderContext = DEFAULT_CONTEXT,
): string {
  const columns = context.columns;
  if (result.kind !== "accepted") return renderFailure("update", result, columns, id);
  const lines: string[] = [];
  receiptRow(lines, "✓", PAST_VERBS.update!, id === undefined ? [] : [{ text: id, opaque: true }], columns);
  for (const field of result.changes ?? []) lines.push(`  ${field}  changed`);
  if (result.warning !== undefined) lines.push(...warningLines(result.warning, columns));
  return lines.join("\n");
}

export function renderDebtTree(
  id: string,
  result: DebtTreeResult | DebtAbsent,
  context: TextRenderContext = DEFAULT_CONTEXT,
): string {
  if (result.kind === "absent") return "debt world absent";
  if (result.kind === "missing")
    return refusalLines("tree", ["reason  debt missing", `debt  ${id}`], context.columns).join("\n");
  return treeLines(id, result, context.columns).join("\n");
}

/** Creation retains its minted identity in the native answer. */
export function renderDebtMutation(
  verb: string,
  result: DebtMutationResult,
  context: TextRenderContext = DEFAULT_CONTEXT,
): string {
  if (result.kind !== "accepted") return renderFailure(verb, result, context.columns);
  const lines: string[] = [];
  receiptRow(lines, "✓", PAST_VERBS[verb] ?? verb, [{ text: result.id, opaque: true }], context.columns);
  if (result.warning !== undefined) lines.push(...warningLines(result.warning, context.columns));
  return lines.join("\n");
}
