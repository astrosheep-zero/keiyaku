import {
  debtNonblankTextSchema,
  debtStateSchema,
  debtPrioritySchema,
  type DebtDocument,
  type DebtState,
} from "./document.js";
import { debtIdSchema, type DebtId } from "./identity.js";
import { nonEmptyDebtValues, nonEmptyDebtArraySchema } from "./operation-types.js";
import { z } from "zod";

export const debtRefSchema = z
  .strictObject({
    id: debtIdSchema,
    state: z.union([debtStateSchema, z.literal("missing")]),
  })
  .readonly();
export type DebtRef = z.output<typeof debtRefSchema>;
const debtRowTimestampSchema = z.string().refine((value) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}, "expected canonical UTC ISO timestamp");
export const debtDispositionSchema = z.enum(["ready", "blocked", "done", "drop"]);
export type DebtDisposition = z.output<typeof debtDispositionSchema>;
export const readyDebtRowSchema = z
  .strictObject({
    id: debtIdSchema,
    title: debtNonblankTextSchema,
    priority: debtPrioritySchema,
  })
  .readonly();
export type ReadyDebtRow = z.output<typeof readyDebtRowSchema>;
export const debtSummarySchema = readyDebtRowSchema.unwrap().extend({ disposition: debtDispositionSchema }).readonly();
export type DebtSummary = z.output<typeof debtSummarySchema>;
const debtBlockerSchema = z.strictObject({ id: debtIdSchema, missing: z.literal(true).exactOptional() }).readonly();
export const blockedDebtRowSchema = readyDebtRowSchema
  .unwrap()
  .extend({
    blockers: nonEmptyDebtArraySchema(debtBlockerSchema),
  })
  .readonly();
export type BlockedDebtRow = z.output<typeof blockedDebtRowSchema>;
export const debtDetailSchema = z
  .strictObject({
    title: debtNonblankTextSchema,
    state: debtStateSchema,
    priority: debtPrioritySchema,
    createdAt: debtRowTimestampSchema,
    updatedAt: debtRowTimestampSchema,
    body: z.string().min(1).exactOptional(),
    note: z.string().min(1).exactOptional(),
    needs: nonEmptyDebtArraySchema(debtRefSchema).exactOptional(),
  })
  .readonly();
export type DebtDetail = z.output<typeof debtDetailSchema>;
export type DebtBoard = Readonly<{ debts: ReadonlyMap<DebtId, DebtDocument> }>;

export const debtDoctorIssueSchema = z.union([
  z
    .strictObject({
      kind: z.literal("missing-target"),
      debtId: debtIdSchema,
      relation: z.literal("needs"),
      target: debtIdSchema,
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("self-relation"),
      debtId: debtIdSchema,
      relation: z.literal("needs"),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("cycle"),
      relation: z.literal("needs"),
      debts: z.array(debtIdSchema).min(2).readonly(),
    })
    .readonly(),
]);
export type DebtDoctorIssue = z.output<typeof debtDoctorIssueSchema>;

const terminal = (state: DebtState): boolean => state === "done" || state === "drop";
const sorted = <T extends { id: string }>(values: Iterable<T>): readonly T[] =>
  [...values].sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
export function debtRef(board: DebtBoard, id: DebtId): DebtRef {
  const debt = board.debts.get(id);
  return debt === undefined ? { id, state: "missing" } : { id, state: debt.state };
}

function needReleased(board: DebtBoard, id: DebtId): boolean {
  const target = board.debts.get(id);
  return target !== undefined && terminal(target.state);
}
function hasUnresolvedNeeds(board: DebtBoard, debt: DebtDocument): boolean {
  return debt.needs.some((id) => !needReleased(board, id));
}
export function debtDisposition(board: DebtBoard, debt: DebtDocument): DebtDisposition {
  if (debt.state !== "open") return debt.state;
  return hasUnresolvedNeeds(board, debt) ? "blocked" : "ready";
}
export function debtBlocked(board: DebtBoard, debt: DebtDocument): boolean {
  return debt.state === "open" && hasUnresolvedNeeds(board, debt);
}
export function projectDebtDetail(board: DebtBoard, id: DebtId): DebtDetail | null {
  const debt = board.debts.get(id);
  if (debt === undefined) return null;
  return {
    title: debt.title,
    state: debt.state,
    priority: debt.priority,
    createdAt: debt.createdAt,
    updatedAt: debt.updatedAt,
    ...(debt.body.length === 0 ? {} : { body: debt.body }),
    ...(debt.note.length === 0 ? {} : { note: debt.note }),
    ...(debt.needs.length === 0 ? {} : { needs: debt.needs.map((target) => debtRef(board, target)) }),
  };
}
export function projectDebtSummary(board: DebtBoard, debt: DebtDocument): DebtSummary {
  return {
    id: debt.id,
    title: debt.title,
    priority: debt.priority,
    disposition: debtDisposition(board, debt),
  };
}
export function projectRows(board: DebtBoard, selection: "active" | "closed" | "all"): readonly DebtSummary[] {
  return [...board.debts.values()]
    .filter((debt) => selection === "all" || (selection === "closed") === terminal(debt.state))
    .map((debt) => projectDebtSummary(board, debt))
    .sort(compareDebtRows);
}

/** The established Debt row order: priority first, then canonical identity bytes. */
function compareDebtRows(left: DebtSummary, right: DebtSummary): number {
  return left.priority - right.priority || Buffer.compare(Buffer.from(left.id), Buffer.from(right.id));
}

export function projectBlocked(board: DebtBoard): readonly BlockedDebtRow[] {
  return projectRows(board, "active").flatMap((row) => {
    const debt = board.debts.get(row.id)!;
    if (!debtBlocked(board, debt)) return [];
    const blockers = nonEmptyDebtValues(
      debt.needs
        .filter((need) => !needReleased(board, need))
        .map((id) => ({
          id,
          ...(board.debts.has(id) ? {} : { missing: true as const }),
        })),
    );
    return blockers === undefined ? [] : [{ id: row.id, title: row.title, priority: row.priority, blockers }];
  });
}

export function relationProblem(board: DebtBoard, before: DebtDocument | null, after: DebtDocument): string | null {
  const previous = new Set(before === null ? [] : before.needs);
  for (const target of after.needs) {
    if (previous.has(target)) continue;
    if (target === after.id) return `${after.id} has a self needs relation`;
    if (!board.debts.has(target)) return `${after.id} needs target does not exist: ${target}`;
  }
  return null;
}

function cycleComponents(board: DebtBoard): readonly (readonly DebtId[])[] {
  const ids = sorted([...board.debts.keys()].map((id) => ({ id }))).map(({ id }) => id as DebtId);
  const edges = new Map(ids.map((id) => [id, board.debts.get(id)!.needs.filter((target) => board.debts.has(target))]));
  const reverse = new Map(ids.map((id) => [id, [] as DebtId[]]));
  for (const [id, targets] of edges) for (const target of targets) reverse.get(target)!.push(id);

  const visited = new Set<DebtId>(),
    finished: DebtId[] = [];
  for (const root of ids) {
    if (visited.has(root)) continue;
    visited.add(root);
    const stack: { id: DebtId; index: number }[] = [{ id: root, index: 0 }];
    while (stack.length > 0) {
      const frame = stack.at(-1)!,
        targets = edges.get(frame.id)!;
      if (frame.index < targets.length) {
        const target = targets[frame.index++]!;
        if (!visited.has(target)) {
          visited.add(target);
          stack.push({ id: target, index: 0 });
        }
      } else {
        finished.push(frame.id);
        stack.pop();
      }
    }
  }

  const assigned = new Set<DebtId>(),
    components: DebtId[][] = [];
  for (const root of finished.reverse()) {
    if (assigned.has(root)) continue;
    const component: DebtId[] = [],
      stack = [root];
    assigned.add(root);
    while (stack.length > 0) {
      const id = stack.pop()!;
      component.push(id);
      for (const target of reverse.get(id)!)
        if (!assigned.has(target)) {
          assigned.add(target);
          stack.push(target);
        }
    }
    if (component.length > 1) components.push(sorted(component.map((id) => ({ id }))).map(({ id }) => id as DebtId));
  }
  return components.sort((left, right) => Buffer.compare(Buffer.from(left.join("\0")), Buffer.from(right.join("\0"))));
}

export function diagnoseBoard(board: DebtBoard): readonly DebtDoctorIssue[] {
  const issues: DebtDoctorIssue[] = [];
  for (const debt of sorted(board.debts.values()))
    for (const target of debt.needs) {
      if (target === debt.id) issues.push({ kind: "self-relation", debtId: debt.id, relation: "needs" });
      else if (!board.debts.has(target))
        issues.push({ kind: "missing-target", debtId: debt.id, relation: "needs", target });
    }
  for (const debts of cycleComponents(board)) issues.push({ kind: "cycle", relation: "needs", debts });
  return issues;
}
