import type { ContractGateReport } from "../../index.js";
import type {
  AkumaKanshiRow,
  ContractKanshiRow,
  KanshiReport,
  Section,
  TaskKanshiRow,
} from "../../kanshi/index.js";
import { akumaHot, visibleFleetRows } from "../../kanshi/fleet.js";
import {
  abbreviateGitIds,
  afterWording,
  dependentWording,
  displayGitId,
  gateGlyph,
  gitIdsInRow,
  mergeSummary,
} from "./contract-observation.js";
import { displayColumns, renderTextBlock, safeText, tone, type TextRenderContext } from "./terminal.js";

const PLUMB = "  │ ";
const PATH_PREFIX = `${PLUMB}↳ `;
const MAX_VISIBLE_ROWS = 10;
const FIELD_WIDTH = 8;

function contractMark(row: ContractKanshiRow): string {
  if (row.phase === "claimed") return "✓";
  if (row.phase === "abandoned") return "×";
  if (row.title === null) return "?";
  if (row.gates.reports.some((report) => report.current.kind === "attested" && report.current.verdict === "unsatisfied")) {
    return "!";
  }
  if (row.targetLag.kind === "unknown") return "?";
  if (row.phase === "waiting") return "○";
  return "●";
}

function taskMark(row: TaskKanshiRow): string {
  if (row.disposition === "done") return "✓";
  if (row.disposition === "drop") return "×";
  if (row.disposition === "on_hold") return "⧗";
  if (row.disposition === "in_progress") return "●";
  return row.disposition === "blocked" ? "‖" : "○";
}

function akumaMark(life: string): string {
  if (life === "running") return "●";
  if (life === "stillborn") return "!";
  if (life === "asleep") return "○";
  if (life === "killed") return "×";
  return "?";
}

function gitAbbreviations(report: KanshiReport): ReadonlyMap<string, string> {
  const ids: string[] = [];
  if (report.contracts.kind !== "present") return abbreviateGitIds(ids);
  if (report.contracts.value.state !== null) ids.push(report.contracts.value.state);
  for (const row of report.contracts.value.rows) ids.push(...gitIdsInRow(row));
  return abbreviateGitIds(ids);
}

function formatAge(source: string | null | undefined, observedAt: string): string {
  if (source === null || source === undefined) return "—";
  const sourceMs = Date.parse(source);
  const observedMs = Date.parse(observedAt);
  if (sourceMs > observedMs) return "future";
  const seconds = Math.floor((observedMs - sourceMs) / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function branchName(target: string | null): string | null {
  if (target === null) return null;
  return target.startsWith("refs/heads/") ? target.slice("refs/heads/".length) : target;
}

function targetFacts(row: ContractKanshiRow): readonly string[] {
  const name = branchName(row.target);
  if (name === null) return ["no target"];
  const facts = [`target ${name}`];
  if (row.targetLag.kind === "unknown") facts.push(`commits behind ${name} unknown`);
  if (row.targetLag.kind === "counted") facts.push(`${row.targetLag.behind} commits behind ${name}`);
  if (row.targetObservation?.drift === true) facts.push("target moved");
  return facts;
}

function workspaceState(row: ContractKanshiRow): string {
  const observation = row.workspaceObservation;
  if (row.workspace === "here" && observation.kind === "failed") {
    return `workspace here · failed · ${observation.diagnostic}`;
  }
  if (row.workspace === "here") return `workspace here · ${observation.kind}`;
  if (observation.kind === "failed") return `worktree unavailable · ${observation.diagnostic}`;
  if (observation.kind === "unappointed") return "worktree unappointed";
  if (observation.kind === "unavailable") return "worktree unavailable";
  if (observation.kind === "clean") return "worktree clean";
  const counts = [
    ...(observation.counts.staged > 0 ? [`staged ${observation.counts.staged}`] : []),
    ...(observation.counts.unstaged > 0 ? [`unstaged ${observation.counts.unstaged}`] : []),
    ...(observation.counts.untracked > 0 ? [`untracked ${observation.counts.untracked}`] : []),
    ...(observation.counts.submodules > 0 ? [`submodules ${observation.counts.submodules}`] : []),
  ];
  return counts.length === 0 ? "worktree dirty" : `worktree dirty · ${counts.join(" · ")}`;
}

function mergeFacts(
  row: ContractKanshiRow,
  selected: boolean,
  abbreviations: ReadonlyMap<string, string>,
): readonly string[] {
  const observation = row.workspaceObservation;
  const summary = mergeSummary(observation);
  if (summary === undefined || (observation.kind !== "clean" && observation.kind !== "dirty") || observation.merge === null) {
    return [];
  }
  if (!selected) return [summary];
  const paths = observation.merge.unmergedPaths;
  return [
    summary,
    `merge head ${displayGitId(observation.merge.head, abbreviations)}`,
    ...(paths.length === 0 ? ["0 paths"] : paths),
  ];
}

function worldAfterFacts(row: ContractKanshiRow): readonly string[] {
  return row.after.map(afterWording);
}

function contractObservationFacts(
  row: ContractKanshiRow,
  selection: "world" | "contract",
  abbreviations: ReadonlyMap<string, string>,
): readonly string[] {
  const facts = [...(selection === "contract" ? worldAfterFacts(row) : [])];
  if (selection === "contract" && row.dependents.length > 0) facts.push(`dependents ${row.dependents.map(dependentWording).join(" · ")}`);
  return [...facts, ...mergeFacts(row, selection === "contract", abbreviations)];
}

function showWorkspacePath(row: ContractKanshiRow, hot: boolean): boolean {
  if (row.workspace !== "worktree") return false;
  if (row.workspaceObservation.kind === "unappointed") return false;
  if (row.workspaceObservation.kind !== "clean" && row.workspaceObservation.kind !== "failed") return true;
  return hot;
}

function contractHot(row: ContractKanshiRow): boolean {
  if (row.title === null) return true;
  if (row.phase === "pending-delivery") return true;
  if (row.holder.kind === "unavailable" || row.holder.kind === "held") return true;
  if (row.fleet.length > 0) return true;
  if (row.targetLag.kind === "counted" && row.targetLag.behind > 0) return true;
  if (row.workspaceObservation.kind !== "clean" && row.workspaceObservation.kind !== "unappointed") {
    return true;
  }
  if (row.after.some((edge) => edge.endpoint.kind !== "claimed")) return true;
  return row.gates.reports.some((report) =>
    report.current.kind === "stale"
    || report.current.kind === "missing"
    || (report.current.kind === "attested" && report.current.verdict === "unsatisfied"));
}

function taskHot(row: TaskKanshiRow): boolean {
  return row.disposition === "blocked" || row.disposition === "in_progress";
}

function activitySnapshotLine(row: AkumaKanshiRow): string | undefined {
  const snapshot = row.snapshot;
  if (snapshot === undefined) return undefined;
  const entries = snapshot.entries.flatMap((entry) => entry.kind === "row" ? [entry.row] : []);
  const latest = entries.at(-1);
  if (latest === undefined) {
    if (snapshot.kind === "idle" && snapshot.outcome !== undefined) {
      return snapshot.outcome.outcome.kind === "answered" ? snapshot.outcome.outcome.answer : snapshot.outcome.outcome.diagnostic;
    }
    return "empty";
  }
  if (latest.kind === "said" || latest.kind === "thought" || latest.kind === "note" || latest.kind === "call" || latest.kind === "tell") {
    return latest.text;
  }
  if (latest.kind === "tool") return latest.name;
  return "activity";
}

function plumbFacts(facts: readonly string[], columns: number): readonly string[] {
  const clean = facts.map(safeText).filter((fact) => fact.length > 0);
  if (clean.length === 0) return [];
  const lines: string[] = [];
  let current = PLUMB;
  for (const fact of clean) {
    const candidate = current === PLUMB ? `${PLUMB}${fact}` : `${current} · ${fact}`;
    if (current !== PLUMB && displayColumns(candidate) > columns) {
      lines.push(current);
      current = `${PLUMB}${fact}`;
    } else current = candidate;
  }
  lines.push(current);
  return lines;
}

function plumbBlock(value: string, columns: number): readonly string[] {
  return renderTextBlock(value, PLUMB, columns);
}

function plumbPath(path: string): string {
  return `${PATH_PREFIX}${safeText(path)}`;
}

function identityLine(mark: string, identity: string, extra = ""): string {
  return extra.length === 0 ? `${mark} ${safeText(identity)}` : `${mark} ${safeText(identity)} ${safeText(extra)}`;
}

function renderGates(
  reports: readonly ContractGateReport[],
  observedAt: string,
  columns: number,
  includeSummaries: boolean,
): readonly string[] {
  if (reports.length === 0) return [];
  const lines = [...plumbFacts([`gates: ${reports.map((report) =>
    `${gateGlyph(report)} ${report.gate} ${formatAge(report.current.kind === "attested" ? report.current.at : null, observedAt)}`
  ).join(" · ")}`], columns)];
  if (!includeSummaries) return lines;
  for (const report of reports) {
    if (report.current.kind !== "attested" || report.current.summary === undefined) continue;
    lines.push(...plumbBlock(`${report.gate}: ${report.current.summary}`, columns));
  }
  return lines;
}

function fieldPrefix(label: string): string {
  return `  ${label.padEnd(FIELD_WIDTH, " ")}`;
}

function fieldLine(label: string, value: string): string {
  return `${fieldPrefix(label)}${safeText(value)}`;
}

function fieldBlock(label: string, value: string, columns: number): readonly string[] {
  const continuation = " ".repeat(fieldPrefix(label).length);
  return renderTextBlock(value, continuation, columns).map((line, index) => index === 0
    ? `${fieldPrefix(label)}${line.slice(continuation.length)}`
    : line);
}

function renderWorldGates(reports: readonly ContractGateReport[]): readonly string[] {
  if (reports.length === 0) return [];
  return [fieldLine("GATES", reports.map((report) => `${gateGlyph(report)} ${report.gate}`).join("   "))];
}

function failure(name: string, section: Extract<Section<unknown>, { kind: "failed" }>, context: TextRenderContext): readonly string[] {
  return [`[ ${name} ]`, "", `${tone(`! ${safeText(section.failure.message)}`, "alert", context.color)}`];
}

function sectionAbsent(name: string, _columns: number): readonly string[] {
  return [`[ ${name} ]`, "", `${PLUMB}${name.toLowerCase()} absent`];
}

function endpointFact(id: string, observed: string | undefined): string {
  if (observed === "missing") return `-> ${id} (missing)`;
  if (observed === "unavailable") return `-> ${id} (unavailable)`;
  return `-> ${id}`;
}

function renderNamespaceTasks(row: ContractKanshiRow, context: TextRenderContext): readonly string[] {
  if (row.namespaceTasks.kind === "absent") return plumbFacts(["namespace tasks absent"], context.columns);
  if (row.namespaceTasks.kind === "failed") {
    return plumbFacts([`namespace tasks failed ${row.namespaceTasks.failure.message}`], context.columns);
  }
  const lines = [...plumbFacts([`namespace tasks ${row.namespaceTasks.value.length}`], context.columns)];
  for (const task of row.namespaceTasks.value) {
    const scan = `${taskMark(task)} ${task.id} · P${task.priority} ${task.disposition}`;
    const title = safeText(task.title);
    const inline = `${scan} — ${title}`;
    if (displayColumns(inline) <= context.columns - displayColumns(PLUMB)) {
      lines.push(...plumbFacts([inline], context.columns));
    } else {
      lines.push(...plumbFacts([`${scan} —`], context.columns));
      lines.push(...plumbBlock(title, context.columns));
    }
  }
  return lines;
}

function renderContractRow(
  row: ContractKanshiRow,
  report: KanshiReport,
  context: TextRenderContext,
  selection: "world" | "contract",
  abbreviations: ReadonlyMap<string, string>,
): readonly string[] {
  const hot = contractHot(row);
  const compact = !hot && selection !== "contract";
  const title = row.title ?? "title unavailable";
  const phase = `${row.phase} · ${formatAge(row.phaseAt, report.observedAt)}`;
  const journal = `journal ${formatAge(row.lastJournalAt, report.observedAt)}`;
  const lines = [identityLine(contractMark(row), row.id)];
  if (selection === "contract") {
    const state = report.contracts.kind === "present" ? report.contracts.value.state : null;
    lines.push(...plumbFacts([
      state === null
        ? `observedAt ${report.observedAt}`
        : `contract state ${displayGitId(state, abbreviations)} · observedAt ${report.observedAt}`,
    ], context.columns));
  }
  lines.push(...plumbFacts(compact ? [title, phase, journal, ...targetFacts(row)] : [title], context.columns));
  if (!compact) lines.push(...plumbFacts([phase, journal, ...targetFacts(row)], context.columns));
  lines.push(...plumbFacts(contractObservationFacts(row, selection, abbreviations), context.columns));
  lines.push(...plumbFacts([workspaceState(row)], context.columns));
  if (
    showWorkspacePath(row, hot || selection === "contract")
    && row.workspaceObservation.kind !== "unappointed"
    && row.workspaceObservation.kind !== "failed"
    && row.workspaceObservation.location.kind === "worktree"
  ) {
    lines.push(plumbPath(row.workspaceObservation.location.path));
  }
  lines.push(...renderGates(row.gates.reports, report.observedAt, context.columns, selection === "contract"));
  if (row.holder.kind === "held") lines.push(...plumbFacts([`task ${row.holder.taskId}`], context.columns));
  if (row.holder.kind === "unavailable") lines.push(...plumbFacts(["holder unavailable"], context.columns));
  for (const attached of row.fleet) {
    const aliases = attached.aliases.length === 0 ? "" : ` (${attached.aliases.join(" ")})`;
    lines.push(...plumbFacts([`akuma ${attached.id}${aliases}`], context.columns));
  }
  if (selection === "contract") {
    if (row.issue !== undefined) {
      const detail = row.issue.kind === "hook-failure"
        ? row.issue.diagnostic
        : `target-checkout-retained ${row.issue.target}`;
      lines.push(...plumbFacts([`lag (observed now): ${detail}`], context.columns));
    }
    lines.push(...renderNamespaceTasks(row, context));
  }
  return lines;
}

function isTerminalContract(row: ContractKanshiRow): boolean {
  return row.phase === "claimed" || row.phase === "abandoned";
}

function isTerminalTask(row: TaskKanshiRow): boolean {
  return row.disposition === "done" || row.disposition === "drop";
}

function renderWorldContractRow(row: ContractKanshiRow, report: KanshiReport, context: TextRenderContext): readonly string[] {
  const hot = contractHot(row);
  const title = row.title ?? "title unavailable";
  const phase = `${row.phase} · ${formatAge(row.phaseAt, report.observedAt)}`;
  const after = worldAfterFacts(row);
  if (!hot) {
    return [identityLine(contractMark(row), row.id, `· "${title}" · ${phase} · ${[...targetFacts(row), ...after].join(" · ")}`)];
  }

  const lines = [identityLine(contractMark(row), row.id)];
  lines.push(...fieldBlock("TITLE", title, context.columns));
  lines.push(fieldLine("STATE", phase));
  lines.push(fieldLine("GIT", [...targetFacts(row), workspaceState(row), ...mergeFacts(row, false, new Map())].join(" · ")));
  if (
    showWorkspacePath(row, hot)
    && row.workspaceObservation.kind !== "unappointed"
    && row.workspaceObservation.kind !== "failed"
    && row.workspaceObservation.location.kind === "worktree"
  ) {
    lines.push(fieldLine("DIR", row.workspaceObservation.location.path));
  }
  lines.push(...renderWorldGates(row.gates.reports));
  for (const fact of after) lines.push(`  ${safeText(fact)}`);
  const linked: string[] = [];
  if (row.holder.kind === "held") linked.push(row.holder.taskId);
  if (row.holder.kind === "unavailable") linked.push("holder unavailable");
  for (const attached of row.fleet) {
    const aliases = attached.aliases.length === 0 ? "" : ` (${attached.aliases.join(" ")})`;
    linked.push(`${attached.id}${aliases}`);
  }
  if (linked.length > 0) {
    lines.push(fieldLine("LINKED", linked[0]!));
    for (const item of linked.slice(1)) lines.push(`  ${" ".repeat(FIELD_WIDTH)}${safeText(item)}`);
  }
  return lines;
}

function selectRows<T>(rows: readonly T[], isHot: (row: T) => boolean): readonly T[] {
  return [...rows.filter(isHot), ...rows.filter((row) => !isHot(row))].slice(0, MAX_VISIBLE_ROWS);
}

function sectionFooter({ visible, total, unit, selector, neutral }: Readonly<{
  visible: number;
  total: number;
  unit: string;
  selector: string;
  neutral: boolean;
}>): readonly string[] {
  if (visible === total) return [`  (all ${total}${neutral ? "" : " live"} ${unit} shown)`];
  return [`  + ${total - visible} more${neutral ? "" : " live"} ${unit} not shown`, `    keiyaku ls ${selector}/`];
}

function sectionBlock({ name, unit, selector, rows, total, neutral = false }: Readonly<{
  name: string;
  unit: string;
  selector: string;
  rows: readonly (readonly string[])[];
  total: number;
  neutral?: boolean;
}>): readonly string[] {
  const lines = [`[ ${name} ]  ${total}${neutral ? ` ${unit}` : " live"}`, "", ...rows.flat()];
  lines.push("", ...sectionFooter({ visible: rows.length, total, unit, selector, neutral }));
  return lines;
}

function renderContracts(report: KanshiReport, context: TextRenderContext): readonly string[] {
  const section = report.contracts;
  if (section.kind === "absent") return sectionAbsent("KEIYAKU", context.columns);
  if (section.kind === "failed") return failure("KEIYAKU", section, context);
  const live = section.value.rows.filter((row) => !isTerminalContract(row));
  const rows = selectRows(live, contractHot);
  return sectionBlock({ name: "KEIYAKU", unit: "keiyaku", selector: "kei", rows: rows.map((row) => renderWorldContractRow(row, report, context)), total: live.length });
}

function renderSelectedContract(report: KanshiReport, context: TextRenderContext): readonly string[] {
  const section = report.contracts;
  if (section.kind === "absent") return [`${PLUMB}keiyaku absent`];
  if (section.kind === "failed") return [tone(`! ${safeText(section.failure.message)}`, "alert", context.color)];
  const row = section.value.rows[0];
  return row === undefined
    ? [`${PLUMB}keiyaku absent`]
    : renderContractRow(row, report, context, "contract", gitAbbreviations(report));
}

function renderTasks(report: KanshiReport, context: TextRenderContext): readonly string[] {
  const section = report.tasks;
  if (section.kind === "absent") return sectionAbsent("TASK", context.columns);
  if (section.kind === "failed") return failure("TASK", section, context);
  const live = section.value.rows.filter((row) => !isTerminalTask(row));
  const rows = selectRows(live, taskHot);
  const rowLines: readonly string[][] = rows.map((row) => {
    const compact = !taskHot(row);
    const relation = row.contract === undefined
      ? ["unbound"]
      : [endpointFact(row.contract.id, row.contract.observed)];
    if (compact) return [identityLine(taskMark(row), row.id, `· "${row.title}" · ${row.disposition} · P${row.priority} · ${relation.join(" · ")}`)];
    const lines = [identityLine(taskMark(row), row.id)];
    lines.push(...fieldBlock("TITLE", row.title, context.columns));
    lines.push(fieldLine("STATE", `${row.disposition} · P${row.priority}`));
    for (const blocker of row.blockers ?? []) lines.push(fieldLine("BLOCKED", blocker.id));
    lines.push(fieldLine("LINKED", relation.join(" · ")));
    return lines;
  });
  return sectionBlock({ name: "TASK", unit: "task", selector: "task", rows: rowLines, total: live.length });
}

function akumaLabel(row: AkumaKanshiRow): string {
  const aliases = row.aliases ?? [];
  return aliases.length === 0 ? "" : `(${aliases.join(" ")})`;
}

function renderAkuma(report: KanshiReport, context: TextRenderContext): readonly string[] {
  const section = report.akuma;
  if (section.kind === "absent") return sectionAbsent("FLEET", context.columns);
  if (section.kind === "failed") return failure("FLEET", section, context);
  const rows = visibleFleetRows(section.value.rows);
  const rowLines: readonly string[][] = rows.map((row) => {
    const lifeAt = "lifeAt" in row ? row.lifeAt : null;
    const life = `${row.life} · ${formatAge(lifeAt, report.observedAt)}`;
    const activity = "lastActivityAt" in row && row.lastActivityAt !== null
      ? [`activity ${formatAge(row.lastActivityAt, report.observedAt)}`]
      : [];
    const key = row.life === "stranded" && "strandedReason" in row && row.strandedReason === "resume-unsupported"
      ? [life, ...activity, "resume unsupported"]
      : [life, ...activity];
    const relation = row.contract === undefined
      ? ["unbound"]
      : [endpointFact(row.contract.id, row.contract.observed)];
    const snapshot = activitySnapshotLine(row);
    if (!akumaHot(row)) return [identityLine(akumaMark(row.life), row.id, `${akumaLabel(row)} · ${[...key, ...relation, ...(snapshot === undefined ? [] : [snapshot])].join(" · ")}`.trim())];
    const lines = [identityLine(akumaMark(row.life), row.id, akumaLabel(row))];
    lines.push(fieldLine("LIFE", key.join(" · ")));
    if (snapshot !== undefined) lines.push(fieldLine("SNAPSHOT", snapshot));
    lines.push(fieldLine("LINKED", relation.join(" · ")));
    return lines;
  });
  return sectionBlock({ name: "FLEET", unit: "akuma", selector: "aku", rows: rowLines, total: section.value.rows.length, neutral: true });
}

export function renderKanshiText(
  report: KanshiReport,
  context: TextRenderContext = { columns: 80, color: false },
  selection: "world" | "contract" = "world",
): string {
  if (selection === "contract") return renderSelectedContract(report, context).join("\n");
  return [
    ...renderContracts(report, context),
    "", "",
    ...renderAkuma(report, context),
    "", "",
    ...renderTasks(report, context),
  ].join("\n");
}
