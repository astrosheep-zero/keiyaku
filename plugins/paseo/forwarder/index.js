import { realpath } from "node:fs/promises";
import { resolvePaseoHome, waitForDaemonReady, readLocalCredentialForTarget } from "@getpaseo/server/daemon-control";
import { buildDaemonWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import WebSocket from "ws";
import { Akumas, World } from "@astrosheep/keiyaku";
const refreshRpc = defineRpc({ name: "refresh",
    input: z.object({ world: z.string(), akuId: z.string() }),
    output: z.object({ woken: z.number().int().nonnegative() }),
});
const attachRpc = defineRpc({ name: "attach",
    input: z.object({ world: z.string(), akuId: z.string(), caller: z.union([
            z.object({ kind: z.literal("akuma"), world: z.string(), akuId: z.string() }),
            z.object({ kind: z.literal("external"), integration: z.string(), id: z.string() }),
            z.object({ kind: z.literal("unknown") }),
        ]).optional() }),
    output: z.object({ attached: z.boolean() }),
});
const mirrorPersistence = z.object({ version: z.literal(1),
    data: z.object({ world: z.string(), akuId: z.string() }) });
// Rename only: this is also the one-shot backfill path for existing mirrors.
export async function syncMirrorTitles(client, path, akuId, signal) {
    const world = await World.prove(await realpath(path));
    signal?.throwIfAborted();
    const mirrors = [];
    let cursor;
    do {
        signal?.throwIfAborted();
        const filter = { includeArchived: true };
        const page = await client.fetchAgents({ filter, ...(signal ? { signal } : {}),
            page: { limit: 200, ...(cursor ? { cursor } : {}) } });
        for (const { agent } of page.entries) {
            if (agent.provider !== "keiyaku" || agent.persistence?.provider !== "keiyaku")
                continue;
            // Paseo exposes our provider's versioned persistence in public snapshot metadata.
            // Do not decode opaque session IDs or inspect the daemon's storage.
            const parsed = mirrorPersistence.safeParse(agent.persistence.metadata?.pluginProviderPersistence);
            if (!parsed.success || (akuId !== undefined && parsed.data.data.akuId !== akuId))
                continue;
            const target = parsed.data.data;
            if (target.world !== world)
                continue;
            mirrors.push({ id: agent.id, akuId: target.akuId, title: agent.title });
        }
        if (!page.pageInfo.hasMore)
            break;
        const next = page.pageInfo.nextCursor;
        if (!next || next === cursor)
            throw new Error("Incomplete mirror directory pagination");
        cursor = next;
    } while (cursor);
    if (mirrors.length === 0)
        return 0;
    const bindings = await Akumas.of(world).aliases({ akumaIds: mirrors.map((mirror) => mirror.akuId) });
    const names = new Map();
    for (const binding of bindings) {
        const current = names.get(binding.akumaId) ?? [];
        current.push(binding.alias);
        names.set(binding.akumaId, current);
    }
    // Finish directory pagination and the one Alias snapshot before any renames.
    let updated = 0;
    for (const mirror of mirrors) {
        const bound = names.get(mirror.akuId);
        const title = bound?.length ? `${bound.join(", ")} (${mirror.akuId})` : mirror.akuId;
        if (mirror.title === title)
            continue;
        signal?.throwIfAborted();
        await client.updateAgent(mirror.id, { name: title });
        updated++;
    }
    return updated;
}
async function connect(signal) {
    const home = resolvePaseoHome({ PASEO_HOME: process.env.PASEO_HOME });
    const { listen } = await waitForDaemonReady(home, { timeoutMs: 1000, signal });
    if (/^(unix|pipe):\/\//u.test(listen))
        throw new Error("Paseo hints require a TCP listen address");
    const token = readLocalCredentialForTarget(home, listen);
    signal.throwIfAborted();
    const client = new DaemonClient({ url: buildDaemonWebSocketUrl(listen, { useTls: false }),
        clientId: "keiyaku-paseo-bridge", clientType: "cli", localCredential: () => token ?? undefined,
        connectTimeoutMs: 1000, reconnect: { enabled: false },
        webSocketFactory: (url, cfg) => new WebSocket(url, cfg?.protocols, { headers: cfg?.headers }) });
    const abort = () => { void client.close(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
        await client.connect();
        signal.throwIfAborted();
        return client;
    }
    catch (error) {
        await client.close();
        throw error;
    }
    finally {
        signal.removeEventListener("abort", abort);
    }
}
// A title attempt owns its short-lived connection, so canceling it cannot retire
// the successful runtime RPC connection. Close and all in-flight work are awaited.
export async function backfillMirrorTitles(path, akuId, signal = AbortSignal.timeout(30_000), openClient = connect) {
    const connected = await openClient(signal);
    let closing;
    const close = () => closing ??= connected.close();
    const abort = () => { void close().catch(() => { }); };
    signal.addEventListener("abort", abort, { once: true });
    try {
        signal.throwIfAborted();
        return await syncMirrorTitles(connected, path, akuId, signal);
    }
    finally {
        signal.removeEventListener("abort", abort);
        await close();
    }
}
export function createForwarder(openClient = connect) {
    return {
        manifest: { id: "paseo", apiVersion: 1 },
        async activate(context) {
            const world = await realpath(context.world);
            const createHintClient = () => {
                let client;
                const hint = async (rpc, input, cancellation) => {
                    const signal = AbortSignal.any([AbortSignal.timeout(1500), ...(cancellation ? [cancellation] : [])]);
                    signal.throwIfAborted();
                    const pending = client ??= openClient(signal);
                    let abort;
                    try {
                        return await Promise.race([
                            (async () => {
                                const connected = await pending;
                                signal.throwIfAborted();
                                return rpc.output.parse(await connected.invokePluginRpc("keiyaku-paseo", rpc.name, rpc.input.parse(input)));
                            })(),
                            new Promise((_, reject) => {
                                abort = () => reject(signal.reason);
                                signal.addEventListener("abort", abort, { once: true });
                            }),
                        ]);
                    }
                    catch (error) {
                        if (client === pending)
                            client = undefined;
                        void pending.then((connected) => connected.close()).catch(() => { });
                        // The host owns the single diagnostic and non-authoritative silence.
                        throw error;
                    }
                    finally {
                        signal.removeEventListener("abort", abort);
                    }
                };
                return { hint, async close() {
                        const previous = client;
                        client = undefined;
                        await previous?.then((connected) => connected.close()).catch(() => { });
                    } };
            };
            const runtime = createHintClient();
            const syncTitles = async (akumaId, cancellation) => {
                const signal = AbortSignal.any([AbortSignal.timeout(1500), ...(cancellation ? [cancellation] : [])]);
                try {
                    await backfillMirrorTitles(world, akumaId, signal, openClient);
                }
                catch (error) {
                    console.warn(`Keiyaku mirror title synchronization failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            };
            const refresh = async (event, cancellation, connection = runtime) => {
                try {
                    await connection.hint(attachRpc, { world, akuId: event.akumaId }, cancellation);
                }
                finally {
                    try {
                        await connection.hint(refreshRpc, { world, akuId: event.akumaId }, cancellation);
                    }
                    finally {
                        await syncTitles(event.akumaId, cancellation);
                    }
                }
            };
            return { signals: { "akuma.turn-started": refresh, "akuma.turn-outcome": refresh,
                    async "akuma.observed"(event, cancellation) {
                        const connection = createHintClient();
                        try {
                            await refresh(event, cancellation, connection);
                        }
                        finally {
                            await connection.close();
                        }
                    },
                    async "akuma.born"(event, cancellation) {
                        const caller = event.caller.kind === "akuma" ? { kind: "akuma", world: event.caller.world, akuId: event.caller.akumaId } : event.caller;
                        const result = await runtime.hint(attachRpc, { world, akuId: event.akumaId, caller }, cancellation);
                        if (!("attached" in result) || !result.attached)
                            return;
                        await syncTitles(event.akumaId, cancellation);
                    },
                    async "akuma.body-ended"(event, cancellation) {
                        try {
                            await refresh(event, cancellation);
                        }
                        finally {
                            await runtime.close();
                        }
                    }, } };
        },
    };
}
export default createForwarder();
