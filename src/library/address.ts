import { readAliases } from "../alias/index.js";
import { Akuma, type AkumaList } from "../akuma/akuma.js";
import { parseAkuId, type AkuId } from "../akuma/identity.js";
import { contractId } from "../core/facts/types.js";
import { readDispatches } from "../dispatch/index.js";
import {
  matchesAkumaGlob,
  parseAkumaAlias,
  parseAkumaGlob,
  type AkumaAlias,
  type AkumaGlob,
} from "../identity/selector.js";
import type { Settings } from "../settings.js";
import type { WorldRoot } from "../world.js";
import { requireInput } from "./input.js";
import { scopeForRepo, type Repo } from "./repo.js";

export type DirectAkumaSelector = AkuId | AkumaAlias;
export type SetAkumaSelector = DirectAkumaSelector | AkumaGlob | `kei/${string}`;

export type AkumaAddressInput = Readonly<{
  path: WorldRoot;
  akuma: string;
  settings?: Settings;
}>;

export type AkumaSetAddressInput = Readonly<{
  path: WorldRoot;
  akuma: readonly string[];
  settings?: Settings;
  repo?: Repo;
}>;

function nonblank(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} must be a nonblank string`);
  return value;
}

function settingsOption(value: unknown): Settings | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || typeof (value as { namespace?: unknown }).namespace !== "function") {
    throw new TypeError("settings must be a Settings");
  }
  return value as Settings;
}

function world(path: WorldRoot, settings?: Settings): Akuma {
  return Akuma.of(path, settings);
}

function directId(path: WorldRoot, selector: string): AkuId {
  if (selector.startsWith("@")) {
    const alias = parseAkumaAlias(selector);
    const resolved = readAliases(path).find((binding) => binding.alias === alias)?.akuId ?? null;
    if (resolved === null) throw new TypeError(`unknown Akuma alias: ${alias}`);
    return resolved;
  }
  return parseAkuId(selector).id;
}

export type NamedAddressContract = Readonly<{
  id: string;
  disposition: "active" | "terminal";
  workspace: "worktree" | "here";
  worktreePath: string | null;
}>;

export type NamedAddress =
  | Readonly<{ kind: "contract"; id: string }>
  | Readonly<{ kind: "akuma"; id: AkuId }>;

export function resolveNamedAddress(input: Readonly<{
  path: WorldRoot | null;
  selector: string;
  contracts: readonly NamedAddressContract[];
}>): NamedAddress {
  const selector = nonblank(input.selector, "selector");
  if (selector.startsWith("kei/")) return { kind: "contract", id: contractId(selector) };
  if (selector.startsWith("aku/")) return { kind: "akuma", id: parseAkuId(selector).id };
  const alias = parseAkumaAlias(selector);
  const contractMatches = input.contracts.filter((row) => row.disposition === "active"
    && row.workspace === "worktree" && row.worktreePath !== null
    && `@${row.id.slice("kei/".length)}` === alias);
  const aliasId = input.path === null
    ? null
    : readAliases(input.path).find((binding) => binding.alias === alias)?.akuId ?? null;
  if (contractMatches.length > 0 && aliasId !== null) throw new TypeError(`ambiguous selector matches Contract and Akuma: ${selector}`);
  if (contractMatches.length === 1) return { kind: "contract", id: contractMatches[0]!.id };
  if (contractMatches.length > 1) throw new TypeError(`ambiguous Contract selector: ${selector}`);
  if (aliasId !== null) return { kind: "akuma", id: aliasId };
  throw new TypeError(`unknown selector: ${selector}`);
}

export function addressAkuma(input: AkumaAddressInput): Readonly<{
  path: WorldRoot;
  id: AkuId;
  settings?: Settings;
}> {
  const values = requireInput(input, "Akuma address input");
  for (const key of Object.keys(values)) {
    if (!["path", "akuma", "settings"].includes(key)) throw new TypeError(`Akuma address input has unknown field: ${key}`);
  }
  const path = nonblank(values.path, "path") as WorldRoot;
  const settings = settingsOption(values.settings);
  return { path, id: directId(path, nonblank(values.akuma, "akuma")), ...(settings === undefined ? {} : { settings }) };
}

function idsFromFleet(fleet: AkumaList): readonly AkuId[] {
  return fleet.rows.map((row) => row.id);
}

export async function addressAkumaSet(input: AkumaSetAddressInput): Promise<Readonly<{
  path: WorldRoot;
  ids: readonly AkuId[];
  settings?: Settings;
}>> {
  const values = requireInput(input, "Akuma set address input");
  for (const key of Object.keys(values)) {
    if (!["path", "akuma", "settings", "repo"].includes(key)) throw new TypeError(`Akuma set address input has unknown field: ${key}`);
  }
  if (!Array.isArray(values.akuma) || values.akuma.length === 0) throw new TypeError("akuma must be a nonempty selector array");
  const path = nonblank(values.path, "path") as WorldRoot;
  const settings = settingsOption(values.settings);
  const selectors = values.akuma.map((raw) => {
    const selector = nonblank(raw, "akuma selector");
    if (selector.startsWith("kei/")) return { kind: "contract" as const, value: contractId(selector) };
    if (selector.includes("*")) return { kind: "glob" as const, value: parseAkumaGlob(selector) };
    if (selector.startsWith("@")) return { kind: "alias" as const, value: parseAkumaAlias(selector) };
    return { kind: "direct" as const, value: parseAkuId(selector).id };
  });
  if (selectors.some((selector) => selector.kind === "contract") && values.repo === undefined) {
    throw new TypeError("Contract Akuma selector requires repo");
  }
  const fleetIds = selectors.some((selector) => selector.kind === "glob")
    ? idsFromFleet(world(path, settings).list())
    : [];
  const aliases = selectors.some((selector) => selector.kind === "alias")
    ? new Map(readAliases(path).map((binding) => [binding.alias, binding.akuId]))
    : new Map<AkumaAlias, AkuId>();
  const dispatches = selectors.some((selector) => selector.kind === "contract")
    ? await readDispatches(scopeForRepo(values.repo as Repo))
    : [];
  const selected = new Set<AkuId>();
  for (const selector of selectors) {
    if (selector.kind === "contract") {
      const members = dispatches
        .filter((dispatch) => dispatch.contractId === selector.value)
        .map((dispatch) => dispatch.akuId);
      for (const id of members) selected.add(id);
      continue;
    }
    if (selector.kind === "glob") {
      for (const id of fleetIds) if (matchesAkumaGlob(selector.value, id)) selected.add(id);
      continue;
    }
    if (selector.kind === "alias") {
      const id = aliases.get(selector.value);
      if (id === undefined) throw new TypeError(`unknown Akuma alias: ${selector.value}`);
      selected.add(id);
    } else selected.add(selector.value);
  }
  const ids = [...selected].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (ids.length === 0) throw new TypeError("Akuma selector snapshot is empty");
  return { path, ids, ...(settings === undefined ? {} : { settings }) };
}
