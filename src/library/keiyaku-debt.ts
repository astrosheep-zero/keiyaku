import {
  Debts,
  debtRowViewLimit,
  type AddDebtInput,
  type AddDebtDocumentInput,
  type UpdateDebtInput,
  type DebtQueryExpression,
  type DebtQuerySort,
  type DebtAbsent,
} from "../debt/index.js";
import { addDebt, addDebtDocument } from "../debt/operations.js";
import {
  addInput,
  addDocumentInput,
  closed,
  record,
  namespace,
  debtId,
  debtIds,
  text,
  signal,
  updateInput,
  sort,
} from "../debt/input.js";
import { parseDebtCreationDocument } from "../debt/document.js";
import { debtQuerySelection, normalizeDebtQuery } from "../debt/query.js";
import { installNamespaceContext, resolveDebtNamespaceContext, validateNamespaceContext } from "../debt/context.js";
import { invocationCoordinates, KeiyakuUsageError } from "./keiyaku-coordinates.js";
import { resolveActor } from "./keiyaku-attribution.js";
import type { KeiyakuAt } from "./keiyaku.js";

export type DebtSelection = "active" | "closed" | "all";
export type DebtReadScope = Readonly<{ scope?: "namespace" | "world"; namespace?: readonly string[]; limit?: number }>;
export type DebtLsInvocation = DebtReadScope & Readonly<{ of: "debt"; selection?: DebtSelection }>;
export type DebtReadyInvocation = DebtReadScope & Readonly<{ parent?: string }>;
export type DebtQueryInvocation = DebtReadScope &
  Readonly<{ selection?: DebtSelection; where?: DebtQueryExpression; sort?: DebtQuerySort }>;
export type DebtUpdateInvocation = UpdateDebtInput & Readonly<{ id: string }>;
export type DebtCloseInvocation = Readonly<{ ids: readonly string[]; note?: string; signal?: AbortSignal }>;
export type DebtShowInvocation =
  | Readonly<{ id: string; ids?: never }>
  | Readonly<{ ids: readonly string[]; id?: never }>;
export type DebtContextInvocation = Readonly<{ namespace?: readonly string[] }>;

const coordinates = (at: KeiyakuAt) => invocationCoordinates({ ...at, use: "none" });
const absent: DebtAbsent = { kind: "absent" };
const missing = (id: ReturnType<typeof debtId>) =>
  ({ kind: "refused", refusal: { kind: "debt-missing", debtId: id } }) as const;

function selection(value: unknown): DebtSelection {
  if (value === undefined) return "active";
  if (value !== "active" && value !== "closed" && value !== "all")
    throw new TypeError("selection must be active, closed, or all");
  return value;
}
function readInput(input: unknown, label: string, extra: readonly string[]) {
  const v = record(input, `${label} input`);
  closed(v, ["scope", "namespace", "limit", ...extra], `${label} input`);
  if (v.scope !== undefined && v.scope !== "namespace" && v.scope !== "world")
    throw new TypeError("scope must be namespace or world");
  const ns = namespace(v.namespace);
  if (v.scope === "world" && ns !== undefined) throw new TypeError("namespace and world scope are mutually exclusive");
  debtRowViewLimit(v.limit);
  return v;
}
async function selectedScope(
  at: Awaited<ReturnType<typeof coordinates>>,
  input: DebtReadScope,
): Promise<
  | { scope: "world" }
  | { namespace: readonly string[] }
  | { kind: "refused"; refusal: { kind: "invalid-namespace-context"; path: string } }
> {
  if (input.scope === "world") return { scope: "world" as const };
  if (input.namespace !== undefined) return { namespace: input.namespace };
  const context = await resolveDebtNamespaceContext(at.debtContext);
  return "kind" in context ? { kind: "refused" as const, refusal: context } : { namespace: context.namespace };
}

export async function debtAdd(at: KeiyakuAt, input: AddDebtInput | AddDebtDocumentInput, document: boolean) {
  const parsed = document ? addDocumentInput(input) : addInput(input);
  if (document) parseDebtCreationDocument((parsed as AddDebtDocumentInput).markdown);
  const actor = resolveActor({ env: at.environment, ...(parsed.actor === undefined ? {} : { actor: parsed.actor }) });
  const coord = await coordinates(at);
  const world = coord.world ?? (await coord.establishWorld());
  const scope = parsed.namespace === undefined ? await selectedScope(coord, {}) : { namespace: parsed.namespace };
  if ("kind" in scope) return scope;
  const composed = { ...parsed, ...scope, ...(actor === undefined ? {} : { actor }) };
  return document ? addDebtDocument(world, composed as AddDebtDocumentInput) : addDebt(world, composed as AddDebtInput);
}
export async function debtUpdate(at: KeiyakuAt, input: DebtUpdateInvocation) {
  const { id: raw, ...rest } = record(input, "update input");
  const id = debtId(raw),
    coord = await coordinates(at);
  if (coord.world !== null)
    return Debts.of(coord.world)
      .debt({ id })
      .update(rest as UpdateDebtInput);
  updateInput(rest).signal?.throwIfAborted();
  return missing(id);
}
export async function debtShow(at: KeiyakuAt, input: DebtShowInvocation) {
  const v = record(input, "show input");
  closed(v, ["id", "ids"], "show input");
  if ((v.id === undefined) === (v.ids === undefined)) throw new TypeError("show requires id or ids");
  const plural = v.ids !== undefined;
  if (plural && (!Array.isArray(v.ids) || v.ids.length === 0)) throw new TypeError("ids requires at least one DebtId");
  const ids = plural ? (v.ids as unknown[]).map(debtId) : [debtId(v.id)];
  const coord = await coordinates(at);
  const results: (import("../debt/index.js").DebtDetail | null)[] = [];
  for (const id of ids) results.push(coord.world === null ? null : await Debts.of(coord.world).debt({ id }).read());
  return plural ? results : (results[0] ?? null);
}
export async function debtClose(at: KeiyakuAt, input: DebtCloseInvocation, verb: "done" | "drop") {
  const v = record(input, "close input");
  closed(v, ["ids", "note", "signal"], "close input");
  const coord = await coordinates(at);
  if (coord.world !== null) return Debts.of(coord.world).batch({ ...input, verb });
  const ids = debtIds(v.ids, "ids");
  if (ids === undefined || ids.length === 0) throw new TypeError("ids requires at least one DebtId");
  text(v.note, "note");
  signal(v.signal)?.throwIfAborted();
  return { items: ids.map((id) => ({ id, outcome: missing(id) })) };
}
export async function debtList(at: KeiyakuAt, input: DebtLsInvocation) {
  const v = readInput(input, "list", ["of", "selection"]);
  if (v.of !== "debt") throw new TypeError("of must be debt");
  const selected = selection(v.selection),
    coord = await coordinates(at);
  if (coord.world === null) return absent;
  const scope = await selectedScope(coord, input);
  if ("kind" in scope) return scope;
  return Debts.of(coord.world).list({
    ...scope,
    selection: selected,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
}
export function debtReady(
  at: KeiyakuAt,
  input: DebtReadyInvocation,
  blocked: false,
): Promise<import("../debt/index.js").DebtList | typeof absent>;
export function debtReady(
  at: KeiyakuAt,
  input: DebtReadyInvocation,
  blocked: true,
): Promise<import("../debt/index.js").BlockedDebtList | typeof absent>;
export async function debtReady(at: KeiyakuAt, input: DebtReadyInvocation, blocked: boolean) {
  const v = readInput(input, blocked ? "blocked" : "ready", ["parent"]);
  if (v.parent !== undefined) debtId(v.parent);
  const coord = await coordinates(at);
  if (coord.world === null) return absent;
  const scope = await selectedScope(coord, input);
  if ("kind" in scope) return scope;
  const args = {
    ...scope,
    ...(input.parent === undefined ? {} : { parent: input.parent }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  };
  return blocked ? Debts.of(coord.world).blocked(args) : Debts.of(coord.world).ready(args);
}
export async function debtQuery(at: KeiyakuAt, input: DebtQueryInvocation) {
  const v = readInput(input, "query", ["selection", "where", "sort"]);
  const selected = selection(v.selection);
  if (v.where !== undefined) normalizeDebtQuery(v.where);
  sort(v.sort);
  const coord = await coordinates(at);
  if (coord.world === null) return absent;
  const scope = await selectedScope(coord, input);
  if ("kind" in scope) return scope;
  return Debts.of(coord.world).query({
    ...scope,
    where: debtQuerySelection(selected, input.where),
    ...(input.sort === undefined ? {} : { sort: input.sort }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
}
export async function debtTree(at: KeiyakuAt, input: Readonly<{ id: string }>) {
  const v = record(input, "tree input");
  closed(v, ["id"], "tree input");
  const id = debtId(v.id),
    coord = await coordinates(at);
  return coord.world === null ? missing(id) : Debts.of(coord.world).debt({ id }).tree();
}
export async function debtDoctor(at: KeiyakuAt) {
  const coord = await coordinates(at);
  return coord.world === null ? absent : Debts.of(coord.world).doctor();
}
export async function debtContext(at: KeiyakuAt, input: DebtContextInvocation) {
  const v = record(input, "context input");
  closed(v, ["namespace"], "context input");
  if (v.namespace !== undefined) {
    try {
      validateNamespaceContext(v.namespace);
    } catch (error) {
      if (error instanceof TypeError) throw new KeiyakuUsageError(error.message);
      throw error;
    }
  }
  const coord = await coordinates(at);
  if (v.namespace !== undefined) {
    if (coord.world === null) await coord.establishWorld();
    await installNamespaceContext(coord.debtContext.writeRoot, v.namespace as readonly string[]);
  } else if (coord.world === null)
    return { kind: "accepted", value: { namespace: [], source: "default-root" } } as const;
  const resolved = await resolveDebtNamespaceContext(coord.debtContext);
  return "kind" in resolved
    ? ({ kind: "refused", refusal: resolved } as const)
    : ({ kind: "accepted", value: resolved } as const);
}
