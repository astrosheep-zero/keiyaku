import type { ContractKanshiRow, KanshiReport } from "../../kanshi/index.js";
import {
  abbreviateGitIds,
  afterWording,
  progressStrip,
  displayGitId,
  gateFact,
  gitIdsInRow,
  lifecycleWord,
  mergeSummary,
  targetMovementFacts,
  verificationFact,
} from "./contract-observation.js";
import {
  DEFAULT_CLI_COLUMNS,
  entityLines,
  elapsedMilliseconds,
  identityLine,
  plumbFacts,
  RECENT_TONE_MS,
  renderBoundedPayload,
  renderSectionBlock,
  safeText,
  tone,
  type SemanticTone,
  type TextRenderContext,
} from "./terminal.js";
import { endpointFact, formatAge, NARROW_COLUMNS, renderAkuma } from "./kanshi-akuma.js";
import { contractMark, taskDispositionMark } from "./marks.js";
import { dispositionText } from "./task.js";
const REVIEW_ATTENTION_MS = 15 * 60 * 1_000;
const PENDING_ATTENTION_MS = 60 * 60 * 1_000;

function contractHasError(row: ContractKanshiRow): boolean {
  if (row.phase === "claimed" || row.phase === "abandoned") return row.title === null;
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
  if (row.phase === "delivered" && phaseAge !== null && phaseAge >= REVIEW_ATTENTION_MS) return "attention";
  if (row.phase === "bound" && phaseAge !== null && phaseAge >= PENDING_ATTENTION_MS) return "attention";
  const journalAge = elapsedMilliseconds(row.lastJournalAt, observedAt);
  return journalAge !== null && journalAge <= RECENT_TONE_MS ? "recent" : null;
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

function mergeFacts(row: ContractKanshiRow): readonly string[] {
  const summary = mergeSummary(row.workspaceObservation);
  return summary === undefined ? [] : [summary];
}

function linkedTask(report: KanshiReport, taskId: string): string {
  if (report.tasks.kind !== "present") return `! ${taskId} · unavailable`;
  const task = report.tasks.value.rows.find((candidate) => candidate.id === taskId);
  return task === undefined
    ? `! ${taskId} · unavailable`
    : `${taskDispositionMark(task.disposition)} ${task.id} · ${dispositionText(task.disposition)}`;
}

type AkumaAttachmentRow = Extract<KanshiReport["akuma"], { kind: "present" }>["value"]["rows"][number];

function isTerminalAkuma(life: string): boolean {
  return life === "killed" || life === "stillborn";
}

function linkedAkumaSummary(row: ContractKanshiRow, report: KanshiReport): string | undefined {
  if (row.roster.length === 0) return undefined;
  if (report.akuma.kind !== "present") return "akuma  unavailable";
  const byId = new Map<string, AkumaAttachmentRow>(report.akuma.value.rows.map((akuma) => [akuma.id, akuma]));
  const known = row.roster
    .map((attached) => byId.get(attached.id))
    .filter((akuma): akuma is AkumaAttachmentRow => akuma !== undefined);
  if (known.length === 0) return `akuma  ${row.roster.length} · unavailable`;
  const live = known.filter((akuma) => !isTerminalAkuma(akuma.life)).length;
  const terminal = known.length - live;
  const facts = [`akuma  ${row.roster.length}`];
  if (live > 0) facts.push(`${live} live`);
  if (terminal > 0) facts.push(`${terminal} terminal`);
  if (known.length < row.roster.length) facts.push(`${row.roster.length - known.length} unavailable`);
  return facts.join(" · ");
}

function semanticBlock(_name: string, facts: readonly string[], _context: TextRenderContext): readonly string[] {
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
    openQuote: false,
    truncated: false,
  });
}

function liveAlarms(row: ContractKanshiRow, report: KanshiReport): readonly string[] {
  return [
    ...mergeFacts(row),
    ...(row.holder.kind === "unavailable" ? ["task unavailable"] : []),
    ...(row.holder.kind === "held" && linkedTask(report, row.holder.taskId).startsWith("!")
      ? ["task unavailable"]
      : []),
    ...(row.issue === undefined ? [] : ["pending reconciliation"]),
    ...(row.workspaceObservation.kind === "failed" || row.workspaceObservation.kind === "unavailable"
      ? [workspaceState(row)]
      : []),
  ].map((alarm) => `! ${alarm}`);
}

function terminalFacts(
  row: ContractKanshiRow,
  context: TextRenderContext,
  abbreviations: ReadonlyMap<string, string>,
): readonly string[] {
  if (row.phase === "abandoned") return row.abandonNote === undefined ? [] : payload("note", row.abandonNote, context);
  const integration = row.delivery?.integration.snapshot;
  const review = row.gates.reports.find((gate) => gate.gate === "reviewed");
  return [
    ...(integration === undefined ? [] : [`landed  ${displayGitId(integration, abbreviations)}`]),
    ...(review?.current.kind === "attested" && review.current.summary !== undefined
      ? payload("review", review.current.summary, context)
      : []),
  ];
}

function staleVerificationFacts(row: ContractKanshiRow): readonly string[] {
  if (row.verification?.kind !== "recorded" || row.verification.snapshot === row.delivery?.integration.snapshot)
    return [];
  const fact = verificationFact(row.verification);
  return fact === undefined ? [] : [fact];
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
      state: `${lifecycleWord(row.phase)} · ${formatAge(row.phaseAt, report.observedAt)}`,
      title,
      facts: [],
      context,
    }),
  ];
  if (row.phase === "claimed" || row.phase === "abandoned") {
    const outcome = terminalFacts(row, context, abbreviations);
    lines.push(...outcome.map((fact) => (fact.startsWith("  ") ? fact : `  ${safeText(fact)}`)));
    return lines;
  }
  if (row.phase === "bound") {
    lines.push(...semanticBlock("gates", row.gates.reports.map(gateFact), context));
    lines.push(
      ...semanticBlock(
        "prerequisites",
        row.after.filter((edge) => edge.endpoint.kind !== "claimed").map(afterWording),
        context,
      ),
    );
    lines.push(...semanticBlock("ball", [progressStrip(row)], context));
    const akuma = linkedAkumaSummary(row, report);
    if (akuma !== undefined) lines.push(...semanticBlock("akuma", [akuma], context));
    if (row.worktreePath !== null) lines.push(...semanticBlock("worktree", [`worktree  ${row.worktreePath}`], context));
  } else {
    lines.push(...semanticBlock("ball", [progressStrip(row)], context));
    lines.push(
      ...semanticBlock(
        "prerequisites",
        row.after.filter((edge) => edge.endpoint.kind !== "claimed").map(afterWording),
        context,
      ),
    );
    if (row.delivery !== null) {
      lines.push(
        ...semanticBlock(
          "candidate",
          [
            `candidate  ${displayGitId(row.delivery.tenderSnapshot, abbreviations)}`,
            `integration result  ${displayGitId(row.delivery.integration.snapshot, abbreviations)}${row.verification?.kind === "recorded" && row.verification.snapshot === row.delivery.integration.snapshot ? ` · verification ${row.verification.verdict}` : ""}${row.targetObservation?.drift === true ? " · target moved since" : ""}`,
            ...(row.targetObservation?.drift === true ? targetMovementFacts(row, abbreviations) : []),
          ],
          context,
        ),
      );
    }
    lines.push(...semanticBlock("verification", staleVerificationFacts(row), context));
    const deniedReview = row.gates.reports.find(
      (gate) => gate.gate === "reviewed" && gate.current.kind === "attested" && gate.current.verdict === "unsatisfied",
    );
    lines.push(
      ...semanticBlock(
        "gates",
        row.gates.reports
          .filter(
            (gate) => gate !== deniedReview || gate.current.kind !== "attested" || gate.current.summary === undefined,
          )
          .map(gateFact),
        context,
      ),
    );
    if (deniedReview?.current.kind === "attested" && deniedReview.current.summary !== undefined)
      lines.push(...payload("review  ×", deniedReview.current.summary, context));
  }
  lines.push(...semanticBlock("alarms", liveAlarms(row, report), context));
  return lines;
}

function renderWorldContractRow(
  row: ContractKanshiRow,
  report: KanshiReport,
  context: TextRenderContext,
): readonly string[] {
  const title = row.title ?? "title unavailable";
  const abbreviations = gitAbbreviations(report);
  const contractFacts =
    row.phase === "claimed" || row.phase === "abandoned"
      ? terminalFacts(row, context, abbreviations)
          .filter((fact) => !fact.startsWith("  "))
          .slice(0, 1)
      : [
          progressStrip(row),
          ...(linkedAkumaSummary(row, report) === undefined ? [] : [linkedAkumaSummary(row, report)!]),
          ...liveAlarms(row, report),
        ];
  const statusTone = contractStatusTone(row, report.observedAt);
  return entityLines({
    mark: statusTone === null ? contractMark(row) : tone(contractMark(row), statusTone, context.color),
    identity: row.id,
    state: formatAge(row.phaseAt, report.observedAt),
    title,
    facts: contractFacts,
    context,
  });
}

function renderContracts(report: KanshiReport, context: TextRenderContext): readonly string[] {
  const section = report.contracts;
  if (section.kind === "absent") return ["CONTRACTS // absent"];
  if (section.kind === "failed")
    return ["CONTRACTS // unavailable", "", tone(`! ${safeText(section.failure.message)}`, "alert", context.color)];
  if (section.value.rows.length === 0) return [];
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

function taskFailureFact(failure: Readonly<{ message: string; coordinate?: string }>): string {
  return failure.coordinate === undefined ? failure.message : `${failure.coordinate} · failed ${failure.message}`;
}

function renderTasks(report: KanshiReport, context: TextRenderContext): readonly string[] {
  const section = report.tasks;
  if (section.kind === "absent") return ["TASKS // absent"];
  if (section.kind === "failed")
    return [
      "TASKS // unavailable",
      "",
      tone(`! ${safeText(taskFailureFact(section.failure))}`, "alert", context.color),
    ];
  const rows = section.value.rows;
  if (rows.length === 0) return [];
  const rowLines: readonly (readonly string[])[] = rows.map((row) => {
    const relation = row.contract === undefined ? [] : [endpointFact(row.contract.id, row.contract.observed)];
    const childFacts =
      row.children === undefined ? [] : [`children ${row.children.live} live · ${row.children.total} total`];
    const blockerFacts = (row.blockers ?? []).map((blocker) => `blocked ${blocker.id}`);
    const association = relation.length === 0 ? "" : ` · ${relation.join(" · ")}`;
    if (context.columns > NARROW_COLUMNS) {
      return [
        identityLine(
          taskDispositionMark(row.disposition),
          row.id,
          `· ${dispositionText(row.disposition)} · P${row.priority} · ${row.title}${association}`,
        ),
        ...plumbFacts([...childFacts, ...blockerFacts], context.columns),
      ];
    }
    return entityLines({
      mark: taskDispositionMark(row.disposition),
      identity: row.id,
      state: `${dispositionText(row.disposition)} · P${row.priority}`,
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
  context: TextRenderContext = { columns: DEFAULT_CLI_COLUMNS, color: false },
  selection: "world" | "contract" = "world",
): string {
  if (selection === "contract") return renderSelectedContract(report, context).join("\n");
  const blocks = [renderContracts(report, context), renderAkuma(report, context), renderTasks(report, context)].filter(
    (block) => block.length > 0,
  );
  return blocks.length === 0 ? "○ world empty" : blocks.map((block) => block.join("\n")).join("\n\n");
}
