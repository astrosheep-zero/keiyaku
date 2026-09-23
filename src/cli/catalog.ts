import type { AkumaList } from "../akuma/akuma.js";
import type { ArchetypeCatalogRow } from "../akuma/archetype.js";
import type { TaskRow } from "../task/index.js";
import type { ContractRow } from "../library/contract.js";
import type { WorldRoot } from "../world.js";

export type CatalogQuery =
  | Readonly<{ kind: "tasks"; namespace?: readonly string[]; limit?: number }>
  | Readonly<{ kind: "contracts"; limit?: number }>
  | Readonly<{ kind: "archetypes"; limit?: number }>
  | Readonly<{ kind: "akuma"; archetype?: string; limit?: number }>;

export type Catalog =
  | Readonly<{ kind: "tasks"; root: WorldRoot; rows: readonly TaskRow[]; hasMore: boolean }>
  | Readonly<{
      kind: "contracts";
      root: string;
      state: string | null;
      observedAt: string;
      rows: readonly ContractRow[];
      hasMore: boolean;
    }>
  | Readonly<{ kind: "archetypes"; rows: readonly ArchetypeCatalogRow[]; hasMore: boolean }>
  | Readonly<{
      kind: "akuma";
      root: WorldRoot;
      archetype: string | null;
      observedAt: string;
      rows: AkumaList["rows"];
      searched: readonly string[];
      hasMore: boolean;
    }>;
