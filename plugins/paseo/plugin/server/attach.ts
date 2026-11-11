import { realpath } from "node:fs/promises";
import type { PaseoAgent } from "@getpaseo/client";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { z } from "zod";
import type { attachRpc } from "../shared/attach-rpc.js";
import { raceAbort, type StatusReader } from "./transport.js";
import { listMirrorCandidates, matchesCanonicalMirror } from "./mirror-identity.js";

type Input = z.output<typeof attachRpc.input>;
const MAX_ANCESTRY = 32;

function skip(reason: string) {
  console.warn(`Keiyaku mirror not attached: ${reason}`);
  return { attached: false };
}

/** Each attempt owns its ancestry; daemon creation owns concurrency/idempotency. */
export async function attach(input: Input, { paseo }: PluginHandlerContext, readStatus?: StatusReader) {
  const seen = new Set<string>();
  // The installed RPC context has no cancellation signal. Fence local custody
  // with a deadline; list supports cancellation, refresh/create do not.
  const signal = AbortSignal.timeout(4000);
  async function ensure(target: Input): Promise<{ attached: boolean }> {
    signal.throwIfAborted();
    const world = await realpath(target.world);
    const key = `keiyaku:${world}:${target.akuId}`;
    if (seen.has(key) || seen.size >= MAX_ANCESTRY) return skip("cyclic or excessively deep Akuma caller ancestry");
    seen.add(key);
    // Include archived/detached children: host intent forbids a replacement or reparent.
    const existing = await listMirrorCandidates(paseo, world, target.akuId, true, signal);
    if (existing.length > 1) return skip(`ambiguous mirror for ${target.akuId}`);
    if (existing.length === 1) return { attached: true };

    let caller = target.caller;
    if (caller === undefined && readStatus !== undefined) {
      const retained = (await readStatus(world, target.akuId, signal)).caller;
      caller = retained?.kind === "akuma"
        ? { kind: "akuma", world: retained.world, akuId: retained.akumaId } : retained;
    }
    if (caller?.kind === "akuma") {
      const parentWorld = await realpath(caller.world);
      let candidates = await listMirrorCandidates(paseo, parentWorld, caller.akuId, true, signal);
      if (candidates.length === 0 && readStatus !== undefined) {
        if (!(await ensure({ world: parentWorld, akuId: caller.akuId })).attached) return { attached: false };
        candidates = await listMirrorCandidates(paseo, parentWorld, caller.akuId, true, signal);
      }
      if (candidates.length !== 1) return skip(candidates.length
        ? `ambiguous Akuma parent ${caller.akuId}: multiple mirrors`
        : `no mirror for Akuma parent ${caller.akuId}`);
      const parent = await raceAbort(signal, () => paseo.agents.ref(candidates[0]!.id).refresh());
      if (!parent) return skip(`Akuma parent mirror ${candidates[0]!.id} does not exist`);
      if (parent.agent.archivedAt) return skip(`Akuma parent mirror ${parent.agent.id} is archived`);
      if (parent.agent.id !== candidates[0]!.id || !(await matchesCanonicalMirror(parent.agent, parentWorld, caller.akuId)))
        return skip(`Akuma parent mirror ${parent.agent.id} changed identity`);
      return create(world, target.akuId, parent.agent);
    }
    if (caller?.kind !== "external") return skip("caller is not an external host");
    if (!["codex", "pi", "claude"].includes(caller.integration))
      return skip(`unsupported caller integration ${caller.integration}`);
    const matches = (agent: Pick<PaseoAgent, "persistence">) =>
      agent.persistence?.sessionId === caller.id &&
      (agent.persistence.metadata?.provider ?? agent.persistence.provider) === caller.integration;
    const candidates: string[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      signal.throwIfAborted();
      const page = await raceAbort(signal, () => paseo.agents.list({ filter: { includeArchived: true, includeBackground: true }, signal,
        page: { limit: 200, ...(cursor ? { cursor } : {}) } }));
      for (const { agent } of page.entries) if (matches(agent)) candidates.push(agent.id);
      if (candidates.length > 1) return skip(`ambiguous ${caller.integration} session ${caller.id}: multiple parents`);
      if (!page.pageInfo.hasMore) break;
      const next = page.pageInfo.nextCursor;
      if (!next || cursors.has(next)) return skip("incomplete parent directory pagination");
      cursors.add(next);
      cursor = next;
    }
    if (!candidates[0]) return skip(`no parent for ${caller.integration} session ${caller.id}`);
    const parent = await raceAbort(signal, () => paseo.agents.ref(candidates[0]!).refresh());
    if (!parent) return skip(`parent ${candidates[0]} does not exist`);
    if (parent.agent.archivedAt) return skip(`parent ${parent.agent.id} is archived`);
    if (parent.agent.id !== candidates[0] || !matches(parent.agent)) return skip(`parent ${parent.agent.id} changed native identity`);
    return create(world, target.akuId, parent.agent);
  }
  async function create(world: string, akuId: string, parent: PaseoAgent) {
    signal.throwIfAborted();
    // Aliases never change this creation fingerprint, including after a rename.
    await paseo.agents.create({ parent: parent.id, cwd: parent.cwd, title: akuId,
      config: { provider: "keiyaku/mirror", options: { world, akuId } },
      idempotencyKey: `keiyaku:${world}:${akuId}`,
    });
    return { attached: true };
  }
  try { return await raceAbort(signal, () => ensure(input)); }
  catch (error) { return skip(error instanceof Error ? error.message : String(error)); }
}
