/** @architectureCompositionRoot */
import { KeiyakuError } from "../errors.js";
import { readAliases, type AliasBinding } from "../alias/index.js";
import { readAkumaCompleteRoster } from "../akuma/akuma.js";
import { akumaAddressability, requireBornAkuma } from "../akuma/akuma-probe.js";
import { parseAkumaId, type AkumaId } from "../akuma/identity.js";
import { contractId } from "../core/facts/types.js";
import { readDispatches } from "../dispatch/index.js";
import {
  matchesAkumaGlob,
  parseReadableAkumaAlias,
  parseAkumaGlob,
  type AkumaAlias,
  type AkumaGlob,
} from "../identity/selector.js";
import type { Section } from "../kanshi/index.js";
import type { ContractMembership } from "../protocol/read/status.js";
import { World, type WorldRoot } from "../world.js";
import { matchContractCandidates, readContractCandidates } from "./contract-address.js";
import { requireInput } from "./input.js";
import { scopeForRepo, type Repo } from "./repo.js";

export type AkumaAddressInput = Readonly<{
  akuma: string;
  repo?: Repo;
}>;

export type AkumaSetAddressInput = Readonly<{
  akuma: readonly string[];
  repo?: Repo;
}>;

type UncheckedAkumaAddressInput = Readonly<{
  path: unknown;
  akuma: unknown;
  repo?: unknown;
}>;

export type AkumaWorldScopeRefusal = Readonly<{
  kind: "akuma-not-in-world";
  ids: readonly AkumaId[];
  world: WorldRoot;
}>;

export type AkumaAddressRefusal =
  | Readonly<{ kind: "akuma-alias-not-found"; alias: AkumaAlias }>
  | Readonly<{ kind: "invalid-akuma"; selector: string }>;

export class AkumaAddressError extends KeiyakuError {
  constructor(readonly refusal: AkumaAddressRefusal) {
    super(
      "internal",
      refusal.kind === "akuma-alias-not-found"
        ? `unknown Akuma alias: ${refusal.alias}`
        : `invalid Akuma: ${refusal.selector}`,
    );
  }
}

export class AkumaWorldScopeError extends KeiyakuError {
  readonly refusal: AkumaWorldScopeRefusal;

  constructor(refusal: AkumaWorldScopeRefusal) {
    super("internal", `akuma-not-in-world ${refusal.world} ${refusal.ids.join(" ")}`);
    this.refusal = refusal;
  }
}

function nonblank(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} must be a nonblank string`);
  return value;
}

function parseAddressAlias(selector: string): AkumaAlias {
  try {
    return parseReadableAkumaAlias(selector);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new AkumaAddressError({ kind: "invalid-akuma", selector });
  }
}

function parseAddressId(selector: string): ReturnType<typeof parseAkumaId> {
  try {
    return parseAkumaId(selector);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new AkumaAddressError({ kind: "invalid-akuma", selector });
  }
}

async function directId(path: WorldRoot, selector: string): Promise<AkumaId> {
  if (selector.startsWith("@")) {
    const alias = parseAddressAlias(selector);
    const resolved = (await readAliases(path)).find((binding) => binding.alias === alias)?.akumaId ?? null;
    if (resolved === null) throw new AkumaAddressError({ kind: "akuma-alias-not-found", alias });
    return resolved;
  }
  return parseAddressId(selector).id;
}

export type NamedAddress =
  | Readonly<{ kind: "contract"; id: ReturnType<typeof contractId> }>
  | Readonly<{ kind: "akuma"; id: AkumaId }>;

/** The frozen authority a named selector is adjudicated against. */
export type NamedAddressAuthority = Readonly<{
  contracts: Section<readonly ContractMembership[]>;
  aliases: Section<readonly AliasBinding[]>;
}>;

export type NamedAddressInput = NamedAddressAuthority & Readonly<{ selector: string }>;

async function observe<T>(read: () => Promise<T>): Promise<Section<T>> {
  try {
    return { kind: "present", value: await read() };
  } catch (error) {
    return { kind: "failed", failure: { message: error instanceof Error ? error.message : String(error) } };
  }
}

/** Freeze only the named Contract journals and Alias authority in this invocation. */
export async function observeNamedAddress(
  input: Readonly<{ world: WorldRoot | null; repo: Repo | null; selectors: readonly string[] }>,
): Promise<NamedAddressAuthority> {
  const { world, repo } = input;
  return {
    contracts:
      repo === null
        ? { kind: "absent" }
        : await observe(() =>
            readContractCandidates(
              scopeForRepo(repo),
              input.selectors.flatMap((selector) => {
                if (!selector.startsWith("@")) return [];
                try {
                  return [contractId(`kei/${selector.slice(1)}`)];
                } catch {
                  return [];
                }
              }),
            ),
          ),
    aliases: world === null ? { kind: "absent" } : await observe(() => readAliases(world)),
  };
}

export function resolveNamedAddress(input: NamedAddressInput): NamedAddress {
  const selector = nonblank(input.selector, "selector");
  if (selector.startsWith("kei/")) return { kind: "contract", id: contractId(selector) };
  if (selector.startsWith("aku/")) return { kind: "akuma", id: parseAddressId(selector).id };
  const alias = parseAddressAlias(selector);
  const contractMatches = matchContractCandidates(input.contracts.kind === "present" ? input.contracts.value : [], {
    selector: alias,
  });
  const aliasId =
    input.aliases.kind === "present"
      ? (input.aliases.value.find((binding) => binding.alias === alias)?.akumaId ?? null)
      : null;
  if (contractMatches.length > 0 && aliasId !== null)
    throw new TypeError(`ambiguous selector matches Contract and Akuma: ${selector}`);
  // A readable alias selects its Akuma independently. Contract composition can
  // enrich the subsequent observation, but cannot erase this core address.
  if (aliasId !== null) return { kind: "akuma", id: aliasId };
  if (contractMatches.length === 1) return { kind: "contract", id: contractMatches[0]!.id };
  if (contractMatches.length > 1) throw new TypeError(`ambiguous Contract selector: ${selector}`);
  if (input.contracts.kind === "failed")
    throw new TypeError("cannot resolve a named selector while the Contract world is failed");
  if (input.aliases.kind === "failed")
    throw new TypeError("cannot resolve a named selector while Alias authority is failed");
  throw new AkumaAddressError({ kind: "akuma-alias-not-found", alias });
}

type AddressedAkuma = Readonly<{
  path: WorldRoot;
  id: AkumaId;
}>;

/** Resolve one selector and prove its birth through the native addressability owner. */
export async function addressAkuma(input: UncheckedAkumaAddressInput): Promise<AddressedAkuma> {
  const values = requireInput(input, "Akuma address input");
  for (const key of Object.keys(values)) {
    if (!["path", "akuma", "repo"].includes(key)) {
      throw new TypeError(`Akuma address input has unknown field: ${key}`);
    }
  }
  if (values.repo !== undefined) scopeForRepo(values.repo);
  const path = await World.prove(nonblank(values.path, "path"));
  const id = await directId(path, nonblank(values.akuma, "akuma"));
  await requireBornAkuma(path, id);
  return { path, id };
}

type ParsedSetSelector =
  | Readonly<{ kind: "contract"; value: ReturnType<typeof contractId> }>
  | Readonly<{ kind: "glob"; value: AkumaGlob }>
  | Readonly<{ kind: "alias"; value: AkumaAlias }>
  | Readonly<{ kind: "direct"; value: AkumaId }>;
type DispatchFact = Awaited<ReturnType<typeof readDispatches>>[number];

function parseSetSelector(raw: string): ParsedSetSelector {
  const selector = nonblank(raw, "akuma selector");
  if (selector.startsWith("kei/")) return { kind: "contract", value: contractId(selector) };
  if (selector.includes("*")) return { kind: "glob", value: parseAkumaGlob(selector) };
  if (selector.startsWith("@")) return { kind: "alias", value: parseAddressAlias(selector) };
  return { kind: "direct", value: parseAddressId(selector).id };
}

function hasSelectorKind(selectors: readonly ParsedSetSelector[], kind: ParsedSetSelector["kind"]): boolean {
  return selectors.some((selector) => selector.kind === kind);
}

function addSelectorIds(
  selector: ParsedSetSelector,
  sources: Readonly<{
    rosterIds: readonly AkumaId[];
    aliases: ReadonlyMap<AkumaAlias, AkumaId>;
    dispatches: readonly DispatchFact[];
  }>,
  selected: Set<AkumaId>,
  contractMembers: Set<AkumaId>,
  explicit: Set<AkumaId>,
): void {
  if (selector.kind === "contract") {
    for (const dispatch of sources.dispatches) {
      if (dispatch.contractId !== selector.value) continue;
      selected.add(dispatch.akumaId);
      contractMembers.add(dispatch.akumaId);
    }
    return;
  }
  if (selector.kind === "glob") {
    for (const id of sources.rosterIds) if (matchesAkumaGlob(selector.value, id)) selected.add(id);
    return;
  }
  if (selector.kind === "alias") {
    const id = sources.aliases.get(selector.value);
    if (id === undefined) throw new AkumaAddressError({ kind: "akuma-alias-not-found", alias: selector.value });
    selected.add(id);
    explicit.add(id);
    return;
  }
  selected.add(selector.value);
  explicit.add(selector.value);
}

async function contractMemberInWorld(path: WorldRoot, id: AkumaId): Promise<boolean> {
  // A dispatched physical member stays selected when its Heart cannot be read:
  // the World, not this reader, remains the authority on its membership.
  return (await akumaAddressability(path, id)).kind !== "absent";
}

async function refuseForeignContractMembers(
  path: WorldRoot,
  ids: readonly AkumaId[],
  contractMembers: ReadonlySet<AkumaId>,
): Promise<void> {
  const foreign: AkumaId[] = [];
  for (const id of ids) {
    if (contractMembers.has(id) && !(await contractMemberInWorld(path, id))) foreign.push(id);
  }
  if (foreign.length > 0) throw new AkumaWorldScopeError({ kind: "akuma-not-in-world", ids: foreign, world: path });
}

type ResolvedAkumaSet = Readonly<{
  path: WorldRoot;
  /** The same set in the caller's selector order, for surfaces that name the selection as chosen. */
  orderedIds: readonly AkumaId[];
  /** The canonical order of the selected set. */
  ids: readonly AkumaId[];
  contractMembers: ReadonlySet<AkumaId>;
  explicit: ReadonlySet<AkumaId>;
}>;

function canonicalAkumaOrder(selected: ReadonlySet<AkumaId>): readonly AkumaId[] {
  const ids = [...selected].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (ids.length === 0) throw new TypeError("Akuma selector snapshot is empty");
  return ids;
}

async function readAkumaSet(input: UncheckedAkumaAddressInput): Promise<ResolvedAkumaSet> {
  const values = requireInput(input, "Akuma set address input");
  for (const key of Object.keys(values)) {
    if (!["path", "akuma", "repo"].includes(key)) {
      throw new TypeError(`Akuma set address input has unknown field: ${key}`);
    }
  }
  if (!Array.isArray(values.akuma) || values.akuma.length === 0)
    throw new TypeError("akuma must be a nonempty selector array");
  const path = await World.prove(nonblank(values.path, "path"));
  const selectors = values.akuma.map(parseSetSelector);
  if (hasSelectorKind(selectors, "contract") && values.repo === undefined) {
    throw new TypeError("Contract Akuma selector requires repo");
  }
  const rosterIds = hasSelectorKind(selectors, "glob")
    ? (await readAkumaCompleteRoster(path)).rows.map((row) => row.id)
    : [];
  const aliases = hasSelectorKind(selectors, "alias")
    ? new Map((await readAliases(path)).map((binding) => [binding.alias, binding.akumaId]))
    : new Map<AkumaAlias, AkumaId>();
  const dispatches = hasSelectorKind(selectors, "contract")
    ? await readDispatches(scopeForRepo(values.repo as Repo))
    : [];
  const selected = new Set<AkumaId>();
  const contractMembers = new Set<AkumaId>();
  const explicit = new Set<AkumaId>();
  const sources = { rosterIds, aliases, dispatches };
  for (const selector of selectors) addSelectorIds(selector, sources, selected, contractMembers, explicit);
  return { path, orderedIds: [...selected], ids: canonicalAkumaOrder(selected), contractMembers, explicit };
}

export async function addressAkumaSet(
  input: UncheckedAkumaAddressInput,
): Promise<Readonly<{ path: WorldRoot; ids: readonly AkumaId[]; orderedIds: readonly AkumaId[] }>> {
  const resolved = await readAkumaSet(input);
  for (const id of resolved.explicit) await requireBornAkuma(resolved.path, id);
  await refuseForeignContractMembers(resolved.path, resolved.ids, resolved.contractMembers);
  return { path: resolved.path, ids: resolved.ids, orderedIds: resolved.orderedIds };
}
