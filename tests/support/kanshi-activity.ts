import type { ActivityRow, OutcomeRow, ToolRow } from "../../src/akuma/projection.js";
import { projectCurrentWork } from "../../src/akuma/status-projection.js";
import { parseAkumaId } from "../../src/akuma/identity.js";
import type { AkumaKanshiRow, KanshiReport } from "../../src/kanshi/index.js";

export const AKUMA_ACTIVITY_AT = "2026-01-01T10:00:00.000Z";
const AKUMA_OBSERVED_AT = "2026-01-01T10:00:05.000Z";
const TURN_SEQUENCE = 1;

export type ActivityToolCall = ToolRow["call"];
type ActivityToolResult = NonNullable<ToolRow["result"]>;

function eventFields(sequence: number, turnSequence = TURN_SEQUENCE) {
  return { sequence, turnSequence, at: AKUMA_ACTIVITY_AT } as const;
}

export function turnStarted(sequence = TURN_SEQUENCE, bodySequence = 1): Extract<ActivityRow, { kind: "turn" }> {
  return { kind: "turn", sequence, bodySequence, at: AKUMA_ACTIVITY_AT };
}

export function startedTool(sequence: number, name: string, call: ActivityToolCall, toolId = `tool-${sequence}`): ToolRow {
  return { kind: "tool", ...eventFields(sequence), toolId, name, call, phase: "started" };
}

export function completedTool(
  sequence: number,
  name: string,
  call: ActivityToolCall,
  result: ActivityToolResult = { status: "ok" },
  toolId = `tool-${sequence}`,
): ToolRow {
  return { kind: "tool", ...eventFields(sequence), toolId, name, call, phase: "completed", result };
}

export function answeredOutcome(sequence: number, answer: string, turnSequence = TURN_SEQUENCE): OutcomeRow {
  return {
    kind: "outcome",
    ...eventFields(sequence, turnSequence),
    outcome: { kind: "answered", answer },
  };
}

export function reportedFileChange(path: string) {
  return { path };
}

export function activityAkumaRow(id: string, life: "running" | "asleep", rows: readonly ActivityRow[]): AkumaKanshiRow {
  return {
    id: parseAkumaId(id).id,
    life,
    lifeAt: AKUMA_ACTIVITY_AT,
    lastActivityAt: AKUMA_ACTIVITY_AT,
    work: projectCurrentWork(rows),
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
