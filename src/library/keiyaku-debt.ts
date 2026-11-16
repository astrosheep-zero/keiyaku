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
import type { KeiyakuFor } from "./keiyaku.js";
import type { LifecycleSelection } from "../bounded-list.js";

type DebtListInvocation = Readonly<{
  selection?: LifecycleSelection;
  limit?: number;
}>;
export type DebtUpdateInvocation = UpdateDebtInput & Readonly<{ id: string }>;

const coordinates = (at: KeiyakuFor) => invocationCoordinates({ ...at, use: "none" });
const absent: DebtAbsent = { kind: "absent" };

export async function debtAdd(at: KeiyakuFor, input: AddDebtInput | AddDebtDocumentInput, document: boolean) {
  const parsed = document ? addDocumentInput(input) : addInput(input);
  if (document) parseDebtCreationDocument((parsed as AddDebtDocumentInput).markdown);
  const coord = await coordinates(at);
  const world = coord.world ?? (await coord.establishWorld());
  return document ? addDebtDocument(world, parsed as AddDebtDocumentInput) : addDebt(world, parsed as AddDebtInput);
}
export async function debtUpdate(at: KeiyakuFor, input: DebtUpdateInvocation) {
  const { id: raw, ...rest } = record(input, "update input");
  const id = debtId(raw),
    coord = await coordinates(at);
  if (coord.world !== null)
    return Debts.of(coord.world)
      .debt({ id })
      .update(rest as UpdateDebtInput);
  updateInput(rest).signal?.throwIfAborted();
  return { kind: "refused", reason: "debt-missing" } as const;
}
export async function debtShow(at: KeiyakuFor, id: string): Promise<DebtShowResult | DebtAbsent> {
  const coord = await coordinates(at);
  return coord.world === null ? absent : Debts.of(coord.world).read({ ids: [id] });
}
export async function debtLs(at: KeiyakuFor, input: DebtListInvocation) {
  debtRowViewLimit(input.limit);
  const coord = await coordinates(at);
  return coord.world === null ? ({ kind: "debt-catalogue", absent: true } as const) : Debts.of(coord.world).list(input);
}
export async function debtDoctor(at: KeiyakuFor) {
  const coord = await coordinates(at);
  return coord.world === null ? absent : Debts.of(coord.world).doctor();
}
