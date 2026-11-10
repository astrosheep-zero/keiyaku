import type {
  ContractKanshiBoard,
  ContractKanshiDetail,
  DebtKanshiRow,
  DebtKanshiWorld,
  KanshiCategoryByOwner,
  KanshiCategoryReport,
  KanshiContractReport,
  KanshiReport,
  BoardSection,
} from "../../kanshi/report.js";
type BoardRow = NonNullable<ContractKanshiBoard["rows"]>[number];
import type { DebtSummary } from "../../debt/index.js";
import {
  contractAttentionFacts,
  abbreviateGitIds,
  afterWording,
  displayGitId,
  gateGlyph,
  requirementDisplayName,
  gateRequirementFacts,
  gitIdsInDetail,
  lifecycleWord,
  mergeSummary,
  progressStrip,
  targetMoved,
  targetMovementFacts,
  workspaceState,
} from "./contract-observation.js";
import {
  DEFAULT_CLI_COLUMNS,
  emptyCatalogue,
  elapsedMilliseconds,
  entityLines,
  identityLine,
  plumbFacts,
  renderBoundedPayload,
  renderSectionBlock,
  safeText,
  tone,
  type SemanticTone,
  type TextRenderContext,
} from "./terminal.js";
import { associationFact, formatAge, NARROW_COLUMNS, renderAkuma, renderAkumaBoard } from "./kanshi-akuma.js";
import { contractDetailMark, contractMark, debtDispositionMark } from "./marks.js";
import { dispositionText } from "./debt.js";

const REVIEW_ATTENTION_MS = 15 * 60 * 1_000;
const PENDING_ATTENTION_MS = 60 * 60 * 1_000;

function contractHasError(row: BoardRow): boolean {
  return (
    row.title === undefined ||
    row.attention !== undefined ||
    (row.gates ?? []).some((gate) => gate.verdict === "unsatisfied")
  );
}

function contractStatusTone(row: BoardRow, observedAt: string): SemanticTone | null {
  if (contractHasError(row)) return "alert";
  const phaseAge = elapsedMilliseconds(row.phaseAt, observedAt);
  if (phaseAge === null) return null;
  if (row.delivered === true && phaseAge >= REVIEW_ATTENTION_MS) return "attention";
  return row.delivered !== true && phaseAge >= PENDING_ATTENTION_MS ? "attention" : null;
}

/** Summary associations name their observed owner identity; unavailable authority stays explicit. */
function associationFacts(associations: NonNullable<BoardRow["associations"]>): readonly string[] {
  return associations.map((association) => {
    if (association.kind === "unavailable") return `${association.source} association unavailable`;
    if (association.kind === "debt") return `debt  ${association.debtId}`;
    if (association.aliases !== undefined) return `akuma  ${association.akumaId} (${association.aliases.join(" ")})`;
    return association.aliasesUnavailable === true
      ? `akuma  ${association.akumaId} (aliases unavailable)`
      : `akuma  ${association.akumaId}`;
  });
}

function contractSummaryFacts(row: BoardRow): readonly string[] {
  const associations = row.associations === undefined ? [] : associationFacts(row.associations);
  return [progressStrip(row), ...contractAttentionFacts(row), ...associations];
}

function renderWorldContractRow(row: BoardRow, observedAt: string, context: TextRenderContext): readonly string[] {
  const statusTone = contractStatusTone(row, observedAt);
  return entityLines({
    mark: statusTone === null ? contractMark(row) : tone(contractMark(row), statusTone, context.color),
    identity: row.id,
    state: formatAge(row.phaseAt, observedAt),
    title: row.title ?? "title unavailable",
    facts: contractSummaryFacts(row),
    context,
  });
}

/**
 * One Contract board section. A category board states its own emptiness; the World
 * board leaves an empty section out because the world is its surrounding answer.
 */
function contractBoardRows(
  board: ContractKanshiBoard,
  observedAt: string,
  context: TextRenderContext,
): readonly string[] {
  const rendered = renderSectionBlock({
    name: "CONTRACTS",
    rows: (board.rows ?? []).map((row) => renderWorldContractRow(row, observedAt, context)),
    hasMore: board.more === true,
  });
  return ["CONTRACTS // recent", ...rendered.slice(1)];
}

function renderContractBoard(
  section: BoardSection<ContractKanshiBoard>,
  observedAt: string,
  context: TextRenderContext,
  emptyRows: readonly string[],
): readonly string[] {
  if (section.kind === "absent") return ["CONTRACTS // absent"];
  if (section.kind === "failed") {
    const failure = ["CONTRACTS // unavailable", "", tone(`! ${safeText(section.diagnostic)}`, "alert", context.color)];
    return failure;
  }
  const board = section;
  if ((board.rows ?? []).length === 0) return emptyRows;
  return contractBoardRows(board, observedAt, context);
}

function detailHasError(row: ContractKanshiDetail): boolean {
  if (row.title === undefined) return true;
  if (row.phase === "claimed" || row.phase === "abandoned") return row.issue !== undefined;
  return (
    (row.gates ?? []).some((gate) =>
      gate.requirements.some(
        (requirement) => requirement.current.kind === "attested" && requirement.current.verdict === "unsatisfied",
      ),
    ) ||
    row.targetLag?.kind === "unknown" ||
    row.workspace.kind === "unavailable" ||
    row.issue !== undefined
  );
}

function semanticBlock(_name: string, facts: readonly string[], _context: TextRenderContext): readonly string[] {
  if (facts.length === 0) return [];
  return facts.map((fact) => `  ${safeText(fact)}`);
}

function payload(label: string, text: string, context: TextRenderContext): readonly string[] {
  return renderBoundedPayload({
    text,
    first: `  ${label}  `,
    continuation: "    │ ",
    columns: context.columns,
    maxLines: 3,
    quote: "“",
    truncated: false,
  });
}

function detailProgressStrip(row: ContractKanshiDetail): string {
  return [
    `[${row.delivery === undefined ? " " : "✓"}] delivery`,
    ...(row.gates ?? []).flatMap((gate) =>
      gate.requirements.map((requirement) => {
        const glyph = requirement.current.kind === "attested" ? gateGlyph(requirement) : " ";
        return `[${glyph}] ${requirementDisplayName(gate.gate, requirement)}`;
      }),
    ),
  ].join("  ");
}

function terminalFacts(
  row: ContractKanshiDetail,
  context: TextRenderContext,
  abbreviations: ReadonlyMap<string, string>,
): readonly string[] {
  if (row.phase === "abandoned") return row.abandonNote === undefined ? [] : payload("note", row.abandonNote, context);
  const integration = row.delivery?.integration;
  const review = (row.gates ?? [])
    .find((gate) => gate.gate === "reviewed")
    ?.requirements.find(
      (requirement) => requirement.current.kind === "attested" && requirement.current.summary !== undefined,
    );
  return [
    ...(integration === undefined ? [] : [`landed  ${displayGitId(integration, abbreviations)}`]),
    ...(review?.current.kind === "attested" && review.current.summary !== undefined
      ? payload("review", review.current.summary, context)
      : []),
  ];
}

/** A roster attachment keeps the owner's alias values; unknown life stays absent rather than invented. */
function linkedAkumaRows(row: ContractKanshiDetail): readonly string[] {
  const roster = row.roster;
  if (roster === undefined) return [];
  if ("kind" in roster) return ["  akuma association unavailable"];
  return roster.map((attached) => {
    const aliases =
      attached.aliases !== undefined
        ? attached.aliases.map((alias) => safeText(alias)).join(" ")
        : attached.aliasesUnavailable === true
          ? "aliases unavailable"
          : "";
    const identity = [safeText(attached.id), aliases.length === 0 ? "" : `(${aliases})`].filter(Boolean).join(" ");
    return `  akuma  ${identity}`;
  });
}

function mergeFacts(row: ContractKanshiDetail): readonly string[] {
  const summary = mergeSummary(row.workspace);
  return summary === undefined ? [] : [summary];
}

function issueAlarm(issue: NonNullable<ContractKanshiDetail["issue"]>, target?: string): string {
  return issue.kind === "target-checkout-retained"
    ? `checkout behind${target === undefined ? "" : `  ${target}`}`
    : `checkout unavailable · ${issue.diagnostic}`;
}

function liveAlarms(row: ContractKanshiDetail): readonly string[] {
  return [
    ...mergeFacts(row),
    ...(typeof row.holder === "object" ? ["debt unavailable"] : []),
    ...(typeof row.holder === "string" && row.namespaceDebts.kind !== "present" ? ["debt unavailable"] : []),
    ...(row.issue === undefined ? [] : [issueAlarm(row.issue, row.target)]),
    ...(row.workspace.kind === "unavailable" ? [workspaceState(row.workspace)] : []),
  ].map((alarm) => `! ${alarm}`);
}

/** One Debt row grammar serves the World board and the selected Contract's owned namespace view. */
function debtRowLines(row: DebtKanshiRow | DebtSummary, context: TextRenderContext): readonly string[] {
  const contract = "contract" in row ? row.contract : undefined;
  const relation = contract === undefined ? [] : [associationFact(contract)];
  const childFacts: readonly string[] = [];
  const association = relation.length === 0 ? "" : ` · ${relation.join(" · ")}`;
  if (context.columns > NARROW_COLUMNS)
    return [
      identityLine(
        debtDispositionMark(row.disposition),
        row.id,
        `· ${dispositionText(row.disposition)} · P${row.priority} · ${row.title}${association}`,
      ),
      ...plumbFacts(childFacts, context.columns),
    ];
  return entityLines({
    mark: debtDispositionMark(row.disposition),
    identity: row.id,
    state: `${dispositionText(row.disposition)} · P${row.priority}`,
    title: row.title,
    facts: [...relation, ...childFacts],
    context,
  });
}

function namespaceDebtLines(row: ContractKanshiDetail, context: TextRenderContext): readonly string[] {
  const debts = row.namespaceDebts;
  if (debts.kind === "absent") return [];
  if (debts.kind === "failed") return [tone(`  ! debt  ${safeText(debtFailureFact(debts))}`, "alert", context.color)];
  const bounded = { ...context, columns: Math.max(1, context.columns - 2) };
  return (debts.rows ?? []).flatMap((debt) => debtRowLines(debt, bounded).map((line) => `  ${line}`));
}

function worktreeFacts(row: ContractKanshiDetail): readonly string[] {
  return row.workspace.kind === "unappointed" ? [] : [`worktree  ${row.workspace.path}`];
}

function renderSelectedContractRow(
  id: string,
  row: ContractKanshiDetail,
  context: TextRenderContext,
): readonly string[] {
  const statusTone = detailHasError(row) ? "alert" : null;
  const abbreviations = abbreviateGitIds(gitIdsInDetail(row));
  const lines = [
    ...entityLines({
      mark: statusTone === null ? contractDetailMark(row) : tone(contractDetailMark(row), statusTone, context.color),
      identity: id,
      state: lifecycleWord(row.phase),
      title: row.title ?? "title unavailable",
      facts: [],
      context,
    }),
  ];
  if (row.phase === "claimed" || row.phase === "abandoned") {
    const outcome = terminalFacts(row, context, abbreviations);
    lines.push(...outcome.map((fact) => (fact.startsWith("  ") ? fact : `  ${safeText(fact)}`)));
    // A terminal Contract still carries a physical retention issue; its worktree is expected to be gone.
    lines.push(
      ...semanticBlock("alarms", row.issue === undefined ? [] : [`! ${issueAlarm(row.issue, row.target)}`], context),
    );
    lines.push(...linkedAkumaRows(row), ...namespaceDebtLines(row, context));
    return lines;
  }
  const deniedReview = (row.gates ?? [])
    .find((gate) => gate.gate === "reviewed")
    ?.requirements.find(
      (requirement) => requirement.current.kind === "attested" && requirement.current.verdict === "unsatisfied",
    );
  lines.push(...semanticBlock("ball", [detailProgressStrip(row)], context));
  lines.push(...semanticBlock("gates", (row.gates ?? []).flatMap(gateRequirementFacts), context));
  lines.push(...semanticBlock("prerequisites", (row.after ?? []).map(afterWording), context));
  if (row.delivery !== undefined) {
    const moved = targetMoved(row);
    lines.push(
      ...semanticBlock(
        "candidate",
        [
          `candidate  ${displayGitId(row.delivery.candidate, abbreviations)}`,
          `integration result  ${displayGitId(row.delivery.integration, abbreviations)}${moved ? " · target moved since" : ""}`,
          ...(moved ? targetMovementFacts(row, abbreviations) : []),
        ],
        context,
      ),
    );
  }
  if (deniedReview?.current.kind === "attested" && deniedReview.current.summary !== undefined)
    lines.push(...payload("review  ×", deniedReview.current.summary, context));
  lines.push(...linkedAkumaRows(row));
  lines.push(...semanticBlock("worktree", worktreeFacts(row), context));
  lines.push(...semanticBlock("alarms", liveAlarms(row), context));
  lines.push(...namespaceDebtLines(row, context));
  return lines;
}

function debtFailureFact(failure: Readonly<{ diagnostic: string; coordinate?: string }>): string {
  return failure.coordinate === undefined ? failure.diagnostic : `${failure.coordinate} · failed ${failure.diagnostic}`;
}

function renderSelectedContract(report: KanshiContractReport, context: TextRenderContext): readonly string[] {
  if (report.kind === "contract-absent") return ["  keiyaku absent"];
  if (report.kind === "contract-failed")
    return [tone(`! ${safeText(report.id)} · unavailable · ${safeText(report.diagnostic)}`, "alert", context.color)];
  if (report.kind === "contract-missing") return [`○ ${safeText(report.id)} · missing`];
  return renderSelectedContractRow(report.id, report, context);
}

function debtBoardRows(board: DebtKanshiWorld, context: TextRenderContext): readonly string[] {
  return [
    "DEBTS // recent",
    ...renderSectionBlock({ name: "DEBTS", rows: (board.rows ?? []).map((row) => debtRowLines(row, context)) }).slice(
      1,
    ),
    ...(board.more === true ? ["…"] : []),
  ];
}

function renderDebts(report: KanshiReport, context: TextRenderContext): readonly string[] {
  const section = report.debts;
  if (section.kind === "absent") return ["DEBTS // absent"];
  if (section.kind === "failed") {
    const failure = [
      "DEBTS // unavailable",
      "",
      tone(`! ${safeText(debtFailureFact(section))}`, "alert", context.color),
    ];
    return failure;
  }
  return (section.rows ?? []).length === 0 ? [] : debtBoardRows(section, context);
}

export function renderKanshiText(
  report: KanshiReport | KanshiContractReport,
  context: TextRenderContext = { columns: DEFAULT_CLI_COLUMNS, color: false },
): string {
  if (!("contracts" in report)) return renderSelectedContract(report, context).join("\n");
  const blocks = [
    renderContractBoard(report.contracts, report.observedAt, context, []),
    renderAkuma(report, context),
    renderDebts(report, context),
  ].filter((block) => block.length > 0);
  return blocks.length === 0 ? "○ world empty" : blocks.map((block) => block.join("\n")).join("\n\n");
}

const categoryRenderers: {
  [C in keyof KanshiCategoryByOwner]: (
    report: KanshiCategoryByOwner[C],
    context: TextRenderContext,
  ) => readonly string[];
} = {
  contract: (report, context) =>
    renderContractBoard(report.section, report.observedAt, context, [emptyCatalogue("contracts")]),
  akuma: (report, context) => renderAkumaBoard(report.section, report.observedAt, context, [emptyCatalogue("akuma")]),
};

/** Invocation context selects the owner renderer without inspecting result rows. */
export function renderKanshiCategoryText<C extends keyof KanshiCategoryByOwner>(
  report: KanshiCategoryReport<C>,
  category: C,
  context: TextRenderContext = { columns: DEFAULT_CLI_COLUMNS, color: false },
): string {
  return categoryRenderers[category](report, context).join("\n");
}
