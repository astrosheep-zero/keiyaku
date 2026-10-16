import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import type { AgentRuntimeInfo, AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { AgentEventChannel, otherToolCall, type AgentEvent, type ToolCall, type TurnResult } from "../../provider.js";
import { stringValue } from "../decode.js";

/**
 * The runtime's own confirmation at establishment, reported as a native
 * provider model id. The installed Paseo wire carries no mid-attempt model
 * change on this timeline subscription, so a later re-selection is not
 * observable here and is never invented.
 */
export function paseoRuntimeModel(info: AgentRuntimeInfo | undefined): string | undefined {
  const model = info?.model;
  return typeof model === "string" && model.trim().length > 0 ? model : undefined;
}

type ToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;
type ToolCallDetail = ToolCallItem["detail"];

/**
 * The observed result text one native detail carries. A detail that observes no
 * text stays absent; a present empty string remains observed and empty.
 */
function detailOutput(detail: ToolCallDetail): string | undefined {
  switch (detail.type) {
    case "shell":
      return stringValue(detail.output);
    case "read":
    case "search":
      return stringValue(detail.content);
    case "fetch":
      return stringValue(detail.result);
    default:
      return undefined;
  }
}

/** The verified unified patch a completed edit detail observed, when it supplied one. */
function detailPatch(detail: ToolCallDetail): string | undefined {
  return detail.type === "edit" ? stringValue(detail.unifiedDiff) : undefined;
}

/** Attach the observed patch to the one change its correlated path already named. */
function withObservedPatch(call: ToolCall, patch: string | undefined): ToolCall {
  if (call.kind !== "fileChange") return call;
  const change = call.changes[0];
  if (patch === undefined || change === undefined || call.changes.length !== 1) return call;
  return { kind: "fileChange", changes: [{ ...change, patch }] };
}

function toolCall(item: ToolCallItem): ToolCall {
  const detail = item.detail;
  switch (detail.type) {
    case "shell":
      return { kind: "run", command: detail.command };
    case "read":
      return {
        kind: "read",
        path: detail.filePath,
        ...(detail.offset === undefined ? {} : { offset: detail.offset }),
        ...(detail.limit === undefined ? {} : { limit: detail.limit }),
      };
    case "edit":
    case "write":
      return { kind: "fileChange", changes: [{ op: "unspecified", path: detail.filePath }] };
    case "search":
      return { kind: "search", query: detail.query, scope: detail.toolName === "web_search" ? "web" : "content" };
    case "unknown":
      return otherToolCall(item.name, detail.input);
    default:
      return otherToolCall(item.name);
  }
}

function timelineNarration(item: AgentTimelineItem, calls: Map<string, ToolCall>): AgentEvent | undefined {
  switch (item.type) {
    case "tool_call": {
      const base = calls.get(item.callId) ?? (item.status === "running" ? toolCall(item) : otherToolCall(item.name));
      const call = item.status === "running" ? base : withObservedPatch(base, detailPatch(item.detail));
      calls.set(item.callId, call);
      if (item.status === "running") {
        return { type: "tool", phase: "started", id: item.callId, name: item.name, call };
      }
      const output = detailOutput(item.detail);
      return {
        type: "tool",
        phase: "completed",
        id: item.callId,
        name: item.name,
        call,
        result: {
          status: item.status === "completed" ? "ok" : "error",
          ...(output === undefined ? {} : { output }),
        },
      };
    }
    case "error":
    case "notification":
      return { type: "note", text: item.message };
    case "compaction":
      return { type: "note", text: `Context compaction ${item.status}` };
    case "reasoning":
    case "user_message":
    case "assistant_message":
      return undefined;
    default:
      return { type: "unknown", kind: item.type };
  }
}

/** Live fragments belong to a canonical admitted turn, not agent-wide status. */
export class PaseoTurn {
  readonly events = new AgentEventChannel();
  readonly admission: Promise<string>;
  readonly completion: Promise<TurnResult>;
  private admit!: (turnId: string) => void;
  private rejectAdmission!: (error: unknown) => void;
  private finish!: (result: TurnResult) => void;
  private rejectCompletion!: (error: unknown) => void;
  private turnId: string | undefined;
  private readonly messages: Array<{ id?: string; text: string }> = [];
  private readonly messagesById = new Map<string, { text: string }>();
  private readonly calls = new Map<string, ToolCall>();
  private answer = "";
  private assistantContiguous = false;
  settled = false;
  terminal = false;

  constructor(readonly messageId: string) {
    this.admission = new Promise((resolve, reject) => {
      this.admit = resolve;
      this.rejectAdmission = reject;
    });
    this.completion = new Promise((resolve, reject) => {
      this.finish = resolve;
      this.rejectCompletion = reject;
    });
    void this.admission.catch(() => undefined);
    void this.completion.catch(() => undefined);
  }

  receive(event: AgentStreamEventPayload): void {
    if (this.settled) return;
    if (
      event.type === "timeline" &&
      event.item.type === "user_message" &&
      event.item.clientMessageId === this.messageId
    ) {
      if (event.turnId === undefined) return this.fail(new Error("Paseo native admission omitted turnId"));
      if (this.turnId !== undefined) {
        if (this.turnId !== event.turnId) this.fail(new Error("Paseo canonical admission changed native turn"));
        return;
      }
      this.turnId = event.turnId;
      this.admit(event.turnId);
      return;
    }
    if (!("turnId" in event) || this.turnId === undefined || event.turnId !== this.turnId) return;
    if (event.type === "timeline") {
      if (event.item.type === "assistant_message") this.appendAssistant(event.item);
      else {
        this.assistantContiguous = false;
        const narration = timelineNarration(event.item, this.calls);
        if (narration !== undefined) this.events.emit(narration);
      }
    } else if (event.type === "turn_completed") {
      this.settled = true;
      this.finish({
        kind: "answered",
        answer: this.answer,
        historyId: this.turnId,
      });
    } else if (event.type === "turn_failed" || event.type === "turn_canceled") {
      this.settled = true;
      this.finish({ kind: "failed", diagnostic: event.type === "turn_failed" ? event.error : event.reason });
    }
    if (this.settled) {
      this.terminal = true;
      for (const message of this.messages) this.events.emit({ type: "assistant", text: message.text });
    }
  }

  private appendAssistant(item: Extract<AgentTimelineItem, { type: "assistant_message" }>): void {
    // Native final text is the last contiguous assistant segment; narration keeps all messages.
    this.answer = this.assistantContiguous ? this.answer + item.text : item.text;
    const previous =
      item.messageId === undefined
        ? this.assistantContiguous
          ? this.messages.at(-1)
          : undefined
        : this.messagesById.get(item.messageId);
    this.assistantContiguous = true;
    if (previous !== undefined) previous.text += item.text;
    else {
      const message = { ...(item.messageId === undefined ? {} : { id: item.messageId }), text: item.text };
      this.messages.push(message);
      if (item.messageId !== undefined) this.messagesById.set(item.messageId, message);
    }
  }

  fail(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectAdmission(error);
    this.rejectCompletion(error);
  }
}
