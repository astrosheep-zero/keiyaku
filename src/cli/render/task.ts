import type { ParsedTaskCommand, TaskInvocationResult } from "../commands/task.js";

type Outcome = Readonly<{ kind: "accepted" | "refused" | "retry" | "incomplete"; value?: unknown; refusal?: unknown; reason?: unknown; stopped?: unknown; documentChanges?: readonly Change[] }>;
type Change = Readonly<{ documentDiff: string }>;
type Row = Readonly<{ id: string; priority: number; disposition?: string; state?: string; title: string; contractId?: string | null; blockers?: readonly Readonly<{ id: string }>[] }>;

function outcome(result: TaskInvocationResult): Outcome | null {
  return typeof result === "object" && result !== null && "kind" in result ? result as Outcome : null;
}
function row(value: Row): string {
  const disposition = value.disposition ?? value.state ?? "open";
  return `${value.id} - P${value.priority} - ${disposition} - ${value.title}${value.contractId === null || value.contractId === undefined ? "" : ` - ${value.contractId}`}`;
}
function changes(values: readonly Change[]): string { return values.map((change) => change.documentDiff).filter((diff) => diff.length > 0).join("\n"); }
function refusal(result: Outcome): string {
  if (result.kind === "retry") return `retry ${JSON.stringify(result.reason)}`;
  return `refused ${JSON.stringify(result.refusal)}`;
}
function renderRows(result: Outcome): string {
  if (result.kind !== "accepted") return refusal(result);
  return (result.value as readonly Row[]).map((item) => {
    const blockers = item.blockers?.map((blocker) => blocker.id).join(", ");
    return `${row(item)}${blockers === undefined ? "" : ` <- ${blockers}`}`;
  }).join("\n");
}
function renderShow(result: TaskInvocationResult): string {
  const state = outcome(result); if (state !== null) return refusal(state);
  const detail = result as unknown as Readonly<{ task: Row & Readonly<{ body: string; namespace: readonly string[]; needs: readonly string[]; parent: string | null; supersedes: readonly string[]; relates: readonly string[] }>; blockers: readonly Readonly<{ id: string }>[]; blocks: readonly Readonly<{ id: string }>[]; children: readonly Readonly<{ id: string }>[]; supersededBy: readonly Readonly<{ id: string }>[]; related: readonly Readonly<{ id: string }>[] }>;
  const task = detail.task, lines = [row(task), `namespace: ${task.namespace.join("/") || "root"}`];
  for (const [label, values] of [
    ["needs", task.needs], ["blockers", detail.blockers.map((item) => item.id)], ["blocks", detail.blocks.map((item) => item.id)],
    ["children", detail.children.map((item) => item.id)], ["supersedes", task.supersedes],
    ["superseded by", detail.supersededBy.map((item) => item.id)], ["related", detail.related.map((item) => item.id)],
  ] as const) if (values.length > 0) lines.push(`${label}: ${values.join(", ")}`);
  if (task.parent !== null) lines.push(`parent: ${task.parent}`);
  if (task.body.length > 0) lines.push("", task.body);
  return lines.join("\n");
}
type TreeNode = Readonly<{ task: Readonly<{ id: string; title: string | null; state: string; priority: number | null }>; cycle?: true; reference?: true; needs: readonly TreeNode[] }>;
function treeLines(node: TreeNode, depth = 0): readonly string[] {
  const marker = node.cycle ? "cycle" : node.reference ? "reference" : node.task.state;
  const line = `${"  ".repeat(depth)}${node.task.id} - ${node.task.priority === null ? "P?" : `P${node.task.priority}`} - ${marker}${node.task.title === null ? "" : ` - ${node.task.title}`}`;
  return [line, ...node.needs.flatMap((child) => treeLines(child, depth + 1))];
}

export function renderTaskText(command: ParsedTaskCommand, result: TaskInvocationResult): string {
  if (command.action === "show") return renderShow(result);
  if (command.action === "ls" || command.action === "ready" || command.action === "blocked") return renderRows(outcome(result)!);
  if (command.action === "tree") {
    const state = outcome(result)!; return state.kind === "accepted" ? treeLines(state.value as TreeNode).join("\n") : refusal(state);
  }
  if (command.action === "cycles") {
    const cycles = (result as Readonly<{ cycles: readonly (readonly string[])[] }>).cycles;
    return cycles.map((cycle) => [...cycle, cycle[0]].join(" -> ")).join("\n");
  }
  if (command.action === "namespace") return (result as readonly string[]).join("/") || "root";
  if (command.action === "compose") {
    const state = outcome(result)!;
    return state.kind === "accepted" ? changes(state.documentChanges ?? []) : state.kind === "incomplete" ? "" : refusal(state);
  }
  if (command.action === "hold" || command.action === "done" || command.action === "drop") {
    const batch = result as Readonly<{ items: readonly Readonly<{ id: string; outcome: Outcome }>[] }>;
    return batch.items.map((item) => item.outcome.kind === "accepted" ? `accepted ${item.id}` : `${item.id}: ${refusal(item.outcome)}`).join("\n");
  }
  const state = outcome(result)!;
  if (state.kind !== "accepted") return refusal(state);
  if (command.action === "update") {
    const value = state.value as Readonly<{ task: Row; documentDiff: string }>;
    return [row(value.task), value.documentDiff].filter((line) => line.length > 0).join("\n");
  }
  return row(state.value as Row);
}

export function renderTaskIncompleteDiagnostic(result: TaskInvocationResult): string {
  const state = outcome(result)!;
  return [`incomplete ${JSON.stringify(state.stopped)}`, changes(state.documentChanges ?? [])].filter((line) => line.length > 0).join("\n");
}

export function taskExitCode(result: TaskInvocationResult): number {
  const state = outcome(result);
  if (state?.kind === "retry") return 2;
  if (state?.kind === "refused" || state?.kind === "incomplete") return 1;
  if (typeof result === "object" && result !== null && "items" in result) {
    const kinds = (result as Readonly<{ items: readonly Readonly<{ outcome: Outcome }>[] }>).items.map((item) => item.outcome.kind);
    return kinds.includes("retry") ? 2 : kinds.includes("refused") ? 1 : 0;
  }
  return 0;
}
