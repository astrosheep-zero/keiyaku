import {
  Debts,
  debtRowViewLimit,
  type AddDebtInput,
  type AddDebtDocumentInput,
  type UpdateDebtInput,
  type DebtAbsent,
  type DebtShowResult,
  type DebtShowItem,
} from "../debt/index.js";
import { addDebt, addDebtDocument } from "../debt/operations.js";
import { addInput, addDocumentInput, closed, record, namespace, debtId, updateInput } from "../debt/input.js";
import { parseDebtCreationDocument } from "../debt/document.js";
import { invocationCoordinates } from "./keiyaku-coordinates.js";
import { resolveActor } from "./keiyaku-attribution.js";
import type { KeiyakuAt } from "./keiyaku.js";

export type DebtSelection = "active" | "closed" | "all";
export type DebtReadScope = Readonly<{ scope?: "namespace" | "world"; namespace?: readonly string[]; limit?: number }>;
export type DebtListInvocation = DebtReadScope & Readonly<{ selection?: DebtSelection }>;
export type DebtUpdateInvocation = UpdateDebtInput & Readonly<{ id: string }>;
export type DebtShowInvocation =
  | Readonly<{ id: string; ids?: never }>
  | Readonly<{ ids: readonly string[]; id?: never }>;

const coordinates = (at: KeiyakuAt) => invocationCoordinates({ ...at, use: "none" });
const absent: DebtAbsent = { kind: "absent" };
const missing = () => ({ kind: "refused", reason: "debt-missing" }) as const;

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
function selectedScope(input: DebtReadScope) {
  return input.scope === "world" ? { scope: "world" as const } : { namespace: input.namespace ?? [] };
}

export async function debtAdd(at: KeiyakuAt, input: AddDebtInput | AddDebtDocumentInput, document: boolean) {
  const parsed = document ? addDocumentInput(input) : addInput(input);
  if (document) parseDebtCreationDocument((parsed as AddDebtDocumentInput).markdown);
  const actor = resolveActor({ env: at.environment, ...(parsed.actor === undefined ? {} : { actor: parsed.actor }) });
  const coord = await coordinates(at);
  const world = coord.world ?? (await coord.establishWorld());
  const composed = { ...parsed, ...(actor === undefined ? {} : { actor }) };
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
  return missing();
}
export async function debtShow(at: KeiyakuAt, input: DebtShowInvocation): Promise<DebtShowResult | DebtAbsent> {
  const v = record(input, "show input");
  closed(v, ["id", "ids"], "show input");
  if ((v.id === undefined) === (v.ids === undefined)) throw new TypeError("show requires id or ids");
  const plural = v.ids !== undefined;
  if (plural && (!Array.isArray(v.ids) || v.ids.length === 0)) throw new TypeError("ids requires at least one DebtId");
  const ids = plural ? (v.ids as unknown[]).map(debtId) : [debtId(v.id)];
  const coord = await coordinates(at);
  if (coord.world === null) return absent;
  const items: DebtShowItem[] = [];
  for (const id of ids) {
    const result = await Debts.of(coord.world).debt({ id }).read();
    items.push(result.kind === "present" ? { ...result, kind: "found" } : result);
  }
  return { kind: "present", items };
}
export async function debtLs(at: KeiyakuAt, input: DebtListInvocation) {
  const v = readInput(input, "list", ["selection"]);
  const selected = selection(v.selection);
  const coord = await coordinates(at);
  if (coord.world === null) return absent;
  return Debts.of(coord.world).list({
    ...selectedScope(input),
    selection: selected,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
}
export async function debtTree(at: KeiyakuAt, input: Readonly<{ id: string }>) {
  const v = record(input, "tree input");
  closed(v, ["id"], "tree input");
  const id = debtId(v.id),
    coord = await coordinates(at);
  return coord.world === null ? absent : Debts.of(coord.world).debt({ id }).tree();
}
export async function debtDoctor(at: KeiyakuAt) {
  const coord = await coordinates(at);
  return coord.world === null ? absent : Debts.of(coord.world).doctor();
}
