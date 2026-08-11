import { resolve } from "node:path";
import { Akuma, listArchetypes, type AkumaList } from "../akuma/index.js";
import type { Settings } from "../settings.js";
import { Tasks, type TaskRow } from "../task/index.js";
import { listKeiyaku, type ContractBoard } from "./contract.js";
import { requireInput } from "./input.js";
import { NoGitWorldError, Repo } from "./repo.js";
import { resolveNamedAddress } from "./address.js";

export type Catalog = Readonly<{
  root: string;
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
  path: string;
  settings: Settings;
  selector?: string;
}>;

function diagnostic(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/gu, " ").trim();
  return text.length <= 240 ? text : `${text.slice(0, 239)}…`;
}

async function contracts(path: string): Promise<CatalogSection<ContractBoard>> {
  try {
    const repo = Repo.at({ path });
    return { kind: "present", value: await listKeiyaku({ repo }) };
  } catch (error) {
    return error instanceof NoGitWorldError
      ? { kind: "absent" }
      : { kind: "failed", failure: { message: diagnostic(error) } };
  }
}

async function tasks(path: string): Promise<Catalog["tasks"]> {
  try {
    const source = Tasks.at({ path });
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
    if (!["path", "settings", "selector"].includes(key)) throw new TypeError(`Keiyaku.ls input has unknown field: ${key}`);
  }
  if (typeof values.path !== "string" || values.path.trim().length === 0) throw new TypeError("path must be a nonblank string");
  if (typeof values.settings !== "object" || values.settings === null
    || typeof (values.settings as { namespace?: unknown }).namespace !== "function") {
    throw new TypeError("settings must be a Settings");
  }
  if (values.selector !== undefined && (typeof values.selector !== "string" || values.selector.trim().length === 0)) {
    throw new TypeError("selector must be a nonblank string");
  }
  const path = resolve(values.path);
  const settings = values.settings as Settings;
  const [contractSection, taskSection] = await Promise.all([contracts(path), tasks(path)]);
  const catalog: Catalog = {
    root: path,
    contracts: contractSection,
    tasks: taskSection,
    archetypes: (() => {
      try { return { kind: "present" as const, value: { rows: listArchetypes({ settings }) } }; }
      catch (error) { return { kind: "failed" as const, failure: { message: diagnostic(error) } }; }
    })(),
    akuma: (() => {
      try { return { kind: "present" as const, value: Akuma.at({ path, settings }).list() }; }
      catch (error) { return { kind: "failed" as const, failure: { message: diagnostic(error) } }; }
    })(),
  };
  return values.selector === undefined ? catalog : selectCatalog(catalog, values.selector as string);
}
