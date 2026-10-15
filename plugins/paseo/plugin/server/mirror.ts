import type { ProviderEvent, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import type { Row } from "./keiyaku.js";
import type { AdmittedMessage } from "./message.js";

type Emit = (event: ProviderEvent) => void;
type Turn = { sequence: number; closed: boolean };
export function createMirror(sessionId: string, emit: Emit) {
  let covered: { high: number; signatures: Map<number, string> } | undefined;
  let turn: Turn | undefined;
  let captured: Turn | undefined;
  let unhealthy = false;
  let submissions = 0;
  let deferred: Row[] | undefined;
  const displayedTells = new Map<string, number>();
  const item = (value: ProviderTimelineItem, timestamp?: string) => emit({
    type: "timeline.item", sessionId, item: value, ...(timestamp === undefined ? {} : { timestamp }),
  });
  const finish = (target: Turn | undefined, state: "completed" | "failed" | "canceled", message?: string) => {
    if (!target || target.closed) return;
    target.closed = true;
    emit({ type: "session.turn", sessionId, turnId: `turn/${target.sequence}`, state,
      ...(message === undefined ? {} : { error: { message } }) });
  };
  const userMessage = (row: Extract<Row, { kind: "tell" }>, clientMessageId?: string) => {
    if (displayedTells.has(row.tellId)) return;
    displayedTells.set(row.tellId, row.sequence);
    item({ type: "user_message", id: `keiyaku:tell/${row.tellId}`, text: row.text,
      ...(clientMessageId === undefined ? {} : { clientMessageId }) }, row.at);
  };
  const mirror = {
    seed(rows: Row[]) {
      covered = { high: Math.max(0, ...rows.map((row) => row.sequence)),
        signatures: new Map(rows.map((row) => [row.sequence, JSON.stringify(row)])) };
      for (const row of rows) if (row.kind === "tell") displayedTells.set(row.tellId, row.sequence);
      const latest = rows.filter((row) => row.kind === "turn").sort((a, b) => a.sequence - b.sequence).at(-1);
      if (latest?.kind === "turn") {
        turn = { sequence: latest.turnSequence,
          closed: rows.some((row) => row.kind === "outcome" && row.turnSequence === latest.turnSequence) };
        if (!turn.closed) emit({ type: "session.turn", sessionId, turnId: `turn/${turn.sequence}`, state: "started" });
      }
    },
    hold() {
      submissions++;
      return (publish = true) => {
        submissions--;
        if (submissions === 0) {
          const rows = deferred;
          deferred = undefined;
          if (rows && publish) mirror.publish(rows);
        }
      };
    },
    currentTurnId: () => turn && !turn.closed ? `turn/${turn.sequence}` : undefined,
    refreshedTurnId() {
      const latest = deferred?.filter((row) => row.kind === "turn").at(-1);
      if (latest?.kind !== "turn") return mirror.currentTurnId();
      if (deferred?.some((row) => row.kind === "outcome" && row.turnSequence === latest.turnSequence)) return undefined;
      if (turn?.sequence === latest.turnSequence && turn.closed) return undefined;
      return `turn/${latest.turnSequence}`;
    },
    admit(row: AdmittedMessage, clientMessageId: string) {
      userMessage(row, clientMessageId);
    },
    cancel: (reason: string) => finish(turn, "canceled", reason),
    observedTurn(): Readonly<{ cancel(reason: string): void }> | undefined {
      if (!turn || turn.closed) return undefined;
      const observed = turn;
      captured = observed;
      return { cancel(reason: string) {
        if (deferred?.some((row) => row.kind === "outcome" && row.turnSequence === observed.sequence)) return;
        finish(observed, "canceled", reason);
      } };
    },
    unreadable() {
      if (!unhealthy) item({ type: "notification", level: "warning",
        id: `keiyaku:unreadable/${covered ? Math.min(...covered.signatures.keys()) : 0}`,
        message: "Keiyaku read surface unavailable; retaining the previous mirror." });
      unhealthy = true;
    },
    publish(input: Row[]) {
      // Hold racing reads until native Tell identity can replace the optimistic item.
      if (submissions > 0) { deferred = input; return; }
      const rows = [...input].sort((a, b) => a.sequence - b.sequence);
      const lowest = rows[0]?.sequence;
      // Reads overlap: only a window beyond the previous frontier loses coverage.
      const gap = lowest !== undefined && lowest > (covered?.high ?? 0) + 1;
      if (gap) {
        item({ type: "notification", level: "warning", id: `keiyaku:window/${lowest}`,
          message: `Mirror begins at sequence ${lowest}; ${lowest - 1} earlier rows exist or are outside retention.` });
        finish(turn, "canceled", `coverage gap ${(covered?.high ?? 0) + 1}-${lowest - 1}`);
      }
      for (const row of rows) {
        if (covered?.signatures.get(row.sequence) === JSON.stringify(row)) continue;
        if (row.kind === "tell") {
          userMessage(row);
        } else if (row.kind === "turn") {
          // Publish retained starts even when their outcomes arrive in this read.
          // Older starts must not reopen a sealed or superseded Turn.
          if (!turn || row.turnSequence > turn.sequence) {
            turn = { sequence: row.turnSequence, closed: false };
            emit({ type: "session.turn", sessionId, turnId: `turn/${turn.sequence}`, state: "started" });
          }
        } else if (row.kind === "outcome") {
          item(row.outcome.kind === "answered"
            ? { type: "assistant_message", id: `keiyaku:turn/${row.turnSequence}`, text: row.outcome.answer }
            : { type: "error", id: `keiyaku:turn/${row.turnSequence}`, message: row.outcome.diagnostic }, row.at);
          const target = turn?.sequence === row.turnSequence ? turn
            : captured?.sequence === row.turnSequence ? captured : undefined;
          finish(target, row.outcome.kind === "answered" ? "completed" : "failed",
            row.outcome.kind === "failed" ? row.outcome.diagnostic : undefined);
        }
      }
      covered = { high: Math.max(covered?.high ?? 0, rows.at(-1)?.sequence ?? 0),
        signatures: new Map(rows.map((row) => [row.sequence, JSON.stringify(row)])) };
      if (lowest !== undefined) for (const [id, sequence] of displayedTells) {
        if (sequence < lowest) displayedTells.delete(id);
      }
      unhealthy = false;
    },
  };
  return mirror;
}
