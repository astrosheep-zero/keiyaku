import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import type { AgentRuntimeInfo, AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { AgentEventChannel, otherToolCall, type AgentEvent, type ToolCall } from "../../provider.js";
import {
  fileChangeToolCall,
  nonblank,
  observedChange,
  readToolCall,
  searchToolCall,
  stringValue,
  toolResult,
} from "../decode.js";
import { ToolObservations } from "../tool-observations.js";
import { providerTurn } from "../turn.js";

/**
 * The runtime's own confirmation at establishment, reported as a native
 * provider model id. The installed Paseo wire carries no mid-attempt model
 * change on this timeline subscription, so a later re-selection is not
 * observable here and is never invented.
 */
export function paseoRuntimeModel(info: AgentRuntimeInfo | undefined): string | undefined {
  return nonblank(info?.model);
}

type ToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;
type ToolCallDetail = ToolCallItem["detail"];
type Emit = (event: AgentEvent) => void;

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

function toolCall(item: ToolCallItem): ToolCall {
  const detail = item.detail;
  switch (detail.type) {
    case "shell":
      return { kind: "run", command: detail.command };
    case "read":
      return readToolCall(detail.filePath, detail.offset, detail.limit) ?? otherToolCall(item.name);
    case "edit":
    case "write":
      return fileChangeToolCall("unspecified", detail.filePath) ?? otherToolCall(item.name);
    case "search":
      return (
        searchToolCall(detail.query, detail.toolName === "web_search" ? "web" : "content") ?? otherToolCall(item.name)
      );
    case "unknown":
      return otherToolCall(item.name, detail.input);
    default:
      return otherToolCall(item.name);
  }
}

function timelineNarration(item: AgentTimelineItem, tools: ToolObservations, emit: Emit): void {
  switch (item.type) {
    case "tool_call": {
      const { detail } = item;
      // The ACP mapper's edit/delete projection substitutes its display title
      // for a missing path and puts ordinary result text in the patch field.
      const ambiguousEdit = detail.type === "edit" && (item.metadata?.kind === "edit" || item.metadata?.kind === "delete");
      if (item.status === "running") {
        tools.start(item.callId, { name: item.name, call: ambiguousEdit ? otherToolCall(item.name) : toolCall(item) });
        return;
      }
      const observed = tools.get(item.callId);
      if (observed?.phase === "completed") return;
      const previousCall = observed?.call;
      const change = previousCall?.kind === "fileChange" ? previousCall.changes[0] : undefined;
      let call = previousCall ?? otherToolCall(item.name);
      if (observed !== undefined && detail.type === "unknown") {
        call = otherToolCall(item.name, detail.input);
      } else if (!ambiguousEdit && detail.type === "edit" && change?.path === detail.filePath) {
        const patch = stringValue(detail.unifiedDiff);
        if (patch !== undefined) call = { kind: "fileChange", changes: [observedChange(change.op, change.path, patch)] };
      }
      tools.finish(
        item.callId,
        { name: item.name, call },
        toolResult(item.status === "completed" ? "ok" : "error", detailOutput(detail)),
      );
      return;
    }
    case "error":
      emit({ type: "note", text: item.message });
      return;
    case "compaction":
      if (item.status === "completed") emit({ type: "note", text: "Context compacted" });
      return;
    default:
      return;
  }
}

/** Live fragments belong to a canonical admitted turn, not agent-wide status. */
export class PaseoTurn {
  readonly outcome = providerTurn(new AgentEventChannel());
  readonly admission: Promise<string>;
  private admit!: (turnId: string) => void;
  private rejectAdmission!: (error: unknown) => void;
  private turnId: string | undefined;
  private readonly messages: Array<{ id?: string; text: string }> = [];
  private readonly messagesById = new Map<string, { text: string }>();
  private readonly tools = new ToolObservations((event) => this.outcome.events.emit(event));
  private answer = "";
  private assistantContiguous = false;

  constructor(readonly messageId: string) {
    this.admission = new Promise((resolve, reject) => {
      this.admit = resolve;
      this.rejectAdmission = reject;
    });
    void this.admission.catch(() => undefined);
  }

  receive(event: AgentStreamEventPayload): void {
    if (this.outcome.terminal) return;
    if (
      event.type === "timeline" &&
      event.item.type === "user_message" &&
      event.item.clientMessageId === this.messageId
    ) {
      if (event.turnId === undefined) throw new Error("Paseo native admission omitted turnId");
      if (this.turnId !== undefined) {
        if (this.turnId !== event.turnId) throw new Error("Paseo canonical admission changed native turn");
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
        timelineNarration(event.item, this.tools, (narration) => this.outcome.events.emit(narration));
      }
    } else if (event.type === "turn_completed" || event.type === "turn_failed" || event.type === "turn_canceled") {
      for (const message of this.messages) this.outcome.events.emit({ type: "assistant", text: message.text });
      this.outcome.finish(
        event.type === "turn_completed"
          ? { kind: "answered", answer: this.answer, historyId: this.turnId }
          : { kind: "failed", diagnostic: event.type === "turn_failed" ? event.error : event.reason },
      );
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

  fail(error: unknown): boolean {
    if (!this.outcome.fail(error)) return false;
    this.rejectAdmission(error);
    return true;
  }
}
