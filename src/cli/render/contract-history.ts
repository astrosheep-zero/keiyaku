import type { ContractHistory, ContractHistoryEvent } from "../../index.js";
import { gateDisplayName, lifecycleWord, shortGitId } from "./contract-observation.js";
import { DEFAULT_CLI_COLUMNS, renderOpaqueBlock, safeText } from "./terminal.js";

function listFact(label: string, values: readonly string[] | undefined): readonly string[] {
  return values === undefined ? [] : [`  ${label}  ${values.length === 0 ? "none" : values.map(safeText).join(" · ")}`];
}

function historicalPayload(label: string, payload: string): readonly string[] {
  return [`  ${label}`, ...payload.split("\n").map((line) => (line.length === 0 ? "" : `  ${safeText(line)}`))];
}

/** Lay out a recorded dependency-key set as its labeled facts; unknown representations stay literal. */
function subjectFact(subject: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(subject) as unknown;
  } catch {
    return safeText(subject);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return safeText(subject);
  const parts: string[] = [];
  for (const key of parsed) {
    if (!Array.isArray(key) || key.length !== 2) return safeText(subject);
    const [kind, identity] = key;
    if (typeof kind !== "string" || typeof identity !== "string") return safeText(subject);
    const value = safeText(identity);
    switch (kind) {
      case "change":
      case "document":
      case "segment":
        parts.push(`${kind} ${value}`);
        break;
      case "snapshot":
        parts.push(`snapshot ${shortGitId(value)}`);
        break;
      case "target":
        parts.push(`target revision ${value}`);
        break;
      default:
        return safeText(subject);
    }
  }
  return parts.join(" · ");
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

function eventLine(event: ContractHistoryEvent): string {
  switch (event.kind) {
    case "dispatch":
      return `dispatch · ${event.akumaId}`;
    case "bind": {
      const gates = event.gates?.map(gateDisplayName) ?? [];
      const gateFact = gates.length === 0 ? "" : ` · ${gates.length === 1 ? "gate" : "gates"} ${gates.join(" · ")}`;
      return `bound to ${targetName(event.target)} @ ${shortGitId(event.start)}${gateFact}`;
    }
    case "amend":
      return event.target === undefined ? "amended" : `amended · target ${targetName(event.target)}`;
    case "deliver":
      return `delivered ${shortGitId(event.candidate)}`;
    case "reintegrated":
      return `integrated ${shortGitId(event.predecessor)}..${shortGitId(event.integration)}`;
    case "attestation": {
      const requirement =
        event.gate === "verified" || event.requirement !== `gate:${event.gate}` ? ` ${event.requirement}` : "";
      return `${event.verdict === "satisfied" ? "✓" : "×"} ${gateDisplayName(event.gate)}${requirement} · subject ${subjectFact(event.subject)}${payloadSuffix(event.summary)}`;
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
        ...(event.target === undefined ? [] : [`  target  ${targetName(event.target)}`]),
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
      if (event.note !== undefined) lines.push(...historicalPayload("note", event.note));
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
        `  subject  ${subjectFact(event.subject)}`,
      ];
      if (event.summary !== undefined) lines.push(...historicalPayload("summary", event.summary));
      return lines;
    }
    case "claimed":
      return [`  delivery  ${event.deliveryId}`];
    case "arc":
      return [
        `  sequence  ${event.chapter}`,
        `  title  ${safeText(event.title)}`,
        ...(event.body === undefined ? [] : historicalPayload("body", event.body)),
      ];
    case "abandoned": {
      const lines: string[] = [];
      if (event.note !== undefined) lines.push(...historicalPayload("note", event.note));
      return lines;
    }
  }
}

/** One complete retained record, without substituting a current-state read. */
function exactEventLines(event: Exclude<ContractHistoryEvent, { kind: "dispatch" }>): readonly string[] {
  return [
    `${event.at} ${event.kind} · ${event.id}`,
    ...semanticBody(event),
    ...(event.kind === "bind" || event.kind === "amend"
      ? [
          ...(event.document === undefined ? [] : historicalPayload("document", event.document)),
          ...(event.targetIncarnation === undefined
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
}

export function renderContractHistory(
  history: Extract<ContractHistory, { kind: "contract" | "contract-exact" }>,
): string {
  const header = `history  ${history.contractId}`;
  if (history.kind === "contract-exact") return [header, "", ...exactEventLines(history.event)].join("\n");
  const journals = history.events.filter((event) => event.kind !== "dispatch").length;
  const dispatches = history.events.length - journals;
  const counts = [
    ...(journals === 0 ? [] : [`${journals} ${journals === 1 ? "entry" : "entries"}`]),
    ...(dispatches === 0 ? [] : [`${dispatches} ${dispatches === 1 ? "dispatch" : "dispatches"}`]),
  ];
  const lines = [header + (counts.length === 0 ? "" : ` · ${counts.join(" · ")}`), ""];
  if (history.omitted !== undefined) lines.push(`… ${history.omitted} journal entries omitted`, "");
  let day: string | undefined;
  for (const event of history.events) {
    const nextDay = event.at.slice(0, 10);
    if (nextDay !== day) {
      if (day !== undefined) lines.push("");
      lines.push(nextDay, "");
      day = nextDay;
    }
    lines.push(`${clock(event)} ${event.kind === "dispatch" ? "" : `${event.id} `}${eventLine(event)}`);
  }
  if (history.dispatches !== undefined)
    lines.push(
      "",
      `! Dispatch history unavailable · ${history.dispatches.category} · ${safeText(history.dispatches.diagnostic)}`,
    );
  return lines.join("\n");
}
