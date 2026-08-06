import { sha256, verificationDeclarationKey } from "./declaration-key.js";
import type { ContractBody, ContractState, Gate, SubjectKey } from "./facts/types.js";

/** Parse the persisted opaque subject representation used only by core facts. */
export function parseSubjectKey(value: string): SubjectKey {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("subject key must be lowercase SHA-256 hex");
  return value as SubjectKey;
}

function hash(value: unknown): SubjectKey {
  return parseSubjectKey(sha256(new TextEncoder().encode(JSON.stringify(value))));
}

function completeBodyKey(body: ContractBody): SubjectKey {
  return hash({
    title: body.title,
    context: body.context,
    objective: body.objective,
    design: body.design,
    region: body.region,
    criteria: body.criteria.map((criterion) => ({ title: criterion.title, body: criterion.body })),
    verification: body.verification.map((declaration) => ({ executor: declaration.executor, script: declaration.script })),
    extensions: body.extensions.map((extension) => ({ title: extension.title, content: extension.content })),
    ...(body.gates === undefined ? {} : { gates: body.gates }),
    ...(body.after === undefined ? {} : { after: body.after }),
  });
}

/** Construct the only attestable subject for a gate in the current folded state. */
export function currentSubject(state: ContractState, gate: Gate): SubjectKey | null {
  if (state.delivery === null || state.body === null) return null;
  if (gate === "reviewed") {
    return hash([
      "reviewed",
      state.delivery.data.candidate,
      state.delivery.data.deliveryPatchId,
      completeBodyKey(state.body),
    ]);
  }
  return hash(["verified", state.delivery.data.candidate, verificationDeclarationKey(state.body.verification)]);
}
