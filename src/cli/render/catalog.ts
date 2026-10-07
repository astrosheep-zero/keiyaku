import type { AkumaList } from "../../akuma/akuma.js";
import type { ArchetypeCatalogRow } from "../../akuma/archetype.js";
import type { ContractList } from "../../library/contract-types.js";
import type { TaskPage, TaskRow } from "../../task/index.js";
import { abbreviateGitIds, displayGitId, gitIdsInRow, lifecycleWord, progressStrip } from "./contract-observation.js";
import { ageText, emptyCatalogue, renderBoundedPayload, safeText } from "./terminal.js";
import { akumaMark, contractMark } from "./marks.js";
import { dispositionText, taskFrameHead, taskMark } from "./task.js";

function relativeAge(source: string | null, observedAt: string): string | null {
  if (source === null) return null;
  return ageText(source, observedAt);
}

export function renderAkumaCatalogue(list: AkumaList, archetype: string | null): string {
  const rows = list.rows;
  if (rows.length === 0) {
    return emptyCatalogue("akuma");
  }
  const lines = [archetype === null ? "AKUMA // recent" : `AKUMA // ${safeText(archetype)}`, ""];
  for (const row of rows) {
    const lifeAt = "lifeAt" in row ? row.lifeAt : null;
    const activityAt = "lastActivityAt" in row ? row.lastActivityAt : null;
    const lifeAge = relativeAge(lifeAt, list.observedAt);
    const activityAge = relativeAge(activityAt, list.observedAt);
    const ages = [
      ...(lifeAge === null ? [] : [lifeAge]),
      ...(activityAge === null || activityAge === lifeAge ? [] : [`activity ${activityAge}`]),
    ];
    const aliases = row.aliases.length === 0 ? "" : ` (${row.aliases.map((alias) => safeText(alias)).join(" ")})`;
    lines.push(
      `${akumaMark(row.life)} ${safeText(row.id)}${aliases} · ${row.life}${ages.length === 0 ? "" : ` · ${ages.join(" · ")}`}`,
    );
  }
  if (list.hasMore) lines.push("…");
  return lines.join("\n");
}

function formatAge(source: string, observedAt: string): string {
  return ageText(source, observedAt, "future");
}

export function renderContractCatalogue(list: ContractList): string {
  const abbreviations = abbreviateGitIds([
    ...(list.state === null ? [] : [list.state]),
    ...list.rows.flatMap(gitIdsInRow),
  ]);
  const rows = list.rows;
  if (rows.length === 0) return emptyCatalogue("contracts");
  const header = "CONTRACTS // recent";
  const blocks = rows.map((row) => {
    const terminal = row.phase === "claimed" || row.phase === "abandoned";
    const outcome =
      row.phase === "claimed"
        ? `✓ ${lifecycleWord("claimed")}${row.delivery === null ? "" : ` · landed ${displayGitId(row.delivery.integration.snapshot, abbreviations)}`}`
        : "× abandoned";
    const review = row.gates.reports.find((gate) => gate.gate === "reviewed");
    const testimony =
      row.phase === "claimed" && review?.current.kind === "attested"
        ? review.current.summary
        : row.phase === "abandoned"
          ? row.abandonNote
          : undefined;
    const lines = [
      `${contractMark(row)} ${safeText(row.id)} · ${formatAge(row.phaseAt, list.observedAt)} · ${safeText(row.title ?? "title unavailable")}`,
      `  ${terminal ? outcome : progressStrip(row)}`,
      ...(testimony === undefined
        ? []
        : renderBoundedPayload({
            text: testimony,
            first: `  ${row.phase === "claimed" ? "review" : "note"}  `,
            continuation: "    │ ",
            columns: 100,
            maxLines: 3,
            quote: "“",
            openQuote: false,
            truncated: false,
          })),
    ];
    return lines.join("\n");
  });
  return [header, ...(blocks.length === 0 ? [] : ["", ...blocks]), ...(list.hasMore ? ["…"] : [])].join("\n");
}

export function renderArchetypeCatalogue(
  list: Readonly<{ rows: readonly ArchetypeCatalogRow[]; hasMore: boolean }>,
): string {
  if (list.rows.length === 0) return emptyCatalogue("akuma names");
  return [
    "AKUMA NAMES // available",
    ...(list.rows.length === 0
      ? []
      : [
          "",
          ...list.rows.flatMap((row) => {
            const facts = [
              ...(row.model === undefined ? [] : [safeText(row.model)]),
              ...(row.description === undefined ? [] : [safeText(row.description)]),
            ];
            return [safeText(row.name), ...(facts.length === 0 ? [] : [`  ${facts.join(" — ")}`])];
          }),
          ...(list.hasMore ? ["…"] : []),
        ]),
  ].join("\n");
}

export function renderTaskCatalogue(list: TaskPage<TaskRow>, namespace: readonly string[]): string {
  const scope = namespace.length === 0 ? "root" : `namespace ${namespace.join("/")}`;
  const head = taskFrameHead("tasks", scope);
  if (list.rows.length === 0) return emptyCatalogue("tasks");
  return [
    head,
    ...list.rows.map(
      (row) =>
        `${taskMark(row.disposition)} ${safeText(row.id)} · ${dispositionText(row.disposition)} · P${row.priority} — ${safeText(row.title)}`,
    ),
    ...(list.hasMore ? ["…"] : []),
  ].join("\n");
}
