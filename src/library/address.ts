import { readAliases, type AliasBinding } from "../alias/index.js";
import { Akuma, type AkumaList } from "../akuma/akuma.js";
import { probeBornAkuma } from "../akuma/index.js";
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
import type { WorldRoot } from "../world.js";
import type { KanshiReport, Section } from "../kanshi/report.js";
import { requireInput } from "./input.js";
import { scopeForRepo, type Repo } from "./repo.js";

export type DirectAkumaSelector = AkuId | AkumaAlias;
export type SetAkumaSelector = DirectAkumaSelector | AkumaGlob | `kei/${string}`;

export type AkumaAddressInput = Readonly<{
  path: WorldRoot;
  akuma: string;
  repo?: Repo;
}>;

export type AkumaSetAddressInput = Readonly<{
  path: WorldRoot;
  akuma: readonly string[];
  repo?: Repo;
}>;

export type AkumaWorldScopeRefusal = Readonly<{
  kind: "akuma-not-in-world";
  ids: readonly AkuId[];
  world: WorldRoot;
}>;

export class AkumaWorldScopeError extends TypeError {
  readonly refusal: AkumaWorldScopeRefusal;

  constructor(refusal: AkumaWorldScopeRefusal) {
    super(`akuma-not-in-world ${refusal.world} ${refusal.ids.join(" ")}`);
    this.name = "AkumaWorldScopeError";
    this.refusal = refusal;
  }
}

function nonblank(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} must be a nonblank string`);
  return value;
}

function world(path: WorldRoot): Akuma {
  return Akuma.of(path);
}

async function directId(path: WorldRoot, selector: string): Promise<AkuId> {
  if (selector.startsWith("@")) {
    const alias = parseAkumaAlias(selector);
    const resolved = (await readAliases(path)).find((binding) => binding.alias === alias)?.akuId ?? null;
    if (resolved === null) throw new TypeError(`unknown Akuma alias: ${alias}`);
    return resolved;
  }
  return parseAkuId(selector).id;
}

export type NamedAddress =
  | Readonly<{ kind: "contract"; id: string }>
  | Readonly<{ kind: "akuma"; id: AkuId }>;

export type NamedAddressInput = Readonly<{
  selector: string;
  report: KanshiReport;
  aliases: Section<readonly AliasBinding[]>;
}>;

export function resolveNamedAddress(input: NamedAddressInput): NamedAddress {
  const selector = nonblank(input.selector, "selector");
  if (selector.startsWith("kei/")) return { kind: "contract", id: contractId(selector) };
  if (selector.startsWith("aku/")) return { kind: "akuma", id: parseAkuId(selector).id };
  const alias = parseAkumaAlias(selector);
  if (input.report.contracts.kind === "failed") {
    throw new TypeError("cannot resolve a named selector while the Contract world is failed");
  }
  if (input.aliases.kind === "failed") {
    throw new TypeError("cannot resolve a named selector while Alias authority is failed");
  }
  const contractMatches = (input.report.contracts.kind === "present" ? input.report.contracts.value.rows : []).filter((row) => row.disposition === "active"
    && row.workspace === "worktree" && row.worktreePath !== null
    && `@${row.id.slice("kei/".length)}` === alias);
  const aliasId = input.aliases.kind === "present"
    ? input.aliases.value.find((binding) => binding.alias === alias)?.akuId ?? null
    : null;
  if (contractMatches.length > 0 && aliasId !== null) throw new TypeError(`ambiguous selector matches Contract and Akuma: ${selector}`);
  if (contractMatches.length === 1) return { kind: "contract", id: contractMatches[0]!.id };
  if (contractMatches.length > 1) throw new TypeError(`ambiguous Contract selector: ${selector}`);
  if (aliasId !== null) return { kind: "akuma", id: aliasId };
  throw new TypeError(`unknown selector: ${selector}`);
}

export async function addressAkuma(input: AkumaAddressInput): Promise<Readonly<{
  path: WorldRoot;
  id: AkuId;
}>> {
  const values = requireInput(input, "Akuma address input");
  for (const key of Object.keys(values)) {
    if (!["path", "akuma", "repo"].includes(key)) {
      throw new TypeError(`Akuma address input has unknown field: ${key}`);
    }
  }
  if (values.repo !== undefined) scopeForRepo(values.repo);
  const path = nonblank(values.path, "path") as WorldRoot;
  return { path, id: await directId(path, nonblank(values.akuma, "akuma")) };
}

function idsFromFleet(fleet: AkumaList): readonly AkuId[] {
  return fleet.rows.map((row) => row.id);
}

type ParsedSetSelector =
  | Readonly<{ kind: "contract"; value: ReturnType<typeof contractId> }>
  | Readonly<{ kind: "glob"; value: AkumaGlob }>
  | Readonly<{ kind: "alias"; value: AkumaAlias }>
  | Readonly<{ kind: "direct"; value: AkuId }>;
type DispatchFact = Awaited<ReturnType<typeof readDispatches>>[number];

function parseSetSelector(raw: string): ParsedSetSelector {
  const selector = nonblank(raw, "akuma selector");
  if (selector.startsWith("kei/")) return { kind: "contract", value: contractId(selector) };
  if (selector.includes("*")) return { kind: "glob", value: parseAkumaGlob(selector) };
  if (selector.startsWith("@")) return { kind: "alias", value: parseAkumaAlias(selector) };
  return { kind: "direct", value: parseAkuId(selector).id };
}

function hasSelectorKind(selectors: readonly ParsedSetSelector[], kind: ParsedSetSelector["kind"]): boolean {
  return selectors.some((selector) => selector.kind === kind);
}

function addSelectorIds(
  selector: ParsedSetSelector,
  sources: Readonly<{ fleetIds: readonly AkuId[]; aliases: ReadonlyMap<AkumaAlias, AkuId>; dispatches: readonly DispatchFact[] }>,
  selected: Set<AkuId>,
  contractMembers: Set<AkuId>,
): void {
  if (selector.kind === "contract") {
    for (const dispatch of sources.dispatches) {
      if (dispatch.contractId !== selector.value) continue;
      selected.add(dispatch.akuId);
      contractMembers.add(dispatch.akuId);
    }
    return;
  }
  if (selector.kind === "glob") {
    for (const id of sources.fleetIds) if (matchesAkumaGlob(selector.value, id)) selected.add(id);
    return;
  }
  if (selector.kind === "alias") {
    const id = sources.aliases.get(selector.value);
    if (id === undefined) throw new TypeError(`unknown Akuma alias: ${selector.value}`);
    selected.add(id);
    return;
  }
  selected.add(selector.value);
}

async function contractMemberInWorld(path: WorldRoot, id: AkuId): Promise<boolean> {
  return await probeBornAkuma(path, id);
}

async function refuseForeignContractMembers(path: WorldRoot, ids: readonly AkuId[], contractMembers: ReadonlySet<AkuId>): Promise<void> {
  const foreign: AkuId[] = [];
  for (const id of ids) {
    if (contractMembers.has(id) && !await contractMemberInWorld(path, id)) foreign.push(id);
  }
  if (foreign.length > 0) throw new AkumaWorldScopeError({ kind: "akuma-not-in-world", ids: foreign, world: path });
}

export async function addressAkumaSet(input: AkumaSetAddressInput): Promise<Readonly<{
  path: WorldRoot;
  ids: readonly AkuId[];
}>> {
  const values = requireInput(input, "Akuma set address input");
  for (const key of Object.keys(values)) {
    if (!["path", "akuma", "repo"].includes(key)) {
      throw new TypeError(`Akuma set address input has unknown field: ${key}`);
    }
  }
  if (!Array.isArray(values.akuma) || values.akuma.length === 0) throw new TypeError("akuma must be a nonempty selector array");
  const path = nonblank(values.path, "path") as WorldRoot;
  const selectors = values.akuma.map(parseSetSelector);
  if (hasSelectorKind(selectors, "contract") && values.repo === undefined) {
    throw new TypeError("Contract Akuma selector requires repo");
  }
  const fleetIds = hasSelectorKind(selectors, "glob")
    ? idsFromFleet(await world(path).list())
    : [];
  const aliases = hasSelectorKind(selectors, "alias")
    ? new Map((await readAliases(path)).map((binding) => [binding.alias, binding.akuId]))
    : new Map<AkumaAlias, AkuId>();
  const dispatches = hasSelectorKind(selectors, "contract")
    ? await readDispatches(scopeForRepo(values.repo as Repo))
    : [];
  const selected = new Set<AkuId>();
  const contractMembers = new Set<AkuId>();
  const sources = { fleetIds, aliases, dispatches };
  for (const selector of selectors) addSelectorIds(selector, sources, selected, contractMembers);
  const ids = [...selected].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (ids.length === 0) throw new TypeError("Akuma selector snapshot is empty");
  await refuseForeignContractMembers(path, ids, contractMembers);
  return { path, ids };
}
