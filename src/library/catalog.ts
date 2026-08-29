import { Akuma, type AkumaList } from "../akuma/akuma.js";
import { listArchetypeDefinitions, type ArchetypeCatalogRow } from "../akuma/archetype.js";
import type { TaskRow } from "../task/index.js";
import { observeTaskCatalogRows } from "../task/catalog.js";
import { listKeiyaku, type ContractBoard } from "./contract.js";
import { requireInput } from "./input.js";
import { Repo } from "./repo.js";
import { World, type WorldRoot } from "../world.js";

export type CatalogQuery =
  | Readonly<{ kind: "tasks"; namespace?: readonly string[] }>
  | Readonly<{ kind: "contracts" }>
  | Readonly<{ kind: "archetypes" }>
  | Readonly<{ kind: "akuma"; archetype?: string }>;

export type CatalogInput =
  | Readonly<{ query: Extract<CatalogQuery, { kind: "tasks" }>; path: WorldRoot }>
  | Readonly<{ query: Extract<CatalogQuery, { kind: "contracts" }>; repo: Repo }>
  | Readonly<{ query: Extract<CatalogQuery, { kind: "archetypes" }>; home?: string }>
  | Readonly<{ query: Extract<CatalogQuery, { kind: "akuma" }>; path: WorldRoot }>;

export type Catalog =
  | Readonly<{ kind: "tasks"; root: WorldRoot; rows: readonly TaskRow[] }>
  | Readonly<{ kind: "contracts"; root: string; state: string | null; observedAt: string; rows: ContractBoard["rows"] }>
  | Readonly<{ kind: "archetypes"; rows: readonly ArchetypeCatalogRow[] }>
  | Readonly<{
      kind: "akuma";
      root: WorldRoot;
      archetype: string | null;
      observedAt: string;
      rows: AkumaList["rows"];
      searched: readonly string[];
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
  return {
    kind: "tasks",
    ...(query.namespace === undefined ? {} : { namespace: query.namespace as readonly string[] }),
  };
}

function queryValue(value: unknown): CatalogQuery {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Keiyaku.ls query must be an object");
  }
  const query = value as Readonly<Record<string, unknown>>;
  if (query.kind !== "tasks" && query.kind !== "contracts" && query.kind !== "archetypes" && query.kind !== "akuma") {
    throw new TypeError("Keiyaku.ls query kind is invalid");
  }
  for (const key of Object.keys(query)) {
    if (
      key !== "kind" &&
      !(query.kind === "akuma" && key === "archetype") &&
      !(query.kind === "tasks" && key === "namespace")
    ) {
      throw new TypeError(`Keiyaku.ls query has unknown field: ${key}`);
    }
  }
  if (query.kind === "tasks") return taskQueryValue(query);
  if (query.kind !== "akuma") return { kind: query.kind };
  if (query.archetype !== undefined && typeof query.archetype !== "string") {
    throw new TypeError("Keiyaku.ls Akuma name must be a string");
  }
  return { kind: "akuma", ...(query.archetype === undefined ? {} : { archetype: query.archetype }) };
}

export async function listCatalog(input: CatalogInput): Promise<Catalog> {
  const values = requireInput(input, "Keiyaku.ls input");
  const query = queryValue(values.query);
  const allowed =
    query.kind === "contracts"
      ? ["query", "repo"]
      : query.kind === "archetypes"
        ? ["query", "home"]
        : ["query", "path"];
  for (const key of Object.keys(values)) {
    if (!allowed.includes(key)) throw new TypeError(`Keiyaku.ls input has unknown field: ${key}`);
  }
  if (query.kind === "contracts") {
    if (!(values.repo instanceof Repo)) throw new TypeError("repo must be a Repo");
    const board = await listKeiyaku({ repo: values.repo });
    return { kind: "contracts", root: board.root, state: board.state, observedAt: board.observedAt, rows: board.rows };
  }
  if (query.kind === "archetypes") {
    const home = optionalHome(values.home);
    return {
      kind: "archetypes",
      rows: await listArchetypeDefinitions(home === undefined ? {} : { home }),
    };
  }
  const path = await worldRoot(values.path);
  if (query.kind === "tasks") {
    return { kind: "tasks", root: path, rows: await observeTaskCatalogRows(path, query.namespace) };
  }
  const listed = await Akuma.of(path).list(query.archetype === undefined ? undefined : { archetype: query.archetype });
  return {
    kind: "akuma",
    root: path,
    archetype: query.archetype ?? null,
    observedAt: listed.observedAt,
    rows: listed.rows,
    searched: listed.searched,
  };
}
