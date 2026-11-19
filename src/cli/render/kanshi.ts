import type { KanshiStatusSummary } from "../../kanshi/counts.js";
import type { KanshiContractReport, KanshiReport, ContractKanshiDetail, Section } from "../../kanshi/report.js";
import {
  abbreviateGitIds,
  afterWording,
  displayGitId,
  gateRequirementFacts,
  gitIdsInDetail,
  lifecycleWord,
  mergeSummary,
  requirementDisplayName,
  targetFacts,
  workspaceState,
} from "./contract-observation.js";
import { DEFAULT_CLI_COLUMNS, previewLines, safeText, type TextRenderContext } from "./terminal.js";
import { akumaLabel, renderAkumaBoard } from "./kanshi-akuma.js";
import { contractRowLines } from "./catalog.js";
import { debtRowLines } from "./debt.js";

function payload(label: string, text: string): readonly string[] {
  return [`  ${label}`, ...previewLines(text, "    ")];
}

function renderSelectedContractRow(row: ContractKanshiDetail): readonly string[] {
  const abbreviations = abbreviateGitIds(gitIdsInDetail(row));
  const facts = [
    `holder  ${typeof row.holder === "string" ? row.holder : row.holder === undefined ? "none" : "unavailable"}`,
    ...(row.delivery === undefined
      ? []
      : [
          `candidate  ${displayGitId(row.delivery.candidate, abbreviations)}`,
          `integration result  ${displayGitId(row.delivery.integration, abbreviations)}`,
        ]),
    ...(row.gates ?? []).flatMap(gateRequirementFacts),
    ...(row.after ?? []).map(afterWording),
    ...(row.workspace.kind === "unappointed" ? [] : [`worktree  ${row.workspace.path}`]),
    workspaceState(row.workspace),
    ...targetFacts(row, abbreviations),
    ...[mergeSummary(row.workspace)].filter((fact) => fact !== undefined),
    ...(row.workspace.kind === "present" ? (row.workspace.merge ?? []).map((path) => `conflict  ${path}`) : []),
    ...(row.issue === undefined
      ? []
      : [
          row.issue.kind === "target-checkout-retained"
            ? "checkout behind"
            : `checkout unavailable · ${row.issue.diagnostic}`,
        ]),
    ...(row.roster === undefined
      ? []
      : "kind" in row.roster
        ? ["akuma association unavailable"]
        : row.roster.map((attached) =>
            `akuma  ${attached.id} ${akumaLabel(attached, attached.aliasesUnavailable === true)}`.trimEnd(),
          )),
  ];
  return [
    `${safeText(row.id)} · ${lifecycleWord(row.phase)} · ${safeText(row.title ?? "title unavailable")}`,
    ...facts.map((fact) => `  ${safeText(fact)}`),
    ...(row.gates ?? []).flatMap((gate) =>
      gate.requirements.flatMap((requirement) =>
        requirement.current.kind === "attested" && requirement.current.summary !== undefined
          ? payload(`${requirementDisplayName(gate.gate, requirement)} summary`, requirement.current.summary)
          : [],
      ),
    ),
    ...(row.abandonNote === undefined ? [] : payload("note", row.abandonNote)),
  ];
}

function renderSelectedContract(report: KanshiContractReport): readonly string[] {
  if (report.kind === "contract-absent") return ["  keiyaku absent"];
  if (report.kind === "contract-failed")
    return [`! ${safeText(report.id)} · unavailable · ${safeText(report.diagnostic)}`];
  if (report.kind === "contract-missing") return [`○ ${safeText(report.id)} · missing`];
  return renderSelectedContractRow(report);
}

function countLine<Value>(label: string, section: Section<Value>, render: (value: Value) => string): string {
  if (section.kind === "present") return `${label}  ${render(section.value)}`;
  if (section.kind === "absent") return `${label}  absent`;
  const { message, coordinate } = section.failure;
  return `${label}  unavailable · ${safeText(coordinate === undefined ? message : `${coordinate} · ${message}`)}`;
}

export function renderStatusSummary(report: KanshiStatusSummary): string {
  const lines = [
    countLine("Contracts", report.contracts, ({ total, awaitingReview, conflicts }) => {
      const facts = [`${total} active`, `${awaitingReview} awaiting review`];
      const { known, unavailable } = conflicts;
      if (unavailable === 0 || known > 0)
        facts.push(`${known}${unavailable === 0 ? "" : " known"} conflict${known === 1 ? "" : "s"}`);
      if (unavailable > 0) facts.push(`conflict evidence unavailable for ${unavailable}`);
      return facts.join(" · ");
    }),
    countLine("Akumas", report.akumas, ({ total, byLife }) =>
      [`${total} active`, ...Object.entries(byLife).map(([life, count]) => `${count} ${life}`)].join(" · "),
    ),
    countLine(
      "Debts",
      report.debts,
      ({ total, ready, blocked }) => `${total} open · ${ready} ready · ${blocked} blocked`,
    ),
  ];
  const current = report.currentContract;
  if (current !== undefined) {
    const state = current.state === "awaiting-review" ? "awaiting review" : current.state;
    lines.push(`Current Contract  ${safeText(current.id)} · ${state}`);
  }
  return lines.join("\n");
}

export function renderKanshiText(
  report: KanshiReport | KanshiContractReport,
  context: TextRenderContext = { columns: DEFAULT_CLI_COLUMNS, color: false },
): string {
  if (!("contracts" in report)) return renderSelectedContract(report).join("\n");
  const contracts = report.contracts;
  const debts = report.debts;
  const blocks = [
    contracts.kind === "absent"
      ? ["CONTRACTS // absent"]
      : contracts.kind === "failed"
        ? ["CONTRACTS // unavailable", "", `! ${safeText(contracts.diagnostic)}`]
        : (contracts.rows ?? []).length === 0 && contracts.more !== true
          ? []
          : [
              "CONTRACTS",
              "",
              ...(contracts.rows ?? []).flatMap((row) => contractRowLines(row, report.observedAt)),
              ...(contracts.more === true ? ["…"] : []),
            ],
    renderAkumaBoard(report.akumas, report.observedAt, context, false),
    debts.kind === "absent"
      ? ["DEBTS // absent"]
      : debts.kind === "failed"
        ? [
            "DEBTS // unavailable",
            "",
            `! ${safeText(
              debts.coordinate === undefined ? debts.diagnostic : `${debts.coordinate} · failed ${debts.diagnostic}`,
            )}`,
          ]
        : (debts.rows ?? []).length === 0 && debts.more !== true
          ? []
          : ["DEBTS", "", ...(debts.rows ?? []).flatMap(debtRowLines), ...(debts.more === true ? ["…"] : [])],
  ].filter((block) => block.length > 0);
  return blocks.length === 0 ? "○ world empty" : blocks.map((block) => block.join("\n")).join("\n\n");
}
