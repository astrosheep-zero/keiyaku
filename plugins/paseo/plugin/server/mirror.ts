import type { ProviderEvent, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import type { Row } from "./keiyaku.js";

type Emit = (event: ProviderEvent) => void;
export function createMirror(sessionId: string, emit: Emit) {
  let covered: { high: number; signatures: Map<number, string> } | undefined;
  let turn: { sequence: number; closed: boolean } | undefined;
  let unhealthy = false;
  const item = (value: ProviderTimelineItem, timestamp?: string) => emit({
    type: "timeline.item", sessionId, item: value, ...(timestamp === undefined ? {} : { timestamp }),
  });
  const finish = (state: "completed" | "failed" | "canceled", message?: string) => {
    if (!turn || turn.closed) return;
    turn.closed = true;
    emit({ type: "session.turn", sessionId, turnId: `turn/${turn.sequence}`, state,
      ...(message === undefined ? {} : { error: { message } }) });
  };
  return {
    cancel: (reason: string) => finish("canceled", reason),
    unreadable() {
      if (!unhealthy) item({ type: "notification", level: "warning",
        id: `keiyaku:unreadable/${covered ? Math.min(...covered.signatures.keys()) : 0}`,
        message: "Keiyaku read surface unavailable; retaining the previous mirror." });
      unhealthy = true;
    },
    publish(input: Row[]) {
      const rows = [...input].sort((a, b) => a.sequence - b.sequence);
      const lowest = rows[0]?.sequence;
      // Reads overlap: only a window beyond the previous frontier loses coverage.
      const gap = lowest !== undefined && lowest > (covered?.high ?? 0) + 1;
      if (gap) {
        item({ type: "notification", level: "warning", id: `keiyaku:window/${lowest}`,
          message: `Mirror begins at sequence ${lowest}; ${lowest - 1} earlier rows exist or are outside retention.` });
      }
      for (const row of rows) {
        if (covered?.signatures.get(row.sequence) === JSON.stringify(row)) continue;
        if (row.kind === "tell" && row.state === "told") {
          item({ type: "user_message", id: `keiyaku:tell/${row.tellId}`, text: row.text }, row.at);
        } else if (row.kind === "outcome") {
          item(row.outcome.kind === "answered"
            ? { type: "assistant_message", id: `keiyaku:turn/${row.turnSequence}`, text: row.outcome.answer }
            : { type: "error", id: `keiyaku:turn/${row.turnSequence}`, message: row.outcome.diagnostic }, row.at);
        }
      }
      if (gap) finish("canceled", `coverage gap ${(covered?.high ?? 0) + 1}-${lowest - 1}`);
      const outcome = rows.find((row) => row.kind === "outcome" && row.turnSequence === turn?.sequence);
      if (outcome?.kind === "outcome") finish(outcome.outcome.kind === "answered" ? "completed" : "failed",
        outcome.outcome.kind === "failed" ? outcome.outcome.diagnostic : undefined);
      const latest = rows.filter((row) => row.kind === "turn").at(-1);
      if (latest?.kind === "turn" && (!turn || latest.turnSequence > turn.sequence)) {
        const ended = rows.some((row) => row.kind === "outcome" && row.turnSequence === latest.turnSequence);
        turn = { sequence: latest.turnSequence, closed: ended };
        if (!ended) emit({ type: "session.turn", sessionId, turnId: `turn/${turn.sequence}`, state: "started" });
      }
      covered = { high: Math.max(covered?.high ?? 0, rows.at(-1)?.sequence ?? 0),
        signatures: new Map(rows.map((row) => [row.sequence, JSON.stringify(row)])) };
      unhealthy = false;
    },
  };
}
