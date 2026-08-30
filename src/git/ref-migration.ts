import type { ContractId } from "../core/facts/types.js";
import { contractPhysicalName } from "./identity.js";
import { runGit, type GitRepository } from "./process.js";
import {
  CANDIDATE_PIN_REF_NAMESPACE,
  DELIVERY_REF_NAMESPACE,
  LEGACY_CANDIDATE_PIN_REF_NAMESPACE,
  LEGACY_DELIVERY_REF_NAMESPACE,
  readRef,
  type GitOid,
} from "./repository.js";

export type RefMigrationEffect = Readonly<{
  kind: "ref";
  name: string;
  before: GitOid | null;
  after: GitOid | null;
  action: "created" | "removed";
}>;

export type RefMigrationConflict = Readonly<{
  kind: "ref-migration-conflict";
  legacyRef: string;
  legacyOid: GitOid;
  currentRef: string;
  currentOid: GitOid;
}>;

export type RefMigrationResult = Readonly<{
  effects: readonly RefMigrationEffect[];
  lag: readonly RefMigrationConflict[];
}>;

type RefPair = Readonly<{ legacy: string; current: string }>;
type ObservedRefPair = RefPair & Readonly<{ legacyOid: GitOid | null; currentOid: GitOid | null }>;

export async function migrateContractCustodyRefs(
  repository: GitRepository,
  contract: ContractId,
): Promise<RefMigrationResult> {
  const leaf = contractPhysicalName(contract);
  const pairs = [
    {
      legacy: `${LEGACY_DELIVERY_REF_NAMESPACE}/${leaf}`,
      current: `${DELIVERY_REF_NAMESPACE}/${leaf}`,
    },
    {
      legacy: `${LEGACY_CANDIDATE_PIN_REF_NAMESPACE}/${leaf}`,
      current: `${CANDIDATE_PIN_REF_NAMESPACE}/${leaf}`,
    },
  ];
  const observed: ObservedRefPair[] = await Promise.all(
    pairs.map(async (pair) => {
      const [legacyOid, currentOid] = await Promise.all([
        readRef(repository, pair.legacy),
        readRef(repository, pair.current),
      ]);
      return { ...pair, legacyOid, currentOid };
    }),
  );
  const lag = observed.flatMap<RefMigrationConflict>((pair) =>
    pair.legacyOid !== null && pair.currentOid !== null && pair.currentOid !== pair.legacyOid
      ? [
          {
            kind: "ref-migration-conflict",
            legacyRef: pair.legacy,
            legacyOid: pair.legacyOid,
            currentRef: pair.current,
            currentOid: pair.currentOid,
          },
        ]
      : [],
  );
  if (lag.length > 0) return { effects: [], lag };

  const migrating = observed.filter(
    (pair): pair is ObservedRefPair & Readonly<{ legacyOid: GitOid }> => pair.legacyOid !== null,
  );
  if (migrating.length === 0) return { effects: [], lag: [] };

  const lines = ["start"];
  const effects: RefMigrationEffect[] = [];
  for (const pair of migrating) {
    if (pair.currentOid === null) {
      lines.push(`create ${pair.current} ${pair.legacyOid}`);
      effects.push({ kind: "ref", name: pair.current, before: null, after: pair.legacyOid, action: "created" });
    } else {
      lines.push(`verify ${pair.current} ${pair.currentOid}`);
    }
    lines.push(`delete ${pair.legacy} ${pair.legacyOid}`);
    effects.push({ kind: "ref", name: pair.legacy, before: pair.legacyOid, after: null, action: "removed" });
  }
  lines.push("prepare", "commit", "");
  await runGit(repository, ["update-ref", "--stdin", "--no-deref"], lines.join("\n"));
  return { effects, lag: [] };
}
