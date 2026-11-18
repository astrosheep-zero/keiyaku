import type { AgentEvent, ToolCall, ToolResult } from "../provider.js";

type Observation = Readonly<{ name: string; call: ToolCall }>;
type ObservationRecord = Readonly<{ name: string; call?: ToolCall; phase: "pending" | "started" | "completed" }>;

function strongest(previous: ToolCall | undefined, next: ToolCall): ToolCall {
  if (previous === undefined) return next;
  if (next.kind === "other") {
    if (previous.kind !== "other") return previous;
    return previous.input === undefined ? next : { ...next, input: previous.input };
  }
  if (previous.kind === "read" && next.kind === "read" && previous.path === next.path) return { ...previous, ...next };
  if (previous.kind === "search" && next.kind === "search" && previous.query === next.query)
    return { ...previous, ...next };
  return next;
}

/** One native attempt's observed tools; no execution or terminal authority. */
export class ToolObservations {
  private readonly records = new Map<string, ObservationRecord>();

  constructor(private readonly emit: (event: AgentEvent) => void) {}

  get(id: string): ObservationRecord | undefined {
    return this.records.get(id);
  }

  pending(id: string, name: string): void {
    if (!this.records.has(id)) this.records.set(id, { name, phase: "pending" });
  }

  start(id: string, observation: Observation): void {
    this.observe(id, observation);
  }

  finish(id: string, observation: Observation | undefined, result: ToolResult): void {
    this.observe(id, observation, result);
  }

  private observe(id: string, observation?: Observation, result?: ToolResult): void {
    const previous = this.records.get(id);
    if (previous?.phase === "completed") return;
    const call = observation === undefined ? previous?.call : strongest(previous?.call, observation.call);
    const name = previous?.name ?? observation?.name;
    if (call === undefined || name === undefined) return;
    const phase = result === undefined ? "started" : "completed";
    this.records.set(id, { name, call, phase });
    if (result !== undefined) this.emit({ type: "tool", phase: "completed", id, name, call, result });
    else if (previous?.phase !== "started") this.emit({ type: "tool", phase: "started", id, name, call });
  }
}
