import { realpath } from "node:fs/promises";
import type { OwnedSubscription, PaseoAgent, PaseoAgentListResult, PaseoApi } from "@getpaseo/client";
import { persistedMirrorIdentity } from "./mirror-identity.js";
import { raceAbort } from "./transport.js";

const FILTER = { includeArchived: true, includeBackground: true };
const STATUS_GROUPS: PaseoAgent["status"][][] = [["running", "initializing"], ["idle", "error", "closed"]];
const MAX_BUFFERED_AGENTS = 4096;
type Candidate = Readonly<Pick<PaseoAgent, "id" | "archivedAt">>;
type Fact = Candidate & Readonly<{
  updatedAt: string;
  native?: { provider: string; sessionId: string };
  mirror?: { world: string; akuId: string };
}>;
type Generation = {
  controller: AbortController;
  subscription?: OwnedSubscription<PaseoAgentListResult>;
  unsubscribe?: () => void;
  subscriptionId?: string;
  complete: boolean;
  facts: Map<string, Fact>;
  members: Map<string, Set<string>>;
  revisions: Map<string, number>;
  buffered: Map<string, Fact | undefined>;
  seed: Promise<void>;
};

export class StaleDirectory extends Error {
  constructor(message = "Paseo directory evidence changed") { super(message); }
}

function fact(agent: PaseoAgent): Fact {
  const persistence = agent.persistence;
  const provider = persistence?.metadata?.provider ?? persistence?.provider;
  const mirror = persistedMirrorIdentity(agent);
  return { id: agent.id, archivedAt: agent.archivedAt, updatedAt: agent.updatedAt,
    ...(typeof provider === "string" && persistence?.sessionId
      ? { native: { provider, sessionId: persistence.sessionId } } : {}),
    ...(mirror ? { mirror } : {}),
  };
}
const nativeKey = (provider: string, sessionId: string) => JSON.stringify(["native", provider, sessionId]);
const mirrorKey = (akuId: string) => JSON.stringify(["mirror", akuId]);
const keys = (value: Fact) => [
  ...(value.native ? [nativeKey(value.native.provider, value.native.sessionId)] : []),
  ...(value.mirror ? [mirrorKey(value.mirror.akuId)] : []),
];
const identity = ({ updatedAt: _updatedAt, ...value }: Fact) => JSON.stringify(value);

/** One activation owns this directory, independently of registration handoff. */
export function createDirectoryIndex() {
  let current: Generation | undefined;
  let closed = false;
  const jobs = new Set<Promise<unknown>>();
  const track = <T>(job: Promise<T>): Promise<T> => {
    jobs.add(job);
    void job.finally(() => jobs.delete(job)).catch(() => {});
    return job;
  };
  const release = (subscription: OwnedSubscription<PaseoAgentListResult>) => track(subscription.release().catch((error: unknown) => {
    console.warn(`Keiyaku directory subscription cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }));
  function retire(generation: Generation, reason: unknown = new StaleDirectory()): void {
    if (current === generation) current = undefined;
    generation.complete = false;
    generation.controller.abort(reason);
    generation.unsubscribe?.();
    delete generation.unsubscribe;
    const subscription = generation.subscription;
    delete generation.subscription;
    if (subscription) void release(subscription);
    generation.buffered.clear();
  }
  function check(generation: Generation): void {
    generation.controller.signal.throwIfAborted();
    if (!generation.subscriptionId || generation.subscription?.subscriptionId !== generation.subscriptionId) {
      retire(generation);
      throw new StaleDirectory("Paseo directory connection changed");
    }
  }
  function replace(generation: Generation, id: string, value?: Fact): void {
    const prior = generation.facts.get(id);
    if (prior && value && identity(prior) === identity(value)) {
      generation.facts.set(id, value);
      return;
    }
    const affected = new Set([...(prior ? keys(prior) : []), ...(value ? keys(value) : [])]);
    if (prior) for (const key of keys(prior)) {
      const members = generation.members.get(key)!;
      members.delete(id);
      if (!members.size) generation.members.delete(key);
    }
    generation.facts.delete(id);
    if (value && keys(value).length) {
      generation.facts.set(id, value);
      for (const key of keys(value)) {
        let members = generation.members.get(key);
        if (!members) generation.members.set(key, members = new Set());
        members.add(id);
      }
    }
    for (const key of affected) generation.revisions.set(key, (generation.revisions.get(key) ?? 0) + 1);
  }
  async function bootstrap(generation: Generation, paseo: PaseoApi): Promise<void> {
    const signal = AbortSignal.any([generation.controller.signal, AbortSignal.timeout(4000)]);
    try {
      // The owned stream covers the filter, regardless of this bounded page.
      const result = await raceAbort(signal, () => track(paseo.agents.list({ filter: FILTER,
        page: { limit: 1 }, subscribe: {}, signal: generation.controller.signal }).then((result) => {
        if (generation.controller.signal.aborted) {
          void release(result.subscription);
          throw new StaleDirectory();
        }
        generation.subscription = result.subscription;
        return result;
      })));
      const unsubscribe = result.subscription.subscribe({
        snapshot(snapshot) {
          if (generation.controller.signal.aborted) return;
          if (generation.subscriptionId !== undefined) { retire(generation); return; }
          generation.subscriptionId = snapshot.subscriptionId;
        },
        update(message) {
          if (generation.controller.signal.aborted || message.type !== "agent_update") return;
          try {
            check(generation);
            const update = message.payload;
            const id = update.kind === "upsert" ? update.agent.id : update.agentId;
            const value = update.kind === "upsert" ? fact(update.agent) : undefined;
            if (generation.complete) replace(generation, id, value);
            else {
              generation.buffered.set(id, value);
              if (generation.buffered.size > MAX_BUFFERED_AGENTS) retire(generation, new StaleDirectory("Paseo directory bootstrap update overflow"));
            }
          } catch (error) { retire(generation, error); }
        },
        error(error) { retire(generation, error); },
      });
      generation.unsubscribe = unsubscribe;
      if (generation.controller.signal.aborted) { unsubscribe(); delete generation.unsubscribe; }
      check(generation);
      const staged = new Map<string, Fact>();
      for (const statuses of STATUS_GROUPS) {
        const seen = new Set<string>();
        let cursor: string | undefined;
        for (;;) {
          const page = await raceAbort(signal, () => paseo.agents.list({ filter: { ...FILTER, statuses }, signal,
            page: { limit: 200, ...(cursor ? { cursor } : {}) } }));
          check(generation);
          for (const { agent } of page.entries) {
            const value = fact(agent);
            const prior = staged.get(value.id);
            if (!prior || Date.parse(value.updatedAt) >= Date.parse(prior.updatedAt)) staged.set(value.id, value);
          }
          if (!page.pageInfo.hasMore) break;
          const next = page.pageInfo.nextCursor;
          if (!next || seen.has(next)) throw new Error("incomplete Paseo agent directory pagination");
          seen.add(next);
          cursor = next;
        }
      }
      for (const [id, value] of generation.buffered) {
        if (!value) {
          if (staged.has(id)) throw new StaleDirectory("unordered Paseo directory removal during bootstrap");
        } else {
          const prior = staged.get(id);
          // OwnedSubscription replays updates from before page reads. Never let
          // an older replay undo a newer page; equal conflicting facts cannot prove identity.
          if (prior && identity(prior) !== identity(value)) {
            const order = Date.parse(value.updatedAt) - Date.parse(prior.updatedAt);
            if (order < 0) continue;
            if (!(order > 0)) throw new StaleDirectory("conflicting Paseo directory bootstrap facts");
          }
          staged.set(id, value);
        }
      }
      check(generation);
      for (const value of staged.values()) replace(generation, value.id, value);
      generation.buffered.clear();
      generation.complete = true;
    } catch (error) {
      retire(generation, error);
      throw error;
    }
  }
  return {
    async read(paseo: PaseoApi, signal: AbortSignal) {
      signal.throwIfAborted();
      if (closed) throw new Error("Keiyaku directory index is closed");
      if (current?.complete) {
        try { check(current); } catch { /* Ordinary demand rebuilds disconnected evidence. */ }
      }
      if (!current) {
        const generation: Generation = { controller: new AbortController(), complete: false, facts: new Map(),
          members: new Map(), revisions: new Map(), buffered: new Map(), seed: Promise.resolve() };
        current = generation;
        generation.seed = track(bootstrap(generation, paseo));
      }
      const generation = current;
      await raceAbort(signal, () => generation.seed);
      check(generation);
      const watched = new Map<string, { revision: number; count: number }>();
      function assertCurrent(): void {
        signal.throwIfAborted();
        check(generation);
        for (const [key, { revision }] of watched) if ((generation.revisions.get(key) ?? 0) !== revision) throw new StaleDirectory();
      }
      function candidates(key: string): Fact[] {
        assertCurrent();
        const members = generation.members.get(key);
        watched.set(key, { revision: generation.revisions.get(key) ?? 0, count: members?.size ?? 0 });
        return [...members ?? []].map((id) => generation.facts.get(id)!);
      }
      return {
        signal: generation.controller.signal,
        assertCurrent,
        native(provider: string, sessionId: string): readonly Candidate[] { return candidates(nativeKey(provider, sessionId)); },
        async mirrors(world: string, akuId: string): Promise<readonly Candidate[]> {
          const matching: Candidate[] = [];
          for (const value of candidates(mirrorKey(akuId))) {
            let canonical: string;
            try { canonical = await realpath(value.mirror!.world); }
            catch { throw new Error(`unreadable mirror World for ${akuId}`); }
            if (canonical === world) matching.push(value);
          }
          assertCurrent();
          return matching;
        },
        changed(message?: string): never { assertCurrent(); retire(generation); throw new StaleDirectory(message ?? "Paseo exact agent identity changed"); },
        created(agent: PaseoAgent): void {
          signal.throwIfAborted();
          check(generation);
          const value = fact(agent);
          const ownKey = mirrorKey(value.mirror!.akuId);
          for (const [key, { revision, count }] of watched) {
            const latest = generation.revisions.get(key) ?? 0;
            if (latest === revision) continue;
            // The host may publish our creation before its response. Accept only
            // that single addition, preserving every other watched identity.
            const members = generation.members.get(key);
            const published = generation.facts.get(value.id);
            if (key !== ownKey || latest !== revision + 1 || !published || identity(published) !== identity(value) ||
              members?.size !== count + 1) throw new StaleDirectory();
          }
          replace(generation, agent.id, value);
          watched.set(ownKey, { revision: generation.revisions.get(ownKey) ?? 0, count: generation.members.get(ownKey)!.size });
          assertCurrent();
        },
      };
    },
    async close(): Promise<void> {
      closed = true;
      if (current) retire(current, new Error("Keiyaku directory index is closed"));
      while (jobs.size) await Promise.allSettled([...jobs]);
    },
  };
}
export type DirectoryIndex = ReturnType<typeof createDirectoryIndex>;
export type DirectoryEvidence = Awaited<ReturnType<DirectoryIndex["read"]>>;
