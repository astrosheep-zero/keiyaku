import type { ContractHistory, ContractHistoryEvent, Fact } from "../../index.js";
import { receiptPayload } from "./receipt.js";

function journalCount(events: readonly ContractHistoryEvent[], source: ContractHistoryEvent["source"]): number {
  return events.filter((event) => event.source === source).length;
}

function journalHead(fact: Fact): string {
  return fact.actor === undefined
    ? `${fact.at} ${fact.kind} · ${fact.entry}`
    : `${fact.at} ${fact.kind} · ${fact.entry} · ${fact.actor}`;
}

function listFact(label: string, values: readonly string[]): readonly string[] {
  return values.length === 0 ? [] : [`  ${label}  ${values.join(" · ")}`];
}

function shortId(value: string): string {
  return /^[0-9a-f]{40}$/iu.test(value) ? value.slice(0, 7) : value;
}

/**
 * A persisted subject is a canonical `[kind, value]` key set. Only its snapshot names the commit the verdict
 * covers, so history speaks that component and leaves the segment and document keys to JSON.
 */
function subjectSnapshot(subject: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(subject) as unknown;
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  for (const key of parsed) {
    if (Array.isArray(key) && key[0] === "snapshot" && typeof key[1] === "string") return key[1];
  }
  return undefined;
}

function journalBody(fact: Fact): readonly string[] {
  switch (fact.kind) {
    case "bind": {
      const { coordinates, terms } = fact.data;
      return [
        `  start commit  ${shortId(coordinates.start)}`,
        ...(coordinates.target === undefined ? [] : [`  target  ${coordinates.target}`]),
        `  workspace  ${coordinates.workspace}`,
        ...listFact("gates", terms.gates),
        ...listFact("after", terms.after),
      ];
    }
    case "amend":
      return [...listFact("gates", fact.data.gates), ...listFact("after", fact.data.after)];
    case "bound":
      return [];
    case "deliver": {
      const { tenderSnapshot, integration, method, policy } = fact.data;
      return [
        `  tender commit  ${shortId(tenderSnapshot)}`,
        `  predecessor commit  ${shortId(integration.predecessor)}`,
        `  integration commit  ${shortId(integration.snapshot)}`,
        `  content identity (not commit)  ${integration.changeId}`,
        `  method  ${method}`,
        `  require branches up to date  ${String(policy.requireBranchesToBeUpToDate)}`,
      ];
    }
    case "reintegrated":
      return [
        `  predecessor commit  ${shortId(fact.data.predecessor)}`,
        `  integration commit  ${shortId(fact.data.snapshot)}`,
      ];
    case "attestation": {
      const snapshot = subjectSnapshot(fact.data.subject);
      const lines = [
        `  gate  ${fact.data.gate}`,
        `  verdict  ${fact.data.verdict}`,
        snapshot === undefined ? "  subject  verification" : `  subject  verification  · snapshot ${shortId(snapshot)}`,
      ];
      if (fact.data.summary !== undefined) {
        const clipped =
          fact.data.summary.length > 4096 ? `${fact.data.summary.slice(0, 4096)}\n[truncated]` : fact.data.summary;
        receiptPayload(lines, "summary", clipped);
      }
      return lines;
    }
    case "claimed":
      return [`  delivery  ${fact.data.delivery}`];
    case "arc": {
      const lines = [`  sequence  ${String(fact.data.seq)}`, `  title  ${fact.data.title}`];
      receiptPayload(lines, "objective", fact.data.objective);
      receiptPayload(lines, "brief", fact.data.brief);
      return lines;
    }
    case "abandoned": {
      if (fact.data.note === undefined) return [];
      const lines: string[] = [];
      receiptPayload(lines, "note", fact.data.note);
      return lines;
    }
  }
}

function contractHistoryEventLines(event: ContractHistoryEvent): readonly string[] {
  if (event.source === "dispatch") return [`${event.dispatch.dispatchedAt} dispatch · ${event.dispatch.akuId}`];
  return [journalHead(event.fact), ...journalBody(event.fact)];
}

export function renderContractHistory(history: ContractHistory): string {
  const journals = journalCount(history.events, "journal");
  const dispatches = journalCount(history.events, "dispatch");
  return [
    `history  ${history.id} · ${journals} journal · ${dispatches} dispatch`,
    "",
    ...history.events.flatMap(contractHistoryEventLines),
  ].join("\n");
}
