declare const AKU_ID: unique symbol;

export type AkuId = string & { readonly [AKU_ID]: true };

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
  | Readonly<{ kind: "request"; parentId: AkuId; requestId: string }>
  | Readonly<{ kind: "fork"; parent: AkuId; at: string }>;

export type Soul = Readonly<{
  id: AkuId;
  persona: string;
  description?: string;
  provider: ProviderExecution;
  options: ProviderOptions;
  cwd: string;
  origin: AkumaOrigin;
  confinement: Confinement;
  contract?: string;
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

export type TellState = "recorded" | "delivered" | "seen" | "consumed" | "voided-by-death";

export type TellFact = Readonly<{
  id: string;
  body: string;
  state: TellState;
  recordedAt: string;
}>;

export type RequestInput = Readonly<{
  id: string;
  persona: string;
  body: string;
  cwd?: string;
  contract?: string;
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

export type KillEvidence = "killed" | "already-dead" | "alive-after-sigkill" | "unavailable";
export type DeathFact = Readonly<{ evidence: KillEvidence; at: string }>;
export type SealFact = Readonly<{ evidence: string; at: string }>;
export type LeashProbe = "held" | "free";

export type CollarProbe =
  | Readonly<{ kind: "gone"; end: BodyEnd | null }>
  | Readonly<{ kind: "alive" }>
  | Readonly<{ kind: "unverifiable"; diagnostic: string }>;

export type AkumaLife = "running" | "asleep" | "stranded" | "headless" | "dead";

export type HeartSnapshot = Readonly<{
  soul: Soul | null;
  latestBody: BodyFact | null;
  latestSession: SessionFact | null;
  pending: readonly TellFact[];
  death: DeathFact | null;
}>;

export function life(leashProbe: LeashProbe, collarProbe: CollarProbe, deathRow: DeathFact | null): AkumaLife {
  if (deathRow !== null) return "dead";
  if (leashProbe === "held") return "running";
  if (collarProbe.kind !== "gone") return "headless";
  return collarProbe.end === "exited" ? "asleep" : "stranded";
}
