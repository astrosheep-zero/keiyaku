import { parseTaskId } from "./identity.js";
import type { TaskDocument } from "./document.js";
import type { TaskView } from "./operation-types.js";

export function taskView(document: TaskDocument): TaskView {
  return { ...document, namespace: parseTaskId(document.id).namespace };
}

export function advanceTaskTimestamp(previous: string, candidate: string): string {
  return candidate > previous ? candidate : new Date(Date.parse(previous) + 1).toISOString();
}
