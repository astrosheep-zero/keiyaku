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
  readSeal,
  readSoul,
  recordDeath,
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
  contractId,
  parseAkuId,
  pathsForAkuId,
  personaName,
  type AkumaPaths,
} from "./identity.js";
import type { AkuId } from "./heart/index.js";
import {
  projectActivityHistory,
  selectActivitySnapshot,
  type ActivityHistory,
  type ActivitySnapshot,
} from "./activity.js";
import { loadPersona } from "./persona.js";
import { publishAkuma } from "./publication.js";
import { providerNamed } from "./providers/index.js";
import { injectedBodyRequests, requestBodyCall } from "./requests.js";
import { probeProcessTree, putDownProcessTree } from "../runtime/proc/run.js";
import { settings as readSettings, type Settings } from "../settings.js";

const POLL_MS = 25;
const KILL_GRACE_MS = 1_000;

export type AkumaListRow = Readonly<{
  id: AkuId;
  persona: string;
  description?: string;
  contract?: string;
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
}>;
export type { ActivityHistory, ActivityRow, ActivitySnapshot } from "./activity.js";

export type UnbornAkumaListRow = Readonly<{
  id: AkuId;
  life: "unborn" | "stillborn";
  seal?: Readonly<{ evidence: string; at: string }>;
}>;

export type AkumaList = Readonly<{
  rows: readonly (AkumaListRow | UnbornAkumaListRow)[];
  searched: readonly string[];
}>;

export type TellReceipt = Readonly<{
  id: string;
  state: "recorded";
  wake: "spawned" | Readonly<{ kind: "failed"; diagnostic: string }>;
}>;

export type InterruptReceipt =
  | Readonly<{ kind: "dead" }>
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
      tell: TellReceipt | Readonly<{ kind: "refused-dead" }>;
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

function recordTellBody(paths: AkumaPaths, body: string): Readonly<{ kind: "recorded"; id: string }> | Readonly<{ kind: "dead" }> {
  const id = randomUUID();
  const admitted = recordTell(paths, { id, body, recordedAt: new Date().toISOString() });
  return admitted === "dead" ? { kind: "dead" } : { kind: "recorded", id };
}

async function wakeTell(paths: AkumaPaths, akuma: AkuId, id: string): Promise<TellReceipt> {
  const soul = readSoul(paths);
  if (soul === null) throw new Error(`Akuma ${akuma} has no soul`);
  try {
    await spawnAkumaBody({ paths });
    return { id, state: "recorded", wake: "spawned" };
  } catch (error) {
    return {
      id,
      state: "recorded",
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
    persona: snapshot.soul.persona,
    ...(snapshot.soul.description === undefined ? {} : { description: snapshot.soul.description }),
    ...(snapshot.soul.contract === undefined ? {} : { contract: snapshot.soul.contract }),
    life: life(probeLeash(paths), collar, snapshot.death),
    collar,
    confinement: snapshot.soul.confinement,
    pending: snapshot.pending.map((tell) => tell.id),
  };
}

function bornStatus(paths: AkumaPaths, expected: AkuId): AkumaStatus {
  const snapshot = readHeart(paths);
  if (snapshot.soul === null) throw new AkumaNotBornError(expected);
  const current = bornListRow(paths, expected, snapshot);
  const latest = readCurrentTurn(paths);
  return {
    ...current,
    ...(latest === null ? {} : { outcomeAt: latest.completedAt }),
    ...(latest?.outcome.kind === "answered"
      ? { answer: latest.outcome.answer, answerHistoryId: latest.outcome.historyId }
      : {}),
    ...(latest?.outcome.kind === "failed" ? { failure: latest.outcome.diagnostic } : {}),
    activity: (() => {
      const slice = activitySlice(paths, { limit: 5_000 });
      return selectActivitySnapshot(slice.rows, {
        pending: snapshot.pending,
        lowestRetained: slice.lowestRetained,
        highest: slice.highest,
      });
    })(),
  };
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AkumaHandle {
  constructor(readonly id: AkuId, private readonly worldPath: string) {}

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

  async tell(body: string): Promise<TellReceipt> {
    const recorded = recordTellBody(this.paths, body);
    if (recorded.kind === "dead") throw new Error(`Akuma ${this.id} is dead`);
    return await wakeTell(this.paths, this.id, recorded.id);
  }

  async interrupt(body: string): Promise<InterruptReceipt> {
    if (requestPause(this.paths, new Date().toISOString()) === "dead") return { kind: "dead" };

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

    let recorded: ReturnType<typeof recordTellBody>;
    try {
      leash.clearPause(this.paths);
      recorded = recordTellBody(this.paths, body);
    } finally {
      leash.release();
    }
    if (recorded.kind === "dead") {
      return { kind: "interrupted", putDown, tell: { kind: "refused-dead" } };
    }
    return { kind: "interrupted", putDown, tell: await wakeTell(this.paths, this.id, recorded.id) };
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
        persona: source.persona,
        awaitAsleep: true,
        launch: async (allocated) => await spawnAkumaBody({
          paths: allocated.paths,
          seed: {
            id: allocated.id,
            persona: source.persona,
            ...(source.description === undefined ? {} : { description: source.description }),
            provider: source.provider,
            options: source.options,
            cwd: source.cwd,
            origin: { kind: "fork", parent: this.id, at: input.at },
            confinement: source.confinement,
            ...(source.contract === undefined ? {} : { contract: source.contract }),
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
    if (requestStop(this.paths, at) === "dead") return "already-dead";
    const graceDeadline = performance.now() + KILL_GRACE_MS;
    while (probeLeash(this.paths) === "held" && performance.now() < graceDeadline) await wait(POLL_MS);
    if (probeLeash(this.paths) === "held") {
      const current = readHeart(this.paths).latestBody;
      if (current === null) return "unavailable";
      const evidence = await putDownProcessTree(current.collar);
      if (evidence === "unavailable" || evidence === "alive-after-sigkill") return evidence;
    }
    const releaseDeadline = performance.now() + KILL_GRACE_MS;
    while (probeLeash(this.paths) === "held" && performance.now() < releaseDeadline) await wait(POLL_MS);
    if (probeLeash(this.paths) === "held") return "unavailable";
    return recordDeath(this.paths, { evidence: "killed", at }) === "already-dead" ? "already-dead" : "killed";
  }

  lastAnswer(): string {
    const turn = readLastAnsweredTurn(this.paths);
    return turn?.outcome.kind === "answered" ? turn.outcome.answer : "";
  }
}

export class Akuma {
  private constructor(private readonly path: string, private readonly settings: Settings) {}

  static at(input: Readonly<{ path: string; settings?: Settings }>): Akuma {
    const path = resolve(input.path);
    return new Akuma(path, input.settings ?? readSettings({ root: path }));
  }

  of(input: Readonly<{ id: string }>): AkumaHandle {
    return new AkumaHandle(parseAkuId(input.id).id, this.path);
  }

  async call(input: Readonly<{ persona: string; body: string; cwd?: string; contract?: string }>): Promise<AkumaHandle> {
    const name = personaName(input.persona);
    const contract = input.contract === undefined ? undefined : contractId(input.contract);
    const persona = loadPersona({ name, settings: this.settings });
    const provider = persona.adapter;
    const cwd = resolve(input.cwd ?? this.path);
    const recipe = Object.freeze({
      ...(persona.description === undefined ? {} : { description: persona.description }),
      provider: persona.provider,
      options: persona.options,
      confinement: provider.confinement({ cwd, options: persona.options }),
    });
    const requests = injectedBodyRequests();
    if (requests !== null) {
      const child = await requestBodyCall({
        directory: requests,
        id: randomUUID(),
        world: this.path,
        persona: name,
        body: input.body,
        cwd,
        recipe,
        ...(contract === undefined ? {} : { contract }),
      });
      return new AkumaHandle(child, this.path);
    }
    const published = await publishAkuma({
      worldPath: this.path,
      persona: persona.name,
      launch: async (allocated) => await spawnAkumaBody({
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          persona: allocated.persona,
          ...(persona.description === undefined ? {} : { description: persona.description }),
          provider: persona.provider,
          options: persona.options,
          cwd,
          origin: { kind: "direct" },
          confinement: recipe.confinement,
          ...(contract === undefined ? {} : { contract }),
        },
        initialBody: input.body,
      }),
    });
    return new AkumaHandle(published.id, this.path);
  }

  list(): AkumaList {
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
        const paths = akumaPaths({ runRoot, persona: physical.persona, suffix: physical.suffix });
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
