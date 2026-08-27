import {
  activitySlice,
  isHeartAbsent,
  life,
  lifeAt,
  probeLeash,
  readHeart,
  readSeal,
  readSoul,
  type HeartSnapshot,
} from "./heart/index.js";
import { pathsForAkuId, type AkuId, type AkumaPaths } from "./identity.js";
import {
  ordinarySnapshotBudget,
  projectTurns,
  selectHistory,
  selectSnapshot,
  type ActivityHistory,
  type ActivitySnapshot,
} from "./projection.js";
import { resolveProviderExecution } from "./providers/index.js";
import type { WorldRoot } from "../world.js";
import type { AkumaListRow, AkumaStatus, UnbornAkumaListRow } from "./akuma.js";
import { AkumaNotBornError } from "./akuma-errors.js";

export async function fleetListRow(paths: AkumaPaths, expected: AkuId): Promise<AkumaListRow | UnbornAkumaListRow> {
  const snapshot = await readHeart(paths);
  if (snapshot.soul !== null) return await bornListRow(paths, expected, snapshot);
  try {
    if ((await probeLeash(paths)) === "held") return { id: expected, life: "unborn" };
    const seal = await readSeal(paths);
    return seal === null ? { id: expected, life: "unborn" } : { id: expected, life: "stillborn", seal };
  } catch (error) {
    if (isHeartAbsent(error)) return { id: expected, life: "unborn" };
    throw error;
  }
}

async function bornListRow(paths: AkumaPaths, expected: AkuId, snapshot?: HeartSnapshot): Promise<AkumaListRow> {
  snapshot ??= await readHeart(paths);
  if (snapshot.soul === null) throw new AkumaNotBornError(expected);
  if (snapshot.soul.id !== expected) throw new Error("Akuma soul does not match its coordinate");
  const currentLife = life({ leash: await probeLeash(paths), body: snapshot.latestBody, kill: snapshot.latestKill });
  return {
    id: snapshot.soul.id,
    archetype: snapshot.soul.archetype,
    ...(snapshot.soul.description === undefined ? {} : { description: snapshot.soul.description }),
    life: currentLife,
    lifeAt: lifeAt(currentLife, snapshot.latestBody, snapshot.latestKill, snapshot.soul.createdAt),
    lastActivityAt: snapshot.lastActivityAt,
    pending: snapshot.pending.map((tell) => tell.id),
  };
}

export type BudgetedStatusObservation = Readonly<{ status: AkumaStatus; ordinarySelected: number }>;

export async function bornStatus(
  paths: AkumaPaths,
  expected: AkuId,
  input: Readonly<{ aperture: "monitoring" | "receipt"; ordinaryBudget?: number; admittedTellId?: string }>,
): Promise<BudgetedStatusObservation> {
  if (input.ordinaryBudget !== undefined && (!Number.isSafeInteger(input.ordinaryBudget) || input.ordinaryBudget < 0))
    throw new TypeError("ordinary budget must be a nonnegative safe integer");
  const snapshot = await readHeart(paths);
  if (snapshot.soul === null) throw new AkumaNotBornError(expected);
  const current = await bornListRow(paths, expected, snapshot);
  const resumeUnsupported =
    current.life === "stranded" &&
    snapshot.latestSession?.provider === snapshot.soul.provider.name &&
    (await resolveProviderExecution(snapshot.soul.provider)).adapter.resume === undefined;
  const slice = await activitySlice(paths);
  const selected = selectSnapshot(projectTurns(slice.rows), {
    aperture: input.aperture,
    budget: ordinarySnapshotBudget(input.ordinaryBudget),
    ...(input.admittedTellId === undefined ? {} : { admittedTellId: input.admittedTellId }),
  });
  return {
    status: {
      id: current.id,
      life: current.life,
      ...(snapshot.soul.readonly === undefined ? {} : { readonly: snapshot.soul.readonly }),
      ...(resumeUnsupported ? { strandedReason: "resume-unsupported" as const } : {}),
      timeline: selected.snapshot,
    },
    ordinarySelected: selected.ordinaryCount,
  };
}

export async function readBudgetedStatus(
  worldPath: WorldRoot,
  id: AkuId,
  input: Readonly<{ aperture: "monitoring" | "receipt"; ordinaryBudget?: number; admittedTellId?: string }>,
): Promise<BudgetedStatusObservation> {
  return await bornStatus(pathsForAkuId(worldPath, id), id, input);
}

export async function readAkumaBirthCwd(worldPath: WorldRoot, id: AkuId): Promise<string> {
  const soul = await readSoul(pathsForAkuId(worldPath, id));
  if (soul === null) throw new AkumaNotBornError(id);
  return soul.cwd;
}

export { selectHistory, type ActivityHistory, type ActivitySnapshot };
