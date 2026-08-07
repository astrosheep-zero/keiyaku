import type { ContractPhase } from "../../index.js";
import type { KanshiReport, Section, TaskKanshiRow } from "../../kanshi/index.js";
import { renderFacts, renderTextBlock, renderVoiceRuler, safeText, tone, type TextRenderContext } from "./terminal.js";

const MARKS = [
  "marks ● active · ○ idle · ? lost · ‖ paused",
  "      ✓ asleep · × stopped · ! dead",
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

function failure(name: string, section: Extract<Section<unknown>, { kind: "failed" }>, context: TextRenderContext): string {
  return `${name} failed\n${tone(`! ${safeText(section.failure.message)}`, "alert", context.color)}`;
}

function renderContracts(report: KanshiReport, context: TextRenderContext): string {
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
      row.gates.satisfied ? "gates satisfied" : "gates pending",
    ];
    lines.push(...renderFacts(`${contractMark(row.phase)} ${safeText(row.id)}`, facts, context.columns));
    for (const gate of row.gates.reports) {
      const facts = gate.current.kind === "attested"
        ? [gate.current.verdict, ...(gate.current.summary === undefined ? [] : [gate.current.summary])]
        : gate.current.kind === "stale"
          ? [`stale (${gate.current.priorVerdict})`]
          : ["missing"];
      lines.push(...renderFacts(`  gate ${safeText(gate.gate)}`, facts, context.columns));
    }
  }
  return lines.join("\n");
}

function renderTasks(report: KanshiReport, context: TextRenderContext): string {
  const section = report.tasks;
  if (section.kind === "absent") return "task absent";
  if (section.kind === "failed") return failure("task", section, context);
  const lines = [`task ${section.value.rows.length}`];
  for (const row of section.value.rows) {
    const contract = row.contract === undefined ? [] : [`keiyaku ${row.contract.id} (${row.contract.observed})`];
    lines.push(...renderFacts(`${taskMark(row)} P${row.priority} ${safeText(row.id)}`, [row.disposition.replaceAll("_", " "), ...contract], context.columns));
    lines.push(...renderTextBlock(row.title, "  ", context.columns).map((line) => tone(line, "dim", context.color)));
  }
  return lines.join("\n");
}

export function renderKanshiText(report: KanshiReport, context: TextRenderContext = { columns: 80, color: false }): string {
  const root = tone(`root ${safeText(report.root)}`, "dim", context.color);
  const akuma = report.akuma.kind === "absent"
    ? "akuma absent"
    : report.akuma.kind === "failed"
      ? failure("akuma", report.akuma, context)
      : "akuma 0";
  return [
    renderVoiceRuler("kanshi", "現世", context.columns),
    root,
    MARKS,
    renderContracts(report, context),
    renderTasks(report, context),
    akuma,
  ].join("\n\n");
}
