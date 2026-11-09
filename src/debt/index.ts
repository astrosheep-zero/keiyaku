import { z } from "zod";
import { boundedListSchema } from "../bounded-list.js";
import {
  debtRefSchema,
  debtResultRowSchema,
  blockedDebtRowSchema,
  debtTreeNodeSchema,
  debtDoctorIssueSchema,
} from "./board.js";
import {
  debtViewSchema,
  debtOutcomeSchema,
  debtMutationResultSchema,
  debtUpdateResultSchema,
  debtBatchResultSchema,
} from "./operation-types.js";
import { debtQueryRowSchema } from "./query.js";
import type { WorldRoot } from "../world.js";
import type { NamespaceContextSource, ResolvedNamespaceContext } from "./context.js";
import type { DebtLifecycleVerb } from "./operation-types.js";
export type { WorldRoot } from "../world.js";
import {
  buildTree,
  createDebtRelations,
  diagnoseBoard,
  type BlockedDebtRow,
  type DebtDetailFacts,
  type DebtDoctorIssue,
  type DebtRef,
  type DebtRow,
  type DebtTreeNode,
} from "./board.js";
import { DebtAuthorityCorruptionError, type DebtPriority, type DebtState } from "./document.js";
import type { DebtId } from "./identity.js";
import {
  addDebt,
  addDebtDocument,
  batchDebts,
  blockedDebts,
  lifecycleDebt,
  listDebts,
  queryDebts,
  readDebtDetail,
  readyDebts,
  debtView,
  updateDebt,
  type AddDebtDocumentInput,
  type AddDebtInput,
  type DebtBatchResult,
  type DebtCleanupFailure,
  type DebtMutationResult,
  type DebtOutcome,
  type DebtRefusal,
  type DebtRetry,
  type DebtUpdateResult,
  type DebtView,
  type UpdateDebtInput,
} from "./operations.js";
import { boundedListLimit } from "../bounded-list.js";
import { readBoard } from "./store.js";
import {
  addDocumentInput,
  addInput,
  closed,
  namespace,
  record,
  signal,
  sort,
  debtId as id,
  debtIds,
  text,
  updateInput,
} from "./input.js";
import {
  normalizeDebtQuery,
  debtQuerySelection,
  DEBT_RELATION_PREDICATE_FIELDS,
  type DebtPage,
  type DebtQueryExpression,
  type DebtQueryPredicate,
  type DebtQueryRow,
  type DebtQuerySort,
  type DebtRelationPredicateField,
} from "./query.js";

export const debtAbsentSchema = z.strictObject({ kind: z.literal("absent") }).readonly();
export type DebtAbsent = z.output<typeof debtAbsentSchema>;
export type DebtDetail = Omit<DebtDetailFacts, "debt"> & Readonly<{ debt: DebtView }>;
export type DebtList = DebtOutcome<DebtPage<DebtRow>>;
export type BlockedDebtList = DebtOutcome<DebtPage<BlockedDebtRow>>;
export type DebtQueryResult = DebtOutcome<DebtPage<DebtQueryRow>>;
export type DebtContextSource = NamespaceContextSource;
export type { ResolvedNamespaceContext };
export type DebtContextResult = DebtOutcome<ResolvedNamespaceContext>;
export type DebtDoctorReport = Readonly<{ issues: readonly DebtDoctorIssue[] }>;
export const debtDetailSchema = z
  .strictObject({
    debt: debtViewSchema,
    needs: z.array(z.strictObject({ ...debtRefSchema.unwrap().shape, released: z.boolean() }).readonly()).readonly(),
    blockers: z.array(debtRefSchema).readonly(),
    blocks: z.array(debtRefSchema).readonly(),
    parent: debtRefSchema.nullable(),
    children: z.array(debtRefSchema).readonly(),
    supersedes: z.array(debtRefSchema).readonly(),
    supersededBy: z.array(debtRefSchema).readonly(),
    related: z.array(debtRefSchema).readonly(),
  })
  .readonly();
export const debtReadSchema = debtDetailSchema.nullable();
export const debtListSchema = debtOutcomeSchema(boundedListSchema(debtResultRowSchema));
export const blockedDebtListSchema = debtOutcomeSchema(boundedListSchema(blockedDebtRowSchema));
export const debtQueryResultSchema = debtOutcomeSchema(boundedListSchema(debtQueryRowSchema));
export const debtDoctorReportSchema = z.strictObject({ issues: z.array(debtDoctorIssueSchema).readonly() }).readonly();
export const debtDecompositionTreeSchema = debtOutcomeSchema(debtTreeNodeSchema);
export { debtOutcomeSchema, debtViewSchema, debtMutationResultSchema, debtUpdateResultSchema, debtBatchResultSchema };
export type DebtDecompositionTree = DebtOutcome<DebtTreeNode>;
export type {
  AddDebtDocumentInput,
  AddDebtInput,
  BlockedDebtRow,
  DebtBatchResult,
  DebtCleanupFailure,
  DebtDoctorIssue,
  DebtId,
  DebtMutationResult,
  DebtOutcome,
  DebtPriority,
  DebtRef,
  DebtRefusal,
  DebtRetry,
  DebtRow,
  DebtState,
  DebtTreeNode,
  DebtUpdateResult,
  DebtView,
  UpdateDebtInput,
  DebtPage,
  DebtQueryExpression,
  DebtQueryPredicate,
  DebtQueryRow,
  DebtQuerySort,
  DebtRelationPredicateField,
};
export { DebtAuthorityCorruptionError, DEBT_RELATION_PREDICATE_FIELDS };
export { observeRecentDebtStatus, type RecentDebtStatusRow } from "./catalog.js";
export { boundedListLimit as debtRowViewLimit } from "../bounded-list.js";

class DebtHandle {
  constructor(
    readonly id: DebtId,
    private readonly world: WorldRoot,
  ) {}
  async read(): Promise<DebtDetail | null> {
    const facts = await readDebtDetail(this.world, this.id);
    return facts === null ? null : { ...facts, debt: debtView(facts.debt) };
  }
  async tree(): Promise<DebtDecompositionTree> {
    if (arguments.length > 0) throw new TypeError("tree accepts no input");
    const board = (await readBoard(this.world)).board;
    const node = buildTree(board, this.id, createDebtRelations(board));
    return node === null
      ? { kind: "refused", refusal: { kind: "debt-missing", debtId: this.id } }
      : { kind: "accepted", value: node };
  }
  update(input: UpdateDebtInput): Promise<DebtUpdateResult> {
    return updateDebt(this.world, this.id, updateInput(input));
  }
  private lifecycle(verb: DebtLifecycleVerb, input: unknown): Promise<DebtMutationResult> {
    const value = record(input ?? {}, `${verb} input`);
    closed(value, ["note", "signal"], `${verb} input`);
    const note = text(value.note, "note");
    return lifecycleDebt(this.world, this.id, verb, signal(value.signal), note);
  }
  done(input?: { note?: string; signal?: AbortSignal }): Promise<DebtMutationResult> {
    return this.lifecycle("done", input);
  }
  drop(input?: { note?: string; signal?: AbortSignal }): Promise<DebtMutationResult> {
    return this.lifecycle("drop", input);
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
  ): Promise<DebtList> {
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
  async query(
    input: Readonly<{
      where?: DebtQueryExpression;
      scope?: "namespace" | "world";
      namespace?: readonly string[];
      sort?: DebtQuerySort;
      limit?: number;
    }> = {},
  ): Promise<DebtQueryResult> {
    const v = record(input, "query input");
    closed(v, ["where", "scope", "namespace", "sort", "limit"], "query input");
    if (v.scope !== undefined && v.scope !== "namespace" && v.scope !== "world")
      throw new TypeError("scope must be namespace or world");
    const expression = v.where === undefined ? debtQuerySelection() : normalizeDebtQuery(v.where);
    const selected = namespace(v.namespace);
    const selectedLimit = boundedListLimit(v.limit);
    return queryDebts({
      world: this.world,
      ...(selected === undefined ? {} : { namespace: selected }),
      expression,
      ...(v.scope === undefined ? {} : { scope: v.scope as "namespace" | "world" }),
      sort: sort(v.sort) ?? "priority",
      limit: selectedLimit,
    });
  }
  async doctor(): Promise<DebtDoctorReport> {
    return { issues: diagnoseBoard((await readBoard(this.world)).board) };
  }
  batch(
    input: Readonly<{
      verb: "done" | "drop";
      ids: readonly string[];
      note?: string;
      signal?: AbortSignal;
    }>,
  ): Promise<DebtBatchResult> {
    const v = record(input, "batch input");
    closed(v, ["verb", "ids", "note", "signal"], "batch input");
    const verb = v.verb;
    if (verb !== "done" && verb !== "drop") throw new TypeError("batch verb is invalid");
    const ids = debtIds(v.ids, "ids");
    if (ids === undefined || ids.length === 0) throw new TypeError("ids requires at least one DebtId");
    const note = text(v.note, "note");

    return batchDebts(this.world, verb, ids, signal(v.signal), note);
  }
}
export type Debts = DebtsHandle;

export const Debts = Object.freeze({
  of(world: WorldRoot): Debts {
    if (typeof world !== "string") throw new TypeError("Debts.of world must be a WorldRoot");
    return new DebtsHandle(world);
  },
});
