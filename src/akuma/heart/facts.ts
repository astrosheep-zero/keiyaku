import type { AkuId } from "../identity.js";
import type { ResumeCoordinate } from "../coordinate.js";
import type { ProviderExecution, ProviderOptions, ReadonlyRestraint } from "../provider-recipe.js";
export type { ResumeCoordinate } from "../coordinate.js";

export type Confinement =
  | Readonly<{ kind: "unconfined" }>
  | Readonly<{ kind: "declared"; writableRoots: readonly string[] }>;

export type AkumaOrigin =
  | Readonly<{ kind: "direct" }>
  | Readonly<{ kind: "request"; parent: AkuId; requestId: string }>
  | Readonly<{ kind: "fork"; parent: AkuId; at: string }>;

export type Soul = Readonly<{
  id: AkuId;
  archetype: string;
  description?: string;
  provider: ProviderExecution;
  options: ProviderOptions;
  readonly?: ReadonlyRestraint;
  cwd: string;
  origin: AkumaOrigin;
  confinement: Confinement;
  createdAt: string;
}>;

export type RequestRecipe = Pick<Soul, "description" | "provider" | "options" | "readonly" | "confinement">;

export type BodyEnd = "exited" | "broke-off" | "put-down";

export type BodyFact = Readonly<{
  sequence: number;
  leashTakenAt: string;
  hung?: Readonly<{ diagnostic: string; at: string }>;
  end?: BodyEnd;
  endedAt?: string;
}>;

export type SessionFact = Readonly<{
  sequence: number;
  provider: string;
  coordinate: ResumeCoordinate;
  cwd: string;
  options: ProviderOptions;
  admittedAt: string;
}>;

export type ForkPoint = Readonly<{
  historyId: string;
  session: ResumeCoordinate;
  provider: string;
  cwd: string;
  options: ProviderOptions;
}>;

export type TurnOutcome =
  | Readonly<{ kind: "answered"; historyId?: string; session: ResumeCoordinate; answer: string }>
  | Readonly<{ kind: "failed"; diagnostic: string }>;

export type TurnStartFact = Readonly<{
  kind: "turn-start";
  sequence: number;
  bodySequence: number;
  startedAt: string;
}>;

export type TurnEndFact = Readonly<{
  kind: "turn-end";
  sequence: number;
  turnSequence: number;
  outcome: TurnOutcome;
  completedAt: string;
}>;

export type TurnFact = TurnStartFact & Readonly<{ end?: TurnEndFact }>;

export type CallFact = Readonly<{
  kind: "call";
  sequence: number;
  turnSequence: number;
  body: string;
  at: string;
}>;

export type TellDelivery = Readonly<{
  turnSequence: number;
  route: "launch" | "live";
  receipt?: "unavailable" | "required";
  deliveredAt: string;
}>;

export type TellFact = Readonly<{
  kind: "tell";
  sequence: number;
  id: string;
  body: string;
  recordedAt: string;
  state: "pending" | "told";
  deliveries: readonly TellDelivery[];
}>;

export type TellDeliveryInput = Readonly<{
  tellId: string;
  turnSequence: number;
  fence: string;
  deliveredAt: string;
}> & (
  | Readonly<{ route: "launch" }>
  | Readonly<{ route: "live"; receipt: "unavailable" | "required" }>
);

export type TellReceiptInput = Readonly<{
  kind: string;
  receivedAt: string;
}> & (
  | Readonly<{ evidence: "exact"; tellId: string }>
  | Readonly<{ evidence: "fence"; turnSequence: number; fence: string }>
);

export type RequestInput = Readonly<{
  id: string;
  archetype: string;
  body: string;
  cwd?: string;
  world: string;
  recipe: RequestRecipe;
}>;

export type RequestFact = RequestInput & Readonly<{ admittedAt: string }> & (
  | Readonly<{ state: "admitted" }>
  | Readonly<{ state: "reserved"; child: AkuId }>
  | Readonly<{ state: "served"; child: AkuId }>
  | Readonly<{ state: "refused"; diagnostic: string }>
  | Readonly<{ state: "voided"; evidence: string }>
);

export type KillEvidence = "killed" | "already-killed" | "already-stopped" | "hung" | "untidy" | "unavailable";
export type KillFact = Readonly<{ sequence: number; bodySequence: number; evidence: "killed"; at: string }>;
export type StopFact = Readonly<{ bodySequence: number; requestedAt: string }>;
export type PauseFact = Readonly<{ bodySequence: number; requestedAt: string }>;
export type SealFact = Readonly<{ evidence: string; at: string }>;
export type LeashProbe = "held" | "free";

export type AkumaLife = "running" | "asleep" | "stranded" | "hung" | "untidy" | "killed";

export type HeartSnapshot = Readonly<{
  soul: Soul | null;
  latestBody: BodyFact | null;
  latestSession: SessionFact | null;
  pending: readonly TellFact[];
  latestKill: KillFact | null;
  stop: StopFact | null;
  pause: PauseFact | null;
}>;

export function life(input: Readonly<{
  leash: LeashProbe;
  body: BodyFact | null;
  kill: KillFact | null;
}>): AkumaLife {
  if (input.leash === "held") return input.body?.hung === undefined ? "running" : "hung";
  if (input.body === null || input.body.end === undefined) return "untidy";
  if (input.kill?.bodySequence === input.body.sequence) return "killed";
  return input.body.end === "exited" ? "asleep" : "stranded";
}

export type SoulRow = Readonly<{
  soul_json: string;
}>;
