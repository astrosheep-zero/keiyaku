import {
  Tasks,
  World,
  type Task,
  type TaskDecompositionTree,
  type TaskId,
  type TaskMutationResult,
  type TaskTreeNode,
} from "@astrosheep/keiyaku";
const world = null as unknown as import("@astrosheep/keiyaku").WorldRoot;
const tasks = Tasks.of(world);
const task: Task = tasks.task({ id: "task/example" });
const id: TaskId = task.id;
const result: Promise<TaskMutationResult> = tasks.add({ title: "Example", state: "open", note: "initial" });
const tree: Promise<TaskDecompositionTree> = task.tree();
const node = null as unknown as TaskTreeNode;
void task.update({ note: "replacement" });
void task.drop({ note: "obsolete" });
// @ts-expect-error Task has no static construction surface
Task.at({ path: "." });
// @ts-expect-error callers do not choose IDs during creation
tasks.add({ id: "task/chosen", title: "Chosen" });
// @ts-expect-error tree accepts no full option
void task.tree({ full: true });
// @ts-expect-error the removed execution carrier is not a public input
Tasks.of(world, { execution: {} });
// @ts-expect-error DAG residue type is not exported
type OldTree = import("@astrosheep/keiyaku").TaskDependencyTree;
// @ts-expect-error the retired ./task subpath promise is gone
type RemovedTaskSubpath = import("@astrosheep/keiyaku/task").TaskRow;
void World;
void tasks;
void task;
void id;
void result;
void tree;
void node;
