/** @architectureCompositionRoot */
import { type AkumaList } from "../akuma/akuma.js";
import { createAkumaProduct } from "../akuma/akuma-product.js";
import { listArchetypeDefinitions, type ArchetypeCatalogRow } from "../akuma/archetype.js";
import type { TaskRow } from "../task/index.js";
import { observeTaskCatalog } from "../task/catalog.js";
import { listContractCatalogue, type ContractCatalogue } from "./contract.js";
import { requireInput } from "./input.js";
import { Repo } from "./repo.js";
import { World, type WorldRoot } from "../world.js";

export type CatalogQuery =
  | Readonly<{ kind: "tasks"; namespace?: readonly string[]; limit?: number }>
  | Readonly<{ kind: "contracts"; limit?: number }>
  | Readonly<{ kind: "archetypes" }>
  | Readonly<{ kind: "akuma"; archetype?: string; limit?: number }>;

export type CatalogInput =
  | Readonly<{ query: Extract<CatalogQuery, { kind: "tasks" }>; path: WorldRoot }>
  | Readonly<{ query: Extract<CatalogQuery, { kind: "contracts" }>; repo: Repo }>
  | Readonly<{ query: Extract<CatalogQuery, { kind: "archetypes" }>; path?: WorldRoot; home?: string }>
  | Readonly<{ query: Extract<CatalogQuery, { kind: "akuma" }>; path: WorldRoot }>;

export type Catalog =
  | Readonly<{ kind: "tasks"; root: WorldRoot; rows: readonly TaskRow[]; hasMore: boolean }>
  | Readonly<{
      kind: "contracts";
      root: string;
      state: string | null;
      observedAt: string;
      rows: ContractCatalogue["rows"];
      hasMore: boolean;
    }>
  | Readonly<{ kind: "archetypes"; rows: readonly ArchetypeCatalogRow[] }>
  | Readonly<{
      kind: "akuma";
      root: WorldRoot;
      archetype: string | null;
      observedAt: string;
      rows: AkumaList["rows"];
      searched: readonly string[];
      hasMore: boolean;
    }>;

function optionalHome(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("home must be a nonblank string");
  }
  return value;
}

async function worldRoot(value: unknown): Promise<WorldRoot> {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError("path must be a WorldRoot");
  return await World.prove(value);
}

function taskQueryValue(query: Readonly<Record<string, unknown>>): CatalogQuery {
  if (query.namespace !== undefined && !Array.isArray(query.namespace))
    throw new TypeError("Keiyaku.ls Task namespace must be an array");
  if (query.limit !== undefined && typeof query.limit !== "number")
    throw new TypeError("Keiyaku.ls Task limit must be a number");
  return {
    kind: "tasks",
    ...(query.namespace === undefined ? {} : { namespace: query.namespace as readonly string[] }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  };
}

type CatalogQueryKind = CatalogQuery["kind"];

const catalogQueryKeys: Readonly<Record<CatalogQueryKind, readonly string[]>> = {
  tasks: ["kind", "namespace", "limit"],
  contracts: ["kind", "limit"],
  archetypes: ["kind"],
  akuma: ["kind", "archetype", "limit"],
};

function catalogQueryKind(value: unknown): CatalogQueryKind {
  if (value === "tasks" || value === "contracts" || value === "archetypes" || value === "akuma") return value;
  throw new TypeError("Keiyaku.ls query kind is invalid");
}

function assertCatalogQueryKeys(query: Readonly<Record<string, unknown>>, kind: CatalogQueryKind): void {
  for (const key of Object.keys(query)) {
    if (!catalogQueryKeys[kind].includes(key)) throw new TypeError(`Keiyaku.ls query has unknown field: ${key}`);
  }
}

function akumaQueryValue(query: Readonly<Record<string, unknown>>): CatalogQuery {
  if (query.archetype !== undefined && typeof query.archetype !== "string") {
    throw new TypeError("Keiyaku.ls Akuma name must be a string");
  }
  if (query.limit !== undefined && typeof query.limit !== "number")
    throw new TypeError("Keiyaku.ls Akuma limit must be a number");
  return {
    kind: "akuma",
    ...(query.archetype === undefined ? {} : { archetype: query.archetype }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  };
}

function contractQueryValue(query: Readonly<Record<string, unknown>>): CatalogQuery {
  if (query.limit !== undefined && typeof query.limit !== "number")
    throw new TypeError("Keiyaku.ls Contract limit must be a number");
  return { kind: "contracts", ...(query.limit === undefined ? {} : { limit: query.limit }) };
}

function queryValue(value: unknown): CatalogQuery {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Keiyaku.ls query must be an object");
  }
  const query = value as Readonly<Record<string, unknown>>;
  const kind = catalogQueryKind(query.kind);
  assertCatalogQueryKeys(query, kind);
  if (kind === "tasks") return taskQueryValue(query);
  if (kind === "contracts") return contractQueryValue(query);
  if (kind === "archetypes") return { kind };
  return akumaQueryValue(query);
}

export async function listCatalog(input: CatalogInput): Promise<Catalog> {
  const values = requireInput(input, "Keiyaku.ls input");
  const query = queryValue(values.query);
  const allowed =
    query.kind === "contracts"
      ? ["query", "repo"]
      : query.kind === "archetypes"
        ? ["query", "path", "home"]
        : ["query", "path"];
  for (const key of Object.keys(values)) {
    if (!allowed.includes(key)) throw new TypeError(`Keiyaku.ls input has unknown field: ${key}`);
  }
  if (query.kind === "contracts") {
    if (!(values.repo instanceof Repo)) throw new TypeError("repo must be a Repo");
    const catalogue = await listContractCatalogue({
      repo: values.repo,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
    return { kind: "contracts", ...catalogue };
  }
  if (query.kind === "archetypes") {
    const path = values.path === undefined ? undefined : await worldRoot(values.path);
    const home = optionalHome(values.home);
    return {
      kind: "archetypes",
      rows: await listArchetypeDefinitions({
        ...(path === undefined ? {} : { project: path }),
        ...(home === undefined ? {} : { home }),
      }),
    };
  }
  const path = await worldRoot(values.path);
  if (query.kind === "tasks") {
    return { kind: "tasks", root: path, ...(await observeTaskCatalog(path, query)) };
  }
  const listed = await createAkumaProduct(path).list({
    ...(query.archetype === undefined ? {} : { archetype: query.archetype }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  });
  return {
    kind: "akuma",
    root: path,
    archetype: query.archetype ?? null,
    observedAt: listed.observedAt,
    rows: listed.rows,
    searched: listed.searched,
    hasMore: listed.hasMore,
  };
}
