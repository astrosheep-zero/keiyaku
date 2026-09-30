import { bodyRequestExecution, World } from "@astrosheep/keiyaku";
import {
  Tasks,
  type Task,
  type TaskCompositionResult,
  type TaskCompositionAlias,
  type TaskCompositionPlanAlias,
  type TaskCompositionPlanOrder,
  type TaskCompositionBodyPreview,
  type TaskCompositionAdmission,
  type TaskDecompositionTree,
  type TaskId,
  type TaskMutationResult,
  type TaskTreeNode,
} from "@astrosheep/keiyaku/task";
const world = null as unknown as import("@astrosheep/keiyaku").WorldRoot;
const tasks = Tasks.of(world);
const routedTasks = Tasks.of(world, { execution: bodyRequestExecution({ directory: "/tmp/keiyaku-requests" }) });
const task: Task = tasks.task({ id: "task/example" });
const id: TaskId = task.id;
const result: Promise<TaskMutationResult> = tasks.add({ title: "Example", state: "in_progress", note: "initial" });
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
// @ts-expect-error DAG residue type is not exported
type OldTree = import("@astrosheep/keiyaku/task").TaskDependencyTree;
void tasks;
void routedTasks;
void task;
void id;
void result;
void tree;
void node;

// Installed consumer names stay connected to the inferred outbound composition.
export function compositionFacts(result: TaskCompositionResult): void {
  if (result.kind === "planned") {
    const alias: TaskCompositionPlanAlias | undefined = result.aliases[0];
    const order: TaskCompositionPlanOrder | undefined = result.admissionOrder[0];
    const body: TaskCompositionBodyPreview | undefined = result.bodies[0];
    const admission: TaskCompositionAdmission | undefined = result.admissions[0];
    const position: number | undefined = order?.position;
    const previewBytes: number | undefined = body?.bytes;
    const allocated: TaskId | undefined = admission?.kind === "existing" ? admission.taskId : undefined;
    void [alias, position, previewBytes, allocated];
  }
  if (result.kind === "accepted" || result.kind === "incomplete") {
    const alias: TaskCompositionAlias | undefined = result.aliases[0];
    const admission: TaskCompositionAdmission | undefined = result.admissions[0];
    const allocated: TaskId | undefined = alias?.taskId;
    void [allocated, admission];
  }
}
