import {
  activitySlice,
  HeldAkumaLeash,
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
  if (snapshot.soul !== null) return (await bornObservation(paths, expected, snapshot)).row;
  try {
    if ((await probeLeash(paths)) === "held") return { id: expected, life: "unborn" };
    const seal = await readSeal(paths);
    return seal === null ? { id: expected, life: "unborn" } : { id: expected, life: "stillborn", seal };
  } catch (error) {
    if (isHeartAbsent(error)) return { id: expected, life: "unborn" };
    throw error;
  }
}

async function bornObservation(paths: AkumaPaths, expected: AkuId, snapshot?: HeartSnapshot) {
  snapshot ??= await readHeart(paths);
  if (snapshot.soul === null) throw new AkumaNotBornError(expected);
  const claim = await HeldAkumaLeash.try(paths);
  try {
    // A Body may finish after the first read. Refresh under the free seat so
    // neither its release nor a successor can manufacture an untidy observation.
    if (claim !== null) snapshot = await readHeart(paths);
    const soul = snapshot.soul;
    if (soul === null) throw new AkumaNotBornError(expected);
    if (soul.id !== expected) throw new Error("Akuma soul does not match its coordinate");
    const currentLife = life({
      leash: claim === null ? "held" : "free",
      body: snapshot.latestBody,
      kill: snapshot.latestKill,
    });
    return {
      snapshot,
      soul,
      row: {
        id: soul.id,
        archetype: soul.archetype,
        ...(soul.description === undefined ? {} : { description: soul.description }),
        life: currentLife,
        lifeAt: lifeAt(currentLife, snapshot.latestBody, snapshot.latestKill, soul.createdAt),
        lastActivityAt: snapshot.lastActivityAt,
        pending: snapshot.pending.map((tell) => tell.id),
      } satisfies AkumaListRow,
    };
  } finally {
    claim?.release();
  }
}

export type BudgetedStatusObservation = Readonly<{ status: AkumaStatus; ordinarySelected: number }>;

export async function bornStatus(
  paths: AkumaPaths,
  expected: AkuId,
  input: Readonly<{ aperture: "monitoring" | "receipt"; ordinaryBudget?: number; admittedTellId?: string }>,
): Promise<BudgetedStatusObservation> {
  if (input.ordinaryBudget !== undefined && (!Number.isSafeInteger(input.ordinaryBudget) || input.ordinaryBudget < 0))
    throw new TypeError("ordinary budget must be a nonnegative safe integer");
  const { snapshot, soul, row: current } = await bornObservation(paths, expected);
  const resumeUnsupported =
    current.life === "stranded" &&
    snapshot.latestSession?.provider === soul.provider.name &&
    (await resolveProviderExecution(soul.provider)).adapter.resume === undefined;
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
      ...(soul.readonly === undefined ? {} : { readonly: soul.readonly }),
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
