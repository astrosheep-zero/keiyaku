import { Akuma, listArchetypes, type AkumaList } from "../akuma/index.js";
import type { Settings } from "../settings.js";
import { Tasks, type TaskRow } from "../task/index.js";
import { listKeiyaku, type ContractBoard } from "./contract.js";
import { requireInput } from "./input.js";
import { Repo } from "./repo.js";
import { resolveNamedAddress } from "./address.js";
import type { WorldRoot } from "../world.js";

export type Catalog = Readonly<{
  root: WorldRoot | null;
  contracts: CatalogSection<ContractBoard>;
  tasks: CatalogSection<Readonly<{ root: string; rows: readonly TaskRow[] }>>;
  archetypes: CatalogSection<Readonly<{ rows: readonly string[] }>>;
  akuma: CatalogSection<AkumaList>;
}>;

export type CatalogSection<Value> =
  | Readonly<{ kind: "present"; value: Value }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "failed"; failure: Readonly<{ message: string }> }>;

export type CatalogInput = Readonly<{
  path: WorldRoot | null;
  settings: Settings;
  repo?: Repo;
  selector?: string;
}>;

function diagnostic(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/gu, " ").trim();
  return text.length <= 240 ? text : `${text.slice(0, 239)}…`;
}

async function contracts(repo?: Repo): Promise<CatalogSection<ContractBoard>> {
  if (repo === undefined) return { kind: "absent" };
  try {
    return { kind: "present", value: await listKeiyaku({ repo }) };
  } catch (error) {
    return { kind: "failed", failure: { message: diagnostic(error) } };
  }
}

async function tasks(path: WorldRoot | null): Promise<Catalog["tasks"]> {
  if (path === null) return { kind: "absent" };
  try {
    const source = Tasks.of(path);
    const result = await source.list({ selection: "all", scope: "world" });
    return result.kind === "accepted"
      ? { kind: "present", value: { root: source.root, rows: result.value } }
      : { kind: "failed", failure: { message: diagnostic(result) } };
  } catch (error) {
    return { kind: "failed", failure: { message: diagnostic(error) } };
  }
}

export function selectCatalog(catalog: Catalog, selector: string): Catalog {
  if (selector.startsWith("@") && catalog.contracts.kind === "failed") {
    throw new TypeError(`cannot resolve ${selector} while the Contract catalog failed`);
  }
  const address = resolveNamedAddress({
    path: catalog.root,
    selector,
    contracts: catalog.contracts.kind === "present" ? catalog.contracts.value.rows : [],
  });
  if (address.kind === "contract") {
    return {
      ...catalog,
      contracts: catalog.contracts.kind === "present"
        ? { kind: "present", value: { ...catalog.contracts.value, rows: catalog.contracts.value.rows.filter((row) => row.id === address.id) } }
        : catalog.contracts,
      akuma: catalog.akuma.kind === "present"
        ? { kind: "present", value: { ...catalog.akuma.value, rows: [] } }
        : catalog.akuma,
    };
  }
  return {
    ...catalog,
    contracts: catalog.contracts.kind === "present"
      ? { kind: "present", value: { ...catalog.contracts.value, rows: [] } }
      : catalog.contracts,
    akuma: catalog.akuma.kind === "present"
      ? { kind: "present", value: { ...catalog.akuma.value, rows: catalog.akuma.value.rows.filter((row) => row.id === address.id) } }
      : catalog.akuma,
  };
}

export async function listCatalog(input: CatalogInput): Promise<Catalog> {
  const values = requireInput(input, "Keiyaku.ls input");
  for (const key of Object.keys(values)) {
    if (!["path", "settings", "repo", "selector"].includes(key)) throw new TypeError(`Keiyaku.ls input has unknown field: ${key}`);
  }
  if (values.path !== null && (typeof values.path !== "string" || values.path.trim().length === 0)) {
    throw new TypeError("path must be a WorldRoot or null");
  }
  if (typeof values.settings !== "object" || values.settings === null
    || typeof (values.settings as { namespace?: unknown }).namespace !== "function") {
    throw new TypeError("settings must be a Settings");
  }
  if (values.selector !== undefined && (typeof values.selector !== "string" || values.selector.trim().length === 0)) {
    throw new TypeError("selector must be a nonblank string");
  }
  if (values.repo !== undefined && !(values.repo instanceof Repo)) throw new TypeError("repo must be a Repo");
  const path = values.path as WorldRoot | null;
  const settings = values.settings as Settings;
  const [contractSection, taskSection] = await Promise.all([contracts(values.repo as Repo | undefined), tasks(path)]);
  const catalog: Catalog = {
    root: path,
    contracts: contractSection,
    tasks: taskSection,
    archetypes: (() => {
      try { return { kind: "present" as const, value: { rows: listArchetypes({ settings }) } }; }
      catch (error) { return { kind: "failed" as const, failure: { message: diagnostic(error) } }; }
    })(),
    akuma: (() => {
      try { return path === null
        ? { kind: "absent" as const }
        : { kind: "present" as const, value: Akuma.of(path, settings).list() }; }
      catch (error) { return { kind: "failed" as const, failure: { message: diagnostic(error) } }; }
    })(),
  };
  return values.selector === undefined ? catalog : selectCatalog(catalog, values.selector as string);
}
