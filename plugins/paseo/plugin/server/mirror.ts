import { z } from "zod";
import type { ProviderEvent, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import type { History, Row } from "./keiyaku.js";
import type { AdmittedMessage } from "./message.js";

type Emit = (event: ProviderEvent) => void;
type Turn = { sequence: number; closed: boolean };
export function createMirror(sessionId: string, emit: Emit) {
  let covered: { high: number; signatures: Map<number, string> } | undefined;
  let turn: Turn | undefined;
  const openTurns = new Map<number, Turn>();
  let unhealthy = false;
  let coverageNotice = "";
  let submissions = 0;
  let deferred: History | undefined;
  let deferredReannounce = false;
  const displayedTells = new Map<string, number>();
  const item = (value: ProviderTimelineItem, timestamp?: string) => emit({
    type: "timeline.item", sessionId, item: value, ...(timestamp === undefined ? {} : { timestamp }),
  });
  const finish = (target: Turn | undefined, state: "completed" | "failed" | "canceled", message?: string) => {
    if (!target || target.closed) return;
    target.closed = true;
    openTurns.delete(target.sequence);
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
    seed(history: History) {
      const { rows } = history;
      covered = { high: history.highest ?? 0,
        signatures: new Map(rows.map((row) => [row.sequence, JSON.stringify(row)])) };
      for (const row of rows) if (row.kind === "tell") displayedTells.set(row.tellId, row.sequence);
      const latest = rows.filter((row) => row.kind === "turn").sort((a, b) => a.sequence - b.sequence).at(-1);
      if (latest?.kind === "turn") {
        turn = { sequence: latest.turnSequence,
          closed: rows.some((row) => row.kind === "outcome" && row.turnSequence === latest.turnSequence) };
        if (!turn.closed) {
          openTurns.set(turn.sequence, turn);
          emit({ type: "session.turn", sessionId, turnId: `turn/${turn.sequence}`, state: "started" });
        }
      }
    },
    hold() {
      submissions++;
      return (publish = true) => {
        submissions--;
        if (submissions === 0) {
          const rows = deferred;
          const reannounce = deferredReannounce;
          deferred = undefined;
          deferredReannounce = false;
          if (rows && publish) mirror.publish(rows, reannounce);
        }
      };
    },
    currentTurnId: () => turn && !turn.closed ? `turn/${turn.sequence}` : undefined,
    refreshedTurnId() {
      const latest = deferred?.rows.filter((row) => row.kind === "turn").at(-1);
      if (latest?.kind !== "turn") return mirror.currentTurnId();
      if (deferred?.rows.some((row) => row.kind === "outcome" && row.turnSequence === latest.turnSequence)) return undefined;
      if (turn?.sequence === latest.turnSequence && turn.closed) return undefined;
      return `turn/${latest.turnSequence}`;
    },
    admit(row: AdmittedMessage, clientMessageId: string) {
      userMessage(row, clientMessageId);
    },
    cancel(reason: string) {
      for (const target of openTurns.values()) finish(target, "canceled", reason);
    },
    observedTurn(): Readonly<{ cancel(reason: string): void }> | undefined {
      if (!turn || turn.closed) return undefined;
      const observed = turn;
      return { cancel(reason: string) {
        if (deferred?.rows.some((row) => row.kind === "outcome" && row.turnSequence === observed.sequence)) return;
        finish(observed, "canceled", reason);
      } };
    },
    unreadable() {
      deferredReannounce = false;
      if (!unhealthy) item({ type: "notification", level: "warning",
        id: `keiyaku:unreadable/${covered ? Math.min(...covered.signatures.keys()) : 0}`,
        message: "Keiyaku read surface unavailable; retaining the previous mirror." });
      unhealthy = true;
    },
    publish(input: History, reannounce = false) {
      // Hold racing reads until native Tell identity can replace the optimistic item.
      if (submissions > 0) { deferred = input; deferredReannounce ||= reannounce; return; }
      const rows = [...input.rows].sort((a, b) => a.sequence - b.sequence);
      const lowest = rows[0]?.sequence;
      // Public history metadata, not projected sequence holes, owns coverage.
      // Neither missing retention nor a bounded read is an execution outcome.
      const uncoveredEarlier = input.hasEarlier && (!covered || lowest === undefined || lowest > covered.high);
      const notice = input.historyLost ? "retention" : uncoveredEarlier ? "bounded" : "";
      const noticeKey = notice ? `${notice}/${input.lowestRetained ?? "empty"}` : "";
      if (noticeKey && noticeKey !== coverageNotice) {
        item({ type: "notification", level: "warning", id: `keiyaku:window/${lowest ?? "empty"}`,
          message: input.historyLost
            ? "Keiyaku reports history outside retention; retained records remain available. Execution state is unchanged."
            : "Earlier retained history is outside this bounded mirror read. Execution state is unchanged." });
      }
      coverageNotice = noticeKey;
      for (const row of rows) {
        if (covered?.signatures.get(row.sequence) === JSON.stringify(row)) continue;
        if (row.kind === "tell") {
          userMessage(row);
        } else if (row.kind === "call") {
          item({ type: "user_message", id: `keiyaku:call/${row.sequence}`, text: row.text }, row.at);
        } else if (row.kind === "turn") {
          // Publish retained starts even when their outcomes arrive in this read.
          // Older starts must not reopen a sealed or superseded Turn.
          if (!turn || row.turnSequence > turn.sequence) {
            turn = { sequence: row.turnSequence, closed: false };
            openTurns.set(turn.sequence, turn);
            emit({ type: "session.turn", sessionId, turnId: `turn/${turn.sequence}`, state: "started" });
          }
        } else if (row.kind === "tool") {
          // Tool identity comes from the producer, scoped to its Turn. An older
          // CLI without it can show settled records, never guessed live pairing.
          const state = row.state;
          const toolIdentity = row.toolId === undefined ? `record/${row.sequence}` : `${row.turnSequence}/${row.toolId}`;
          if (typeof state === "string" && row.toolId === undefined) {
            item({ type: "notification", id: `keiyaku:tool/${row.sequence}`, level: "info",
              message: `${row.name}: ${state === "active" ? "start observed" : "result not witnessed"}. ${JSON.stringify(row.call)}` }, row.at);
            continue;
          }
          const result = typeof state === "object" ? state : undefined;
          // The result's own output is the observed text; its diagnostic message is
          // only the stand-in an older producer wrote instead, so an honestly empty
          // output is never replaced by its diagnostic.
          const output = result === undefined ? undefined : result.output === undefined ? result.message : result.output;
          const single = row.call.kind === "fileChange" && row.call.changes.length === 1 ? row.call.changes[0] : undefined;
          const detail: Extract<ProviderTimelineItem, { type: "tool_call" }>["detail"] = row.call.kind === "run"
            ? { type: "shell", command: row.call.command,
              ...(output === undefined ? {} : { output }),
              ...(result?.exitCode === undefined ? {} : { exitCode: result.exitCode }) }
            : row.call.kind === "read"
              ? { type: "read", filePath: row.call.path,
                ...(row.call.offset === undefined ? {} : { offset: row.call.offset }),
                ...(row.call.limit === undefined ? {} : { limit: row.call.limit }),
                ...(output === undefined ? {} : { content: output }) }
              : row.call.kind === "search"
                ? { type: "search", query: row.call.query,
                  ...(output === undefined ? {} : { content: output }),
                  ...(row.durationMs === undefined ? {} : { durationMs: row.durationMs }),
                  ...(row.truncated === undefined ? {} : { truncated: row.truncated }) }
                // One observed file patch is the whole operation; anything else keeps
                // the complete change list so no single file stands in for the rest.
                : row.call.kind === "fileChange" && single?.patch !== undefined
                  ? { type: "edit", filePath: single.path, unifiedDiff: single.patch }
                  : { type: "unknown", input: z.json().parse(row.call), output: result === undefined ? null : z.json().parse(result) };
          item({ type: "tool_call", id: `keiyaku:tool/${toolIdentity}`, callId: `tool/${toolIdentity}`, name: row.name,
            detail, metadata: { turnSequence: row.turnSequence, sequence: row.sequence,
              ...(row.durationMs === undefined ? {} : { durationMs: row.durationMs }),
              ...(row.truncated === undefined ? {} : { truncated: row.truncated }),
              call: z.json().parse(row.call), state: z.json().parse(state) },
            ...(typeof state === "object" && state.status === "error"
              ? { status: "failed", error: z.json().parse(state) }
              : { status: state === "active" ? "running" : state === "unsettled" ? "canceled" : "completed", error: null }) }, row.at);
        } else if (row.kind === "said") {
          item({ type: "assistant_message", id: `keiyaku:said/${row.sequence}`, text: row.text }, row.at);
        } else if (row.kind === "thought") {
          item({ type: "reasoning", id: `keiyaku:thought/${row.sequence}`, text: row.text }, row.at);
        } else if (row.kind === "note") {
          item({ type: "notification", id: `keiyaku:note/${row.sequence}`, level: "info", message: row.text }, row.at);
        } else if (row.kind === "outcome") {
          item(row.outcome.kind === "answered"
            ? { type: "assistant_message", id: row.outcome.foldedSaidSequence === undefined
              ? `keiyaku:turn/${row.turnSequence}` : `keiyaku:said/${row.outcome.foldedSaidSequence}`, text: row.outcome.answer }
            : { type: "error", id: `keiyaku:turn/${row.turnSequence}`, message: row.outcome.diagnostic }, row.at);
          finish(openTurns.get(row.turnSequence), row.outcome.kind === "answered" ? "completed" : "failed",
            row.outcome.kind === "failed" ? row.outcome.diagnostic : undefined);
        }
      }
      covered = { high: Math.max(covered?.high ?? 0, input.highest ?? 0),
        signatures: new Map(rows.map((row) => [row.sequence, JSON.stringify(row)])) };
      if (lowest !== undefined) for (const [id, sequence] of displayedTells) {
        if (sequence < lowest) displayedTells.delete(id);
      }
      unhealthy = false;
      const current = turn;
      if (reannounce && current && !current.closed && rows.some((row) => row.kind === "turn" && row.turnSequence === current.sequence))
        emit({ type: "session.turn", sessionId, turnId: `turn/${current.sequence}`, state: "started" });
    },
  };
  return mirror;
}
