import type { ContractGateReport, ContractPhase } from "../../index.js";
import type { KanshiReport, Section, TaskKanshiRow } from "../../kanshi/index.js";
import { displayColumns, renderFacts, renderTextBlock, renderVoiceRuler, safeText, tone, type TextRenderContext } from "./terminal.js";

const MARKS = [
  "marks ● active · ○ idle/ready/missing · ⧗ waiting/blocked · ‖ held",
  "      ✓ satisfied · ! failed/unsatisfied · ? stale/lost/unknown · × ended",
].join("\n");

function contractMark(phase: ContractPhase): string {
  if (phase === "claimed") return "✓";
  if (phase === "abandoned") return "×";
  if (phase === "waiting" || phase === "pending-delivery") return "⧗";
  return "●";
}

function taskMark(row: TaskKanshiRow): string {
  if (row.disposition === "done") return "✓";
  if (row.disposition === "drop") return "×";
  if (row.disposition === "on_hold") return "‖";
  if (row.disposition === "in_progress") return "●";
  return row.disposition === "blocked" ? "⧗" : "○";
}

function akumaMark(life: string): string {
  if (life === "running") return "●";
  if (life === "stillborn") return "!";
  if (life === "asleep" || life === "dead") return "○";
  return "?";
}

function gatePresentation(report: ContractGateReport): Readonly<{ mark: string; facts: readonly string[] }> {
  const { current } = report;
  if (current.kind === "missing") return { mark: "○", facts: ["missing"] };
  if (current.kind === "stale") return { mark: "?", facts: ["stale", `was ${current.priorVerdict}`] };
  return current.verdict === "satisfied"
    ? { mark: "✓", facts: ["satisfied"] }
    : { mark: "!", facts: ["unsatisfied"] };
}

function renderGates(
  reports: readonly ContractGateReport[],
  context: TextRenderContext,
  includeSummaries: boolean,
): readonly string[] {
  if (reports.length === 0) return [];
  const names = reports.map((report) => safeText(report.gate));
  const nameColumns = Math.max(...names.map(displayColumns));
  const lines: string[] = [];
  for (const report of reports) {
    const name = safeText(report.gate);
    const presentation = gatePresentation(report);
    const primary = `  ${presentation.mark} ${name}${" ".repeat(nameColumns - displayColumns(name))}`;
    lines.push(...renderFacts(primary, presentation.facts, context.columns));
    if (includeSummaries && report.current.kind === "attested" && report.current.summary !== undefined) {
      lines.push(...renderTextBlock(report.current.summary, "      ", context.columns)
        .map((line) => tone(line, "dim", context.color)));
    }
  }
  return lines;
}

function failure(name: string, section: Extract<Section<unknown>, { kind: "failed" }>, context: TextRenderContext): string {
  return `${name} failed\n${tone(`! ${safeText(section.failure.message)}`, "alert", context.color)}`;
}

function renderContracts(report: KanshiReport, context: TextRenderContext, selection: "world" | "contract"): string {
  const section = report.contracts;
  if (section.kind === "absent") return "keiyaku absent";
  if (section.kind === "failed") return failure("keiyaku", section, context);
  const lines = [`keiyaku ${section.value.rows.length}`];
  for (const row of section.value.rows) {
    const facts = [
      row.phase,
      row.workspace,
      ...(row.target === null ? [] : [`target ${row.target}`]),
      ...(row.candidate === null ? [] : [`candidate ${row.candidate}`]),
    ];
    lines.push(...renderFacts(`${contractMark(row.phase)} ${safeText(row.id)}`, facts, context.columns));
    lines.push(...renderGates(row.gates.reports, context, selection === "contract"));
  }
  return lines.join("\n");
}

function renderTasks(report: KanshiReport, context: TextRenderContext): string {
  const section = report.tasks;
  if (section.kind === "absent") return "task absent";
  if (section.kind === "failed") return failure("task", section, context);
  const active = section.value.rows.filter((row) => row.disposition !== "done" && row.disposition !== "drop");
  const ready = active.filter((row) => row.disposition === "ready").length;
  const onHold = active.filter((row) => row.disposition === "on_hold").length;
  const lines = [`task ${active.length}`];
  const visible = active.filter((row) => row.disposition === "in_progress" || row.disposition === "blocked");
  for (const row of visible) {
    const contract = row.contract === undefined ? [] : [`keiyaku ${row.contract.id} (${row.contract.observed})`];
    lines.push(...renderFacts(`${taskMark(row)} P${row.priority} ${safeText(row.id)}`, [row.title, row.disposition.replaceAll("_", " "), ...contract], context.columns));
  }
  const omitted = [ready > 0 ? `${ready} ready` : undefined, onHold > 0 ? `${onHold} held` : undefined]
    .filter((fact): fact is string => fact !== undefined);
  if (omitted.length > 0) lines.push(tone(`+ ${omitted.join(" · ")}`, "dim", context.color));
  return lines.join("\n");
}

function renderAkuma(report: KanshiReport, context: TextRenderContext): string {
  const section = report.akuma;
  if (section.kind === "absent") return "akuma absent";
  if (section.kind === "failed") return failure("akuma", section, context);
  const lines = [`akuma ${section.value.rows.length}`];
  for (const row of section.value.rows) {
    const pending = "pending" in row && row.pending.length > 0 ? [`pending ${row.pending.length}`] : [];
    const confinement = "confinement" in row
      ? row.confinement.kind === "unconfined"
        ? ["unconfined"]
        : [`writes ${row.confinement.writableRoots.join(" ")}`]
      : [];
    lines.push(...renderFacts(`${akumaMark(row.life)} ${safeText(row.id)}`, [row.life, ...confinement, ...pending], context.columns));
  }
  return lines.join("\n");
}

export function renderKanshiText(
  report: KanshiReport,
  context: TextRenderContext = { columns: 80, color: false },
  selection: "world" | "contract" = "world",
): string {
  const root = tone(`root ${safeText(report.root)}`, "dim", context.color);
  return [
    renderVoiceRuler("kanshi", "現世", context.columns),
    root,
    MARKS,
    renderContracts(report, context, selection),
    renderTasks(report, context),
    renderAkuma(report, context),
  ].join("\n\n");
}
