import { realpath } from "node:fs/promises";
import type { PaseoAgent } from "@getpaseo/client";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { z } from "zod";
import type { attachRpc } from "../shared/attach-rpc.js";
import { raceAbort, type StatusReader } from "./transport.js";
import { matchesCanonicalMirror } from "./mirror-identity.js";
import { StaleDirectory, type DirectoryEvidence, type DirectoryIndex } from "./directory.js";

type Input = z.output<typeof attachRpc.input>;
const MAX_ANCESTRY = 32;

function skip(reason: string) {
  console.warn(`Keiyaku mirror not attached: ${reason}`);
  return undefined;
}

/** Each attempt owns its ancestry; daemon creation owns concurrency/idempotency. */
export async function attach(input: Input, { paseo }: PluginHandlerContext, directory: DirectoryIndex, readStatus?: StatusReader) {
  // The installed RPC context has no cancellation signal. Keep the existing local bound.
  const signal = AbortSignal.timeout(4000);
  let evidence: DirectoryEvidence;
  const seen = new Set<string>();
  async function fresh(candidate: { id: string; archivedAt?: PaseoAgent["archivedAt"] }) {
    const result = await raceAbort(signal, () => paseo.agents.ref(candidate.id).refresh());
    evidence.assertCurrent();
    if (!result) evidence.changed(`parent ${candidate.id} does not exist`);
    if (result.agent.id !== candidate.id || result.agent.archivedAt !== candidate.archivedAt)
      evidence.changed(`parent ${candidate.id} changed identity or archive state`);
    return result.agent;
  }
  async function ensure(target: Input): Promise<PaseoAgent | undefined> {
    evidence.assertCurrent();
    const world = await realpath(target.world);
    evidence.assertCurrent();
    const key = `keiyaku:${world}:${target.akuId}`;
    if (seen.has(key) || seen.size >= MAX_ANCESTRY) return skip("cyclic or excessively deep Akuma caller ancestry");
    seen.add(key);
    // Archived/detached children forbid replacement and reparenting too.
    const existing = await evidence.mirrors(world, target.akuId);
    if (existing.length > 1) return skip(`ambiguous mirror for ${target.akuId}`);
    if (existing.length === 1) {
      const agent = await fresh(existing[0]!);
      if (!(await matchesCanonicalMirror(agent, world, target.akuId, true))) evidence.changed(`mirror ${agent.id} changed identity`);
      evidence.assertCurrent();
      return agent;
    }

    let caller = target.caller;
    if (caller === undefined && readStatus !== undefined) {
      const retained = (await readStatus(world, target.akuId, signal)).caller;
      evidence.assertCurrent();
      caller = retained?.kind === "akuma"
        ? { kind: "akuma", world: retained.world, akuId: retained.akumaId } : retained;
    }
    if (caller?.kind === "akuma") {
      const parentWorld = await realpath(caller.world);
      const candidates = await evidence.mirrors(parentWorld, caller.akuId);
      let candidate = candidates[0];
      if (candidates.length === 0 && readStatus !== undefined) {
        candidate = await ensure({ world: parentWorld, akuId: caller.akuId });
        if (!candidate) return undefined;
      }
      if (candidates.length > 1 || !candidate) return skip(candidates.length
        ? `ambiguous Akuma parent ${caller.akuId}: multiple mirrors`
        : `no mirror for Akuma parent ${caller.akuId}`);
      const parent = await fresh(candidate);
      if (parent.archivedAt) return skip(`Akuma parent mirror ${parent.id} is archived`);
      if (!(await matchesCanonicalMirror(parent, parentWorld, caller.akuId))) evidence.changed(`Akuma parent mirror ${parent.id} changed identity`);
      return create(world, target.akuId, parent);
    }
    if (caller?.kind !== "external") return skip("caller is not an external host");
    if (!["codex", "pi", "claude"].includes(caller.integration))
      return skip(`unsupported caller integration ${caller.integration}`);
    const matches = (agent: PaseoAgent) =>
      agent.persistence?.sessionId === caller.id &&
      (agent.persistence.metadata?.provider ?? agent.persistence.provider) === caller.integration;
    const candidates = evidence.native(caller.integration, caller.id);
    if (candidates.length > 1) return skip(`ambiguous ${caller.integration} session ${caller.id}: multiple parents`);
    const candidate = candidates[0];
    if (!candidate) return skip(`no parent for ${caller.integration} session ${caller.id}`);
    const parent = await fresh(candidate);
    if (parent.archivedAt) return skip(`parent ${parent.id} is archived`);
    if (!matches(parent)) evidence.changed(`parent ${parent.id} changed native identity`);
    return create(world, target.akuId, parent);
  }
  async function create(world: string, akuId: string, parent: PaseoAgent) {
    evidence.assertCurrent();
    // Aliases never change this creation fingerprint, including after a rename.
    const handle = await paseo.agents.create({ parent: parent.id, cwd: parent.cwd, title: akuId,
      config: { provider: "keiyaku/mirror", options: { world, akuId } },
      idempotencyKey: `keiyaku:${world}:${akuId}`,
    });
    const created = handle.current();
    if (!created || !(await matchesCanonicalMirror(created, world, akuId)))
      throw new Error(`no matching public snapshot for created mirror ${akuId}`);
    evidence.created(created);
    return created;
  }
  try {
    return await raceAbort(signal, async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          evidence = await directory.read(paseo, signal);
          seen.clear();
          return { attached: Boolean(await ensure(input)) };
        } catch (error) {
          if (!(error instanceof StaleDirectory) || attempt === 1) throw error;
        }
      }
    });
  } catch (error) {
    skip(error instanceof Error ? error.message : String(error));
    return { attached: false };
  }
}
