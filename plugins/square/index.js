import { DeliveryLedger, deliveryLedgerLocation, harnessOwner, requireOwner, postAndDispatch, dispatchEligibleCards, } from "@astrosheep/square";
const TURN_HISTORY = /^turn\/[1-9]\d*$/u;
const WAIT_TTL_MS = 5 * 60_000;
const WAIT_RENEW_MS = 2 * 60_000;
function localOwner(environment) {
    const explicit = environment.KEIYAKU_INITIATOR?.trim();
    if (explicit)
        return requireOwner(explicit);
    if (environment.CLAUDE_CODE_CHILD_SESSION === "1")
        return undefined;
    const coordinates = [
        ["CLAUDE_CODE_SESSION_ID", "claude-code"],
        ["CODEX_THREAD_ID", "codex"],
        ["OPENCODE_SESSION_ID", "opencode"],
        ["PI_SESSION_ID", "pi"],
    ].flatMap(([variable, channel]) => {
        const session = environment[variable]?.trim();
        return session ? [{ channel: channel, session }] : [];
    });
    if (coordinates.length > 1)
        return undefined;
    const paseo = environment.PASEO_AGENT_ID?.trim();
    const coordinate = coordinates[0] ?? (paseo ? { channel: "paseo", session: paseo } : undefined);
    return coordinate === undefined ? undefined : harnessOwner(coordinate);
}
/** Bound an operation without abandoning the connection its late work still owns. */
async function bounded(work, signal) {
    let abort;
    const cancelled = new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        if (signal.aborted)
            abort();
        else
            signal.addEventListener("abort", abort, { once: true });
    });
    try {
        return await Promise.race([work, cancelled]);
    }
    finally {
        signal.removeEventListener("abort", abort);
    }
}
/** An invoked external effect may settle after the bounded handler has retired. */
function ledgerLifetime(ledger) {
    const pending = new Set();
    let retired = false;
    let closing;
    const closeOnce = () => (closing ??= ledger.close());
    const own = (work) => {
        pending.add(work);
        const settled = () => {
            pending.delete(work);
            if (retired && pending.size === 0)
                void closeOnce().catch(console.error);
        };
        void work.then(settled, settled);
        return work;
    };
    return {
        own,
        track(result) {
            if (result.lateSettlement !== undefined)
                own(result.lateSettlement);
        },
        async close() {
            retired = true;
            if (pending.size === 0)
                await closeOnce();
        },
    };
}
function turnOutcomeBody(signal) {
    const { kind } = signal.outcome;
    const verdict = kind === "failed" ? "× failed" : kind === "canceled" ? "○ canceled" : "✓ done";
    const result = kind === "failed" ? signal.outcome.reason : kind === "answered" ? signal.outcome.text : "";
    const footer = [
        `\`turn/${signal.turnSequence}\``,
        signal.contractId === undefined ? undefined : `\`${signal.contractId}\``,
    ]
        .filter((value) => value !== undefined)
        .join(" · ");
    const head = `\`${signal.akumaId}\` ${verdict}`;
    return result.trim() === "" ? `${head}\n\n---\n\n${footer}` : `${head}\n${result}\n\n---\n\n${footer}`;
}
function bodyEndExpression(signal) {
    const diagnostic = signal.diagnostic === undefined ? "" : `: ${signal.diagnostic}`;
    const footer = [
        `\`body/${signal.bodySequence}\``,
        signal.initiator === undefined ? undefined : `requested by ${signal.initiator}`,
        signal.contractId === undefined ? undefined : `\`${signal.contractId}\``,
        "ignore if you have already seen this.",
    ]
        .filter((value) => value !== undefined)
        .join(" · ");
    return `\`${signal.akumaId}\` × interrupted\n${signal.end}${diagnostic}\n\n---\n\n${footer}`;
}
const bodyKey = (signal) => `${signal.akumaId}/body/${signal.bodySequence}`;
const plugin = {
    manifest: { id: "square", apiVersion: 1 },
    async activate() {
        const environment = { ...process.env };
        const location = deliveryLedgerLocation(environment);
        const bodyNotifications = new Map();
        const serialize = (signal, operation) => {
            const key = bodyKey(signal);
            const state = bodyNotifications.get(key) ?? { tail: Promise.resolve(), terminalRecipients: new Set() };
            bodyNotifications.set(key, state);
            const result = state.tail.then(() => operation(state));
            state.tail = result.catch(() => { });
            return result;
        };
        const sendNotice = async (akumaId, ref, body, recipients, cancellation, committed) => {
            cancellation?.throwIfAborted();
            if (!recipients?.length)
                return;
            const ledger = await DeliveryLedger.open({ location });
            const lifetime = ledgerLifetime(ledger);
            try {
                const details = { kind: "presentation", origin: "Keiyaku", author: akumaId, ref, body };
                const results = await Promise.allSettled([...new Set(recipients)].map(async (recipient) => {
                    cancellation?.throwIfAborted();
                    const result = await postAndDispatch(ledger, {
                        owner: requireOwner(recipient),
                        key: `keiyaku/${akumaId}/${ref}`,
                        text: body,
                        details,
                    }, {
                        env: environment,
                        ...(cancellation === undefined ? {} : { signal: cancellation }),
                        track: lifetime.track,
                    });
                    cancellation?.throwIfAborted();
                    if (["posted", "duplicate", "suppressed"].includes(result.status))
                        committed?.(recipient);
                    else if (result.status === "conflict")
                        throw new Error(`Keiyaku card conflict: ${akumaId}/${ref}`);
                }));
                const failed = results.find((result) => result.status === "rejected");
                if (failed)
                    throw failed.reason;
            }
            finally {
                await lifetime.close();
            }
        };
        const waitDeferral = async (input, cancellation) => {
            cancellation?.throwIfAborted();
            const owner = localOwner(environment);
            if (owner === undefined || input.akumaIds.length === 0)
                return undefined;
            const ledger = await DeliveryLedger.open({ location });
            const lifetime = ledgerLifetime(ledger);
            const acquired = [];
            const expired = new Set();
            let closing;
            let timer;
            let renewal;
            let renewalDiagnostic;
            let stopped = false;
            const cleanup = (signal = AbortSignal.timeout(5_000)) => {
                if (closing !== undefined)
                    return closing;
                stopped = true;
                if (timer !== undefined)
                    clearTimeout(timer);
                closing = (async () => {
                    let failure;
                    try {
                        try {
                            await bounded(renewal ?? Promise.resolve(), signal);
                        }
                        catch (error) {
                            failure = error;
                        }
                        // Even an expired cleanup budget starts release; late work retains the ledger.
                        const releases = acquired.map((id) => lifetime.own(ledger.releaseSuppression({ owner, id })));
                        try {
                            await bounded(Promise.all(releases), signal);
                        }
                        catch (error) {
                            failure ??= error;
                        }
                        if (!signal.aborted) {
                            await bounded(lifetime.own(dispatchEligibleCards(ledger, owner, {
                                env: environment,
                                signal,
                                track: lifetime.track,
                            })), signal);
                        }
                        if (failure !== undefined)
                            throw failure;
                        if (renewalDiagnostic !== undefined)
                            throw renewalDiagnostic;
                    }
                    finally {
                        await lifetime.close();
                    }
                })();
                return closing;
            };
            try {
                await Promise.all([...new Set(input.akumaIds)].map((id) => lifetime.own((async () => {
                    cancellation?.throwIfAborted();
                    const result = await ledger.suppress({
                        owner,
                        key: `keiyaku/${id}/turn/`,
                        scope: "prefix",
                        expiresAt: Date.now() + WAIT_TTL_MS,
                    });
                    if (stopped || cancellation?.aborted) {
                        await ledger.releaseSuppression({ owner, id: result.id });
                        cancellation?.throwIfAborted();
                        return;
                    }
                    acquired.push(result.id);
                })())));
                cancellation?.throwIfAborted();
                const renew = () => {
                    if (stopped)
                        return;
                    renewal = Promise.allSettled(acquired
                        .filter((id) => !expired.has(id))
                        .map(async (id) => {
                        if (!(await bounded(lifetime.own(ledger.renewSuppression({ owner, id, expiresAt: Date.now() + WAIT_TTL_MS })), AbortSignal.timeout(5_000)))) {
                            expired.add(id);
                            throw new Error(`Keiyaku wait suppression ${id} expired before renewal`);
                        }
                    }))
                        .then((results) => {
                        const failure = results.find((result) => result.status === "rejected");
                        if (failure)
                            renewalDiagnostic ??= failure.reason;
                    })
                        .finally(() => {
                        if (!stopped && expired.size < acquired.length)
                            timer = setTimeout(renew, WAIT_RENEW_MS);
                    });
                };
                timer = setTimeout(renew, WAIT_RENEW_MS);
                return { close: cleanup };
            }
            catch (error) {
                await cleanup().catch(() => { });
                throw error;
            }
        };
        return {
            waitDeferral,
            signals: {
                async "akuma.reported"(signal, cancellation) {
                    if (signal.initiator === undefined)
                        return;
                    await sendNotice(signal.akumaId, `report/${signal.reportSequence}`, `\`${signal.akumaId}\` ▸ update\n${signal.text}\n\n---\n\n\`report/${signal.reportSequence}\``, [signal.initiator], cancellation);
                },
                async "akuma.outcome-observed"(signal, cancellation) {
                    cancellation?.throwIfAborted();
                    if (!TURN_HISTORY.test(signal.historyId))
                        return;
                    const owner = signal.observer === undefined ? localOwner(environment) : requireOwner(signal.observer);
                    if (owner === undefined)
                        return;
                    const ledger = await DeliveryLedger.open({ location });
                    try {
                        cancellation?.throwIfAborted();
                        await ledger.suppress({ owner, key: `keiyaku/${signal.akumaId}/${signal.historyId}`, scope: "exact" });
                    }
                    finally {
                        await ledger.close();
                    }
                },
                async "akuma.turn-outcome"(signal, cancellation) {
                    await serialize(signal, async (state) => {
                        await sendNotice(signal.akumaId, `turn/${signal.turnSequence}`, turnOutcomeBody(signal), signal.participants, cancellation, (recipient) => {
                            if (signal.outcome.kind !== "answered")
                                state.terminalRecipients.add(recipient);
                        });
                    });
                },
                async "akuma.body-ended"(signal, cancellation) {
                    await serialize(signal, async (state) => {
                        try {
                            if (signal.end === "exited" || signal.end === "put-down")
                                return;
                            await sendNotice(signal.akumaId, `body/${signal.bodySequence}`, bodyEndExpression(signal), signal.participants?.filter((recipient) => !state.terminalRecipients.has(recipient)), cancellation);
                        }
                        finally {
                            if (bodyNotifications.get(bodyKey(signal)) === state)
                                bodyNotifications.delete(bodyKey(signal));
                        }
                    });
                },
            },
        };
    },
};
export default plugin;
