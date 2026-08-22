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
  return values.length === 0 ? [`  ${label} 0`] : [`  ${label} ${values.join(" · ")}`];
}

function journalBody(fact: Fact): readonly string[] {
  switch (fact.kind) {
    case "bind": {
      const { coordinates, terms } = fact.data;
      return [
        `  start ${coordinates.start}`,
        ...(coordinates.target === undefined ? [] : [`  target ${coordinates.target}`]),
        `  workspace ${coordinates.workspace}`,
        `  document ${terms.document.key}`,
        ...listFact("gates", terms.gates),
        ...listFact("after", terms.after),
      ];
    }
    case "amend":
      return [
        `  document ${fact.data.document.key}`,
        ...listFact("gates", fact.data.gates),
        ...listFact("after", fact.data.after),
      ];
    case "bound":
      return [];
    case "deliver": {
      const { tenderSnapshot, integration, method, policy } = fact.data;
      return [
        `  tender ${tenderSnapshot}`,
        `  predecessor ${integration.predecessor}`,
        `  snapshot ${integration.snapshot}`,
        `  change ${integration.changeId}`,
        `  method ${method}`,
        `  require-branches-to-be-up-to-date ${String(policy.requireBranchesToBeUpToDate)}`,
      ];
    }
    case "reintegrated":
      return [`  predecessor ${fact.data.predecessor}`, `  snapshot ${fact.data.snapshot}`];
    case "attestation": {
      const lines = [`  gate ${fact.data.gate}`, `  verdict ${fact.data.verdict}`, `  subject ${fact.data.subject}`];
      if (fact.data.summary !== undefined) receiptPayload(lines, "summary", fact.data.summary);
      return lines;
    }
    case "claimed":
      return [`  delivery ${fact.data.delivery}`];
    case "arc": {
      const lines = [`  sequence ${String(fact.data.seq)}`, `  title ${fact.data.title}`];
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
    `history ${history.id} · ${journals} journal · ${dispatches} dispatch`,
    "",
    ...history.events.flatMap(contractHistoryEventLines),
  ].join("\n");
}
