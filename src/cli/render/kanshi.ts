import type { AkumaKanshiRow, ContractKanshiRow, KanshiReport, TaskKanshiRow } from "../../kanshi/index.js";
import { visibleFleetRows } from "../../kanshi/fleet.js";
import {
  abbreviateGitIds,
  afterWording,
  candidateFact,
  dependentWording,
  displayGitId,
  gateFact,
  gitIdsInRow,
  mergeSummary,
  targetMovementFacts,
} from "./contract-observation.js";
import {
  displayColumns,
  renderTextBlock,
  safeText,
  tone,
  truncateDisplayText,
  type TextRenderContext,
} from "./terminal.js";
const PLUMB = "  │ ";
const MAX_VISIBLE_ROWS = 10;
const NARROW_COLUMNS = 72;

function contractMark(row: ContractKanshiRow): string {
  if (row.phase === "claimed") return "✓";
  if (row.phase === "abandoned") return "×";
  if (row.title === null) return "?";
  if (
    row.gates.reports.some((report) => report.current.kind === "attested" && report.current.verdict === "unsatisfied")
  ) {
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
  if (sourceMs > observedMs) return "now";
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

function targetFacts(row: ContractKanshiRow, abbreviations: ReadonlyMap<string, string>): readonly string[] {
  const name = branchName(row.target);
  if (name === null) return ["no target"];
  const facts = [`target ${name}`];
  if (row.targetLag.kind === "unknown") facts.push(`commits behind ${name} unknown`);
  if (row.targetLag.kind === "counted") facts.push(`${row.targetLag.behind} commits behind ${name}`);
  return [...facts, ...targetMovementFacts(row, abbreviations)];
}

function selectedTargetFacts(row: ContractKanshiRow, abbreviations: ReadonlyMap<string, string>): readonly string[] {
  return [
    ...targetFacts(row, abbreviations),
    ...(row.target !== null && row.targetObservation?.head !== null && row.targetObservation?.head !== undefined
      ? [`target head ${displayGitId(row.targetObservation.head, abbreviations)}`]
      : []),
  ];
}

function workspaceState(row: ContractKanshiRow): string {
  const observation = row.workspaceObservation;
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
  if (
    summary === undefined ||
    (observation.kind !== "clean" && observation.kind !== "dirty") ||
    observation.merge === null
  ) {
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

function activitySnapshotLine(row: AkumaKanshiRow): string | undefined {
  const snapshot = row.snapshot;
  if (snapshot === undefined) return undefined;
  const entries = snapshot.entries.flatMap((entry) => (entry.kind === "row" ? [entry.row] : []));
  const latest = entries.at(-1);
  if (latest === undefined) {
    if (snapshot.kind === "idle" && snapshot.outcome !== undefined) {
      return snapshot.outcome.outcome.kind === "answered"
        ? snapshot.outcome.outcome.answer
        : snapshot.outcome.outcome.diagnostic;
    }
    return undefined;
  }
  if (
    latest.kind === "said" ||
    latest.kind === "thought" ||
    latest.kind === "note" ||
    latest.kind === "call" ||
    latest.kind === "tell"
  ) {
    return latest.text;
  }
  if (latest.kind === "tool") return latest.name;
  return "activity";
}

function boundedActivity(value: string, columns: number, prefix: string): string {
  const budget = Math.max(1, columns - displayColumns(prefix));
  return `activity "${truncateDisplayText(value, Math.max(1, budget - displayColumns('activity ""')))}"`;
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

function identityLine(mark: string, identity: string, extra = ""): string {
  return extra.length === 0 ? `${mark} ${safeText(identity)}` : `${mark} ${safeText(identity)} ${safeText(extra)}`;
}

function entityLines(
  mark: string,
  identity: string,
  state: string,
  title: string,
  facts: readonly string[],
  context: TextRenderContext,
): readonly string[] {
  if (context.columns > NARROW_COLUMNS) {
    return [identityLine(mark, identity, `· ${state} · ${title}`), ...plumbFacts(facts, context.columns)];
  }
  return [
    `${mark} ${safeText(state)}`,
    `  ${safeText(identity)}`,
    ...(title.length === 0 ? [] : renderTextBlock(safeText(title), "  ", context.columns)),
    ...plumbFacts(facts, context.columns),
  ];
}

function endpointFact(id: string, observed: string | undefined): string {
  if (observed === "missing") return `-> ${id} (missing)`;
  if (observed === "unavailable") return `-> ${id} (unavailable)`;
  return `-> ${id}`;
}

function linkedTask(report: KanshiReport, taskId: string): string {
  if (report.tasks.kind !== "present") return `! ${taskId} · unavailable`;
  const task = report.tasks.value.rows.find((candidate) => candidate.id === taskId);
  return task === undefined ? `! ${taskId} · missing` : `${taskMark(task)} ${task.id} · ${task.disposition}`;
}

function linkedAkuma(report: KanshiReport, id: string, aliases: readonly string[]): string {
  const alias = aliases.length === 0 ? "" : ` (${aliases.join(" ")})`;
  if (report.akuma.kind !== "present") return `! ${id}${alias} · unavailable`;
  const akuma = report.akuma.value.rows.find((candidate) => candidate.id === id);
  return akuma === undefined ? `! ${id}${alias} · missing` : `${akumaMark(akuma.life)} ${id}${alias} · ${akuma.life}`;
}

type AkumaAttachmentRow = Extract<KanshiReport["akuma"], { kind: "present" }>["value"]["rows"][number];

function isTerminalAkuma(life: string): boolean {
  return life === "killed" || life === "stillborn";
}

function attachmentTimestamp(akuma: AkumaAttachmentRow): string | null {
  if ("lifeAt" in akuma && akuma.lifeAt !== null) return akuma.lifeAt;
  if ("lastActivityAt" in akuma && akuma.lastActivityAt !== null) return akuma.lastActivityAt;
  return null;
}

function worldAttachments(row: ContractKanshiRow, report: KanshiReport): readonly ContractKanshiRow["fleet"][number][] {
  if (report.akuma.kind !== "present") return row.fleet;
  const byId = new Map<string, AkumaAttachmentRow>(report.akuma.value.rows.map((akuma) => [akuma.id, akuma]));
  const nonTerminal = new Set<ContractKanshiRow["fleet"][number]["id"]>();
  const unknown = new Set<ContractKanshiRow["fleet"][number]["id"]>();
  let latestTerminal: { id: ContractKanshiRow["fleet"][number]["id"]; at: string | null } | undefined;
  row.fleet.forEach((attached) => {
    const akuma = byId.get(attached.id);
    if (akuma === undefined) {
      unknown.add(attached.id);
      return;
    }
    if (!isTerminalAkuma(akuma.life)) {
      nonTerminal.add(attached.id);
      return;
    }
    const at = attachmentTimestamp(akuma);
    if (latestTerminal === undefined || (at !== null && (latestTerminal.at === null || at > latestTerminal.at))) {
      latestTerminal = { id: attached.id, at };
    }
  });
  const retained = new Set(unknown);
  for (const id of nonTerminal) retained.add(id);
  if (nonTerminal.size === 0 && latestTerminal !== undefined) retained.add(latestTerminal.id);
  return row.fleet.filter((attached) => retained.has(attached.id));
}

function linkedFacts(row: ContractKanshiRow, report: KanshiReport, mode: "world" | "selected"): readonly string[] {
  const linked: string[] = [];
  if (row.holder.kind === "held") linked.push(linkedTask(report, row.holder.taskId));
  if (row.holder.kind === "unavailable") linked.push("! task · unavailable");
  const attachments = mode === "world" ? worldAttachments(row, report) : row.fleet;
  for (const attached of attachments) linked.push(linkedAkuma(report, attached.id, attached.aliases));
  return linked;
}

function linkedAkumaSummary(row: ContractKanshiRow, report: KanshiReport): string | undefined {
  if (row.fleet.length === 0) return undefined;
  if (report.akuma.kind !== "present") return "akuma unavailable";
  const byId = new Map<string, AkumaAttachmentRow>(report.akuma.value.rows.map((akuma) => [akuma.id, akuma]));
  const known = row.fleet
    .map((attached) => byId.get(attached.id))
    .filter((akuma): akuma is AkumaAttachmentRow => akuma !== undefined);
  if (known.length === 0) return `akuma ${row.fleet.length} missing`;
  const live = known.filter((akuma) => !isTerminalAkuma(akuma.life)).length;
  const terminal = known.length - live;
  const facts = [`akuma ${row.fleet.length}`];
  if (live > 0) facts.push(`${live} live`);
  if (terminal > 0) facts.push(`${terminal} terminal`);
  return facts.join(" · ");
}

function semanticBlock(name: string, facts: readonly string[], context: TextRenderContext): readonly string[] {
  if (facts.length === 0) return [];
  const lines = [`  ${name}`];
  for (const fact of facts) lines.push(...renderTextBlock(safeText(fact), "    ", context.columns));
  return lines;
}

function namespaceTaskFacts(row: ContractKanshiRow): readonly string[] {
  if (row.namespaceTasks.kind === "absent") return [];
  if (row.namespaceTasks.kind === "failed") {
    return [`failed ${row.namespaceTasks.failure.message}`];
  }
  return row.namespaceTasks.value.map(
    (task) => `${taskMark(task)} ${task.id} · P${task.priority} ${task.disposition} — ${task.title}`,
  );
}

function renderSelectedContractRow(
  row: ContractKanshiRow,
  report: KanshiReport,
  context: TextRenderContext,
  abbreviations: ReadonlyMap<string, string>,
): readonly string[] {
  const title = row.title ?? "title unavailable";
  const lines = [
    ...entityLines(
      contractMark(row),
      row.id,
      `${row.phase} · ${formatAge(row.phaseAt, report.observedAt)}`,
      title,
      [],
      context,
    ),
  ];
  lines.push(...semanticBlock("after", worldAfterFacts(row), context));
  lines.push(...semanticBlock("dependents", row.dependents.map(dependentWording), context));
  const gateFacts = row.gates.reports.flatMap((gate) => [
    `${gateFact(gate)} ${formatAge(gate.current.kind === "attested" ? gate.current.at : null, report.observedAt)}`,
    ...(gate.current.kind === "attested" && gate.current.summary !== undefined
      ? [`${gate.gate}: ${gate.current.summary}`]
      : []),
  ]);
  lines.push(...semanticBlock("gates", gateFacts, context));
  lines.push(...semanticBlock("candidate/integration", candidateFacts(row, abbreviations), context));
  lines.push(...semanticBlock("target", selectedTargetFacts(row, abbreviations), context));
  const workspaceFacts = [workspaceState(row)];
  if (
    row.workspaceObservation.kind !== "unappointed" &&
    row.workspaceObservation.kind !== "failed" &&
    row.workspaceObservation.location.kind === "worktree"
  ) {
    workspaceFacts.push(`path ${row.workspaceObservation.location.path}`);
  }
  lines.push(
    ...semanticBlock("workspace/merge", [...workspaceFacts, ...mergeFacts(row, true, abbreviations)], context),
  );
  const attachments = [...linkedFacts(row, report, "selected")];
  if (row.issue !== undefined) attachments.push(`lag (observed now): target-checkout-retained ${row.issue.target}`);
  lines.push(...semanticBlock("attachments", attachments, context));
  lines.push(...semanticBlock("namespace tasks", namespaceTaskFacts(row), context));
  return lines;
}

function candidateFacts(row: ContractKanshiRow, abbreviations: ReadonlyMap<string, string>): readonly string[] {
  if (row.delivery === null) return [candidateFact(row.delivery)];
  const delivery = row.delivery;
  return [
    `tender ${displayGitId(delivery.tenderSnapshot, abbreviations)}`,
    `integration ${displayGitId(delivery.integration.predecessor, abbreviations)} -> ${displayGitId(delivery.integration.snapshot, abbreviations)}`,
    `method ${delivery.method}`,
    `change ${delivery.integration.changeId}`,
  ];
}

function isTerminalContract(row: ContractKanshiRow): boolean {
  return row.phase === "claimed" || row.phase === "abandoned";
}

function isTerminalTask(row: TaskKanshiRow): boolean {
  return row.disposition === "done" || row.disposition === "drop";
}

function renderWorldContractRow(
  row: ContractKanshiRow,
  report: KanshiReport,
  context: TextRenderContext,
): readonly string[] {
  const title = row.title ?? "title unavailable";
  const contractFacts = [
    candidateFact(row.delivery),
    ...targetFacts(row, gitAbbreviations(report)),
    ...worldAfterFacts(row),
    ...(row.dependents.length === 0 ? [] : [`dependents ${row.dependents.map(dependentWording).join(" · ")}`]),
    ...row.gates.reports.map(gateFact),
  ];
  const linkedFacts = [
    ...(row.holder.kind === "held" ? [linkedTask(report, row.holder.taskId)] : []),
    ...(row.holder.kind === "unavailable" ? ["! task · unavailable"] : []),
    ...(linkedAkumaSummary(row, report) === undefined ? [] : [linkedAkumaSummary(row, report)!]),
  ];
  return entityLines(
    contractMark(row),
    row.id,
    `${row.phase} · ${formatAge(row.lastJournalAt, report.observedAt)}`,
    title,
    contractFacts,
    context,
  ).concat(plumbFacts(linkedFacts, context.columns));
}

function selectRecentRows<T>(rows: readonly T[], timestamp: (row: T) => string): readonly T[] {
  return [...rows]
    .sort((left, right) => {
      const leftAt = timestamp(left);
      const rightAt = timestamp(right);
      if (leftAt === rightAt) return 0;
      return leftAt > rightAt ? -1 : 1;
    })
    .slice(0, MAX_VISIBLE_ROWS);
}

function sectionFooter({
  visible,
  total,
  unit,
  selector,
  neutral,
}: Readonly<{
  visible: number;
  total: number;
  unit: string;
  selector: string;
  neutral: boolean;
}>): readonly string[] {
  if (visible === total) return [`  (all ${total}${neutral ? "" : " live"} ${unit} shown)`];
  return [`  + ${total - visible} more${neutral ? "" : " live"} ${unit} not shown`, `    keiyaku ls ${selector}/`];
}

function sectionBlock({
  name,
  unit,
  selector,
  rows,
  total,
  neutral = false,
}: Readonly<{
  name: string;
  unit: string;
  selector: string;
  rows: readonly (readonly string[])[];
  total: number;
  neutral?: boolean;
}>): readonly string[] {
  const lines = [`[ ${name} ]  ${total}${neutral ? ` ${unit}` : " live"}`, "", ...rows.flat()];
  if (lines.at(-1) !== "") lines.push("");
  lines.push(...sectionFooter({ visible: rows.length, total, unit, selector, neutral }));
  return lines;
}

function renderContracts(report: KanshiReport, context: TextRenderContext): readonly string[] {
  const section = report.contracts;
  if (section.kind === "absent") return ["CONTRACTS // absent", "", `${PLUMB}contracts absent`];
  if (section.kind === "failed")
    return ["CONTRACTS // unavailable", "", tone(`! ${safeText(section.failure.message)}`, "alert", context.color)];
  const live = section.value.rows.filter((row) => !isTerminalContract(row));
  const rows = selectRecentRows(live, (row) => row.lastJournalAt);
  const candidates = live.filter((row) => row.delivery !== null).length;
  const rendered = sectionBlock({
    name: "CONTRACTS",
    unit: "keiyaku",
    selector: "kei",
    rows: rows.map((row) => renderWorldContractRow(row, report, context)),
    total: live.length,
  });
  const header = `CONTRACTS // ${live.length} live · ${candidates} candidates`;
  return [header, ...rendered.slice(1)];
}

function renderSelectedContract(report: KanshiReport, context: TextRenderContext): readonly string[] {
  const section = report.contracts;
  if (section.kind === "absent") return [`${PLUMB}keiyaku absent`];
  if (section.kind === "failed") return [tone(`! ${safeText(section.failure.message)}`, "alert", context.color)];
  const row = section.value.rows[0];
  return row === undefined
    ? [`${PLUMB}keiyaku absent`]
    : renderSelectedContractRow(row, report, context, gitAbbreviations(report));
}

function renderTasks(report: KanshiReport, context: TextRenderContext): readonly string[] {
  const section = report.tasks;
  if (section.kind === "absent") return ["TASKS // absent", "", `${PLUMB}tasks absent`];
  if (section.kind === "failed")
    return ["TASKS // unavailable", "", tone(`! ${safeText(section.failure.message)}`, "alert", context.color)];
  const live = section.value.rows.filter((row) => !isTerminalTask(row));
  const rows = selectRecentRows(live, (row) => row.updatedAt);
  const rowLines: readonly (readonly string[])[] = rows.map((row) => {
    const relation = row.contract === undefined ? ["unbound"] : [endpointFact(row.contract.id, row.contract.observed)];
    if (context.columns > NARROW_COLUMNS) {
      return [
        identityLine(
          taskMark(row),
          row.id,
          `· ${row.disposition} · P${row.priority} · ${row.title} · ${relation.join(" · ")}`,
        ),
        ...plumbFacts(
          (row.blockers ?? []).map((blocker) => `blocked ${blocker.id}`),
          context.columns,
        ),
      ];
    }
    return entityLines(
      taskMark(row),
      row.id,
      `${row.disposition} · P${row.priority}`,
      row.title,
      [...relation, ...(row.blockers ?? []).map((blocker) => `blocked ${blocker.id}`)],
      context,
    );
  });
  return [
    `TASKS // ${live.length} live`,
    ...sectionBlock({ name: "TASKS", unit: "task", selector: "task", rows: rowLines, total: live.length }).slice(1),
  ];
}

function akumaLabel(row: AkumaKanshiRow): string {
  const aliases = row.aliases ?? [];
  return aliases.length === 0 ? "" : `(${aliases.join(" ")})`;
}

function renderAkuma(report: KanshiReport, context: TextRenderContext): readonly string[] {
  const section = report.akuma;
  if (section.kind === "absent") return ["AKUMA // absent", "", `${PLUMB}akuma absent`];
  if (section.kind === "failed")
    return ["AKUMA // unavailable", "", tone(`! ${safeText(section.failure.message)}`, "alert", context.color)];
  const rows = visibleFleetRows(section.value.rows);
  const rowLines: readonly (readonly string[])[] = rows.map((row) => {
    const lifeAt = "lifeAt" in row ? row.lifeAt : null;
    const life = `${row.life} · ${formatAge(lifeAt, report.observedAt)}`;
    const activity =
      "lastActivityAt" in row && row.lastActivityAt !== null
        ? [`activity ${formatAge(row.lastActivityAt, report.observedAt)}`]
        : [];
    const key =
      row.life === "stranded" && "strandedReason" in row && row.strandedReason === "resume-unsupported"
        ? [life, ...activity, "resume unsupported"]
        : [life, ...activity];
    const relation = row.contract === undefined ? ["unbound"] : [endpointFact(row.contract.id, row.contract.observed)];
    const snapshot = activitySnapshotLine(row);
    const aliases = akumaLabel(row);
    if (context.columns > NARROW_COLUMNS) {
      const prefix = `${aliases} · ${[...key, ...relation].join(" · ")}`.trim();
      const lines = [identityLine(akumaMark(row.life), row.id, prefix)];
      return snapshot === undefined
        ? lines
        : [...lines, ...plumbFacts([boundedActivity(snapshot, context.columns, PLUMB)], context.columns)];
    }
    const identity = aliases.length === 0 ? row.id : `${row.id} ${aliases}`;
    const facts = [...key.slice(1), ...relation];
    const lines = entityLines(akumaMark(row.life), identity, key[0]!, "", facts, context);
    if (snapshot === undefined) return lines;
    return [...lines, ...plumbFacts([boundedActivity(snapshot, context.columns, PLUMB)], context.columns)];
  });
  const header = `AKUMA // ${rows.length} recent · ${section.value.rows.length} known`;
  const rendered = sectionBlock({
    name: "AKUMA",
    unit: "akuma",
    selector: "aku",
    rows: rowLines,
    total: section.value.rows.length,
    neutral: true,
  });
  return [header, ...rendered.slice(1)];
}
export function renderKanshiText(
  report: KanshiReport,
  context: TextRenderContext = { columns: 80, color: false },
  selection: "world" | "contract" = "world",
): string {
  if (selection === "contract") return renderSelectedContract(report, context).join("\n");
  return [
    `${tone("契", "alert", context.color)} KEIYAKU // WORLD`,
    "",
    ...renderContracts(report, context),
    "",
    ...renderAkuma(report, context),
    "",
    ...renderTasks(report, context),
  ].join("\n");
}
