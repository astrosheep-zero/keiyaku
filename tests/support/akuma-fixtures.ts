import type { BodyLaunch } from "../../src/akuma/body.js";
import { ALLOWED_ACTIONS } from "../../src/akuma/allowed.js";
import type { TimelineFact } from "../../src/akuma/heart/index.js";
import type { allocateAkumaDirectory } from "../../src/akuma/identity.js";

type AllocatedAkuma = Awaited<ReturnType<typeof allocateAkumaDirectory>>;
type ActivityFact = Extract<TimelineFact, { kind: "activity" }>;
type TurnEndFact = Extract<TimelineFact, { kind: "turn-end" }>;

/** Keep the data under test explicit; only the repeated carrier shape lives here. */
export function activityFact(
  sequence: number,
  turnSequence: number,
  at: string,
  event: ActivityFact["event"],
): ActivityFact {
  return { kind: "activity", sequence, turnSequence, at, event };
}

export function turnEndFact(
  sequence: number,
  turnSequence: number,
  completedAt: string,
  outcome: TurnEndFact["outcome"],
): TurnEndFact {
  return { kind: "turn-end", sequence, turnSequence, completedAt, outcome };
}

/** A fresh launch object per call; no shared Heart, adapter, options, or lifecycle. */
export function claudeBodyLaunch(
  allocated: AllocatedAkuma,
  cwd: string,
  initialBody: string,
  extra: Omit<BodyLaunch, "paths" | "seed" | "initialBody"> = {},
): BodyLaunch {
  return {
    paths: allocated.paths,
    seed: {
      id: allocated.id,
      archetype: "claude",
      provider: { name: "claude", kind: "claude-agent-sdk" },
      options: {},
      origin: { kind: "direct" },
      allowed: ALLOWED_ACTIONS,
      cwd,
    },
    initialBody,
    ...extra,
  };
}
