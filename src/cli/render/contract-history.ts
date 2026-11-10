import type { ContractHistory, ContractHistoryEvent } from "../../index.js";
import { gateDisplayName, lifecycleWord, shortGitId } from "./contract-observation.js";
import { receiptPayload } from "./receipt.js";
import { DEFAULT_CLI_COLUMNS, renderOpaqueBlock, safeText } from "./terminal.js";

function listFact(label: string, values: readonly string[] | undefined): readonly string[] {
  return values === undefined || values.length === 0 ? [] : [`  ${label}  ${values.map(safeText).join(" · ")}`];
}

function targetName(target: Extract<ContractHistoryEvent, { kind: "bind" }>["target"]): string {
  if (target === undefined) return "targetless";
  return typeof target === "string" ? target.replace(/^refs\/heads\//u, "") : target.contractId;
}

function clock(event: ContractHistoryEvent): string {
  const date = new Date(event.at);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

function payloadSuffix(payload: string | undefined): string {
  if (payload === undefined || payload.trim().length === 0) return "";
  const count = renderOpaqueBlock(payload, "  ", DEFAULT_CLI_COLUMNS).length;
  return ` · ${count} line${count === 1 ? "" : "s"}`;
}

function eventLine(event: ContractHistoryEvent, dispatches: readonly ContractHistoryEvent[] = []): string {
  switch (event.kind) {
    case "dispatch":
      return `dispatch · ${event.akumaId}`;
    case "bind": {
      const gates = event.gates?.map(gateDisplayName) ?? [];
      const gateFact = gates.length === 0 ? "" : ` · ${gates.length === 1 ? "gate" : "gates"} ${gates.join(" · ")}`;
      const callers = dispatches.flatMap((item) => (item.kind === "dispatch" ? [` · ${item.akumaId}`] : [])).join("");
      return `bound to ${targetName(event.target)} @ ${shortGitId(event.start)}${gateFact}${callers}`;
    }
    case "amend": {
      const changed = [
        ...(event.changedSections ?? []),
        ...(event.gates === undefined ? [] : ["gates"]),
        ...(event.after === undefined ? [] : ["after"]),
      ];
      return `amended${changed.length === 0 ? "" : ` · ${changed.join(" · ")}`}`;
    }
    case "deliver":
      return `delivered ${shortGitId(event.candidate)}`;
    case "reintegrated":
      return `integrated ${shortGitId(event.predecessor)}..${shortGitId(event.integration)}`;
    case "attestation": {
      const requirement =
        event.gate === "verified" || event.requirement !== `gate:${event.gate}` ? ` ${event.requirement}` : "";
      return `${event.verdict === "satisfied" ? "✓" : "×"} ${gateDisplayName(event.gate)}${requirement} · subject ${safeText(event.subject)}${payloadSuffix(event.summary)}`;
    }
    case "claimed":
      return lifecycleWord("claimed");
    case "arc":
      return `arc ${safeText(event.title)}${payloadSuffix(event.body)}`;
    case "abandoned":
      return `abandoned${payloadSuffix(event.note)}`;
  }
}

function semanticBody(event: ContractHistoryEvent): readonly string[] {
  switch (event.kind) {
    case "dispatch":
      return [];
    case "bind":
      return [
        `  start commit  ${shortGitId(event.start)}`,
        `  target  ${targetName(event.target)}`,
        ...listFact("gates", event.gates),
        ...listFact("after", event.after),
      ];
    case "amend":
      return [
        ...listFact("changed sections", event.changedSections),
        ...listFact("gates", event.gates),
        ...listFact("after", event.after),
      ];
    case "deliver": {
      const lines = [
        `  candidate  ${shortGitId(event.candidate)}`,
        `  predecessor commit  ${shortGitId(event.predecessor)}`,
        `  integration result  ${shortGitId(event.integration)}`,
        `  content identity  ${event.contentId}`,
      ];
      if (event.note !== undefined) receiptPayload(lines, "note", event.note);
      return lines;
    }
    case "reintegrated":
      return [
        `  predecessor commit  ${shortGitId(event.predecessor)}`,
        `  integration result  ${shortGitId(event.integration)}`,
      ];
    case "attestation": {
      const lines = [
        `  gate  ${event.gate}`,
        `  requirement  ${event.requirement}`,
        `  verdict  ${event.verdict}`,
        `  subject  ${safeText(event.subject)}`,
      ];
      if (event.summary !== undefined) receiptPayload(lines, "summary", event.summary);
      return lines;
    }
    case "claimed":
      return [`  delivery  ${event.deliveryId}`];
    case "arc":
      return [
        `  sequence  ${event.chapter}`,
        `  title  ${safeText(event.title)}`,
        ...(event.body === undefined ? [] : ["  body", ...renderOpaqueBlock(event.body, "  ", DEFAULT_CLI_COLUMNS)]),
      ];
    case "abandoned": {
      const lines: string[] = [];
      if (event.note !== undefined) receiptPayload(lines, "note", event.note);
      return lines;
    }
  }
}

/** Full mode exposes supplied historical facts, never a current-state reread. */
function fullEventLines(event: ContractHistoryEvent): readonly string[] {
  const identity = event.kind === "dispatch" ? event.akumaId : event.id;
  const actor = event.kind !== "dispatch" && event.actor !== undefined ? ` · ${event.actor}` : "";
  const header = `${event.at} ${event.kind} · ${identity}${actor}`;
  const detail = [
    ...semanticBody(event),
    ...(event.kind === "bind" || event.kind === "amend"
      ? [
          ...(event.document === undefined
            ? []
            : ["  document", ...renderOpaqueBlock(event.document, "  ", DEFAULT_CLI_COLUMNS)]),
          ...(event.kind !== "bind" || event.targetIncarnation === undefined
            ? []
            : [
                `  target incarnation  ${safeText(event.targetIncarnation.id)} · ${safeText(event.targetIncarnation.identity)}`,
              ]),
        ]
      : []),
    ...(event.kind !== "deliver" || event.requireBranchesToBeUpToDate === undefined
      ? []
      : [`  require branches up to date  ${event.requireBranchesToBeUpToDate}`]),
  ];
  return [header, ...detail];
}

export function renderContractHistory(
  history: Extract<ContractHistory, { kind: "contract" }>,
  options: Readonly<{ full?: boolean }> = {},
): string {
  const journals = history.events.filter((event) => event.kind !== "dispatch").length;
  const dispatches = history.events.length - journals;
  const counts = [
    ...(journals === 0
      ? []
      : [`${journals} ${options.full === true ? "journal " : ""}${journals === 1 ? "entry" : "entries"}`]),
    ...(dispatches === 0 ? [] : [`${dispatches} ${dispatches === 1 ? "dispatch" : "dispatches"}`]),
  ];
  const state = history.events.some((event) => event.kind === "claimed")
    ? lifecycleWord("claimed")
    : history.events.some((event) => event.kind === "abandoned")
      ? "abandoned"
      : "bound";
  const header = `history  ${history.contractId}${options.full === true ? "" : ` · ${state}`}${counts.length === 0 ? "" : ` · ${counts.join(" · ")}`}`;
  const failure =
    history.dispatches === undefined
      ? []
      : [
          "",
          `! Dispatch history unavailable · ${history.dispatches.category} · ${safeText(history.dispatches.diagnostic)}`,
        ];
  if (options.full === true) return [header, "", ...history.events.flatMap(fullEventLines), ...failure].join("\n");
  const lines = [header, ""];
  let day: string | undefined;
  for (let index = 0; index < history.events.length; index += 1) {
    const event = history.events[index]!;
    const nextDay = event.at.slice(0, 10);
    if (nextDay !== day) {
      if (day !== undefined) lines.push("");
      lines.push(nextDay, "");
      day = nextDay;
    }
    const adjacent: ContractHistoryEvent[] = [];
    if (event.kind === "bind") {
      while (history.events[index + 1]?.kind === "dispatch") adjacent.push(history.events[++index]!);
    }
    lines.push(`${clock(event)} ${eventLine(event, adjacent)}`);
  }
  return [...lines, ...failure].join("\n");
}
