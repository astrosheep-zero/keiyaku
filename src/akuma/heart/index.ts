import type { AkuId, AkumaPaths } from "../identity.js";
import type {
  BodyEnd,
  BodyFact,
  ForkPoint,
  HeartSnapshot,
  KillFact,
  RequestFact,
  RequestInput,
  SealFact,
  SessionFact,
  Soul,
  TellDeliveryInput,
  TellFact,
  TellReceiptInput,
  TurnEndFact,
  TurnFact,
  TurnOutcome,
  TurnStartFact,
} from "./facts.js";
export type { CallFact } from "./facts.js";
import {
  answeredTurnFact,
  endBodyFact,
  finishBodyFact,
  insertActivityFact,
  insertTurnEndFact,
  insertTurnStartFact,
  insertPauseControl,
  insertRequestFact,
  insertSessionFact,
  insertStopControl,
  killFactForBody,
  latestBodyFact,
  latestKillFact,
  latestSessionFact,
  lastAnsweredTurnFact,
  nonterminalRequestFacts,
  pauseFact,
  requestFact,
  sessionFactForCoordinate,
  stopFact,
  updateRequestRefused,
  updateRequestReserved,
  updateRequestServed,
  updateRequestVoided,
} from "./rows.js";
import type { ActivityFact } from "./rows.js";
import {
  insertTellDeliveryFact,
  insertTellFact,
  insertTellReceiptFact,
  pendingTellFacts,
  tellFact,
  tellIdsForFence,
} from "./tells.js";
import {
  activityFactSlice,
  pruneActivityFacts,
  type ActivityFactSlice,
} from "./timeline.js";
import { isHeartAbsent, readSealFromLeash, transaction, withHeart } from "./storage.js";
import { soulFact } from "./soul.js";
export { HeartAbsentError, HeldAkumaLeash, initializeHeart, isHeartAbsent, probeLeash } from "./storage.js";

export { life, lifeAt } from "./facts.js";
export type {
  AkumaLife,
  AkumaOrigin,
  BodyEnd,
  BodyFact,
  Confinement,
  HeartSnapshot,
  ForkPoint,
  KillEvidence,
  KillFact,
  LeashProbe,
  PauseFact,
  RequestFact,
  RequestInput,
  RequestRecipe,
  SealFact,
  SessionFact,
  Soul,
  StopFact,
  TellFact,
  TellDelivery,
  TellDeliveryInput,
  TellReceiptInput,
  TurnEndFact,
  TurnFact,
  TurnOutcome,
  TurnStartFact,
} from "./facts.js";
export type { ResumeCoordinate } from "../coordinate.js";

const ACTIVITY_LIMIT = 5_000;

export async function readSoul(paths: AkumaPaths): Promise<Soul | null> {
  try {
    return await withHeart(paths, soulFact);
  } catch (error) {
    if (isHeartAbsent(error)) return null;
    throw error;
  }
}

export async function heartExists(paths: AkumaPaths): Promise<boolean> {
  try {
    return await withHeart(paths, () => true);
  } catch (error) {
    if (isHeartAbsent(error)) return false;
    throw error;
  }
}

export async function readSeal(paths: AkumaPaths): Promise<SealFact | null> {
  try {
    return await readSealFromLeash(paths);
  } catch (error) {
    if (isHeartAbsent(error)) return null;
    throw error;
  }
}

export async function recordSession(paths: AkumaPaths, input: Omit<SessionFact, "sequence">): Promise<SessionFact> {
  return await withHeart(paths, (heart) => ({ sequence: insertSessionFact(heart, input), ...input }));
}

export async function appendActivity(
  paths: AkumaPaths,
  input: Readonly<{ turnSequence: number; event: unknown; at: string }>,
): Promise<number> {
  return await withHeart(paths, (heart) =>
    transaction(heart, () => {
      const sequence = insertActivityFact(heart, input);
      pruneActivityFacts(heart, ACTIVITY_LIMIT);
      return sequence;
    }));
}

export type ActivitySliceInput = Readonly<{ before?: number; since?: number; limit?: number }>;
export type ActivitySlice = ActivityFactSlice;
export type { ActivityFact };
export type { TimelineFact } from "./timeline.js";

export async function activitySlice(paths: AkumaPaths, input: ActivitySliceInput = {}): Promise<ActivitySlice> {
  const limit = input.limit ?? ACTIVITY_LIMIT;
  return await withHeart(paths, (heart) => activityFactSlice(heart, { ...input, limit }));
}

export async function recordTell(
  paths: AkumaPaths,
  tell: Omit<TellFact, "sequence" | "state" | "deliveries">,
): Promise<Readonly<{ kind: "not-born" } | { kind: "recorded"; tell: TellFact }>> {
  return await withHeart(paths, (heart) =>
    transaction(heart, () => {
      if (soulFact(heart) === null) return { kind: "not-born" };
      const sequence = insertTellFact(heart, tell);
      pruneActivityFacts(heart, ACTIVITY_LIMIT);
      return { kind: "recorded", tell: { sequence, ...tell, state: "pending", deliveries: [] } };
    }));
}

export async function recordTellDeliveries(
  paths: AkumaPaths,
  inputs: readonly TellDeliveryInput[],
): Promise<void> {
  await withHeart(paths, (heart) =>
    transaction(heart, () => {
      for (const input of inputs) {
        const current = tellFact(heart, input.tellId);
        if (current === null) throw new Error(`unknown tell ${input.tellId}`);
      }
      for (const input of inputs) insertTellDeliveryFact(heart, input);
      pruneActivityFacts(heart, ACTIVITY_LIMIT);
    }));
}

export async function recordTellReceipt(
  paths: AkumaPaths,
  input: TellReceiptInput,
): Promise<void> {
  await withHeart(paths, (heart) =>
    transaction(heart, () => {
      const tellIds = input.evidence === "exact"
        ? [input.tellId]
        : tellIdsForFence(heart, input.turnSequence, input.fence);
      if (tellIds.length === 0) throw new Error("tell receipt has no delivery mapping");
      insertTellReceiptFact(heart, input);
      pruneActivityFacts(heart, ACTIVITY_LIMIT);
    }));
}

function sameRequestInput(fact: RequestFact, input: RequestInput): boolean {
  return fact.id === input.id
    && fact.archetype === input.archetype
    && fact.body === input.body
    && fact.cwd === input.cwd
    && fact.world === input.world
    && JSON.stringify(fact.recipe) === JSON.stringify(input.recipe);
}

export async function admitRequest(
  paths: AkumaPaths,
  input: RequestInput & Readonly<{ admittedAt: string }>,
): Promise<RequestFact> {
  return await withHeart(paths, (heart) =>
    transaction(heart, () => {
      insertRequestFact(heart, input);
      const fact = requestFact(heart, input.id);
      if (fact === null) throw new Error(`Akuma request ${input.id} was not admitted`);
      if (!sameRequestInput(fact, input)) throw new Error(`Akuma request ${input.id} reused different input`);
      return fact;
    }));
}

export async function reserveRequest(paths: AkumaPaths, id: string, child: AkuId): Promise<RequestFact> {
  return await withHeart(paths, (heart) =>
    transaction(heart, () => {
      const before = requestFact(heart, id);
      if (before === null) throw new Error(`unknown Akuma request ${id}`);
      if (before.state === "admitted") updateRequestReserved(heart, id, child);
      else if ((before.state !== "reserved" && before.state !== "served") || before.child !== child) {
        throw new Error(`Akuma request ${id} cannot reserve ${child}`);
      }
      return requestFact(heart, id)!;
    }));
}

export async function serveRequest(paths: AkumaPaths, id: string, child: AkuId): Promise<RequestFact> {
  return await withHeart(paths, (heart) =>
    transaction(heart, () => {
      const before = requestFact(heart, id);
      if (before === null) throw new Error(`unknown Akuma request ${id}`);
      if (before.state === "reserved" && before.child === child) updateRequestServed(heart, id, child);
      else if (before.state !== "served" || before.child !== child) {
        throw new Error(`Akuma request ${id} cannot serve ${child}`);
      }
      return requestFact(heart, id)!;
    }));
}

export async function refuseRequest(paths: AkumaPaths, id: string, diagnostic: string): Promise<RequestFact> {
  return await withHeart(paths, (heart) =>
    transaction(heart, () => {
      const before = requestFact(heart, id);
      if (before === null) throw new Error(`unknown Akuma request ${id}`);
      if (before.state === "admitted") updateRequestRefused(heart, id, diagnostic);
      else if (before.state !== "refused" || before.diagnostic !== diagnostic) {
        throw new Error(`Akuma request ${id} cannot be refused`);
      }
      return requestFact(heart, id)!;
    }));
}

export async function voidRequest(paths: AkumaPaths, id: string, evidence: string): Promise<RequestFact> {
  return await withHeart(paths, (heart) =>
    transaction(heart, () => {
      const before = requestFact(heart, id);
      if (before === null) throw new Error(`unknown Akuma request ${id}`);
      if (before.state === "admitted" || before.state === "reserved") updateRequestVoided(heart, id, evidence);
      else if (before.state !== "voided" || before.evidence !== evidence) {
        throw new Error(`Akuma request ${id} cannot be voided`);
      }
      return requestFact(heart, id)!;
    }));
}

export async function readRequest(paths: AkumaPaths, id: string): Promise<RequestFact | null> {
  return await withHeart(paths, (heart) => requestFact(heart, id));
}

export async function readNonterminalRequests(paths: AkumaPaths): Promise<readonly RequestFact[]> {
  return await withHeart(paths, nonterminalRequestFacts);
}

export async function readKill(paths: AkumaPaths, bodySequence: number): Promise<KillFact | null> {
  return await withHeart(paths, (heart) => killFactForBody(heart, bodySequence));
}

export async function requestStop(
  paths: AkumaPaths,
  at: string,
): Promise<Readonly<{ kind: "requested"; body: BodyFact }>
  | Readonly<{ kind: "already-killed" | "already-stopped"; body: BodyFact }>> {
  return await withHeart(paths, (heart) =>
    transaction(heart, () => {
      const body = latestBodyFact(heart);
      if (body === null) throw new Error("Akuma has no Body to kill");
      if (latestKillFact(heart)?.bodySequence === body.sequence) return { kind: "already-killed", body };
      if (body.end !== undefined) return { kind: "already-stopped", body };
      const existing = stopFact(heart);
      if (existing !== null && existing.bodySequence !== body.sequence) {
        throw new Error("Akuma stop target is not the latest Body");
      }
      insertStopControl(heart, body.sequence, at);
      return { kind: "requested", body };
    }));
}

export async function requestPause(
  paths: AkumaPaths,
  at: string,
): Promise<Readonly<{ kind: "not-born" } | { kind: "requested"; body: BodyFact }>> {
  return await withHeart(paths, (heart) =>
    transaction(heart, () => {
      if (soulFact(heart) === null) return { kind: "not-born" };
      const body = latestBodyFact(heart);
      if (body === null) throw new Error("Akuma has no Body to interrupt");
      insertPauseControl(heart, at);
      return { kind: "requested", body };
    }));
}

export async function stopRequested(paths: AkumaPaths, bodySequence?: number): Promise<boolean> {
  return await withHeart(paths, (heart) => {
    const target = stopFact(heart);
    return target !== null && (bodySequence === undefined || target.bodySequence === bodySequence);
  });
}

export async function pauseRequested(paths: AkumaPaths, bodySequence?: number): Promise<boolean> {
  return await withHeart(paths, (heart) => {
    const target = pauseFact(heart);
    return target !== null && (bodySequence === undefined || target.bodySequence === bodySequence);
  });
}

export async function breakBody(paths: AkumaPaths, input: Readonly<{ sequence: number; end: Exclude<BodyEnd, "exited">; at: string }>): Promise<void> {
  await withHeart(paths, (heart) => endBodyFact(heart, input));
}

export async function beginTurn(
  paths: AkumaPaths,
  input: Readonly<{ bodySequence: number; startedAt: string; call?: string }>,
): Promise<TurnStartFact> {
  return await withHeart(paths, (heart) => transaction(heart, () => {
    const fact = insertTurnStartFact(heart, input);
    pruneActivityFacts(heart, ACTIVITY_LIMIT);
    return fact;
  }));
}

export async function endTurn(
  paths: AkumaPaths,
  input: Readonly<{ turnSequence: number; outcome: TurnOutcome; completedAt: string }>,
): Promise<TurnEndFact> {
  return await withHeart(paths, (heart) => transaction(heart, () => {
    const fact = insertTurnEndFact(heart, { kind: "turn-end", ...input });
    pruneActivityFacts(heart, ACTIVITY_LIMIT);
    return fact;
  }));
}

export async function finishBodyIfIdle(paths: AkumaPaths, input: Readonly<{ sequence: number; at: string }>):
Promise<Readonly<{ kind: "controlled" | "finished" } | { kind: "pending"; tells: readonly string[] }>> {
  return await withHeart(paths, (heart) =>
    transaction(heart, () => {
      if (stopFact(heart)?.bodySequence === input.sequence || pauseFact(heart)?.bodySequence === input.sequence) {
        endBodyFact(heart, { ...input, end: "put-down" });
        return { kind: "controlled" };
      }
      const pending = pendingTellFacts(heart);
      if (pending.length > 0) return { kind: "pending", tells: pending.map((tell) => tell.id) };
      finishBodyFact(heart, input);
      return { kind: "finished" };
    }));
}

export async function readHeart(paths: AkumaPaths): Promise<HeartSnapshot> {
  try {
    return await withHeart(paths, (heart) => ({
        soul: soulFact(heart),
        latestBody: latestBodyFact(heart),
        latestSession: latestSessionFact(heart),
        pending: pendingTellFacts(heart),
        latestKill: latestKillFact(heart),
        stop: stopFact(heart),
        pause: pauseFact(heart),
    }));
  } catch (error) {
    if (isHeartAbsent(error)) {
      return { soul: null, latestBody: null, latestSession: null, pending: [], latestKill: null, stop: null, pause: null };
    }
    throw error;
  }
}

export async function readLastAnsweredTurn(paths: AkumaPaths): Promise<TurnFact | null> {
  return await withHeart(paths, lastAnsweredTurnFact);
}

export async function readForkPoint(
  paths: AkumaPaths,
  historyId: string,
): Promise<ForkPoint | null> {
  try {
    return await withHeart(paths, (heart) => {
      const turn = answeredTurnFact(heart, historyId);
      const outcome = turn?.end?.outcome;
      if (outcome?.kind !== "answered" || outcome.historyId === undefined) return null;
      const recipe = sessionFactForCoordinate(heart, outcome.session);
      if (recipe === null) throw new Error(`Akuma fork point ${historyId} has no session recipe`);
      return {
        historyId: outcome.historyId,
        session: outcome.session,
        provider: recipe.provider,
        cwd: recipe.cwd,
        options: recipe.options,
      };
    });
  } catch (error) {
    if (isHeartAbsent(error)) return null;
    throw error;
  }
}
