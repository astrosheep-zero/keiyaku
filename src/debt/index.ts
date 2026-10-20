import type { WorldRoot } from "../world.js";
import type { NamespaceContextSource, ResolvedNamespaceContext } from "./context.js";
import { executionChannel, localExecutionContext, type ExecutionContext } from "../akuma/requests.js";
import {
  requestForwardedDebt,
  type DebtLifecycleVerb,
  type DebtMutationRequest,
  type DebtMutationResultForRequest,
} from "./mutation.js";
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
  actor,
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

export type DebtDetail = Omit<DebtDetailFacts, "debt"> & Readonly<{ debt: DebtView }>;
export type DebtList = DebtOutcome<DebtPage<DebtRow>>;
export type BlockedDebtList = DebtOutcome<DebtPage<BlockedDebtRow>>;
export type DebtQueryResult = DebtOutcome<DebtPage<DebtQueryRow>>;
export type DebtContextSource = NamespaceContextSource;
export type { ResolvedNamespaceContext };
export type DebtContextResult = DebtOutcome<ResolvedNamespaceContext>;
export type DebtDoctorReport = Readonly<{ issues: readonly DebtDoctorIssue[] }>;
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
export type { LibraryExecution } from "../akuma/requests.js";
export { DebtAuthorityCorruptionError, DEBT_RELATION_PREDICATE_FIELDS };
export { observeRecentDebtStatus, type RecentDebtStatusRow } from "./catalog.js";
export { boundedListLimit as debtRowViewLimit } from "../bounded-list.js";

/**
 * The one captured execution route per Debts handle. Local execution calls the
 * Debt operations directly; a forwarded handle sends the same operation through
 * the one body-request channel. The channel is read once at construction, never
 * re-derived per operation.
 */
type DebtRoute = Readonly<{ kind: "local" }> | Readonly<{ kind: "forwarded"; directory: string }>;

function debtRoute(execution: ExecutionContext): DebtRoute {
  const channel = executionChannel(execution);
  return channel.kind === "body-request" ? { kind: "forwarded", directory: channel.directory } : { kind: "local" };
}

function forwardDebt<Request extends DebtMutationRequest>(
  directory: string,
  world: WorldRoot,
  request: Request,
  signal?: AbortSignal,
): Promise<DebtMutationResultForRequest<Request>> {
  return requestForwardedDebt({
    directory,
    world,
    request,
    ...(signal === undefined ? {} : { signal }),
  });
}

type LifecycleAction = "debt.done" | "debt.drop";
type SingleLifecycleRequest = Extract<DebtMutationRequest, { action: LifecycleAction; id: DebtId }>;
type BatchLifecycleRequest = Extract<DebtMutationRequest, { action: LifecycleAction; ids: readonly DebtId[] }>;

/** The single lifecycle request shapes, keyed once by verb instead of switched per handle. */
const SINGLE_LIFECYCLE: Readonly<
  Record<DebtLifecycleVerb, (id: DebtId, note: string | undefined) => SingleLifecycleRequest>
> = {
  done: (id, note) => ({ action: "debt.done", id, ...(note === undefined ? {} : { note }) }),
  drop: (id, note) => ({ action: "debt.drop", id, ...(note === undefined ? {} : { note }) }),
};

/** The batch lifecycle request shapes for the same verbs. */
const BATCH_LIFECYCLE: Readonly<
  Record<DebtLifecycleVerb, (ids: readonly DebtId[], note: string | undefined) => BatchLifecycleRequest>
> = {
  done: (ids, note) => ({ action: "debt.done", ids, ...(note === undefined ? {} : { note }) }),
  drop: (ids, note) => ({ action: "debt.drop", ids, ...(note === undefined ? {} : { note }) }),
};

/**
 * The one bound operation table for a captured route. Each entry either calls the
 * local Debt operations directly or sends the same validated values as the one
 * forwarded request shape. Validation stays in the handle methods.
 */
type DebtOperations = Readonly<{
  add(values: AddDebtInput): Promise<DebtMutationResult>;
  addDocument(values: AddDebtDocumentInput): Promise<DebtMutationResult>;
  update(id: DebtId, values: UpdateDebtInput): Promise<DebtUpdateResult>;
  lifecycle(
    id: DebtId,
    verb: DebtLifecycleVerb,
    note: string | undefined,
    signal?: AbortSignal,
  ): Promise<DebtMutationResult>;
  batch(
    verb: DebtLifecycleVerb,
    ids: readonly DebtId[],
    note: string | undefined,
    signal?: AbortSignal,
  ): Promise<DebtBatchResult>;
}>;

function debtOperations(world: WorldRoot, route: DebtRoute): DebtOperations {
  if (route.kind === "forwarded") {
    const { directory } = route;
    return {
      add: (values) => {
        const { actor: _actor, signal, namespace: selected, ...request } = values;
        return forwardDebt(
          directory,
          world,
          { action: "debt.add", input: { ...request, namespace: selected ?? [] } },
          signal,
        );
      },
      addDocument: (values) =>
        forwardDebt(
          directory,
          world,
          { action: "debt.addDocument", input: { markdown: values.markdown, namespace: values.namespace ?? [] } },
          values.signal,
        ),
      update: (id, values) => {
        const { signal, ...request } = values;
        return forwardDebt(directory, world, { action: "debt.update", id, input: request }, signal);
      },
      lifecycle: (id, verb, note, signal) => forwardDebt(directory, world, SINGLE_LIFECYCLE[verb](id, note), signal),
      batch: (verb, ids, note, signal) => forwardDebt(directory, world, BATCH_LIFECYCLE[verb](ids, note), signal),
    };
  }
  return {
    add: (values) => addDebt(world, values),
    addDocument: (values) => addDebtDocument(world, values),
    update: (id, values) => updateDebt(world, id, values),
    lifecycle: (id, verb, note, signal) => lifecycleDebt(world, id, verb, signal, note),
    batch: (verb, ids, note, signal) => batchDebts(world, verb, ids, signal, note),
  };
}

class DebtHandle {
  constructor(
    readonly id: DebtId,
    private readonly world: WorldRoot,
    private readonly operations: DebtOperations,
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
    return this.operations.update(this.id, updateInput(input));
  }
  private lifecycle(verb: DebtLifecycleVerb, input: unknown): Promise<DebtMutationResult> {
    const value = record(input ?? {}, `${verb} input`);
    closed(value, ["note", "signal"], `${verb} input`);
    const note = text(value.note, "note");
    return this.operations.lifecycle(this.id, verb, note, signal(value.signal));
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
  private readonly operations: DebtOperations;
  constructor(
    private readonly world: WorldRoot,
    execution: ExecutionContext,
  ) {
    this.root = world;
    this.operations = debtOperations(world, debtRoute(execution));
  }
  debt(input: Readonly<{ id: string }>): Debt {
    const v = record(input, "debt input");
    closed(v, ["id"], "debt input");
    return new DebtHandle(id(v.id), this.world, this.operations);
  }
  add(input: AddDebtInput): Promise<DebtMutationResult> {
    return this.operations.add(addInput(input));
  }
  addDocument(input: AddDebtDocumentInput): Promise<DebtMutationResult> {
    const v = record(input, "addDocument input");
    closed(v, ["markdown", "namespace", "actor", "signal"], "addDocument input");
    const markdown = text(v.markdown, "markdown");
    if (markdown === undefined) throw new TypeError("markdown is required");
    const ns = namespace(v.namespace),
      createdBy = actor(v.actor),
      abort = signal(v.signal);
    return this.operations.addDocument({
      markdown,
      ...(ns === undefined ? {} : { namespace: ns }),
      ...(createdBy === undefined ? {} : { actor: createdBy }),
      ...(abort === undefined ? {} : { signal: abort }),
    });
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

    return this.operations.batch(verb, ids, note, signal(v.signal));
  }
}
export type Debts = DebtsHandle;

/**
 * The one Debts composition. Public `of` fixes local execution; CLI and Body pass their captured
 * internal channel through `debtsWithExecution` instead of a second constructor.
 */
export function debtsWithExecution(world: WorldRoot, execution: ExecutionContext): Debts {
  if (typeof world !== "string") throw new TypeError("Debts.of world must be a WorldRoot");
  return new DebtsHandle(world, execution);
}

export const Debts = Object.freeze({
  of(world: WorldRoot): Debts {
    return debtsWithExecution(world, localExecutionContext());
  },
});
