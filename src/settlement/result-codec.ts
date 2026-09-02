import { contractId } from "../core/facts/types.js";
import { canonicalTaskId } from "../task/identity.js";
import type { SettlementLag } from "./settle.js";

function fail(): never {
  throw new Error("malformed settlement lag");
}

function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) fail();
  for (const key of required) if (!(key in record)) fail();
  return record;
}

function nonblank(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") fail();
  return value;
}

export function decodeSettlementLag(value: unknown): SettlementLag {
  const record = object(value, ["kind", "surface", "contractId", "diagnostic"], ["taskId", "path"]);
  if (record.kind !== "settlement-failed") fail();
  if (record.surface !== "task-holder" && record.surface !== "task") fail();
  let id;
  try {
    id = contractId(nonblank(record.contractId));
  } catch {
    fail();
  }
  const lag: SettlementLag = {
    kind: "settlement-failed",
    surface: record.surface,
    contractId: id,
    diagnostic: nonblank(record.diagnostic),
  };
  if (record.taskId !== undefined) {
    try {
      return {
        ...lag,
        taskId: canonicalTaskId(nonblank(record.taskId)),
        ...(record.path === undefined ? {} : { path: nonblank(record.path) }),
      };
    } catch {
      fail();
    }
  }
  return record.path === undefined ? lag : { ...lag, path: nonblank(record.path) };
}
