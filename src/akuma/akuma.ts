import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnAkumaBody } from "./body.js";
import {
  HeldAkumaLeash,
  activitySlice,
  life,
  probeLeash,
  readCurrentTurn,
  readHeart,
  readLastAnsweredTurn,
  readTurns,
  readForkPoint,
  readKill,
  readSeal,
  readSoul,
  recordTell,
  requestPause,
  requestStop,
  type AkumaLife,
  type CollarProbe,
  type HeartSnapshot,
  type KillEvidence,
  type ResumeCoordinate,
  type SessionFact,
  type Soul,
} from "./heart/index.js";
import {
  akuIdFromDirectoryName,
  akumaPaths,
  akumaRunRoot,
  parseAkuId,
  pathsForAkuId,
  archetypeName,
  type AkuId,
  type AkumaPaths,
} from "./identity.js";
import {
  projectActivityHistory,
  selectActivitySnapshot,
  type ActivityHistory,
  type ActivitySnapshot,
} from "./activity.js";
import { listArchetypes as readArchetypes, loadArchetype } from "./archetype.js";
import { publishAkuma } from "./publication.js";
import { providerNamed } from "./providers/index.js";
import { injectedBodyRequests, requestBodyCall } from "./requests.js";
import { probeProcessTree, putDownProcessTree } from "../runtime/proc/run.js";
import { settings as readSettings, type Settings } from "../settings.js";
import type { WorldRoot } from "../world.js";

const POLL_MS = 25;
const KILL_GRACE_MS = 1_000;

export type AkumaListRow = Readonly<{
  id: AkuId;
  archetype: string;
  description?: string;
  life: AkumaLife;
  collar: CollarProbe;
  confinement: Soul["confinement"];
  pending: readonly string[];
}>;

export type AkumaStatus = AkumaListRow & Readonly<{
  answer?: string;
  answerHistoryId?: string;
  failure?: string;
  outcomeAt?: string;
  activity: ActivitySnapshot;
  strandedReason?: "resume-unsupported";
}>;
export type { ActivityHistory, ActivityRow, ActivitySnapshot, ActivitySnapshotEntry } from "./activity.js";

export type UnbornAkumaListRow = Readonly<{
  id: AkuId;
  life: "unborn" | "stillborn";
  seal?: Readonly<{ evidence: string; at: string }>;
}>;

export type AkumaList = Readonly<{
  rows: readonly (AkumaListRow | UnbornAkumaListRow)[];
  searched: readonly string[];
}>;

export type AkumaListInput = Readonly<{
  archetype?: string;
}>;

export type TellResult = Readonly<{
  admission: Readonly<{ tellId: string; fact: "recorded" }>;
  wake: "spawned" | Readonly<{ kind: "failed"; diagnostic: string }>;
}>;

export type InterruptReceipt =
  | Readonly<{
      kind: "unstoppable";
      evidence:
        | "no-collar"
        | "collar-unverifiable"
        | "unavailable"
        | "alive-after-sigkill"
        | "leash-held-after-put-down";
    }>
  | Readonly<{
      kind: "interrupted";
      putDown: "was-idle" | "self-aborted" | "collar";
      tell: TellResult;
    }>;

export type ForkReceipt =
  | Readonly<{ kind: "forked"; child: AkuId }>
  | Readonly<{ kind: "provider-cannot-fork"; provider: string }>
  | Readonly<{ kind: "unknown-history"; at: string }>
  | Readonly<{ kind: "fork-failed"; diagnostic: string }>
  | Readonly<{ kind: "upstream-forked"; childSession: ResumeCoordinate; diagnostic: string }>;

export class AkumaNotBornError extends Error {
  readonly kind = "akuma-not-born";
  constructor(readonly id: AkuId) {
    super(`Akuma ${id} is not born`);
    this.name = "AkumaNotBornError";
  }
}
function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function takeLeashUntil(paths: AkumaPaths, deadline: number): Promise<HeldAkumaLeash | null> {
  for (;;) {
    const leash = HeldAkumaLeash.try(paths);
    if (leash !== null) return leash;
    if (performance.now() >= deadline) return null;
    await wait(POLL_MS);
  }
}

function recordTellBody(
  paths: AkumaPaths,
  akuma: AkuId,
  body: string,
): Readonly<{ kind: "recorded"; tellId: string }> {
  const id = randomUUID();
  const admitted = recordTell(paths, { id, body, recordedAt: new Date().toISOString() });
  if (admitted.kind === "not-born") throw new AkumaNotBornError(akuma);
  return { kind: "recorded", tellId: admitted.tell.id };
}

async function wakeTell(paths: AkumaPaths, tellId: string): Promise<TellResult> {
  try {
    await spawnAkumaBody({ paths });
    return { admission: { tellId, fact: "recorded" }, wake: "spawned" };
  } catch (error) {
    return {
      admission: { tellId, fact: "recorded" },
      wake: { kind: "failed", diagnostic: error instanceof Error ? error.message : String(error) },
    };
  }
}

function collarProbe(snapshot: HeartSnapshot): CollarProbe {
  if (snapshot.latestBody === null) return { kind: "gone", end: null };
  const probe = probeProcessTree(snapshot.latestBody.collar);
  if (probe.kind === "gone") return { kind: "gone", end: snapshot.latestBody.end ?? null };
  return probe;
}

function bornListRow(paths: AkumaPaths, expected: AkuId, snapshot = readHeart(paths)): AkumaListRow {
  if (snapshot.soul === null) throw new AkumaNotBornError(expected);
  if (snapshot.soul.id !== expected) throw new Error("Akuma soul does not match its coordinate");
  const collar = collarProbe(snapshot);
  return {
    id: snapshot.soul.id,
    archetype: snapshot.soul.archetype,
    ...(snapshot.soul.description === undefined ? {} : { description: snapshot.soul.description }),
    life: life(probeLeash(paths), collar, snapshot.latestBody, snapshot.latestKill),
    collar,
    confinement: snapshot.soul.confinement,
    pending: snapshot.pending.map((tell) => tell.id),
  };
}

function bornStatus(paths: AkumaPaths, expected: AkuId, profile: "status" | "feedback" = "status"): AkumaStatus {
  const snapshot = readHeart(paths);
  if (snapshot.soul === null) throw new AkumaNotBornError(expected);
  const current = bornListRow(paths, expected, snapshot);
  const latest = readCurrentTurn(paths);
  const resumeUnsupported = current.life === "stranded"
    && snapshot.latestSession?.provider === snapshot.soul.provider.name
    && providerNamed(snapshot.soul.provider).resume === undefined;
  return {
    ...current,
    ...(latest === null ? {} : { outcomeAt: latest.completedAt }),
    ...(latest?.outcome.kind === "answered"
      ? { answer: latest.outcome.answer, answerHistoryId: latest.outcome.historyId }
      : {}),
    ...(latest?.outcome.kind === "failed" ? { failure: latest.outcome.diagnostic } : {}),
    ...(resumeUnsupported ? { strandedReason: "resume-unsupported" as const } : {}),
    activity: (() => {
      const slice = activitySlice(paths, { limit: Number.MAX_SAFE_INTEGER });
      return selectActivitySnapshot(slice.rows, {
        lowestRetained: slice.lowestRetained,
        highest: slice.highest,
        profile,
      });
    })(),
  };
}

/** Package-internal compact observation for action feedback. */
export function readActionFeedbackStatus(worldPath: WorldRoot, id: AkuId): AkumaStatus {
  return bornStatus(pathsForAkuId(worldPath, id), id, "feedback");
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AkumaHandle {
  constructor(readonly id: AkuId, private readonly worldPath: WorldRoot) {}

  private get paths(): AkumaPaths {
    return pathsForAkuId(this.worldPath, this.id);
  }

  status(): AkumaStatus {
    return bornStatus(this.paths, this.id);
  }

  history(input: Readonly<{ before?: number; since?: number; limit?: number }> = {}): ActivityHistory {
    if (input.before !== undefined && input.since !== undefined) {
      throw new TypeError("Akuma history before and since are mutually exclusive");
    }
    for (const [name, value] of [["before", input.before], ["since", input.since]] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new TypeError(`Akuma history ${name} must be a positive safe integer`);
      }
    }
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 5_000) {
      throw new TypeError("Akuma history limit must be a positive safe integer no greater than 5000");
    }
    const slice = activitySlice(this.paths, {
      ...(input.before === undefined ? {} : { before: input.before }),
      ...(input.since === undefined ? {} : { since: input.since }),
      limit: 5_000,
    });
    return projectActivityHistory(slice, readTurns(this.paths), {
      since: input.since !== undefined,
      limit,
    });
  }

  async wait(
    predicate: (status: AkumaStatus) => boolean = (status) => status.life !== "running",
    options: Readonly<{ timeoutMs?: number }> = {},
  ): Promise<AkumaStatus> {
    if (options.timeoutMs !== undefined
      && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
      throw new TypeError("Akuma wait timeoutMs must be a nonnegative finite millisecond duration");
    }
    const deadline = options.timeoutMs === undefined ? undefined : performance.now() + options.timeoutMs;
    for (;;) {
      const status = this.status();
      if (predicate(status) || (deadline !== undefined && performance.now() >= deadline)) return status;
      await wait(deadline === undefined ? POLL_MS : Math.min(POLL_MS, Math.max(0, deadline - performance.now())));
    }
  }

  async tell(body: string): Promise<TellResult> {
    const recorded = recordTellBody(this.paths, this.id, body);
    return await wakeTell(this.paths, recorded.tellId);
  }

  async interrupt(body: string): Promise<InterruptReceipt> {
    if (requestPause(this.paths, new Date().toISOString()).kind === "not-born") {
      throw new AkumaNotBornError(this.id);
    }

    let putDown: "was-idle" | "self-aborted" | "collar" = "was-idle";
    let leash = HeldAkumaLeash.try(this.paths);
    if (leash === null) {
      leash = await takeLeashUntil(this.paths, performance.now() + KILL_GRACE_MS);
      putDown = "self-aborted";
    }
    if (leash === null) {
      const current = readHeart(this.paths).latestBody;
      if (current === null) return { kind: "unstoppable", evidence: "no-collar" };
      if (probeProcessTree(current.collar).kind === "unverifiable") {
        return { kind: "unstoppable", evidence: "collar-unverifiable" };
      }
      const evidence = await putDownProcessTree(current.collar);
      if (evidence === "unavailable" || evidence === "alive-after-sigkill") {
        return { kind: "unstoppable", evidence };
      }
      leash = await takeLeashUntil(this.paths, performance.now() + KILL_GRACE_MS);
      if (leash === null) return { kind: "unstoppable", evidence: "leash-held-after-put-down" };
      putDown = "collar";
    }

    let recorded: Readonly<{ kind: "recorded"; tellId: string }>;
    try {
      const id = randomUUID();
      const admitted = leash.recordInterruptTell(this.paths, {
        id,
        body,
        recordedAt: new Date().toISOString(),
      });
      if (admitted.kind === "not-born") throw new AkumaNotBornError(this.id);
      recorded = { kind: "recorded", tellId: admitted.tell.id };
    } finally {
      leash.release();
    }
    return { kind: "interrupted", putDown, tell: await wakeTell(this.paths, recorded.tellId) };
  }

  async fork(input: Readonly<{ at: string }>): Promise<ForkReceipt> {
    const source = readSoul(this.paths);
    if (source === null) throw new AkumaNotBornError(this.id);
    if (source.id !== this.id) throw new Error("Akuma soul does not match its coordinate");
    const adapter = providerNamed(source.provider);
    if (adapter.fork === undefined) return { kind: "provider-cannot-fork", provider: source.provider.name };
    const point = readForkPoint(this.paths, input.at);
    if (point === null) return { kind: "unknown-history", at: input.at };
    if (point.provider !== source.provider.name) throw new Error(`Akuma fork point ${input.at} has a mismatched provider`);

    let childSession: ResumeCoordinate;
    try {
      childSession = (await adapter.fork({ session: point.session, at: point.historyId, cwd: point.cwd })).session;
    } catch (error) {
      return { kind: "fork-failed", diagnostic: diagnostic(error) };
    }

    const admittedAt = new Date().toISOString();
    const birthSession: Omit<SessionFact, "sequence"> = {
      provider: point.provider,
      coordinate: childSession,
      cwd: point.cwd,
      options: point.options,
      admittedAt,
    };
    try {
      const child = await publishAkuma({
        worldPath: this.worldPath,
        archetype: source.archetype,
        awaitAsleep: true,
        launch: async (allocated) => await spawnAkumaBody({
          paths: allocated.paths,
          seed: {
            id: allocated.id,
            archetype: source.archetype,
            ...(source.description === undefined ? {} : { description: source.description }),
            provider: source.provider,
            options: source.options,
            cwd: source.cwd,
            origin: { kind: "fork", parent: this.id, at: input.at },
            confinement: source.confinement,
          },
          birthSession,
        }),
      });
      return { kind: "forked", child: child.id };
    } catch (error) {
      return { kind: "upstream-forked", childSession, diagnostic: diagnostic(error) };
    }
  }

  async kill(): Promise<KillEvidence> {
    const at = new Date().toISOString();
    const request = requestStop(this.paths, at);
    if (request.kind === "already-killed") return "already-killed";
    const target = request.body;
    const graceDeadline = performance.now() + KILL_GRACE_MS;
    while (probeLeash(this.paths) === "held" && performance.now() < graceDeadline) await wait(POLL_MS);
    if (readKill(this.paths, target.sequence) !== null) return "killed";
    const targetProbe = probeProcessTree(target.collar);
    if (targetProbe.kind === "unverifiable") return "unavailable";
    if (targetProbe.kind === "alive") {
      const evidence = await putDownProcessTree(target.collar);
      if (evidence === "unavailable" || evidence === "alive-after-sigkill") return evidence;
    }
    const leash = await takeLeashUntil(this.paths, performance.now() + KILL_GRACE_MS);
    if (leash === null) return readKill(this.paths, target.sequence) === null ? "unavailable" : "killed";
    try {
      const settled = leash.settleStop(this.paths, target.sequence);
      if (settled === null) return "unavailable";
      return "killed";
    } finally {
      leash.release();
    }
  }

  lastAnswer(): LastAnswer {
    const turn = readLastAnsweredTurn(this.paths);
    return turn?.outcome.kind === "answered"
      ? { kind: "answer", answer: turn.outcome.answer }
      : { kind: "no-answer" };
  }
}

export type LastAnswer =
  | Readonly<{ kind: "answer"; answer: string }>
  | Readonly<{ kind: "no-answer" }>;

export class Akuma {
  private constructor(private readonly path: WorldRoot, private readonly configuredSettings?: Settings) {}

  static of(root: WorldRoot, settings?: Settings): Akuma {
    if (typeof root !== "string") throw new TypeError("Akuma.of root must be a WorldRoot");
    return new Akuma(root, settings);
  }

  private settings(): Settings {
    return this.configuredSettings ?? readSettings({ root: this.path });
  }

  of(input: Readonly<{ id: string }>): AkumaHandle {
    return new AkumaHandle(parseAkuId(input.id).id, this.path);
  }

  listArchetypes(): readonly string[] {
    return readArchetypes({ settings: this.settings() });
  }

  async call(input: Readonly<{ archetype: string; body: string; cwd?: string }>): Promise<AkumaHandle> {
    const name = archetypeName(input.archetype);
    const archetype = loadArchetype({ name, settings: this.settings() });
    const provider = archetype.adapter;
    const cwd = resolve(input.cwd ?? this.path);
    const recipe = Object.freeze({
      ...(archetype.description === undefined ? {} : { description: archetype.description }),
      provider: archetype.provider,
      options: archetype.options,
      confinement: provider.confinement({ cwd, options: archetype.options }),
    });
    const requests = injectedBodyRequests();
    if (requests !== null) {
      const child = await requestBodyCall({
        directory: requests,
        id: randomUUID(),
        world: this.path,
        archetype: name,
        body: input.body,
        cwd,
        recipe,
      });
      return new AkumaHandle(child, this.path);
    }
    const published = await publishAkuma({
      worldPath: this.path,
      archetype: archetype.name,
      launch: async (allocated) => await spawnAkumaBody({
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          archetype: allocated.archetype,
          ...(archetype.description === undefined ? {} : { description: archetype.description }),
          provider: archetype.provider,
          options: archetype.options,
          cwd,
          origin: { kind: "direct" },
          confinement: recipe.confinement,
        },
        initialBody: input.body,
      }),
    });
    return new AkumaHandle(published.id, this.path);
  }

  list(input: AkumaListInput = {}): AkumaList {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new TypeError("Akuma list input must be an object");
    }
    const unknown = Object.keys(input).find((key) => key !== "archetype");
    if (unknown !== undefined) throw new TypeError(`Akuma list input has unknown field: ${unknown}`);
    const selected = input.archetype === undefined ? undefined : archetypeName(input.archetype);
    const runRoot = akumaRunRoot(this.path);
    let names: string[];
    try {
      names = readdirSync(runRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rows: [], searched: [runRoot] };
      throw error;
    }
    const rows: AkumaList["rows"] = names.flatMap((name): AkumaList["rows"] => {
      try {
        const physical = akuIdFromDirectoryName(name);
        if (selected !== undefined && physical.archetype !== selected) return [];
        const paths = akumaPaths({ runRoot, archetype: physical.archetype, suffix: physical.suffix });
        const snapshot = readHeart(paths);
        if (snapshot.soul !== null) return [bornListRow(paths, physical.id, snapshot)];
        if (probeLeash(paths) === "held") return [{ id: physical.id, life: "unborn" as const }];
        const seal = readSeal(paths);
        return seal === null
          ? [{ id: physical.id, life: "unborn" as const }]
          : [{ id: physical.id, life: "stillborn" as const, seal }];
      } catch {
        return [];
      }
    });
    return {
      rows,
      searched: [runRoot],
    };
  }
}
