import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Gate } from "../index.js";
import { CliUsageError } from "./parse.js";

const GATE_SET_NAME = /^[a-z0-9][a-z0-9-]*$/;

type GateSets = ReadonlyMap<string, readonly Gate[]>;

function malformed(message: string): never {
  throw new CliUsageError(`invalid .keiyaku/settings.json: ${message}`);
}

function gateSets(root: string): GateSets {
  const path = join(root, ".keiyaku", "settings.json");
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  let settings: unknown;
  try {
    settings = JSON.parse(source) as unknown;
  } catch {
    malformed("expected JSON");
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) malformed("expected an object");
  const gates = (settings as Record<string, unknown>).gates;
  if (gates === undefined) return new Map();
  if (typeof gates !== "object" || gates === null || Array.isArray(gates)) malformed("gates must be an object");
  const result = new Map<string, readonly Gate[]>();
  for (const [name, snapshot] of Object.entries(gates as Record<string, unknown>)) {
    if (!GATE_SET_NAME.test(name)) malformed(`invalid gate set name '${name}'`);
    if (!Array.isArray(snapshot)) malformed(`gate set '${name}' must be an array`);
    const values = snapshot.map((value) => {
      if (value !== "reviewed" && value !== "verified") malformed(`gate set '${name}' contains an unknown gate`);
      return value;
    });
    if (new Set(values).size !== values.length) malformed(`gate set '${name}' contains duplicate gates`);
    result.set(name, values);
  }
  return result;
}

export function selectedGates(root: string, selected?: string): readonly Gate[] {
  const sets = gateSets(root);
  if (selected === undefined) return [...(sets.get("default") ?? ["reviewed"] as const)];
  if (!GATE_SET_NAME.test(selected)) throw new CliUsageError("--gates must be a lowercase machine segment");
  const gates = sets.get(selected);
  if (gates === undefined) throw new CliUsageError(`unknown gate set: ${selected}`);
  return [...gates];
}
