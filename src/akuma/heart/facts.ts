import type { AkuId } from "../identity.js";

export type Confinement =
  | Readonly<{ kind: "unconfined" }>
  | Readonly<{ kind: "declared"; writableRoots: readonly string[] }>;

export type ProviderOptions = Readonly<{
  model?: string;
  effort?: string;
  access?: "read" | "write" | "auto";
  network?: "disabled" | "enabled";
  systemPrompt?: string;
}>;

export type ProviderExecution = Readonly<{
  name: string;
  kind: "claude-agent-sdk" | "codex-app-server";
  executable?: string;
  config?: Readonly<Record<string, unknown>>;
  env?: Readonly<Record<string, string>>;
}>;

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
  cwd: string;
  origin: AkumaOrigin;
  confinement: Confinement;
  createdAt: string;
}>;

export type RequestRecipe = Pick<Soul, "description" | "provider" | "options" | "confinement">;

export type Collar = Readonly<{
  pid: number;
  processGroup: number;
  spawnedAt: string;
}>;

export type BodyEnd = "exited" | "broke-off" | "put-down";

export type BodyFact = Readonly<{
  sequence: number;
  collar: Collar;
  leashTakenAt: string;
  end?: BodyEnd;
  endedAt?: string;
}>;

export type ResumeCoordinate = Readonly<{ sessionId: string }>;

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
  | Readonly<{ kind: "answered"; historyId: string; session: ResumeCoordinate; answer: string }>
  | Readonly<{ kind: "failed"; diagnostic: string }>;

export type TurnFact = Readonly<{
  sequence: number;
  bodySequence: number;
  outcome: TurnOutcome;
  completedAt: string;
}>;

export type TellFact = Readonly<{
  sequence: number;
  id: string;
  body: string;
  recordedAt: string;
  state: "pending" | "told";
}>;

export type TellDeliveryInput = Readonly<{
  tellId: string;
  bodySequence: number;
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
  | Readonly<{ evidence: "fence"; bodySequence: number; fence: string }>
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

export type KillEvidence = "killed" | "already-killed" | "alive-after-sigkill" | "unavailable";
export type KillFact = Readonly<{ sequence: number; bodySequence: number; evidence: "killed"; at: string }>;
export type StopFact = Readonly<{ bodySequence: number; requestedAt: string }>;
export type SealFact = Readonly<{ evidence: string; at: string }>;
export type LeashProbe = "held" | "free";

export type CollarProbe =
  | Readonly<{ kind: "gone"; end: BodyEnd | null }>
  | Readonly<{ kind: "alive" }>
  | Readonly<{ kind: "unverifiable"; diagnostic: string }>;

export type AkumaLife = "running" | "asleep" | "stranded" | "headless" | "killed";

export type HeartSnapshot = Readonly<{
  soul: Soul | null;
  latestBody: BodyFact | null;
  latestSession: SessionFact | null;
  pending: readonly TellFact[];
  latestKill: KillFact | null;
}>;

export function life(
  leashProbe: LeashProbe,
  collarProbe: CollarProbe,
  latestBody: BodyFact | null,
  latestKill: KillFact | null,
): AkumaLife {
  if (leashProbe === "held") return "running";
  if (collarProbe.kind !== "gone") return "headless";
  if (latestBody !== null && latestKill?.bodySequence === latestBody.sequence) return "killed";
  return collarProbe.end === "exited" ? "asleep" : "stranded";
}
