/** @architectureCompositionRoot */
import { tryAcquireAliasCustody, readAliases } from "../alias/index.js";
import { knownAkuma, type KnownAkuma } from "../akuma/akuma.js";
import type { DispatchAssociation } from "../akuma/dispatch-association.js";
import type { AkuId } from "../akuma/identity.js";
import { boundedMap } from "../akuma/read-pool.js";
import {
  readRetentionCandidate,
  retentionCandidateBound,
  retentionNow,
  retireInactiveAkuma,
  type AkumaRetentionCandidate,
} from "../akuma/retention.js";
import { observeDispatchAssociations } from "../dispatch/index.js";
import { observeContractAt } from "../git/observe.js";
import { isPrivateStateSeatContention, withPrivateStatePublicationSeat } from "../git/private-state-seat.js";
import { withGitDecodeChannel } from "../git/read-observation.js";
import { NoGitWorldError, repositoryAt } from "../git/repository.js";
import type { WorldRoot } from "../world.js";

type Repository = Parameters<typeof observeContractAt>[0];

/**
 * A World that never became a Git repository has no Dispatch or Contract
 * authority, so every candidate is free of those associations. Any other
 * failure to prove the repository keeps all candidates.
 */
async function retentionRepository(world: WorldRoot): Promise<Repository | undefined> {
  try {
    return await repositoryAt(world);
  } catch (error) {
    if (error instanceof NoGitWorldError) return undefined;
    throw error;
  }
}

/**
 * A Dispatch association is retirable only when it is absent or names a
 * terminal Contract. Unproven, corrupt, missing-Contract, and active Contract
 * associations all keep the Akuma.
 */
async function dispatchAssociationIsRetirable(
  repository: Repository | undefined,
  association: DispatchAssociation,
): Promise<boolean> {
  if (association.kind === "none") return true;
  if (association.kind === "failed" || repository === undefined) return false;
  return await withGitDecodeChannel(repository, async (channel) => {
    try {
      const terminal = (await observeContractAt(repository, channel, association.contractId)).state?.terminal;
      return terminal?.kind === "claimed" || terminal?.kind === "abandoned";
    } catch {
      return false;
    }
  });
}

async function retireCandidate(
  world: WorldRoot,
  repository: Repository | undefined,
  candidate: AkumaRetentionCandidate,
  now: number,
): Promise<boolean> {
  try {
    const receipt = await retireInactiveAkuma({
      entry: candidate.entry,
      now,
      retireUnderCustody: async (retire) => {
        // Alias writers use this same authority lock. Holding it across the
        // Dispatch judgment and removal means an Alias cannot appear between
        // the final check and the deletion.
        const aliases = await tryAcquireAliasCustody(world);
        if (aliases === null) return "retained";
        try {
          if (aliases.bindings.some((binding) => binding.akuId === candidate.entry.id)) return "retained";
          if (repository === undefined) return (await retire()) ? "retired" : "retained";
          try {
            // Dispatch publication takes this same private-state seat. Holding
            // it across the judgment and removal means a Dispatch cannot appear
            // between the final check and the deletion.
            const retired = await withPrivateStatePublicationSeat(
              repository,
              async () => {
                const associations = await observeDispatchAssociations(repository, [candidate.entry.id]);
                if (!(await dispatchAssociationIsRetirable(repository, associations.get(candidate.entry.id)!)))
                  return "retained" as const;
                return (await retire()) ? ("retired" as const) : ("retained" as const);
              },
              { timeoutMs: 0 },
            );
            return retired.value;
          } catch (error) {
            if (isPrivateStateSeatContention(error)) return "retained";
            throw error;
          }
        } finally {
          aliases.release();
        }
      },
    });
    return receipt === "retired";
  } catch {
    // One unreadable, corrupt, or unremovable candidate never fails the sweep
    // or the ordinary operation that triggered it.
    return false;
  }
}

/**
 * One deterministic, bounded retention sweep over the World's recognized Akuma
 * entries. The semantic age, lifecycle, and custody judgment stay in the Akuma
 * owner; this composition supplies only the optional Alias, Dispatch, and
 * Contract associations that owner must not read itself.
 */
export async function sweepInactiveAkumas(
  world: WorldRoot,
  options: Readonly<{ now?: number }> = {},
): Promise<readonly AkuId[]> {
  const now = options.now ?? retentionNow();
  const known = await knownAkuma(world);
  if (known.rows.length === 0) return [];
  const bounded = await boundedMap(known.rows, async (entry): Promise<KnownAkuma | null> => {
    try {
      return (await retentionCandidateBound(entry.paths, now)) ? entry : null;
    } catch {
      return null;
    }
  });
  const prefiltered = bounded.filter((entry): entry is KnownAkuma => entry !== null);
  if (prefiltered.length === 0) return [];
  const loaded = await boundedMap(prefiltered, async (entry) => {
    try {
      return await readRetentionCandidate(entry, now);
    } catch {
      return null;
    }
  });
  const candidates = loaded.filter((candidate): candidate is AkumaRetentionCandidate => candidate !== null);
  if (candidates.length === 0) return [];

  const aliases = new Set((await readAliases(world)).map((binding) => binding.akuId));
  const repository = await retentionRepository(world);
  const associations = await observeDispatchAssociations(
    repository,
    candidates.map((candidate) => candidate.entry.id),
  );
  const retired: AkuId[] = [];
  for (const candidate of candidates) {
    if (aliases.has(candidate.entry.id)) continue;
    if (!(await dispatchAssociationIsRetirable(repository, associations.get(candidate.entry.id)!))) continue;
    if (await retireCandidate(world, repository, candidate, now)) retired.push(candidate.entry.id);
  }
  return retired;
}
