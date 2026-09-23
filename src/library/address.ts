/** @architectureCompositionRoot */
import { readAliases, type AliasBinding } from "../alias/index.js";
import { createAkumaProduct } from "../akuma/akuma-product.js";
import { akumaAddressability, requireBornAkuma } from "../akuma/akuma-probe.js";
import { parseAkuId, type AkuId } from "../akuma/identity.js";
import { contractId } from "../core/facts/types.js";
import { readDispatches } from "../dispatch/index.js";
import {
  matchesAkumaGlob,
  parseReadableAkumaAlias,
  parseAkumaGlob,
  type AkumaAlias,
  type AkumaGlob,
} from "../identity/selector.js";
import { World, type WorldRoot } from "../world.js";
import type { KanshiReport, Section } from "../kanshi/index.js";
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

type UncheckedAkumaAddressInput = Readonly<{
  path: unknown;
  akuma: unknown;
  repo?: unknown;
}>;

export type AkumaWorldScopeRefusal = Readonly<{
  kind: "akuma-not-in-world";
  ids: readonly AkuId[];
  world: WorldRoot;
}>;

export type AkumaAddressRefusal =
  | Readonly<{ kind: "akuma-alias-not-found"; alias: AkumaAlias }>
  | Readonly<{ kind: "invalid-akuma"; selector: string }>;

export class AkumaAddressError extends Error {
  constructor(readonly refusal: AkumaAddressRefusal) {
    super(
      refusal.kind === "akuma-alias-not-found"
        ? `unknown Akuma alias: ${refusal.alias}`
        : `invalid Akuma: ${refusal.selector}`,
    );
    this.name = "AkumaAddressError";
  }
}

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

function parseAddressAlias(selector: string): AkumaAlias {
  try {
    return parseReadableAkumaAlias(selector);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new AkumaAddressError({ kind: "invalid-akuma", selector });
  }
}

function parseAddressId(selector: string): ReturnType<typeof parseAkuId> {
  try {
    return parseAkuId(selector);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new AkumaAddressError({ kind: "invalid-akuma", selector });
  }
}

async function directId(path: WorldRoot, selector: string): Promise<AkuId> {
  if (selector.startsWith("@")) {
    const alias = parseAddressAlias(selector);
    const resolved = (await readAliases(path)).find((binding) => binding.alias === alias)?.akuId ?? null;
    if (resolved === null) throw new AkumaAddressError({ kind: "akuma-alias-not-found", alias });
    return resolved;
  }
  return parseAddressId(selector).id;
}

export type NamedAddress =
  | Readonly<{ kind: "contract"; id: ReturnType<typeof contractId> }>
  | Readonly<{ kind: "akuma"; id: AkuId }>;

export type NamedAddressInput = Readonly<{
  selector: string;
  report: KanshiReport;
  aliases: Section<readonly AliasBinding[]>;
}>;

export function resolveNamedAddress(input: NamedAddressInput): NamedAddress {
  const selector = nonblank(input.selector, "selector");
  if (selector.startsWith("kei/")) return { kind: "contract", id: contractId(selector) };
  if (selector.startsWith("aku/")) return { kind: "akuma", id: parseAddressId(selector).id };
  const alias = parseAddressAlias(selector);
  const contractMatches = (input.report.contracts.kind === "present" ? input.report.contracts.value.rows : []).filter(
    (row) =>
      row.disposition === "active" &&
      row.workspace === "worktree" &&
      row.worktreePath !== null &&
      `@${row.id.slice("kei/".length)}` === alias,
  );
  const aliasId =
    input.aliases.kind === "present"
      ? (input.aliases.value.find((binding) => binding.alias === alias)?.akuId ?? null)
      : null;
  if (contractMatches.length > 0 && aliasId !== null)
    throw new TypeError(`ambiguous selector matches Contract and Akuma: ${selector}`);
  // A readable alias selects its Akuma independently. Contract composition can
  // enrich the subsequent observation, but cannot erase this core address.
  if (aliasId !== null) return { kind: "akuma", id: aliasId };
  if (contractMatches.length === 1) return { kind: "contract", id: contractMatches[0]!.id };
  if (contractMatches.length > 1) throw new TypeError(`ambiguous Contract selector: ${selector}`);
  if (input.report.contracts.kind === "failed") {
    throw new TypeError("cannot resolve a named selector while the Contract world is failed");
  }
  if (input.aliases.kind === "failed") {
    throw new TypeError("cannot resolve a named selector while Alias authority is failed");
  }
  throw new AkumaAddressError({ kind: "akuma-alias-not-found", alias });
}

type AddressedAkuma = Readonly<{
  path: WorldRoot;
  id: AkuId;
}>;

/**
 * Resolves one selector to a complete identity without proving it born. The
 * caller is a forwarding boundary: the parent Fleet answers for the target, so
 * this process must not read its own Heart files to decide.
 */
export async function resolveAkuma(input: UncheckedAkumaAddressInput): Promise<AddressedAkuma> {
  const values = requireInput(input, "Akuma address input");
  for (const key of Object.keys(values)) {
    if (!["path", "akuma", "repo"].includes(key)) {
      throw new TypeError(`Akuma address input has unknown field: ${key}`);
    }
  }
  if (values.repo !== undefined) scopeForRepo(values.repo);
  const path = await World.prove(nonblank(values.path, "path"));
  const id = await directId(path, nonblank(values.akuma, "akuma"));
  return { path, id };
}

/**
 * Resolves one selector against this World, where a local caller is answered
 * for the target's birth by the one addressability normalization.
 */
export async function addressAkuma(input: UncheckedAkumaAddressInput): Promise<AddressedAkuma> {
  const addressed = await resolveAkuma(input);
  await requireBornAkuma(addressed.path, addressed.id);
  return addressed;
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
  if (selector.startsWith("@")) return { kind: "alias", value: parseAddressAlias(selector) };
  return { kind: "direct", value: parseAddressId(selector).id };
}

function hasSelectorKind(selectors: readonly ParsedSetSelector[], kind: ParsedSetSelector["kind"]): boolean {
  return selectors.some((selector) => selector.kind === kind);
}

function addSelectorIds(
  selector: ParsedSetSelector,
  sources: Readonly<{
    fleetIds: readonly AkuId[];
    aliases: ReadonlyMap<AkumaAlias, AkuId>;
    dispatches: readonly DispatchFact[];
  }>,
  selected: Set<AkuId>,
  contractMembers: Set<AkuId>,
  explicit: Set<AkuId>,
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
    if (id === undefined) throw new AkumaAddressError({ kind: "akuma-alias-not-found", alias: selector.value });
    selected.add(id);
    explicit.add(id);
    return;
  }
  selected.add(selector.value);
  explicit.add(selector.value);
}

async function contractMemberInWorld(path: WorldRoot, id: AkuId): Promise<boolean> {
  // A dispatched physical member stays selected when its Heart cannot be read:
  // the World, not this reader, remains the authority on its membership.
  return (await akumaAddressability(path, id)).kind !== "absent";
}

async function refuseForeignContractMembers(
  path: WorldRoot,
  ids: readonly AkuId[],
  contractMembers: ReadonlySet<AkuId>,
): Promise<void> {
  const foreign: AkuId[] = [];
  for (const id of ids) {
    if (contractMembers.has(id) && !(await contractMemberInWorld(path, id))) foreign.push(id);
  }
  if (foreign.length > 0) throw new AkumaWorldScopeError({ kind: "akuma-not-in-world", ids: foreign, world: path });
}

type ResolvedAkumaSet = Readonly<{
  path: WorldRoot;
  /** The same set in the caller's selector order, for surfaces that name the selection as chosen. */
  orderedIds: readonly AkuId[];
  /** The canonical order of the selected set. */
  ids: readonly AkuId[];
  contractMembers: ReadonlySet<AkuId>;
  explicit: ReadonlySet<AkuId>;
}>;

function canonicalAkumaOrder(selected: ReadonlySet<AkuId>): readonly AkuId[] {
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
  const fleetIds = hasSelectorKind(selectors, "glob")
    ? (await createAkumaProduct(path).listComplete()).rows.map((row) => row.id)
    : [];
  const aliases = hasSelectorKind(selectors, "alias")
    ? new Map((await readAliases(path)).map((binding) => [binding.alias, binding.akuId]))
    : new Map<AkumaAlias, AkuId>();
  const dispatches = hasSelectorKind(selectors, "contract")
    ? await readDispatches(scopeForRepo(values.repo as Repo))
    : [];
  const selected = new Set<AkuId>();
  const contractMembers = new Set<AkuId>();
  const explicit = new Set<AkuId>();
  const sources = { fleetIds, aliases, dispatches };
  for (const selector of selectors) addSelectorIds(selector, sources, selected, contractMembers, explicit);
  return { path, orderedIds: [...selected], ids: canonicalAkumaOrder(selected), contractMembers, explicit };
}

/**
 * Resolves a selector set to complete identities without proving any born. The
 * caller is a forwarding boundary, the parent Fleet owns the answer, and no
 * member's Heart is read here.
 */
export async function resolveAkumaSet(
  input: UncheckedAkumaAddressInput,
): Promise<Readonly<{ path: WorldRoot; ids: readonly AkuId[]; orderedIds: readonly AkuId[] }>> {
  const resolved = await readAkumaSet(input);
  return { path: resolved.path, ids: resolved.ids, orderedIds: resolved.orderedIds };
}

export async function addressAkumaSet(
  input: UncheckedAkumaAddressInput,
): Promise<Readonly<{ path: WorldRoot; ids: readonly AkuId[]; orderedIds: readonly AkuId[] }>> {
  const resolved = await readAkumaSet(input);
  for (const id of resolved.explicit) await requireBornAkuma(resolved.path, id);
  await refuseForeignContractMembers(resolved.path, resolved.ids, resolved.contractMembers);
  return { path: resolved.path, ids: resolved.ids, orderedIds: resolved.orderedIds };
}
