import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { serializeTaskDocument, type TaskDocument } from "../../src/task/document.js";
import type { TaskId } from "../../src/task/index.js";
import { authorityPath } from "../../src/task/store.js";
import type { WorldRoot } from "../../src/world.js";

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
  const path = authorityPath(world, document.id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeTaskDocument(document));
}
