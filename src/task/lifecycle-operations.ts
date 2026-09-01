import type { TaskBoard } from "./board.js";
import { serializeTaskDocument, type TaskDocument } from "./document.js";
import {
  type SettledTaskResult,
  type TaskBatchResult,
  type TaskLifecycleVerb,
  type TaskMutationResult,
  type TaskRetry,
} from "./operation-types.js";
import type { TaskId } from "./identity.js";
import { authorityBytesMatch, readBoard, replaceAuthority, withTaskLocks } from "./store.js";
import type { WorldRoot } from "../world.js";
import { advanceTaskTimestamp, taskView } from "./view.js";

const TRANSITIONS: Readonly<
  Record<TaskLifecycleVerb, Readonly<Partial<Record<TaskDocument["state"], TaskDocument["state"]>>>>
> = {
  start: { open: "in_progress" },
  stop: { in_progress: "open" },
  hold: { open: "on_hold", in_progress: "on_hold" },
  resume: { on_hold: "open" },
  done: { open: "done", in_progress: "done", on_hold: "done" },
  drop: { open: "drop", in_progress: "drop", on_hold: "drop" },
};

type CurrentTaskBoard = {
  board: TaskBoard;
  bytes: Map<TaskId, Uint8Array>;
};
type LifecycleFreshness = "batch" | "none";
type LifecycleOptions = Readonly<{ note?: string; freshness?: LifecycleFreshness }>;
type BatchLifecycleOptions = Readonly<{ signal?: AbortSignal; note?: string }>;

function currentTaskBoard(board: TaskBoard, bytes: ReadonlyMap<TaskId, Uint8Array>): CurrentTaskBoard {
  return { board, bytes: new Map(bytes) };
}
function retry(reason: TaskRetry): TaskMutationResult {
  return { kind: "retry", reason };
}

async function transitionLifecycle(
  world: WorldRoot,
  id: TaskId,
  verb: TaskLifecycleVerb,
  currentBoard: CurrentTaskBoard,
  options: LifecycleOptions = {},
): Promise<TaskMutationResult> {
  const { note, freshness = "none" } = options;
  const current = currentBoard.board.tasks.get(id);
  if (current === undefined) {
    return freshness === "batch" && !(await authorityBytesMatch(world, id, null))
      ? retry("concurrent-modification")
      : { kind: "refused", refusal: { kind: "task-missing", taskId: id } };
  }
  const state = TRANSITIONS[verb][current.state];
  if (state === undefined) {
    return freshness === "batch" && !(await authorityBytesMatch(world, id, currentBoard.bytes.get(id)!))
      ? retry("concurrent-modification")
      : { kind: "refused", refusal: { kind: "invalid-lifecycle-transition", taskId: id, state: current.state, verb } };
  }
  const at = new Date().toISOString();
  const next = {
    ...current,
    state,
    ...(note === undefined ? {} : { note }),
    updatedAt: advanceTaskTimestamp(current.updatedAt, at),
  };
  const bytes = serializeTaskDocument(next);
  if (
    (await replaceAuthority({
      world,
      id,
      expected: currentBoard.bytes.get(id)!,
      next: bytes,
    })) !== "replaced"
  ) {
    return retry("concurrent-modification");
  }
  currentBoard.board = {
    tasks: new Map(currentBoard.board.tasks).set(id, next),
  };
  currentBoard.bytes.set(id, bytes);
  return { kind: "accepted", value: taskView(next) };
}

async function lifecycleFromCurrentBoard(
  world: WorldRoot,
  id: TaskId,
  verb: TaskLifecycleVerb,
  currentBoard: CurrentTaskBoard,
  options: BatchLifecycleOptions = {},
): Promise<TaskMutationResult> {
  const { signal, note } = options;
  const result = await withTaskLocks(
    { world, allocation: false, ids: [id], ...(signal === undefined ? {} : { signal }) },
    async () =>
      transitionLifecycle(world, id, verb, currentBoard, {
        freshness: "batch",
        ...(note === undefined ? {} : { note }),
      }),
  );
  return result === "busy" ? retry("busy") : result;
}

export async function lifecycleTask(
  world: WorldRoot,
  id: TaskId,
  verb: TaskLifecycleVerb,
  signal?: AbortSignal,
  note?: string,
): Promise<TaskMutationResult> {
  const result = await withTaskLocks(
    { world, allocation: false, ids: [id], ...(signal === undefined ? {} : { signal }) },
    async (): Promise<TaskMutationResult> => {
      const snapshot = await readBoard(world);
      const options = note === undefined ? {} : { note };
      return transitionLifecycle(world, id, verb, currentTaskBoard(snapshot.board, snapshot.bytes), options);
    },
  );
  return result === "busy" ? retry("busy") : result;
}

export async function batchTasks(
  world: WorldRoot,
  verb: "start" | "done" | "drop" | "hold",
  ids: readonly TaskId[],
  signal?: AbortSignal,
  note?: string,
): Promise<TaskBatchResult> {
  signal?.throwIfAborted();
  const snapshot = await readBoard(world);
  const currentBoard = currentTaskBoard(snapshot.board, snapshot.bytes);
  const items = [];
  for (const id of ids) {
    signal?.throwIfAborted();
    items.push({
      id,
      outcome: await lifecycleFromCurrentBoard(world, id, verb, currentBoard, {
        ...(signal === undefined ? {} : { signal }),
        ...(note === undefined ? {} : { note }),
      }),
    });
  }
  return { items };
}

export async function settleTask(world: WorldRoot, id: TaskId): Promise<SettledTaskResult> {
  const result = await withTaskLocks({ world, allocation: false, ids: [id] }, async (): Promise<SettledTaskResult> => {
    const snapshot = await readBoard(world),
      current = snapshot.board.tasks.get(id);
    if (current === undefined) return { kind: "refused", refusal: { kind: "task-missing", taskId: id } };
    if (current.state === "done") return { kind: "unchanged" };
    if (current.state === "drop") {
      return {
        kind: "refused",
        refusal: { kind: "invalid-lifecycle-transition", taskId: id, state: current.state, verb: "done" },
      };
    }
    const next: TaskDocument = {
      ...current,
      state: "done",
      updatedAt: advanceTaskTimestamp(current.updatedAt, new Date().toISOString()),
    };
    const replaced = await replaceAuthority({
      world,
      id,
      expected: snapshot.bytes.get(id)!,
      next: serializeTaskDocument(next),
    });
    return replaced === "replaced"
      ? { kind: "changed", task: taskView(next), action: "done" }
      : { kind: "retry", reason: "concurrent-modification" };
  });
  return result === "busy" ? { kind: "retry", reason: "busy" } : result;
}
