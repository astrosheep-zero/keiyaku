import type { ContractGateReport } from "../../index.js";
import type {
  AkumaKanshiRow,
  ContractKanshiRow,
  KanshiReport,
  Section,
  TaskKanshiRow,
} from "../../kanshi/index.js";
import { displayColumns, renderTextBlock, safeText, tone, type TextRenderContext } from "./terminal.js";

const RULE = "─";
const HORIZON = "───";
const PLUMB = "  │ ";
const PATH_PREFIX = `${PLUMB}↳ `;

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

function gateMark(report: ContractGateReport): string {
  if (report.current.kind !== "attested") return "?";
  return report.current.verdict === "satisfied" ? "✓" : "!";
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

function isLost(life: string): boolean {
  return life === "stranded" || life === "hung" || life === "untidy";
}

function branchName(target: string | null): string | null {
  if (target === null) return null;
  return target.startsWith("refs/heads/") ? target.slice("refs/heads/".length) : target;
}

function targetFacts(row: ContractKanshiRow): readonly string[] {
  const name = branchName(row.target);
  if (name === null) return ["no target"];
  const facts = [`target ${name}`];
  if (row.targetLag.kind === "unknown") facts.push("behind unknown");
  if (row.targetLag.kind === "counted") facts.push(`behind ${row.targetLag.behind}`);
  if (row.targetObservation?.drift === true) facts.push("drift");
  return facts;
}

function workspaceState(row: ContractKanshiRow): string {
  const observation = row.workspaceObservation;
  if (row.workspace === "here") return `workspace here · ${observation.kind}`;
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

function showWorkspacePath(row: ContractKanshiRow, hot: boolean): boolean {
  if (row.workspace !== "worktree") return false;
  if (row.workspaceObservation.kind === "unappointed") return false;
  if (row.workspaceObservation.kind !== "clean") return true;
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
  return row.gates.reports.some((report) =>
    report.current.kind === "stale"
    || (report.current.kind === "attested" && report.current.verdict === "unsatisfied"));
}

function taskHot(row: TaskKanshiRow): boolean {
  return row.disposition === "blocked" || row.disposition === "in_progress";
}

function akumaHot(row: AkumaKanshiRow): boolean {
  if (row.life === "running" || row.life === "stillborn" || isLost(row.life)) return true;
  return row.contract?.observed === "missing" || row.contract?.observed === "unavailable";
}

function aperture(label: string, columns: number): string {
  const prefix = `──[ ${label} ]`;
  const fill = Math.max(1, columns - displayColumns(prefix));
  return `${prefix}${RULE.repeat(fill)}`;
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
    `${gateMark(report)} ${report.gate} ${formatAge(report.current.kind === "attested" ? report.current.at : null, observedAt)}`
  ).join(" · ")}`], columns)];
  if (!includeSummaries) return lines;
  for (const report of reports) {
    if (report.current.kind !== "attested" || report.current.summary === undefined) continue;
    lines.push(...plumbBlock(`${report.gate}: ${report.current.summary}`, columns));
  }
  return lines;
}

function failure(name: string, section: Extract<Section<unknown>, { kind: "failed" }>, context: TextRenderContext): readonly string[] {
  return [aperture(name, context.columns), `${tone(`! ${safeText(section.failure.message)}`, "alert", context.color)}`];
}

function sectionAbsent(name: string, columns: number): readonly string[] {
  return [aperture(name, columns), `${PLUMB}${name.toLowerCase()} absent`];
}

function endpointFact(id: string, observed: string | undefined): string {
  if (observed === "missing") return `-> ${id} (missing)`;
  if (observed === "unavailable") return `-> ${id} (unavailable)`;
  return `-> ${id}`;
}

function renderContracts(report: KanshiReport, context: TextRenderContext, selection: "world" | "contract"): readonly string[] {
  const section = report.contracts;
  if (section.kind === "absent") return sectionAbsent("KEIYAKU", context.columns);
  if (section.kind === "failed") return failure("KEIYAKU", section, context);
  const rows = [
    ...section.value.rows.filter(contractHot),
    ...section.value.rows.filter((row) => !contractHot(row)),
  ];
  const lines = [aperture("KEIYAKU", context.columns)];
  for (const row of rows) {
    const hot = contractHot(row);
    const compact = !hot && selection !== "contract";
    const title = row.title ?? "title unavailable";
    const phase = `${row.phase} · ${formatAge(row.phaseAt, report.observedAt)}`;
    lines.push(identityLine(contractMark(row), row.id));
    lines.push(...plumbFacts(
      compact
        ? [title, phase, ...targetFacts(row)]
        : [title],
      context.columns,
    ));
    if (!compact) lines.push(...plumbFacts([phase, ...targetFacts(row)], context.columns));
    lines.push(...plumbFacts([workspaceState(row)], context.columns));
    if (
      showWorkspacePath(row, hot || selection === "contract")
      && row.workspaceObservation.kind !== "unappointed"
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
  }
  const attention = rows.filter(contractHot).length;
  lines.push(aperture(`${rows.length} keiyaku · ${attention} attention`, context.columns));
  return lines;
}

function renderTasks(report: KanshiReport, context: TextRenderContext): readonly string[] {
  const section = report.tasks;
  if (section.kind === "absent") return sectionAbsent("TASK", context.columns);
  if (section.kind === "failed") return failure("TASK", section, context);
  const rows = [
    ...section.value.rows.filter(taskHot),
    ...section.value.rows.filter((row) => !taskHot(row)),
  ];
  const lines = [aperture("TASK", context.columns)];
  for (const row of rows) {
    const compact = !taskHot(row);
    lines.push(identityLine(taskMark(row), row.id));
    const relation = row.contract === undefined
      ? ["unbound"]
      : [endpointFact(row.contract.id, row.contract.observed)];
    const facts = [row.title, row.disposition, `P${row.priority}`, ...relation];
    if (compact) lines.push(...plumbFacts(facts, context.columns));
    else {
      lines.push(...plumbBlock(row.title, context.columns));
      lines.push(...plumbFacts([row.disposition, `P${row.priority}`], context.columns));
      for (const blocker of row.blockers ?? []) {
        lines.push(...plumbFacts([`blocked by ${blocker.id}`], context.columns));
      }
      lines.push(...plumbFacts(relation, context.columns));
    }
  }
  const attention = rows.filter(taskHot).length;
  lines.push(aperture(`${rows.length} task · ${attention} attention`, context.columns));
  return lines;
}

function akumaLabel(row: AkumaKanshiRow): string {
  const aliases = row.aliases ?? [];
  return aliases.length === 0 ? "" : `(${aliases.join(" ")})`;
}

function renderAkuma(report: KanshiReport, context: TextRenderContext): readonly string[] {
  const section = report.akuma;
  if (section.kind === "absent") return sectionAbsent("FLEET", context.columns);
  if (section.kind === "failed") return failure("FLEET", section, context);
  const rows = [
    ...section.value.rows.filter(akumaHot),
    ...section.value.rows.filter((row) => !akumaHot(row)),
  ];
  const lines = [aperture("FLEET", context.columns)];
  for (const row of rows) {
    lines.push(identityLine(akumaMark(row.life), row.id, akumaLabel(row)));
    const lifeAt = "lifeAt" in row ? row.lifeAt : null;
    const life = `${row.life} · ${formatAge(lifeAt, report.observedAt)}`;
    const key = row.life === "stranded" && "strandedReason" in row && row.strandedReason === "resume-unsupported"
      ? [life, "resume unsupported"]
      : [life];
    const relation = row.contract === undefined
      ? ["unbound"]
      : [endpointFact(row.contract.id, row.contract.observed)];
    if (!akumaHot(row)) lines.push(...plumbFacts([...key, ...relation], context.columns));
    else {
      lines.push(...plumbFacts(key, context.columns));
      lines.push(...plumbFacts(relation, context.columns));
    }
  }
  const attention = rows.filter(akumaHot).length;
  lines.push(aperture(`${rows.length} akuma · ${attention} attention`, context.columns));
  return lines;
}

function sectionCount(name: string, section: Section<{ rows: readonly unknown[] }>): string {
  if (section.kind === "present") return `${section.value.rows.length} ${name}`;
  return `${section.kind} ${name}`;
}

function worldCoordinate(report: KanshiReport): string {
  const project = report.root;
  const branch = report.branch?.startsWith("refs/heads/") === true
    ? report.branch.slice("refs/heads/".length)
    : report.branch;
  const state = report.contracts.kind === "present" ? report.contracts.value.state ?? null : null;
  return [project, branch, state].filter((part): part is string => part !== null && part.length > 0).map(safeText).join(" ");
}

function splitHorizon(report: KanshiReport, columns: number): readonly string[] {
  if (report.root === null) return ["✗ keiyaku world absent"];
  const aggregate = [
    sectionCount("keiyaku", report.contracts),
    sectionCount("akuma", report.akuma),
    sectionCount("task", report.tasks),
  ].join(" · ");
  const world = worldCoordinate(report);
  const minimum = `kanshi ${HORIZON} ${aggregate} ${HORIZON} ${world}`;
  if (displayColumns(minimum) > columns) return [minimum];
  const fill = columns - displayColumns(minimum);
  const left = Math.floor(fill / 2);
  const right = Math.ceil(fill / 2);
  return [`kanshi ${HORIZON}${RULE.repeat(left)} ${aggregate} ${HORIZON}${RULE.repeat(right)} ${world}`];
}

export function renderKanshiText(
  report: KanshiReport,
  context: TextRenderContext = { columns: 80, color: false },
  selection: "world" | "contract" = "world",
): string {
  return [
    ...splitHorizon(report, context.columns),
    "",
    ...renderContracts(report, context, selection),
    "",
    ...renderTasks(report, context),
    "",
    ...renderAkuma(report, context),
  ].join("\n");
}
