import { targetName } from "../../core/facts/types.js";
import type { ContractHistory, ContractHistoryEvent, Fact } from "../../index.js";
import { gateDisplayName, lifecycleWord, shortGitId } from "./contract-observation.js";
import { receiptPayload } from "./receipt.js";
import { renderOpaqueBlock, DEFAULT_CLI_COLUMNS } from "./terminal.js";

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

/**
 * A persisted subject is a canonical `[kind, value]` key set. Only its snapshot names the commit the verdict
 * covers, so history speaks that component and leaves the segment and document keys to JSON.
 */
function subjectValue(subject: string, wanted: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(subject) as unknown;
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  for (const key of parsed) {
    if (Array.isArray(key) && key[0] === wanted && typeof key[1] === "string") return key[1];
  }
  return undefined;
}

function journalBody(fact: Fact, workspace?: Readonly<{ kind: "worktree"; path: string }>): readonly string[] {
  switch (fact.kind) {
    case "bind": {
      const { coordinates, terms } = fact.data;
      return [
        `  start commit  ${shortGitId(coordinates.start)}`,
        ...(coordinates.target === undefined ? [] : [`  target  ${targetName(coordinates.target)}`]),
        `  ${workspace === undefined ? "worktree" : `worktree  ${workspace.path}`}`,
        ...listFact("gates", terms.gates),
        ...listFact("after", terms.after),
      ];
    }
    case "amend":
      return [...listFact("gates", fact.data.gates), ...listFact("after", fact.data.after)];
    case "deliver": {
      const { tenderSnapshot, integration, method, policy } = fact.data;
      return [
        `  candidate  ${shortGitId(tenderSnapshot)}`,
        `  predecessor commit  ${shortGitId(integration.predecessor)}`,
        `  integration result  ${shortGitId(integration.snapshot)}`,
        `  content identity  ${integration.changeId}`,
        `  method  ${method}`,
        `  require branches up to date  ${String(policy.requireBranchesToBeUpToDate)}`,
      ];
    }
    case "reintegrated":
      return [
        `  predecessor commit  ${shortGitId(fact.data.predecessor)}`,
        `  integration result  ${shortGitId(fact.data.snapshot)}`,
      ];
    case "attestation": {
      const snapshot = subjectValue(fact.data.subject, "snapshot");
      const lines = [
        `  gate  ${fact.data.gate}`,
        `  requirement  ${fact.data.requirement}`,
        `  verdict  ${fact.data.verdict}`,
        ...(snapshot === undefined ? [] : [`  snapshot  ${shortGitId(snapshot)}`]),
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
      const body = fact.data.body.replace(/^(?:\r?\n)+/u, "").trimEnd();
      if (body.length > 0) lines.push("  body", ...renderOpaqueBlock(body, "  ", DEFAULT_CLI_COLUMNS));
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

function fullEventLines(
  event: ContractHistoryEvent,
  workspace?: Readonly<{ kind: "worktree"; path: string }>,
): readonly string[] {
  if (event.source === "dispatch") return [`${event.dispatch.dispatchedAt} dispatch · ${event.dispatch.akuId}`];
  return [journalHead(event.fact), ...journalBody(event.fact, workspace)];
}

function renderFullHistory(history: ContractHistory): string {
  const journals = journalCount(history.events, "journal");
  const dispatches = journalCount(history.events, "dispatch");
  const counts = [
    ...(journals === 0 ? [] : [`${journals} journal ${journals === 1 ? "entry" : "entries"}`]),
    ...(dispatches === 0 ? [] : [`${dispatches} ${dispatches === 1 ? "dispatch" : "dispatches"}`]),
  ];
  return [
    `history  ${history.id}${counts.length === 0 ? "" : ` · ${counts.join(" · ")}`}`,
    "",
    ...history.events.flatMap((event) => fullEventLines(event, history.workspace)),
  ].join("\n");
}

type Beat = Readonly<{ events: readonly ContractHistoryEvent[] }>;

function eventAt(event: ContractHistoryEvent): string {
  return event.source === "journal" ? event.fact.at : event.dispatch.dispatchedAt;
}

function eventKind(event: ContractHistoryEvent): string {
  return event.source === "journal" ? event.fact.kind : "dispatch";
}

function mark(verdict: "satisfied" | "unsatisfied"): string {
  return verdict === "satisfied" ? "✓" : "×";
}

function bindLine(bind: Extract<Fact, { kind: "bind" }>, dispatch: ContractHistoryEvent | undefined): string {
  const destination = bind.data.coordinates.target;
  const target = destination === undefined ? "targetless" : targetName(destination).replace(/^refs\/heads\//u, "");
  const gates = bind.data.terms.gates.map(gateDisplayName);
  const gateFact = gates.length === 0 ? "" : ` · ${gates.length === 1 ? "gate" : "gates"} ${gates.join(" · ")}`;
  const caller = dispatch?.source === "dispatch" ? ` · ${dispatch.dispatch.akuId}` : "";
  return `bound to ${target} @ ${shortGitId(bind.data.coordinates.start)}${gateFact}${caller}`;
}

/**
 * The skeleton row is itself the first line of the beat's full form; the fold names the rest.
 * Counting the full form's rendered lines keeps the number honest under wrapping.
 */
function foldedPayloadLines(full: readonly string[]): number {
  return Math.max(0, full.length - 1);
}

const lineCount = (count: number): string => `${count} line${count === 1 ? "" : "s"}`;

function skeletonBeatLines(beat: Beat, history: ContractHistory): readonly string[] {
  const first = beat.events[0];
  if (first === undefined) return [];
  const full = beat.events.flatMap((event) => fullEventLines(event, history.workspace));
  const evidenceSuffix = (): string => {
    const count = foldedPayloadLines(full);
    return count > 0 ? ` · ${lineCount(count)}` : "";
  };
  const payloadSuffix = (rendered: readonly string[]): string =>
    rendered.length > 0 ? ` · ${lineCount(rendered.length)}` : "";
  if (first.source === "dispatch") return [`${clock(first)} dispatch · ${first.dispatch.akuId}`];
  const fact = first.fact;
  switch (fact.kind) {
    case "bind": {
      const dispatch = beat.events.find((event) => event.source === "dispatch");
      return [`${clock(first)} ${bindLine(fact, dispatch)}`];
    }
    case "deliver":
      return [`${clock(first)} delivered ${shortGitId(fact.data.tenderSnapshot)}${evidenceSuffix()}`];
    case "reintegrated":
      return [
        `${clock(first)} integrated ${shortGitId(fact.data.predecessor)}..${shortGitId(fact.data.snapshot)}${evidenceSuffix()}`,
      ];
    case "attestation": {
      const name = gateDisplayName(fact.data.gate);
      const requirement =
        fact.data.gate === "verified" || fact.data.requirement !== `gate:${fact.data.gate}`
          ? ` ${fact.data.requirement}`
          : "";
      const snapshot = subjectValue(fact.data.subject, "snapshot");
      return [
        `${clock(first)} ${mark(fact.data.verdict)} ${name}${requirement}${snapshot === undefined ? "" : ` · snapshot ${shortGitId(snapshot)}`}${evidenceSuffix()}`,
      ];
    }
    case "amend": {
      const changed = [fact.data.gates.length > 0 ? "gates" : "", fact.data.after.length > 0 ? "after" : ""]
        .filter((value) => value.length > 0)
        .join(" · ");
      return [`${clock(first)} amended${changed.length === 0 ? "" : ` · ${changed}`}`];
    }
    case "arc": {
      const body = fact.data.body.replace(/^(?:\r?\n)+/u, "").trimEnd();
      const folded = body.length === 0 ? [] : renderOpaqueBlock(body, "  ", DEFAULT_CLI_COLUMNS);
      return [`${clock(first)} arc ${fact.data.title}${payloadSuffix(folded)}`];
    }
    case "claimed":
      return [`${clock(first)} ${lifecycleWord("claimed")}`];
    case "abandoned":
      return [
        `${clock(first)} abandoned${fact.data.note === undefined ? "" : payloadSuffix(renderOpaqueBlock(fact.data.note, "  ", DEFAULT_CLI_COLUMNS))}`,
      ];
    default: {
      const folded = foldedPayloadLines(full);
      return [`${clock(first)} ${eventKind(first)}${folded > 0 ? ` · ${lineCount(folded)}` : ""}`];
    }
  }
}

function clock(event: ContractHistoryEvent): string {
  const date = new Date(eventAt(event));
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

function skeletonState(history: ContractHistory): string {
  const journal = history.events.filter(
    (event): event is Readonly<{ source: "journal"; fact: Fact }> => event.source === "journal",
  );
  if (journal.some((event) => event.fact.kind === "claimed")) return lifecycleWord("claimed");
  if (journal.some((event) => event.fact.kind === "abandoned")) return "abandoned";
  return "bound";
}

function skeletonBeats(history: ContractHistory): readonly Beat[] {
  const events = history.events;
  const consumed = new Set<number>();
  const beats: Beat[] = [];
  for (let index = 0; index < events.length; index += 1) {
    if (consumed.has(index)) continue;
    const event = events[index]!;
    const grouped = [event];
    consumed.add(index);
    if (event.source === "journal" && event.fact.kind === "bind") {
      for (let next = index + 1; next < events.length; next += 1) {
        const candidate = events[next]!;
        if (candidate.source !== "dispatch") break;
        grouped.push(candidate);
        consumed.add(next);
      }
    }
    beats.push({ events: grouped });
  }
  return beats;
}

function renderSkeleton(history: ContractHistory): string {
  const journals = journalCount(history.events, "journal");
  const dispatches = journalCount(history.events, "dispatch");
  const counts = [
    ...(journals === 0 ? [] : [`${journals} ${journals === 1 ? "entry" : "entries"}`]),
    ...(dispatches === 0 ? [] : [`${dispatches} ${dispatches === 1 ? "dispatch" : "dispatches"}`]),
  ];
  const header = `history  ${history.id} · ${skeletonState(history)}${counts.length === 0 ? "" : ` · ${counts.join(" · ")}`}`;
  const lines = [header, ""];
  let day: string | undefined;
  for (const beat of skeletonBeats(history)) {
    const first = beat.events[0]!;
    const nextDay = eventAt(first).slice(0, 10);
    if (nextDay !== day) {
      if (day !== undefined) lines.push("");
      lines.push(nextDay, "");
      day = nextDay;
    }
    lines.push(...skeletonBeatLines(beat, history));
  }
  return lines.join("\n");
}

export function renderContractHistory(history: ContractHistory, options: Readonly<{ full?: boolean }> = {}): string {
  return options.full === true ? renderFullHistory(history) : renderSkeleton(history);
}
