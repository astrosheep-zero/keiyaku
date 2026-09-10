import {
  readStatusFacts,
  readLifeSnapshot,
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
  if (snapshot.soul !== null) {
    const observed = await bornObservation(paths, expected, () => readHeart(paths), snapshot);
    return {
      id: observed.soul.id,
      archetype: observed.soul.archetype,
      ...(observed.soul.description === undefined ? {} : { description: observed.soul.description }),
      life: observed.currentLife,
      lifeAt: lifeAt(
        observed.currentLife,
        observed.snapshot.latestBody,
        observed.snapshot.latestKill,
        observed.soul.createdAt,
      ),
      lastActivityAt: observed.snapshot.lastActivityAt,
      pending: observed.snapshot.pending.map((tell) => tell.id),
    };
  }
  try {
    if ((await probeLeash(paths)) === "held") return { id: expected, life: "unborn" };
    const seal = await readSeal(paths);
    return seal === null ? { id: expected, life: "unborn" } : { id: expected, life: "stillborn", seal };
  } catch (error) {
    if (isHeartAbsent(error)) return { id: expected, life: "unborn" };
    throw error;
  }
}

async function bornObservation<T extends Pick<HeartSnapshot, "soul" | "latestBody" | "latestKill">>(
  paths: AkumaPaths,
  expected: AkuId,
  read: () => Promise<T>,
  snapshot?: T,
) {
  snapshot ??= await read();
  if (snapshot.soul === null) throw new AkumaNotBornError(expected);
  const claim = await HeldAkumaLeash.try(paths);
  try {
    // A Body may finish after the first read. Refresh under the free seat so
    // neither its release nor a successor can manufacture an untidy observation.
    if (claim !== null) snapshot = await read();
    const soul = snapshot.soul;
    if (soul === null) throw new AkumaNotBornError(expected);
    if (soul.id !== expected) throw new Error("Akuma soul does not match its coordinate");
    const currentLife = life({
      leash: claim === null ? "held" : "free",
      body: snapshot.latestBody,
      kill: snapshot.latestKill,
    });
    return { snapshot, soul, currentLife };
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
  const { snapshot, soul, currentLife } = await bornObservation(paths, expected, () => readLifeSnapshot(paths));
  const resumeUnsupported =
    currentLife === "stranded" &&
    snapshot.latestSession?.provider === soul.provider.name &&
    (await resolveProviderExecution(soul.provider)).adapter.resume === undefined;
  const facts = await readStatusFacts(paths, input);
  const selected = selectSnapshot(projectTurns(facts), {
    aperture: input.aperture,
    budget: ordinarySnapshotBudget(input.ordinaryBudget),
    ...(input.admittedTellId === undefined ? {} : { admittedTellId: input.admittedTellId }),
  });
  return {
    status: {
      id: soul.id,
      life: currentLife,
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

function complete(life: AkumaStatus["life"], pending: boolean): boolean {
  return life !== "running" && !pending;
}

export function defaultWaitComplete(status: AkumaStatus): boolean {
  return complete(
    status.life,
    status.timeline.entries.some(
      (entry) => entry.kind === "row" && entry.row.kind === "tell" && entry.row.state === "pending",
    ),
  );
}

export async function readWaitComplete(worldPath: WorldRoot, id: AkuId): Promise<boolean> {
  const paths = pathsForAkuId(worldPath, id);
  const observed = await bornObservation(paths, id, () => readLifeSnapshot(paths));
  return complete(observed.currentLife, observed.snapshot.hasPendingTell);
}

export async function readAkumaBirthCwd(worldPath: WorldRoot, id: AkuId): Promise<string> {
  const soul = await readSoul(pathsForAkuId(worldPath, id));
  if (soul === null) throw new AkumaNotBornError(id);
  return soul.cwd;
}

export { selectHistory, type ActivityHistory, type ActivitySnapshot };
