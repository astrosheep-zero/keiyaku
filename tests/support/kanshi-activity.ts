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
} from "../../src/akuma/projection.js";
import { projectCurrentWork } from "../../src/akuma/status-projection.js";
import { parseAkumaId } from "../../src/akuma/identity.js";
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
  return { kind: "tool", ...eventFields(sequence), toolId: `tool-${sequence}`, name, call, state };
}

export function activeTool(sequence: number, name: string, call: ActivityToolCall): ActiveToolRow {
  return { kind: "tool", ...eventFields(sequence), toolId: `tool-${sequence}`, name, call, state: "active" };
}

export function answeredOutcome(sequence: number, answer: string): OutcomeRow {
  return {
    kind: "outcome",
    ...eventFields(sequence),
    outcome: { kind: "answered", answer },
  };
}

export function reportedFileChange(path: string): ReportedFileChange {
  return { path };
}

export function openAkumaSnapshot(
  entries: readonly ActivitySnapshotEntry<OpenSnapshotRow>[],
  reportedChanges: readonly ReportedFileChange[] = [],
): Extract<ActivitySnapshot, { kind: "open" }> {
  return {
    kind: "open",
    turn: { kind: "turn", sequence: TURN_SEQUENCE, bodySequence: 1, at: AKUMA_ACTIVITY_AT },
    entries,
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
    reportedChanges: [],
    reportedChangesOmitted: 0,
    ...(outcome === undefined ? {} : { outcome }),
  };
}

export function activityAkumaRow(id: string, life: "running" | "asleep", snapshot: ActivitySnapshot): AkumaKanshiRow {
  return {
    id: parseAkumaId(id).id,
    life,
    lifeAt: AKUMA_ACTIVITY_AT,
    lastActivityAt: AKUMA_ACTIVITY_AT,
    work: projectCurrentWork(snapshot),
  };
}

export function akumaWorldReport(rows: readonly AkumaKanshiRow[]): KanshiReport {
  return {
    kind: "world",
    observedAt: AKUMA_OBSERVED_AT,
    contracts: { kind: "absent" },
    debts: { kind: "absent" },
    akumas: {
      kind: "present",
      ...(rows.length === 0 ? {} : { rows }),
    },
  };
}
