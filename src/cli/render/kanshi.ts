import type { ContractKanshiRow, KanshiReport, TaskKanshiRow } from "../../kanshi/index.js";
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
  entityLines,
  elapsedMilliseconds,
  identityLine,
  plumbFacts,
  RECENT_TONE_MS,
  renderTextBlock,
  renderSectionBlock,
  safeText,
  tone,
  type SemanticTone,
  type TextRenderContext,
} from "./terminal.js";
import { akumaMark, endpointFact, formatAge, NARROW_COLUMNS, renderAkuma } from "./kanshi-akuma.js";
const PLUMB = "  │ ";
const REVIEW_ATTENTION_MS = 15 * 60 * 1_000;
const PENDING_ATTENTION_MS = 60 * 60 * 1_000;

function contractHasError(row: ContractKanshiRow): boolean {
  return (
    row.title === null ||
    row.gates.reports.some(
      (report) => report.current.kind === "attested" && report.current.verdict === "unsatisfied",
    ) ||
    row.targetLag.kind === "unknown" ||
    row.workspaceObservation.kind === "failed" ||
    row.workspaceObservation.kind === "unavailable" ||
    row.issue !== undefined
  );
}

function contractStatusTone(row: ContractKanshiRow, observedAt: string): SemanticTone | null {
  if (contractHasError(row)) return "alert";
  const phaseAge = elapsedMilliseconds(row.phaseAt, observedAt);
  if (row.phase === "tendered" && phaseAge !== null && phaseAge >= REVIEW_ATTENTION_MS) return "attention";
  if ((row.phase === "waiting" || row.phase === "bound") && phaseAge !== null && phaseAge >= PENDING_ATTENTION_MS)
    return "attention";
  const journalAge = elapsedMilliseconds(row.lastJournalAt, observedAt);
  return journalAge !== null && journalAge <= RECENT_TONE_MS ? "recent" : null;
}

function contractMark(row: ContractKanshiRow): string {
  if (row.phase === "claimed") return "✓";
  if (row.phase === "abandoned") return "×";
  if (row.title === null) return "?";
  if (
    row.gates.reports.some((report) => report.current.kind === "attested" && report.current.verdict === "unsatisfied")
  )
    return "!";
  if (row.targetLag.kind === "unknown") return "?";
  if (row.phase === "waiting") return "○";
  return "●";
}

function taskMark(row: TaskKanshiRow): string {
  if (row.disposition === "done") return "✓";
  if (row.disposition === "drop") return "×";
  if (row.disposition === "on_hold") return "⧗";
  return row.disposition === "in_progress" ? "●" : row.disposition === "blocked" ? "‖" : "○";
}

function gitAbbreviations(report: KanshiReport): ReadonlyMap<string, string> {
  const ids: string[] = [];
  if (report.contracts.kind !== "present") return abbreviateGitIds(ids);
  if (report.contracts.value.state !== null) ids.push(report.contracts.value.state);
  report.contracts.value.rows.forEach((row) => ids.push(...gitIdsInRow(row)));
  return abbreviateGitIds(ids);
}

function branchName(target: string | null): string | null {
  return target === null ? null : target.startsWith("refs/heads/") ? target.slice("refs/heads/".length) : target;
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
  const head = row.targetObservation?.head;
  return [
    ...targetFacts(row, abbreviations),
    ...(row.target !== null && head ? [`target head ${displayGitId(head, abbreviations)}`] : []),
  ];
}

function workspaceState(row: ContractKanshiRow): string {
  const observation = row.workspaceObservation;
  if (observation.kind === "failed") return `worktree unavailable · ${observation.diagnostic}`;
  if (observation.kind === "unappointed") return "worktree unappointed";
  if (observation.kind === "unavailable") return "worktree unavailable";
  if (observation.kind === "clean") return "worktree clean";
  const counts = Object.entries(observation.counts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name} ${count}`);
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
  )
    return [];
  if (!selected) return [summary];
  const paths = observation.merge.unmergedPaths;
  return [
    summary,
    `merge head ${displayGitId(observation.merge.head, abbreviations)}`,
    ...(paths.length === 0 ? ["0 paths"] : paths),
  ];
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
  return "lifeAt" in akuma && akuma.lifeAt !== null
    ? akuma.lifeAt
    : "lastActivityAt" in akuma
      ? akuma.lastActivityAt
      : null;
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
  if (row.namespaceTasks === undefined) return [];
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
  const statusTone = contractStatusTone(row, report.observedAt);
  const lines = [
    ...entityLines({
      mark: statusTone === null ? contractMark(row) : tone(contractMark(row), statusTone, context.color),
      identity: row.id,
      state: `${row.phase} · ${formatAge(row.phaseAt, report.observedAt)}`,
      title,
      facts: [],
      context,
    }),
  ];
  lines.push(...semanticBlock("after", row.after.map(afterWording), context));
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

function renderWorldContractRow(
  row: ContractKanshiRow,
  report: KanshiReport,
  context: TextRenderContext,
): readonly string[] {
  const title = row.title ?? "title unavailable";
  const contractFacts = [
    candidateFact(row.delivery),
    ...targetFacts(row, gitAbbreviations(report)),
    ...row.after.map(afterWording),
    ...(row.dependents.length === 0 ? [] : [`dependents ${row.dependents.map(dependentWording).join(" · ")}`]),
    ...row.gates.reports.map(gateFact),
  ];
  const linkedFacts = [
    ...(row.holder.kind === "held" ? [linkedTask(report, row.holder.taskId)] : []),
    ...(row.holder.kind === "unavailable" ? ["! task · unavailable"] : []),
    ...(linkedAkumaSummary(row, report) === undefined ? [] : [linkedAkumaSummary(row, report)!]),
  ];
  const statusTone = contractStatusTone(row, report.observedAt);
  return entityLines({
    mark: statusTone === null ? contractMark(row) : tone(contractMark(row), statusTone, context.color),
    identity: row.id,
    state: `${row.phase} · ${formatAge(row.lastJournalAt, report.observedAt)}`,
    title,
    facts: contractFacts,
    context,
  }).concat(plumbFacts(linkedFacts, context.columns));
}

function renderContracts(report: KanshiReport, context: TextRenderContext): readonly string[] {
  const section = report.contracts;
  if (section.kind === "absent") return ["CONTRACTS // absent", "", `${PLUMB}contracts absent`];
  if (section.kind === "failed")
    return ["CONTRACTS // unavailable", "", tone(`! ${safeText(section.failure.message)}`, "alert", context.color)];
  const rendered = renderSectionBlock({
    name: "CONTRACTS",
    rows: section.value.rows.map((row) => renderWorldContractRow(row, report, context)),
  });
  const header = "CONTRACTS // recent";
  return [header, ...rendered.slice(1), ...(section.value.hasMore === true ? ["…"] : [])];
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
  const rows = section.value.rows;
  const rowLines: readonly (readonly string[])[] = rows.map((row) => {
    const relation = row.contract === undefined ? ["unbound"] : [endpointFact(row.contract.id, row.contract.observed)];
    const childFacts =
      row.children === undefined ? [] : [`children ${row.children.live} live · ${row.children.total} total`];
    const blockerFacts = (row.blockers ?? []).map((blocker) => `blocked ${blocker.id}`);
    if (context.columns > NARROW_COLUMNS) {
      return [
        identityLine(
          taskMark(row),
          row.id,
          `· ${row.disposition} · P${row.priority} · ${row.title} · ${relation.join(" · ")}`,
        ),
        ...plumbFacts([...childFacts, ...blockerFacts], context.columns),
      ];
    }
    return entityLines({
      mark: taskMark(row),
      identity: row.id,
      state: `${row.disposition} · P${row.priority}`,
      title: row.title,
      facts: [...relation, ...childFacts, ...blockerFacts],
      context,
    });
  });
  return [
    "TASKS // recent",
    ...renderSectionBlock({
      name: "TASKS",
      rows: rowLines,
    }).slice(1),
    ...(section.value.hasMore ? ["…"] : []),
  ];
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
