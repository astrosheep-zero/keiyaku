import type { ContractGateReport, ContractPhase } from "../../index.js";
import type { AkumaKanshiRow, KanshiReport, Section, TaskKanshiRow } from "../../kanshi/index.js";
import { displayColumns, renderTextBlock, safeText, tone, type TextRenderContext } from "./terminal.js";

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

function gateMark(report: ContractGateReport): string {
  if (report.current.kind !== "attested") return "?";
  return report.current.verdict === "satisfied" ? "✓" : "!";
}

function hotFirst<Row>(rows: readonly Row[], hot: (row: Row) => boolean): readonly Row[] {
  return [...rows.filter(hot), ...rows.filter((row) => !hot(row))];
}

function wrapChain(parts: readonly string[], columns: number): readonly string[] {
  if (parts.length === 0) return [];
  const lines: string[] = [];
  let current = "  ";
  for (const part of parts.map(safeText)) {
    const candidate = current === "  " ? `${current}${part}` : `${current} · ${part}`;
    if (current !== "  " && displayColumns(candidate) > columns) {
      lines.push(current);
      current = `  ${part}`;
    } else current = candidate;
  }
  lines.push(current);
  return lines;
}

function wrapHeading(primary: string, facts: readonly string[], columns: number): readonly string[] {
  const head = safeText(primary);
  const lines: string[] = [];
  let current = head;
  for (const fact of facts.map(safeText)) {
    const candidate = `${current} · ${fact}`;
    if (displayColumns(candidate) > columns) {
      lines.push(current);
      current = `  ${fact}`;
    } else current = candidate;
  }
  lines.push(current);
  return lines;
}

function renderGates(
  reports: readonly ContractGateReport[],
  context: TextRenderContext,
  includeSummaries: boolean,
): readonly string[] {
  const lines = [...wrapChain(reports.map((report) => `${gateMark(report)} ${safeText(report.gate)}`), context.columns)];
  if (!includeSummaries) return lines;
  for (const report of reports) {
    if (report.current.kind !== "attested" || report.current.summary === undefined) continue;
    lines.push(...renderTextBlock(`${safeText(report.gate)}: ${report.current.summary}`, "  ", context.columns)
      .map((line) => tone(line, "dim", context.color)));
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
  const rows = hotFirst(section.value.rows, (row) => row.phase === "waiting" || row.phase === "pending-delivery");
  const lines = [`keiyaku ${rows.length}`];
  for (const row of rows) {
    const facts = [
      row.workspace,
      ...(row.candidate === null ? [] : [`candidate ${safeText(row.candidate).slice(0, 8)}`]),
      ...(row.target === null ? [] : [`-> ${row.target}`]),
    ];
    lines.push(`${contractMark(row.phase)} ${safeText(row.id)} ${row.phase}`);
    lines.push(...wrapChain(facts, context.columns));
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
  const visible = hotFirst(
    active.filter((row) => row.disposition === "in_progress" || row.disposition === "blocked"),
    (row) => row.disposition === "blocked",
  );
  const lines = [...wrapHeading(`task ${active.length}`, [`${ready} ready`, `${onHold} held`], context.columns)];
  for (const row of visible) {
    const contract = row.contract === undefined ? [] : [`keiyaku ${row.contract.id} (${row.contract.observed})`];
    lines.push(`${taskMark(row)} ${safeText(row.id)} ${row.disposition}`);
    lines.push(...renderTextBlock(row.title, "  ", context.columns));
    lines.push(...wrapChain([`P${row.priority}`, ...contract], context.columns));
  }
  return lines.join("\n");
}

function isLost(life: string): boolean {
  return life === "stranded" || life === "headless";
}

function akumaPriority(row: AkumaKanshiRow): number {
  if (isLost(row.life) || row.life === "stillborn") return 0;
  return row.life === "running" ? 1 : 2;
}

function firstLine(value: string): string {
  return value.split(/[\r\n\u2028\u2029]/u, 1)[0] ?? "";
}

function truncateDisplay(value: string, columns: number): string {
  if (displayColumns(value) <= columns) return value;
  if (columns <= 0) return "";
  const ellipsis = "…";
  if (columns <= displayColumns(ellipsis)) return ellipsis;
  let result = "";
  let used = 0;
  for (const character of value) {
    const width = displayColumns(character);
    if (used + width + displayColumns(ellipsis) > columns) break;
    result += character;
    used += width;
  }
  return `${result}${ellipsis}`;
}

function bornFacts(row: AkumaKanshiRow): readonly string[] {
  if (!("pending" in row) || (row.life !== "running" && !isLost(row.life))) return [];
  const confinement = row.confinement.kind === "unconfined"
    ? ["unconfined"]
    : row.confinement.writableRoots.map((root, index) => index === 0 ? `writes ${root}` : root);
  return [
    ...(row.pending.length === 0 ? [] : [`pending ${row.pending.length}`]),
    ...confinement,
  ];
}

function stillbornEvidence(row: AkumaKanshiRow, columns: number): string | null {
  if (row.life !== "stillborn" || !("seal" in row) || row.seal === undefined) return null;
  const prefix = "  seal ";
  const evidence = safeText(firstLine(row.seal.evidence)).trim();
  if (evidence.length === 0) return null;
  return `${prefix}${truncateDisplay(evidence, Math.max(0, columns - displayColumns(prefix)))}`;
}

function renderAkuma(report: KanshiReport, context: TextRenderContext): string {
  const section = report.akuma;
  if (section.kind === "absent") return "akuma absent";
  if (section.kind === "failed") return failure("akuma", section, context);
  const rows = [
    ...section.value.rows.filter((row) => akumaPriority(row) === 0),
    ...section.value.rows.filter((row) => akumaPriority(row) === 1),
    ...section.value.rows.filter((row) => akumaPriority(row) === 2),
  ];
  const lines = [`akuma ${rows.length}`];
  for (const row of rows) {
    lines.push(`${akumaMark(row.life)} ${safeText(row.id)} ${row.life}`);
    lines.push(...wrapChain(bornFacts(row), context.columns));
    const evidence = stillbornEvidence(row, context.columns);
    if (evidence !== null) lines.push(evidence);
  }
  return lines.join("\n");
}

export function renderKanshiText(
  report: KanshiReport,
  context: TextRenderContext = { columns: 80, color: false },
  selection: "world" | "contract" = "world",
): string {
  return [
    `kanshi ${safeText(report.root)}`,
    renderContracts(report, context, selection),
    renderTasks(report, context),
    renderAkuma(report, context),
  ].join("\n\n");
}
