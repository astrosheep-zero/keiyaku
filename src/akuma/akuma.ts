import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnAkumaBody } from "./body.js";
import {
  HeldAkumaLeash,
  activityAfter,
  life,
  probeLeash,
  readHeart,
  readHistory,
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
  type TurnFact,
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
import type { AgentEvent } from "./provider.js";
import { loadPersona } from "./persona.js";
import { publishAkuma } from "./publication.js";
import { providerNamed } from "./providers/index.js";
import { injectedBodyRequests, requestBodyCall } from "./requests.js";
import { probeProcessTree, putDownProcessTree } from "../runtime/proc/run.js";

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
  failure?: string;
  history: readonly TurnFact[];
}>;

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
  const history = readHistory(paths);
  const latest = history.at(-1)?.outcome;
  return {
    ...current,
    ...(latest?.kind === "answered" ? { answer: latest.answer } : {}),
    ...(latest?.kind === "failed" ? { failure: latest.diagnostic } : {}),
    history,
  };
}

function eventFrom(value: unknown): AgentEvent {
  if (value === null || typeof value !== "object") throw new Error("Akuma activity is not an event object");
  const event = value as { type?: unknown; coordinate?: unknown; text?: unknown; note?: unknown; kind?: unknown };
  if (event.type === "assistant" && typeof event.text === "string") return { type: "assistant", text: event.text };
  if (event.type === "action" && typeof event.note === "string") return { type: "action", note: event.note };
  if (event.type === "unknown" && typeof event.kind === "string") return { type: "unknown", kind: event.kind };
  if (event.type === "session" && event.coordinate !== null && typeof event.coordinate === "object") {
    const sessionId = (event.coordinate as { sessionId?: unknown }).sessionId;
    if (typeof sessionId === "string") return { type: "session", coordinate: { sessionId } };
  }
  throw new Error("Akuma activity has an invalid event shape");
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

  async *follow(): AsyncIterable<AgentEvent> {
    let sequence = 0;
    for (;;) {
      const rows = activityAfter(this.paths, sequence);
      for (const row of rows) {
        sequence = row.sequence;
        yield eventFrom(row.event);
      }
      if (bornListRow(this.paths, this.id).life !== "running" && activityAfter(this.paths, sequence).length === 0) return;
      await wait(POLL_MS);
    }
  }

  async wait(predicate: (status: AkumaStatus) => boolean = (status) => status.life !== "running"): Promise<AkumaStatus> {
    for (;;) {
      const status = this.status();
      if (predicate(status)) return status;
      await wait(POLL_MS);
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
    if (adapter.fork === undefined) return { kind: "provider-cannot-fork", provider: source.provider };
    const point = readForkPoint(this.paths, input.at);
    if (point === null) return { kind: "unknown-history", at: input.at };
    if (point.provider !== source.provider) throw new Error(`Akuma fork point ${input.at} has a mismatched provider`);

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
}

export class Akuma {
  private constructor(private readonly path: string) {}

  static at(input: Readonly<{ path: string }>): Akuma {
    return new Akuma(resolve(input.path));
  }

  of(input: Readonly<{ id: string }>): AkumaHandle {
    return new AkumaHandle(parseAkuId(input.id).id, this.path);
  }

  async call(input: Readonly<{ persona: string; body: string; cwd?: string; contract?: string }>): Promise<AkumaHandle> {
    const name = personaName(input.persona);
    const contract = input.contract === undefined ? undefined : contractId(input.contract);
    const requests = injectedBodyRequests();
    if (requests !== null) {
      const child = await requestBodyCall({
        directory: requests,
        id: randomUUID(),
        world: this.path,
        persona: name,
        body: input.body,
        ...(input.cwd === undefined ? {} : { cwd: resolve(input.cwd) }),
        ...(contract === undefined ? {} : { contract }),
      });
      return new AkumaHandle(child, this.path);
    }
    const persona = loadPersona({ name });
    const provider = persona.adapter;
    const cwd = resolve(input.cwd ?? this.path);
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
          confinement: provider.confinement({ cwd, options: persona.options }),
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
    return {
      rows: names.map((name) => {
        const physical = akuIdFromDirectoryName(name);
        const paths = akumaPaths({ runRoot, persona: physical.persona, suffix: physical.suffix });
        const snapshot = readHeart(paths);
        if (snapshot.soul !== null) return bornListRow(paths, physical.id, snapshot);
        if (probeLeash(paths) === "held") return { id: physical.id, life: "unborn" as const };
        const seal = readSeal(paths);
        return seal === null
          ? { id: physical.id, life: "unborn" as const }
          : { id: physical.id, life: "stillborn" as const, seal };
      }),
      searched: [runRoot],
    };
  }
}
