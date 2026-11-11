import { z } from "zod";
import {
  debtRefSchema,
  blockedDebtRowSchema,
  readyDebtRowSchema,
  debtTreeRootSchema,
  debtTreeNodeSchema,
  debtDoctorIssueSchema,
  debtSummarySchema,
  debtDispositionSchema,
  debtDetailSchema,
  buildTree,
  createDebtRelations,
  diagnoseBoard,
  type BlockedDebtRow,
  type DebtDetail,
  type DebtDoctorIssue,
  type DebtRef,
  type DebtSummary,
  type DebtTreeNode,
  type DebtTreeRoot,
  type ReadyDebtRow,
} from "./board.js";
import {
  debtWarningSchema,
  debtRefusalSchema,
  debtRetrySchema,
  debtReadPageSchema,
  debtParentReadRefusalSchema,
  nonEmptyDebtValues,
  nonEmptyDebtArraySchema,
  debtMutationResultSchema,
  debtUpdateResultSchema,
  debtChangeSchema,
  type DebtWarning,
  type DebtRefusal,
  type DebtRetry,
  type DebtReadPage,
  type DebtMutationResult,
  type DebtParentReadRefusal,
  type DebtUpdateResult,
  type DebtChange,
} from "./operation-types.js";
import type { WorldRoot } from "../world.js";
export type { WorldRoot } from "../world.js";
import { DebtAuthorityCorruptionError, type DebtPriority, type DebtState } from "./document.js";
import { type DebtId } from "./identity.js";
import {
  addDebt,
  addDebtDocument,
  blockedDebts,
  listDebts,
  readDebtDetail,
  readyDebts,
  updateDebt,
  type AddDebtDocumentInput,
  type AddDebtInput,
  type UpdateDebtInput,
} from "./operations.js";
import { boundedListLimit } from "../bounded-list.js";
import { readBoard } from "./store.js";
import { addDocumentInput, addInput, closed, namespace, record, debtId as id, updateInput } from "./input.js";

export const debtAbsentSchema = z.strictObject({ kind: z.literal("absent") }).readonly();
export type DebtAbsent = z.output<typeof debtAbsentSchema>;
export const debtReadResultSchema = z.union([
  z.strictObject({ kind: z.literal("present"), ...debtDetailSchema.unwrap().shape }).readonly(),
  z.strictObject({ kind: z.literal("missing") }).readonly(),
]);
export type DebtReadResult = z.output<typeof debtReadResultSchema>;
export const debtShowItemSchema = z.union([
  z.strictObject({ kind: z.literal("found"), ...debtDetailSchema.unwrap().shape }).readonly(),
  z.strictObject({ kind: z.literal("missing") }).readonly(),
]);
export type DebtShowItem = z.output<typeof debtShowItemSchema>;
export const debtShowResultSchema = z
  .strictObject({ kind: z.literal("present"), items: nonEmptyDebtArraySchema(debtShowItemSchema) })
  .readonly();
export type DebtShowResult = z.output<typeof debtShowResultSchema>;
export const debtTreeResultSchema = z.union([
  z.strictObject({ kind: z.literal("present"), ...debtTreeRootSchema.unwrap().shape }).readonly(),
  z.strictObject({ kind: z.literal("missing") }).readonly(),
]);
export type DebtTreeResult = z.output<typeof debtTreeResultSchema>;
export const debtDoctorReportSchema = z
  .strictObject({
    kind: z.literal("present"),
    issues: nonEmptyDebtArraySchema(debtDoctorIssueSchema).exactOptional(),
  })
  .readonly();
export type DebtDoctorReport = z.output<typeof debtDoctorReportSchema>;
export const debtListSchema = debtReadPageSchema(debtSummarySchema).options[0];
export const debtReadyListSchema = z.union([
  debtReadPageSchema(readyDebtRowSchema).options[0],
  debtAbsentSchema,
  debtParentReadRefusalSchema,
]);
export const blockedDebtListSchema = z.union([
  debtReadPageSchema(blockedDebtRowSchema).options[0],
  debtAbsentSchema,
  debtParentReadRefusalSchema,
]);
export const debtCatalogueSchema = z.union([debtListSchema, debtAbsentSchema]);
export type DebtCatalogue = z.output<typeof debtCatalogueSchema>;
export type DebtList = z.output<typeof debtListSchema>;
export type DebtReadyList = DebtReadPage<ReadyDebtRow, DebtParentReadRefusal>;
export type BlockedDebtList = DebtReadPage<BlockedDebtRow, DebtParentReadRefusal>;
export { debtWarningSchema, debtRefusalSchema, debtRetrySchema, debtReadPageSchema };
export {
  debtParentReadRefusalSchema,
  readyDebtRowSchema,
  debtTreeRootSchema,
  debtMutationResultSchema,
  debtUpdateResultSchema,
  debtChangeSchema,
  debtDetailSchema,
  debtSummarySchema,
  debtDispositionSchema,
  blockedDebtRowSchema,
  debtRefSchema,
  debtTreeNodeSchema,
  debtDoctorIssueSchema,
};
export type {
  AddDebtDocumentInput,
  AddDebtInput,
  BlockedDebtRow,
  DebtChange,
  DebtDetail,
  DebtDoctorIssue,
  DebtId,
  DebtMutationResult,
  DebtPriority,
  DebtReadPage,
  DebtRef,
  DebtRefusal,
  DebtRetry,
  DebtState,
  DebtSummary,
  DebtTreeNode,
  DebtTreeRoot,
  ReadyDebtRow,
  DebtParentReadRefusal,
  DebtUpdateResult,
  DebtWarning,
  UpdateDebtInput,
};
export { DebtAuthorityCorruptionError };
export { observeRecentDebtStatus, type RecentDebtSummary } from "./catalog.js";
export { boundedListLimit as debtRowViewLimit } from "../bounded-list.js";

class DebtHandle {
  constructor(
    readonly id: DebtId,
    private readonly world: WorldRoot,
  ) {}
  async read(): Promise<DebtReadResult> {
    const debt = await readDebtDetail(this.world, this.id);
    return debt === null ? { kind: "missing" } : { kind: "present", ...debt };
  }
  async tree(): Promise<DebtTreeResult> {
    if (arguments.length > 0) throw new TypeError("tree accepts no input");
    const board = (await readBoard(this.world)).board;
    const tree = buildTree(board, this.id, createDebtRelations(board));
    return tree === null ? { kind: "missing" } : { kind: "present", ...tree };
  }
  update(input: UpdateDebtInput): Promise<DebtUpdateResult> {
    return updateDebt(this.world, this.id, updateInput(input));
  }
}
export type Debt = DebtHandle;

class DebtsHandle {
  readonly root: WorldRoot;
  constructor(private readonly world: WorldRoot) {
    this.root = world;
  }
  debt(input: Readonly<{ id: string }>): Debt {
    const v = record(input, "debt input");
    closed(v, ["id"], "debt input");
    return new DebtHandle(id(v.id), this.world);
  }
  add(input: AddDebtInput): Promise<DebtMutationResult> {
    return addDebt(this.world, addInput(input));
  }
  addDocument(input: AddDebtDocumentInput): Promise<DebtMutationResult> {
    return addDebtDocument(this.world, addDocumentInput(input));
  }
  async list(
    input: Readonly<{
      selection?: "active" | "closed" | "all";
      scope?: "namespace" | "world";
      namespace?: readonly string[];
      limit?: number;
    }> = {},
  ): Promise<DebtList> {
    const v = record(input, "list input");
    closed(v, ["selection", "scope", "namespace", "limit"], "list input");
    if (v.selection !== undefined && v.selection !== "active" && v.selection !== "closed" && v.selection !== "all")
      throw new TypeError("selection must be active, closed, or all");
    if (v.scope !== undefined && v.scope !== "namespace" && v.scope !== "world")
      throw new TypeError("scope must be namespace or world");
    const selectedLimit = boundedListLimit(v.limit);
    return listDebts(
      this.world,
      namespace(v.namespace),
      v.selection ?? "active",
      v.scope as "namespace" | "world" | undefined,
      selectedLimit,
    );
  }
  async ready(
    input: Readonly<{
      scope?: "namespace" | "world";
      namespace?: readonly string[];
      parent?: string;
      limit?: number;
    }> = {},
  ): Promise<DebtReadyList> {
    const v = record(input, "ready input");
    closed(v, ["scope", "namespace", "parent", "limit"], "ready input");
    if (v.scope !== undefined && v.scope !== "namespace" && v.scope !== "world")
      throw new TypeError("scope must be namespace or world");
    const parent = v.parent === undefined ? undefined : id(v.parent);
    const selectedLimit = boundedListLimit(v.limit);
    return readyDebts(
      this.world,
      namespace(v.namespace),
      v.scope as "namespace" | "world" | undefined,
      parent,
      selectedLimit,
    );
  }
  async blocked(
    input: Readonly<{
      scope?: "namespace" | "world";
      namespace?: readonly string[];
      parent?: string;
      limit?: number;
    }> = {},
  ): Promise<BlockedDebtList> {
    const v = record(input, "blocked input");
    closed(v, ["scope", "namespace", "parent", "limit"], "blocked input");
    if (v.scope !== undefined && v.scope !== "namespace" && v.scope !== "world")
      throw new TypeError("scope must be namespace or world");
    const parent = v.parent === undefined ? undefined : id(v.parent);
    const selectedLimit = boundedListLimit(v.limit);
    return blockedDebts(
      this.world,
      namespace(v.namespace),
      v.scope as "namespace" | "world" | undefined,
      parent,
      selectedLimit,
    );
  }
  async doctor(): Promise<DebtDoctorReport> {
    const issues = nonEmptyDebtValues(diagnoseBoard((await readBoard(this.world)).board));
    return { kind: "present", ...(issues === undefined ? {} : { issues }) };
  }
}
export type Debts = DebtsHandle;

export const Debts = Object.freeze({
  of(world: WorldRoot): Debts {
    if (typeof world !== "string") throw new TypeError("Debts.of world must be a WorldRoot");
    return new DebtsHandle(world);
  },
});
