import type {
  DebtAbsent,
  DebtCatalogue,
  DebtSummary,
  DebtShowItem,
  DebtDoctorIssue,
  DebtDoctorReport,
  DebtMutationResult,
  DebtRef,
  DebtRefusal,
  DebtShowResult,
  DebtUpdateResult,
  DebtWarning,
} from "../../debt/index.js";
import type { DebtKanshiRow } from "../../kanshi/report.js";
import { associationFact } from "./kanshi-akuma.js";
import { debtMark } from "./marks.js";
import { renderStructuredRefusal } from "./refusal.js";
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
  return { diagnostic, facts: [`detail  ${refusal.diagnostic}`] };
}

function renderFailure(verb: string, result: DebtFailure, id?: string): string {
  if (result.kind === "retry")
    return [`? ${verb} retry${id === undefined ? "" : `  ${safeText(id)}`}`, result.reason].join("\n");
  const facts = projectRefusal(result);
  return renderStructuredRefusal(verb, facts.diagnostic, [
    ...(id === undefined ? [] : [`debt  ${id}`]),
    ...(facts.facts ?? []),
  ]);
}

/** A cleanup problem cannot reverse the confirmed write. */
function warningLines(warning: DebtWarning, columns: number): readonly string[] {
  return ["  ! warning", ...renderOpaqueBlock(warning, "    ", columns)];
}

function edge(label: string, ref: DebtRef): string {
  return `  ${label} ${ref.id} · ${dispositionText(ref.state)}`;
}

export function debtRowLines(row: DebtSummary & Pick<DebtKanshiRow, "contract">): readonly string[] {
  const facts = [
    row.id,
    dispositionText(row.disposition),
    `P${row.priority}`,
    row.title,
    ...(row.contract === undefined ? [] : [associationFact(row.contract)]),
  ];
  return [`${debtMark(row.disposition)} ${safeText(facts.join(" · "))}`];
}

export function renderDebtList(result: DebtCatalogue): string {
  const page = result;
  if ("absent" in page) return "debt world absent";
  const rows = page.rows ?? [];
  if (rows.length === 0) return emptyCatalogue("debts");
  return ["DEBTS", "", ...rows.flatMap(debtRowLines), ...(page.more === true ? ["…"] : [])].join("\n");
}

function textTimestamp(timestamp: string): string {
  return timestamp.replace(/\.\d+(?=Z$)/u, "");
}

function renderShowDetail(id: string, debt: Extract<DebtShowItem, { kind: "found" }>, columns: number): string {
  const lines = [
    ...entityLines(
      { id, priority: debt.priority, mark: debtMark(debt.state), word: debt.state, title: debt.title },
      columns,
    ),
    `  created  ${textTimestamp(debt.createdAt)}`,
    `  updated  ${textTimestamp(debt.updatedAt)}`,
  ];
  for (const need of debt.needs ?? []) lines.push(edge("needs", need));
  for (const label of ["note", "body"] as const) {
    const payload = debt[label];
    if (payload !== undefined)
      lines.push(`  ${label}`, ...payload.split("\n").map((line) => `  ${safeText(line)}`), "");
  }
  return lines.join("\n");
}

/** Each item corresponds to the same invocation position, including missing targets. */
export function renderDebtShow(
  result: DebtShowResult | DebtAbsent,
  context: TextRenderContext = DEFAULT_CONTEXT,
): string {
  if (result.kind === "absent") return "debt world absent";
  return result.items
    .map((item) =>
      item.kind === "found"
        ? renderShowDetail(item.id, item, context.columns)
        : renderStructuredRefusal("show", "debt missing", [`debt  ${item.id}`]),
    )
    .join("\n\n");
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
  if (result.kind !== "accepted") return renderFailure("update", result, id);
  const lines = [`✓ ${PAST_VERBS.update!}${id === undefined ? "" : `  ${safeText(id)}`}`];
  for (const field of result.changes ?? []) lines.push(`  ${field}  changed`);
  if (result.warning !== undefined) lines.push(...warningLines(result.warning, columns));
  return lines.join("\n");
}

/** Creation retains its minted identity in the native answer. */
export function renderDebtMutation(
  verb: string,
  result: DebtMutationResult,
  context: TextRenderContext = DEFAULT_CONTEXT,
): string {
  if (result.kind !== "accepted") return renderFailure(verb, result);
  const lines = [`✓ ${PAST_VERBS[verb] ?? verb}  ${safeText(result.id)}`];
  if (result.warning !== undefined) lines.push(...warningLines(result.warning, context.columns));
  return lines.join("\n");
}
