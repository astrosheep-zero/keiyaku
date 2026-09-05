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
  targetFacts,
} from "./contract-observation.js";
import {
  entityLines,
  elapsedMilliseconds,
  identityLine,
  plumbFacts,
  RECENT_TONE_MS,
  renderSectionBlock,
  linkedEntityLines,
  safeText,
  tone,
  type SemanticTone,
  type TextRenderContext,
} from "./terminal.js";
import { akumaMark, endpointFact, formatAge, NARROW_COLUMNS, renderAkuma } from "./kanshi-akuma.js";
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
  if (row.phase === "abandoned") return "✕";
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
  if (row.disposition === "drop") return "✕";
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

function workspaceState(row: ContractKanshiRow): string {
  const observation = row.workspaceObservation;
  if (observation.kind === "failed") return `workspace  unavailable · ${observation.diagnostic}`;
  if (observation.kind === "unappointed") return "workspace  unappointed";
  if (observation.kind === "unavailable") return "workspace  unavailable";
  if (observation.kind === "clean") return "workspace  clean";
  const counts = Object.entries(observation.counts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name} ${count}`);
  return counts.length === 0 ? "workspace  dirty" : `workspace  dirty · ${counts.join(" · ")}`;
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
    `merge head  ${displayGitId(observation.merge.head, abbreviations)}`,
    ...(paths.length === 0 ? ["unmerged paths  none"] : paths.map((path) => `unmerged path  ${path}`)),
    ...(observation.merge.handoffBase === undefined
      ? []
      : ["saved  worktree bytes before projection", `handoff base  ${observation.merge.handoffBase}`]),
  ];
}

function linkedTask(report: KanshiReport, taskId: string): string {
  if (report.tasks.kind !== "present") return `! ${taskId} · unavailable`;
  const task = report.tasks.value.rows.find((candidate) => candidate.id === taskId);
  return task === undefined ? `! ${taskId} · unavailable` : `${taskMark(task)} ${task.id} · ${task.disposition}`;
}

function linkedAkuma(report: KanshiReport, id: string, aliases: readonly string[]): string {
  const alias = aliases.length === 0 ? "" : ` (${aliases.join(" ")})`;
  if (report.akuma.kind !== "present") return `! ${id}${alias} · unavailable`;
  const akuma = report.akuma.value.rows.find((candidate) => candidate.id === id);
  return akuma === undefined
    ? `! ${id}${alias} · unavailable`
    : `${akumaMark(akuma.life)} ${id}${alias} · ${akuma.life} · ${formatAge("lifeAt" in akuma ? akuma.lifeAt : null, report.observedAt)}`;
}

type AkumaAttachmentRow = Extract<KanshiReport["akuma"], { kind: "present" }>["value"]["rows"][number];

function isTerminalAkuma(life: string): boolean {
  return life === "killed" || life === "stillborn";
}

function linkedFacts(row: ContractKanshiRow, report: KanshiReport): readonly string[] {
  const linked: string[] = [];
  if (row.holder.kind === "held") linked.push(linkedTask(report, row.holder.taskId));
  if (row.holder.kind === "unavailable") linked.push("! task · unavailable");
  for (const attached of row.fleet) linked.push(linkedAkuma(report, attached.id, attached.aliases));
  return linked;
}

function linkedAkumaSummary(row: ContractKanshiRow, report: KanshiReport): string | undefined {
  if (row.fleet.length === 0) return undefined;
  if (report.akuma.kind !== "present") return "akuma  unavailable";
  const byId = new Map<string, AkumaAttachmentRow>(report.akuma.value.rows.map((akuma) => [akuma.id, akuma]));
  const known = row.fleet
    .map((attached) => byId.get(attached.id))
    .filter((akuma): akuma is AkumaAttachmentRow => akuma !== undefined);
  if (known.length === 0) return `akuma  ${row.fleet.length} · unavailable`;
  const live = known.filter((akuma) => !isTerminalAkuma(akuma.life)).length;
  const terminal = known.length - live;
  const facts = [`akuma  ${row.fleet.length}`];
  if (live > 0) facts.push(`${live} live`);
  if (terminal > 0) facts.push(`${terminal} terminal`);
  if (known.length < row.fleet.length) facts.push(`${row.fleet.length - known.length} unavailable`);
  return facts.join(" · ");
}

function semanticBlock(name: string, facts: readonly string[], _context: TextRenderContext): readonly string[] {
  if (facts.length === 0) return [];
  const lines = [`  ${name}`];
  for (const fact of facts) lines.push(`    ${safeText(fact)}`);
  return lines;
}

function namespaceTaskFacts(row: ContractKanshiRow): readonly string[] {
  if (row.namespaceTasks === undefined) return [];
  if (row.namespaceTasks.kind === "absent") return [];
  if (row.namespaceTasks.kind === "failed") {
    return [`failed ${row.namespaceTasks.failure.message}`];
  }
  return row.namespaceTasks.value.map(
    (task) => `${taskMark(task)} ${task.id} · ${task.disposition} · P${task.priority} · ${task.title}`,
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
    `${gateFact(gate)}${gate.current.kind === "attested" ? ` · ${formatAge(gate.current.at, report.observedAt)}` : ""}`,
    ...(gate.current.kind === "attested" && gate.current.summary !== undefined
      ? [`summary  ${gate.gate} · ${gate.current.summary}`]
      : []),
  ]);
  lines.push(...semanticBlock("gates", gateFacts, context));
  lines.push(...semanticBlock("candidate/integration", candidateFacts(row, abbreviations), context));
  lines.push(...semanticBlock("target", targetFacts(row, abbreviations), context));
  const workspaceFacts = [workspaceState(row)];
  if (
    row.workspaceObservation.kind !== "unappointed" &&
    row.workspaceObservation.kind !== "failed" &&
    row.workspaceObservation.location.kind === "worktree"
  ) {
    workspaceFacts.push(`worktree  ${row.workspaceObservation.location.path}`);
  }
  lines.push(
    ...semanticBlock("workspace/merge", [...workspaceFacts, ...mergeFacts(row, true, abbreviations)], context),
  );
  const attachments = [...linkedFacts(row, report)];
  if (row.issue !== undefined)
    lines.push(...plumbFacts([`lag  target-checkout-retained · ${row.issue.target}`], context.columns));
  lines.push(...linkedEntityLines(attachments, context.columns));
  lines.push(...semanticBlock("namespace tasks", namespaceTaskFacts(row), context));
  const observation = row.workspaceObservation;
  if ((observation.kind === "clean" || observation.kind === "dirty") && observation.merge?.recovery !== undefined) {
    lines.push(`  deliver  ${safeText(observation.merge.recovery.continue)} · reads worktree bytes, not index`);
  }
  return lines;
}

function candidateFacts(row: ContractKanshiRow, abbreviations: ReadonlyMap<string, string>): readonly string[] {
  if (row.delivery === null) return [candidateFact(row.delivery)];
  const delivery = row.delivery;
  return [
    candidateFact(delivery),
    `tender commit  ${displayGitId(delivery.tenderSnapshot, abbreviations)}`,
    `integration commit  ${displayGitId(delivery.integration.snapshot, abbreviations)} · predecessor ${displayGitId(delivery.integration.predecessor, abbreviations)}`,
    `method  ${delivery.method}`,
    `content identity (not commit)  ${delivery.integration.changeId}`,
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
    ...(row.worktreePath === null ? [] : [`worktree  ${row.worktreePath}`]),
    ...(linkedAkumaSummary(row, report) === undefined ? [] : [linkedAkumaSummary(row, report)!]),
    ...row.after.map(afterWording),
    ...(row.dependents.length === 0 ? [] : [`dependents  ${row.dependents.map(dependentWording).join(" · ")}`]),
    ...row.gates.reports.map(gateFact),
  ];
  const linkedFacts = [
    ...(row.holder.kind === "held" ? [linkedTask(report, row.holder.taskId)] : []),
    ...(row.holder.kind === "unavailable" ? ["! task · unavailable"] : []),
  ];
  const statusTone = contractStatusTone(row, report.observedAt);
  return entityLines({
    mark: statusTone === null ? contractMark(row) : tone(contractMark(row), statusTone, context.color),
    identity: row.id,
    state: `${row.phase} · ${formatAge(row.lastJournalAt, report.observedAt)}`,
    title,
    facts: contractFacts,
    context,
  }).concat(linkedEntityLines(linkedFacts, context.columns));
}

function renderContracts(report: KanshiReport, context: TextRenderContext): readonly string[] {
  const section = report.contracts;
  if (section.kind === "absent") return ["CONTRACTS // absent", "", "  contracts absent"];
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
  if (section.kind === "absent") return ["  keiyaku absent"];
  if (section.kind === "failed") return [tone(`! ${safeText(section.failure.message)}`, "alert", context.color)];
  const row = section.value.rows[0];
  return row === undefined
    ? ["  keiyaku absent"]
    : renderSelectedContractRow(row, report, context, gitAbbreviations(report));
}

function renderTasks(report: KanshiReport, context: TextRenderContext): readonly string[] {
  const section = report.tasks;
  if (section.kind === "absent") return ["TASKS // absent", "", "  tasks absent"];
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
