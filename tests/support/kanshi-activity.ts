import type {
  ActiveToolRow,
  ActivitySnapshot,
  ActivitySnapshotEntry,
  CompletedToolRow,
  IdleSnapshotRow,
  OpenSnapshotRow,
  OutcomeRow,
  ReportedFileChange,
  SnapshotRow,
} from "../../src/akuma/akuma.js";
import { parseAkuId } from "../../src/akuma/identity.js";
import type { AkumaKanshiRow, KanshiReport } from "../../src/kanshi/index.js";

export const AKUMA_ACTIVITY_AT = "2026-01-01T10:00:00.000Z";
const AKUMA_OBSERVED_AT = "2026-01-01T10:00:05.000Z";
const TURN_SEQUENCE = 1;

export type ActivityToolCall = CompletedToolRow["call"];
type ActivityToolResult = CompletedToolRow["state"];

function eventFields(sequence: number) {
  return { sequence, turnSequence: TURN_SEQUENCE, at: AKUMA_ACTIVITY_AT } as const;
}

/** Wrap one concrete snapshot row in the entry the retained timeline stores it as. */
export function snapshotRow<Row extends SnapshotRow>(row: Row): ActivitySnapshotEntry<Row> {
  return { kind: "row", row };
}

export function completedTool(
  sequence: number,
  name: string,
  call: ActivityToolCall,
  state: ActivityToolResult = { status: "ok" },
): CompletedToolRow {
  return { kind: "tool", ...eventFields(sequence), name, call, state };
}

export function activeTool(sequence: number, name: string, call: ActivityToolCall): ActiveToolRow {
  return { kind: "tool", ...eventFields(sequence), name, call, state: "active" };
}

export function answeredOutcome(sequence: number, answer: string): OutcomeRow {
  return {
    kind: "outcome",
    ...eventFields(sequence),
    outcome: { kind: "answered", historyId: "history-1", answer },
  };
}

export function reportedFileChange(
  sequence: number,
  op: ReportedFileChange["op"],
  path: string,
): ReportedFileChange {
  return { sequence, at: AKUMA_ACTIVITY_AT, op, path };
}

export function openAkumaSnapshot(
  entries: readonly ActivitySnapshotEntry<OpenSnapshotRow>[],
  reportedChanges: readonly ReportedFileChange[] = [],
): Extract<ActivitySnapshot, { kind: "open" }> {
  return {
    kind: "open",
    turn: { kind: "turn", ...eventFields(TURN_SEQUENCE), bodySequence: 1 },
    entries,
    omitted: 0,
    reportedChanges,
    reportedChangesOmitted: 0,
  };
}

export function idleAkumaSnapshot(
  entries: readonly ActivitySnapshotEntry<IdleSnapshotRow>[],
  outcome?: OutcomeRow,
): Extract<ActivitySnapshot, { kind: "idle" }> {
  return {
    kind: "idle",
    entries,
    omitted: 0,
    reportedChanges: [],
    reportedChangesOmitted: 0,
    ...(outcome === undefined ? {} : { outcome }),
  };
}

export function activityAkumaRow(
  id: string,
  life: "running" | "asleep",
  snapshot: ActivitySnapshot,
): AkumaKanshiRow {
  return {
    id: parseAkuId(id).id,
    archetype: "worker",
    life,
    lifeAt: AKUMA_ACTIVITY_AT,
    lastActivityAt: AKUMA_ACTIVITY_AT,
    pending: [],
    aliases: [],
    snapshot,
  };
}

export function akumaWorldReport(rows: readonly AkumaKanshiRow[]): KanshiReport {
  return {
    root: null,
    observedAt: AKUMA_OBSERVED_AT,
    branch: null,
    contracts: { kind: "absent" },
    tasks: { kind: "absent" },
    akuma: {
      kind: "present",
      value: { observedAt: AKUMA_ACTIVITY_AT, searched: [], hasMore: false, rows },
    },
  };
}
