import type {
  AkumaKanshiRow,
  ContractKanshiBoard,
  ContractKanshiDetail,
  DebtKanshiRow,
  DebtKanshiWorld,
  KanshiContractReport,
  KanshiReport,
  BoardSection,
} from "../../kanshi/report.js";
type BoardRow = NonNullable<ContractKanshiBoard["rows"]>[number];
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
  entityLines,
  identityLine,
  renderBoundedPayload,
  renderSectionBlock,
  safeText,
  tone,
  type SemanticTone,
  type TextRenderContext,
} from "./terminal.js";
import {
  associationFact,
  formatAge,
  NARROW_COLUMNS,
  renderAkumaBoard,
  akumaLabel,
  akumaRowLines,
} from "./kanshi-akuma.js";
import { contractDetailMark, contractMark, debtDispositionMark } from "./marks.js";
import { dispositionText } from "./debt.js";

function contractHasError(row: BoardRow): boolean {
  return (
    row.title === undefined ||
    row.attention !== undefined ||
    (row.gates ?? []).some((gate) => gate.verdict === "unsatisfied")
  );
}

function contractSummaryFacts(row: BoardRow): readonly string[] {
  const associations = (row.associations ?? []).flatMap((association) => {
    if (association.kind === "unavailable") return [`${association.source} association unavailable`];
    return association.kind === "debt" ? [`debt  ${association.debtId}`] : [];
  });
  return [progressStrip(row), ...contractAttentionFacts(row), ...associations];
}

function renderWorldContractRow(row: BoardRow, observedAt: string, context: TextRenderContext): readonly string[] {
  const statusTone: SemanticTone | null = contractHasError(row) ? "alert" : null;
  return entityLines({
    mark: statusTone === null ? contractMark(row) : tone(contractMark(row), statusTone, context.color),
    identity: row.id,
    state: `${lifecycleWord(row.phase)} · ${formatAge(row.phaseAt, observedAt)}`,
    title: row.title ?? "title unavailable",
    facts: contractSummaryFacts(row),
    context,
  });
}

/** The World omits an empty Contract section. */
function contractBoardRows(
  board: ContractKanshiBoard,
  observedAt: string,
  context: TextRenderContext,
  children: ReadonlyMap<string, readonly AkumaKanshiRow[]>,
  aliasesUnavailable: boolean,
): readonly string[] {
  const nestedContext = { ...context, columns: Math.max(1, context.columns - 2) };
  const rendered = renderSectionBlock({
    name: "CONTRACTS",
    rows: (board.rows ?? []).map((row) => [
      ...renderWorldContractRow(row, observedAt, context),
      ...(children.get(row.id) ?? []).flatMap((child) => {
        const { contract: _contract, ...facts } = child;
        return akumaRowLines(facts, aliasesUnavailable, observedAt, nestedContext).map((line) => `  ${line}`);
      }),
    ]),
    hasMore: board.more === true,
  });
  return ["CONTRACTS // recent", ...rendered.slice(1)];
}

function renderContractBoard(
  section: BoardSection<ContractKanshiBoard>,
  observedAt: string,
  context: TextRenderContext,
  children: ReadonlyMap<string, readonly AkumaKanshiRow[]>,
  aliasesUnavailable: boolean,
): readonly string[] {
  if (section.kind === "absent") return ["CONTRACTS // absent"];
  if (section.kind === "failed") {
    return ["CONTRACTS // unavailable", "", tone(`! ${safeText(section.diagnostic)}`, "alert", context.color)];
  }
  if ((section.rows ?? []).length === 0) return [];
  return contractBoardRows(section, observedAt, context, children, aliasesUnavailable);
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

function semanticBlock(facts: readonly string[]): readonly string[] {
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
    const aliases = safeText(akumaLabel(attached, attached.aliasesUnavailable === true));
    return `  akuma  ${safeText(attached.id)}${aliases === "" ? "" : ` ${aliases}`}`;
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
    ...(row.issue === undefined ? [] : [issueAlarm(row.issue, row.target)]),
    ...(row.workspace.kind === "unavailable" ? [workspaceState(row.workspace)] : []),
  ].map((alarm) => `! ${alarm}`);
}

function debtRowLines(row: DebtKanshiRow, context: TextRenderContext): readonly string[] {
  const contract = row.contract;
  const relation = contract === undefined ? [] : [associationFact(contract)];
  const association = relation.length === 0 ? "" : ` · ${relation.join(" · ")}`;
  if (context.columns > NARROW_COLUMNS)
    return [
      identityLine(
        debtDispositionMark(row.disposition),
        row.id,
        `· ${dispositionText(row.disposition)} · P${row.priority} · ${row.title}${association}`,
      ),
    ];
  return entityLines({
    mark: debtDispositionMark(row.disposition),
    identity: row.id,
    state: `${dispositionText(row.disposition)} · P${row.priority}`,
    title: row.title,
    facts: relation,
    context,
  });
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
      facts:
        typeof row.holder === "string"
          ? [`debt  ${row.holder}`]
          : row.holder === undefined
            ? []
            : ["debt association unavailable"],
      context,
    }),
  ];
  if (row.phase === "claimed" || row.phase === "abandoned") {
    const outcome = terminalFacts(row, context, abbreviations);
    lines.push(...outcome.map((fact) => (fact.startsWith("  ") ? fact : `  ${safeText(fact)}`)));
    // A terminal Contract still carries a physical retention issue; its worktree is expected to be gone.
    lines.push(...semanticBlock(row.issue === undefined ? [] : [`! ${issueAlarm(row.issue, row.target)}`]));
    lines.push(...linkedAkumaRows(row));
    return lines;
  }
  const deniedReview = (row.gates ?? [])
    .find((gate) => gate.gate === "reviewed")
    ?.requirements.find(
      (requirement) => requirement.current.kind === "attested" && requirement.current.verdict === "unsatisfied",
    );
  lines.push(...semanticBlock([detailProgressStrip(row)]));
  lines.push(...semanticBlock((row.gates ?? []).flatMap(gateRequirementFacts)));
  lines.push(...semanticBlock((row.after ?? []).map(afterWording)));
  if (row.delivery !== undefined) {
    const moved = targetMoved(row);
    lines.push(
      ...semanticBlock([
        `candidate  ${displayGitId(row.delivery.candidate, abbreviations)}`,
        `integration result  ${displayGitId(row.delivery.integration, abbreviations)}${moved ? " · target moved since" : ""}`,
        ...(moved ? targetMovementFacts(row, abbreviations) : []),
      ]),
    );
  }
  if (deniedReview?.current.kind === "attested" && deniedReview.current.summary !== undefined)
    lines.push(...payload("review  ×", deniedReview.current.summary, context));
  lines.push(...linkedAkumaRows(row));
  lines.push(...semanticBlock(worktreeFacts(row)));
  lines.push(...semanticBlock(liveAlarms(row)));
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
    return ["DEBTS // unavailable", "", tone(`! ${safeText(debtFailureFact(section))}`, "alert", context.color)];
  }
  return (section.rows ?? []).length === 0 ? [] : debtBoardRows(section, context);
}

function renderUngroupedAkumas(
  report: KanshiReport,
  rows: readonly AkumaKanshiRow[],
  context: TextRenderContext,
): readonly string[] {
  return renderAkumaBoard(report.akumas, report.observedAt, context, [], rows);
}

export function renderKanshiText(
  report: KanshiReport | KanshiContractReport,
  context: TextRenderContext = { columns: DEFAULT_CLI_COLUMNS, color: false },
): string {
  if (!("contracts" in report)) return renderSelectedContract(report, context).join("\n");
  const children = new Map<string, AkumaKanshiRow[]>(
    report.contracts.kind === "present" ? (report.contracts.rows ?? []).map((row) => [row.id, []]) : [],
  );
  const ungrouped: AkumaKanshiRow[] = [];
  if (report.akumas.kind === "present") {
    for (const row of report.akumas.rows ?? []) {
      const group = row.contract?.kind === "associated" ? children.get(row.contract.contractId) : undefined;
      (group ?? ungrouped).push(row);
    }
  }
  const blocks = [
    renderContractBoard(
      report.contracts,
      report.observedAt,
      context,
      children,
      report.akumas.kind === "present" && report.akumas.aliasesError !== undefined,
    ),
    renderUngroupedAkumas(report, ungrouped, context),
    renderDebts(report, context),
  ].filter((block) => block.length > 0);
  return blocks.length === 0 ? "○ world empty" : blocks.map((block) => block.join("\n")).join("\n\n");
}
