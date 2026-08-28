import type { AkumaStatus } from "../akuma/index.js";
import { parseAkuId } from "../akuma/identity.js";

type FleetResultRecord = Readonly<Record<string, unknown>>;

export function exactFleetKeys(value: FleetResultRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

export function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

export function nonblankFleetText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function fleetCount(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function canonicalFleetAkuId(value: unknown): AkumaStatus["id"] | null {
  if (typeof value !== "string") return null;
  try {
    const id = parseAkuId(value).id;
    return id === value ? id : null;
  } catch {
    return null;
  }
}

function fleetTimestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function optionalTruncated(value: Readonly<Record<string, unknown>>): boolean {
  return value.truncated === undefined || value.truncated === true;
}

function runToolCall(call: FleetResultRecord): boolean {
  return exactFleetKeys(call, ["command", "kind"]) && typeof call.command === "string";
}

function readToolCall(call: FleetResultRecord): boolean {
  const expected = [
    "kind",
    "path",
    ...(call.offset === undefined ? [] : ["offset"]),
    ...(call.limit === undefined ? [] : ["limit"]),
  ];
  return (
    exactFleetKeys(call, expected) &&
    typeof call.path === "string" &&
    (call.offset === undefined || fleetCount(call.offset)) &&
    (call.limit === undefined || fleetCount(call.limit))
  );
}

function searchToolCall(call: FleetResultRecord): boolean {
  const expected = [
    "kind",
    "query",
    ...(call.scope === undefined ? [] : ["scope"]),
    ...(call.path === undefined ? [] : ["path"]),
    ...(call.glob === undefined ? [] : ["glob"]),
  ];
  return (
    exactFleetKeys(call, expected) &&
    typeof call.query === "string" &&
    (call.scope === undefined || ["content", "files", "web"].includes(call.scope as string)) &&
    (call.path === undefined || typeof call.path === "string") &&
    (call.glob === undefined || typeof call.glob === "string")
  );
}

function fileChangeRecord(value: unknown): boolean {
  const change = record(value);
  const diffstat = change === null ? null : record(change.diffstat);
  const expected = ["op", "path", ...(change?.diffstat === undefined ? [] : ["diffstat"])];
  return (
    change !== null &&
    exactFleetKeys(change, expected) &&
    ["add", "update", "delete", "unspecified"].includes(change.op as string) &&
    typeof change.path === "string" &&
    (change.diffstat === undefined ||
      (diffstat !== null &&
        exactFleetKeys(diffstat, ["added", "removed"]) &&
        fleetCount(diffstat.added) &&
        fleetCount(diffstat.removed)))
  );
}

function fileChangeToolCall(call: FleetResultRecord): boolean {
  return (
    exactFleetKeys(call, ["changes", "kind"]) && Array.isArray(call.changes) && call.changes.every(fileChangeRecord)
  );
}

function otherToolCall(call: FleetResultRecord): boolean {
  return exactFleetKeys(call, ["display", "kind"]) && typeof call.display === "string";
}

const fleetToolCallVariants: Readonly<Record<string, (call: FleetResultRecord) => boolean>> = {
  run: runToolCall,
  read: readToolCall,
  search: searchToolCall,
  fileChange: fileChangeToolCall,
  other: otherToolCall,
};

function fleetToolCall(value: unknown): boolean {
  const call = record(value);
  if (call === null || typeof call.kind !== "string") return false;
  return fleetToolCallVariants[call.kind]?.(call) ?? false;
}

function fleetToolResult(value: unknown): boolean {
  const result = record(value);
  return (
    result !== null &&
    exactFleetKeys(result, [
      "status",
      ...(result.message === undefined ? [] : ["message"]),
      ...(result.exitCode === undefined ? [] : ["exitCode"]),
    ]) &&
    (result.status === "ok" || result.status === "error") &&
    (result.message === undefined || typeof result.message === "string") &&
    (result.exitCode === undefined || (typeof result.exitCode === "number" && Number.isSafeInteger(result.exitCode)))
  );
}

function fleetTellDeliveries(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((delivery) => {
      const item = record(delivery);
      return (
        item !== null &&
        exactFleetKeys(item, [
          "deliveredAt",
          "route",
          "turnSequence",
          ...(item.receipt === undefined ? [] : ["receipt"]),
        ]) &&
        fleetCount(item.turnSequence) &&
        fleetTimestamp(item.deliveredAt) &&
        (item.route === "launch" || item.route === "live") &&
        (item.route === "live"
          ? item.receipt === "unavailable" || item.receipt === "required"
          : item.receipt === undefined)
      );
    })
  );
}

function turnTimelineRow(row: FleetResultRecord): boolean {
  return (
    exactFleetKeys(row, ["at", "bodySequence", "kind", "sequence", "turnSequence"]) &&
    fleetTimestamp(row.at) &&
    fleetCount(row.bodySequence) &&
    fleetCount(row.sequence) &&
    fleetCount(row.turnSequence)
  );
}

function textTimelineRow(row: FleetResultRecord): boolean {
  const expected = [
    "at",
    "kind",
    "sequence",
    "text",
    "turnSequence",
    ...(row.truncated === undefined ? [] : ["truncated"]),
  ];
  return (
    exactFleetKeys(row, expected) &&
    fleetTimestamp(row.at) &&
    fleetCount(row.sequence) &&
    fleetCount(row.turnSequence) &&
    typeof row.text === "string" &&
    optionalTruncated(row)
  );
}

function tellTimelineRow(row: FleetResultRecord): boolean {
  return (
    exactFleetKeys(row, ["at", "deliveries", "kind", "sequence", "state", "tellId", "text"]) &&
    fleetTimestamp(row.at) &&
    fleetCount(row.sequence) &&
    nonblankFleetText(row.tellId) &&
    typeof row.text === "string" &&
    (row.state === "pending" || row.state === "told") &&
    fleetTellDeliveries(row.deliveries)
  );
}

function outcomeValue(value: unknown): boolean {
  const outcome = record(value);
  if (outcome === null) return false;
  if (outcome.kind === "answered") {
    return (
      exactFleetKeys(outcome, ["answer", "historyId", "kind"]) &&
      nonblankFleetText(outcome.historyId) &&
      typeof outcome.answer === "string"
    );
  }
  return (
    outcome.kind === "failed" &&
    exactFleetKeys(outcome, ["diagnostic", "historyId", "kind"]) &&
    nonblankFleetText(outcome.historyId) &&
    typeof outcome.diagnostic === "string"
  );
}

function outcomeTimelineRow(row: FleetResultRecord): boolean {
  return (
    exactFleetKeys(row, ["at", "kind", "outcome", "sequence", "turnSequence"]) &&
    fleetTimestamp(row.at) &&
    fleetCount(row.sequence) &&
    fleetCount(row.turnSequence) &&
    outcomeValue(row.outcome)
  );
}

function toolTimelineRow(row: FleetResultRecord): boolean {
  const expected = [
    "at",
    "call",
    "kind",
    "name",
    "sequence",
    "state",
    "turnSequence",
    ...(row.completedAt === undefined ? [] : ["completedAt"]),
    ...(row.durationMs === undefined ? [] : ["durationMs"]),
    ...(row.truncated === undefined ? [] : ["truncated"]),
  ];
  return (
    exactFleetKeys(row, expected) &&
    fleetTimestamp(row.at) &&
    fleetCount(row.sequence) &&
    fleetCount(row.turnSequence) &&
    nonblankFleetText(row.name) &&
    fleetToolCall(row.call) &&
    optionalTruncated(row) &&
    (row.completedAt === undefined || fleetTimestamp(row.completedAt)) &&
    (row.durationMs === undefined ||
      (typeof row.durationMs === "number" && Number.isFinite(row.durationMs) && row.durationMs >= 0)) &&
    (row.state === "active" || row.state === "unsettled" || fleetToolResult(row.state))
  );
}

const fleetTimelineRowVariants: Readonly<Record<string, (row: FleetResultRecord) => boolean>> = {
  turn: turnTimelineRow,
  call: textTimelineRow,
  said: textTimelineRow,
  thought: textTimelineRow,
  note: textTimelineRow,
  tell: tellTimelineRow,
  outcome: outcomeTimelineRow,
  tool: toolTimelineRow,
};

function fleetTimelineRow(value: unknown): boolean {
  const row = record(value);
  if (row === null || typeof row.kind !== "string") return false;
  return fleetTimelineRowVariants[row.kind]?.(row) ?? false;
}

function reportedFileChange(value: unknown): boolean {
  const change = record(value);
  const diffstat = change === null ? null : record(change.diffstat);
  const expected = ["at", "op", "path", "sequence", ...(change?.diffstat === undefined ? [] : ["diffstat"])];
  return (
    change !== null &&
    exactFleetKeys(change, expected) &&
    fleetTimestamp(change.at) &&
    fleetCount(change.sequence) &&
    typeof change.path === "string" &&
    ["add", "update", "delete", "unspecified"].includes(change.op as string) &&
    (change.diffstat === undefined ||
      (diffstat !== null &&
        exactFleetKeys(diffstat, ["added", "removed"]) &&
        fleetCount(diffstat.added) &&
        fleetCount(diffstat.removed)))
  );
}

function timelineEntry(value: unknown): boolean {
  const entry = record(value);
  if (entry === null || typeof entry.kind !== "string") return false;
  if (entry.kind === "gap") return exactFleetKeys(entry, ["count", "kind"]) && fleetCount(entry.count);
  return entry.kind === "row" && exactFleetKeys(entry, ["kind", "row"]) && fleetTimelineRow(entry.row);
}

function timelineCommon(timeline: FleetResultRecord): boolean {
  const expected = [
    "entries",
    "kind",
    "omitted",
    "reportedChanges",
    "reportedChangesOmitted",
    ...(timeline.turn === undefined ? [] : ["turn"]),
    ...(timeline.outcome === undefined ? [] : ["outcome"]),
  ];
  return (
    exactFleetKeys(timeline, expected) &&
    fleetCount(timeline.omitted) &&
    fleetCount(timeline.reportedChangesOmitted) &&
    Array.isArray(timeline.reportedChanges) &&
    timeline.reportedChanges.every(reportedFileChange) &&
    Array.isArray(timeline.entries) &&
    timeline.entries.every(timelineEntry)
  );
}

function unbornTimeline(timeline: FleetResultRecord): boolean {
  return (
    timeline.turn === undefined &&
    timeline.outcome === undefined &&
    Array.isArray(timeline.entries) &&
    timeline.entries.length === 0 &&
    timeline.omitted === 0
  );
}

function openTimeline(timeline: FleetResultRecord): boolean {
  return fleetTimelineRow(timeline.turn) && record(timeline.turn)?.kind === "turn" && timeline.outcome === undefined;
}

function idleTimeline(timeline: FleetResultRecord): boolean {
  return (
    timeline.turn === undefined &&
    (timeline.outcome === undefined ||
      (fleetTimelineRow(timeline.outcome) && record(timeline.outcome)?.kind === "outcome"))
  );
}

const fleetTimelineVariants: Readonly<Record<string, (timeline: FleetResultRecord) => boolean>> = {
  unborn: unbornTimeline,
  open: openTimeline,
  idle: idleTimeline,
};

function fleetTimeline(value: unknown): boolean {
  const timeline = record(value);
  if (timeline === null || typeof timeline.kind !== "string" || !timelineCommon(timeline)) return false;
  return fleetTimelineVariants[timeline.kind]?.(timeline) ?? false;
}

function fleetReadonly(value: unknown): boolean {
  const restraint = record(value);
  return (
    restraint !== null &&
    ((restraint.enforcement === "native" && exactFleetKeys(restraint, ["enforcement"])) ||
      (restraint.enforcement === "none" &&
        exactFleetKeys(restraint, ["diagnostic", "enforcement"]) &&
        nonblankFleetText(restraint.diagnostic)))
  );
}

export function isFleetTaskRows(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((row) => {
      const item = record(row);
      const children = item === null ? null : record(item.children);
      return (
        item !== null &&
        exactFleetKeys(item, [
          "bodyPresent",
          "disposition",
          "id",
          "priority",
          "state",
          "title",
          "updatedAt",
          ...(item.children === undefined ? [] : ["children"]),
        ]) &&
        typeof item.id === "string" &&
        nonblankFleetText(item.title) &&
        ["open", "in_progress", "on_hold", "done", "drop"].includes(item.state as string) &&
        ["ready", "blocked", "in_progress", "on_hold", "done", "drop"].includes(item.disposition as string) &&
        [0, 1, 2, 3].includes(item.priority as number) &&
        typeof item.bodyPresent === "boolean" &&
        fleetTimestamp(item.updatedAt) &&
        (item.children === undefined ||
          (children !== null &&
            exactFleetKeys(children, ["live", "total"]) &&
            fleetCount(children.live) &&
            fleetCount(children.total)))
      );
    })
  );
}

export function isFleetStatus(value: unknown): value is AkumaStatus {
  const status = record(value);
  const id = status === null ? null : canonicalFleetAkuId(status.id);
  const expected = [
    "id",
    "life",
    "timeline",
    ...(status?.readonly === undefined ? [] : ["readonly"]),
    ...(status?.strandedReason === undefined ? [] : ["strandedReason"]),
  ];
  return (
    status !== null &&
    exactFleetKeys(status, expected) &&
    id !== null &&
    (status.life === "running" ||
      status.life === "asleep" ||
      status.life === "stranded" ||
      status.life === "hung" ||
      status.life === "untidy" ||
      status.life === "killed") &&
    (status.strandedReason === undefined || status.strandedReason === "resume-unsupported") &&
    fleetTimeline(status.timeline) &&
    (status.readonly === undefined || fleetReadonly(status.readonly))
  );
}
