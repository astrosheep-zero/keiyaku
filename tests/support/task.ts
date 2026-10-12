import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { serializeTaskDocument, type TaskDocument } from "../../src/task/document.js";
import { parseTaskId, taskAuthorityPath, type TaskId } from "../../src/task/identity.js";
import type { WorldRoot } from "../../src/world.js";

/** The physical Task authority path a World gives one Task identity. */
export function taskAuthorityFile(world: WorldRoot, id: TaskId): string {
  return taskAuthorityPath(resolve(world, ".keiyaku", "tasks"), parseTaskId(id));
}

export function taskDocument(
  input: Readonly<{
    id: TaskId;
    title: string;
    state?: TaskDocument["state"];
    priority?: TaskDocument["priority"];
    needs?: TaskDocument["needs"];
    createdBy?: string;
    createdAt?: string;
    updatedAt?: string;
  }>,
): TaskDocument {
  return {
    id: input.id,
    title: input.title,
    body: "",
    note: "",
    state: input.state ?? "open",
    priority: input.priority ?? 2,
    needs: input.needs ?? [],
    parent: null,
    supersedes: [],
    relates: [],
    ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
    createdAt: input.createdAt ?? "2026-08-17T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-08-17T00:00:00.000Z",
  };
}

export function writeTaskAuthority(world: WorldRoot, document: TaskDocument): void {
  const path = taskAuthorityFile(world, document.id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeTaskDocument(document));
}
