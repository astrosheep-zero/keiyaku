import {
  Debts,
  debtRowViewLimit,
  type AddDebtInput,
  type AddDebtDocumentInput,
  type UpdateDebtInput,
  type DebtAbsent,
  type DebtShowResult,
} from "../debt/index.js";
import { addDebt, addDebtDocument } from "../debt/operations.js";
import { addInput, addDocumentInput, record, debtId, updateInput } from "../debt/input.js";
import { parseDebtCreationDocument } from "../debt/document.js";
import { invocationCoordinates } from "./keiyaku-coordinates.js";
import { resolveActor } from "./keiyaku-attribution.js";
import type { KeiyakuAt } from "./keiyaku.js";

type DebtListInvocation = Readonly<{ selection?: "active" | "closed" | "all"; limit?: number }>;
export type DebtUpdateInvocation = UpdateDebtInput & Readonly<{ id: string }>;

const coordinates = (at: KeiyakuAt) => invocationCoordinates({ ...at, use: "none" });
const absent: DebtAbsent = { kind: "absent" };
const missing = () => ({ kind: "refused", reason: "debt-missing" }) as const;

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
export async function debtShow(at: KeiyakuAt, ids: readonly string[]): Promise<DebtShowResult | DebtAbsent> {
  const coord = await coordinates(at);
  return coord.world === null ? absent : Debts.of(coord.world).read({ ids });
}
export async function debtLs(at: KeiyakuAt, input: DebtListInvocation) {
  debtRowViewLimit(input.limit);
  const coord = await coordinates(at);
  return coord.world === null ? ({ kind: "debt-catalogue", absent: true } as const) : Debts.of(coord.world).list(input);
}
export async function debtDoctor(at: KeiyakuAt) {
  const coord = await coordinates(at);
  return coord.world === null ? absent : Debts.of(coord.world).doctor();
}
