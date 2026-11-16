/** @architectureCompositionRoot */
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { AKUMA_WAIT_POLL_MS, createAkumaWaitObserver } from "../akuma/akuma-wait.js";
import { akumaIdSchema, type AkumaId } from "../akuma/identity.js";
import { akumaWaitItemSchema } from "../akuma/selection-observation.js";
import type { ContractId } from "../core/facts/types.js";
import { outcomePluginObserver, stderrPluginDiagnostic, withAkumaWaitDeferrals } from "../plugin/akuma-signals.js";
import type { WorldRoot } from "../world.js";
import { addressAkumaSet } from "./address.js";
import { contractWaitMemberSchema, createContractWaitObserver } from "./contract-wait.js";
import { scopeForRepo, type Repo } from "./repo.js";

const unknownAkuma = z.strictObject({ kind: z.literal("unknown"), id: akumaIdSchema }).readonly();
const contractMember = z
  .strictObject({ kind: z.literal("contract"), observation: contractWaitMemberSchema })
  .readonly();
const akumaMember = z
  .strictObject({
    kind: z.literal("akuma"),
    observation: z.union([akumaWaitItemSchema, unknownAkuma]),
  })
  .readonly();
export const invocationWaitMemberSchema = z.union([contractMember, akumaMember]);
export const invocationWaitResultSchema = z
  .strictObject({
    kind: z.literal("wait"),
    reason: z.enum(["completed", "deadline", "missing", "unavailable"]),
    members: z.array(invocationWaitMemberSchema).nonempty().readonly(),
  })
  .readonly();
export const invocationWaitNormalResultSchema = invocationWaitResultSchema
  .unwrap()
  .extend({
    reason: z.enum(["completed", "deadline"]),
    members: z
      .array(
        z.union([
          contractMember
            .unwrap()
            .extend({
              observation: contractWaitMemberSchema
                .unwrap()
                .extend({ presence: z.literal("unknown").exactOptional() })
                .readonly(),
            })
            .readonly(),
          akumaMember
            .unwrap()
            .extend({ observation: z.union([akumaWaitItemSchema.options[0], unknownAkuma]) })
            .readonly(),
        ]),
      )
      .nonempty()
      .readonly(),
  })
  .readonly();
export type InvocationWaitMember = z.output<typeof invocationWaitMemberSchema>;
export type InvocationWaitResult = z.output<typeof invocationWaitResultSchema>;

type Subject = Readonly<{ kind: "contract"; id: ContractId }> | Readonly<{ kind: "akuma"; id: AkumaId }>;

function freezeSubjects(selectors: readonly string[], expansions: readonly (readonly AkumaId[])[]): Subject[] {
  let index = 0;
  const seen = new Set<string>();
  return selectors.flatMap((selector): Subject[] => {
    const selected: Subject[] = selector.startsWith("kei/")
      ? [{ kind: "contract", id: selector as ContractId }]
      : expansions[index++]!.map((id) => ({ kind: "akuma", id }));
    return selected.filter(({ id }) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  });
}

type WaitInput = Readonly<{
  selectors: readonly string[];
  repo?: Repo;
  world?: WorldRoot;
  completion?: "any" | "all";
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

/** Freeze selection once, then compose native observations under one invocation deadline. */
export async function waitInvocation(input: WaitInput): Promise<InvocationWaitResult> {
  const akumaSelectors = input.selectors.filter((selector) => !selector.startsWith("kei/"));
  const addressed =
    akumaSelectors.length === 0
      ? undefined
      : await addressAkumaSet(
          {
            path: input.world,
            akuma: akumaSelectors,
            ...(input.repo === undefined ? {} : { repo: input.repo }),
          },
          { contractSelectors: false },
        );
  input.signal?.throwIfAborted();
  const subjects = freezeSubjects(input.selectors, addressed?.selections ?? []);
  return await observeSubjects(input, subjects, addressed);
}

function waitEvidence(
  subjects: readonly Subject[],
  contracts: ReturnType<typeof createContractWaitObserver> | undefined,
  akumas: ReturnType<typeof createAkumaWaitObserver> | undefined,
  completion: "any" | "all" | undefined,
) {
  const members = (): InvocationWaitMember[] => {
    const observed = new Map(contracts?.members().map((member) => [member.id, member]));
    return subjects.map((subject) =>
      subject.kind === "contract"
        ? { kind: "contract", observation: observed.get(subject.id)! }
        : { kind: "akuma", observation: akumas?.items.get(subject.id) ?? { kind: "unknown", id: subject.id } },
    );
  };
  const conclusion = (): InvocationWaitResult["reason"] | undefined => {
    const evidence = members();
    if (evidence.some((member) => member.kind === "contract" && member.observation.presence === "missing"))
      return "missing";
    if (evidence.some((member) => member.kind === "akuma" && member.observation.kind === "missing"))
      return "unavailable";
    const changed = new Set(contracts?.satisfied());
    const satisfied = subjects.map((subject) =>
      subject.kind === "contract" ? changed.has(subject.id) : akumas!.satisfied(subject.id),
    );
    return (completion === "all" ? satisfied.every(Boolean) : satisfied.some(Boolean)) ? "completed" : undefined;
  };
  return {
    conclusion,
    async answer(
      reason: InvocationWaitResult["reason"],
      signal?: AbortSignal,
      initialOnly = false,
    ): Promise<InvocationWaitResult> {
      // Mandatory final processing has its own bounded read allowance, not a new wait.
      if (reason === "deadline" && !initialOnly && akumas !== undefined) {
        const bound = AbortSignal.timeout(5_000);
        try {
          await akumas.observe(signal === undefined ? bound : AbortSignal.any([signal, bound]), true);
        } catch (error) {
          signal?.throwIfAborted();
          if (!bound.aborted) throw error;
          akumas.unavailableRecent("recent activity observation deadline");
        }
      }
      const finalReason = conclusion() ?? reason;
      const finalMembers = members().map((member): InvocationWaitMember => {
        if (finalReason === "deadline" || member.kind !== "akuma" || member.observation.kind !== "observed")
          return member;
        const { events: _events, eventsUnavailable: _unavailable, ...observation } = member.observation;
        return { kind: "akuma", observation };
      });
      return { kind: "wait", reason: finalReason, members: finalMembers };
    },
  };
}

function pacedAkumaRounds(
  observer: ReturnType<typeof createAkumaWaitObserver>,
  completion: "any" | "all",
  initialRecent: boolean,
) {
  let initial = true;
  let next = 0;
  return {
    remaining: () => Math.max(0, next - performance.now()),
    async observe(signal: AbortSignal): Promise<void> {
      if (performance.now() < next) return;
      next = performance.now() + AKUMA_WAIT_POLL_MS;
      if (!initial) {
        let ready: boolean;
        try {
          ready = await observer.probe(completion, signal);
        } catch {
          signal.throwIfAborted();
          ready = true;
        }
        if (!ready) return;
      }
      initial = false;
      await observer.observe(signal, initialRecent);
    },
  };
}

async function observeSubjects(
  input: WaitInput,
  subjects: readonly Subject[],
  addressed: Awaited<ReturnType<typeof addressAkumaSet>> | undefined,
): Promise<InvocationWaitResult> {
  const contracts = subjects.flatMap((subject) => (subject.kind === "contract" ? [subject.id] : []));
  const journals =
    contracts.length === 0 ? undefined : createContractWaitObserver(scopeForRepo(input.repo!), contracts);
  const akumas =
    addressed === undefined ? undefined : createAkumaWaitObserver(addressed.path, addressed.orderedIds, true);
  const deadline = input.timeoutMs === undefined ? Infinity : performance.now() + input.timeoutMs;
  const stop = new AbortController();
  const signal = input.signal === undefined ? stop.signal : AbortSignal.any([input.signal, stop.signal]);
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      expired = true;
      stop.abort();
    } else timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
  };
  // Like native waits, zero still takes an initial snapshot; positive bounds also cover reads.
  if (input.timeoutMs !== undefined && input.timeoutMs > 0) schedule();
  const { conclusion, answer } = waitEvidence(subjects, journals, akumas, input.completion);
  const akumaRounds =
    akumas === undefined ? undefined : pacedAkumaRounds(akumas, input.completion ?? "any", input.timeoutMs === 0);
  const observe = async (): Promise<InvocationWaitResult> => {
    let reason: InvocationWaitResult["reason"] | undefined;
    let failure: { error: unknown } | undefined;
    try {
      for (;;) {
        const round = async (read: () => Promise<unknown>): Promise<void> => {
          try {
            await read();
            reason ??= conclusion();
            if (reason !== undefined) stop.abort();
          } catch (error) {
            if (!signal.aborted) {
              failure = { error };
              stop.abort(error);
            }
          }
        };
        // Await retirement of both reads even when one family completes, fails or is cancelled.
        await Promise.all([
          ...(journals === undefined ? [] : [round(() => journals.observe(signal))]),
          ...(akumaRounds === undefined ? [] : [round(() => akumaRounds.observe(signal))]),
        ]);
        input.signal?.throwIfAborted();
        if (failure !== undefined) throw failure.error;
        reason ??= conclusion();
        if (reason !== undefined || expired || performance.now() >= deadline) {
          return await answer(reason ?? "deadline", input.signal, input.timeoutMs === 0);
        }
        const remaining = Math.min(akumaRounds?.remaining() ?? Infinity, deadline - performance.now());
        await delay(journals === undefined ? remaining : Math.min(100, remaining), undefined, { signal });
      }
    } catch (error) {
      input.signal?.throwIfAborted();
      if (expired) return await answer(conclusion() ?? "deadline", input.signal, input.timeoutMs === 0);
      throw error;
    }
  };
  try {
    const result =
      addressed === undefined
        ? await observe()
        : await withAkumaWaitDeferrals(
            { world: addressed.path, reportDiagnostic: stderrPluginDiagnostic },
            { akumaIds: addressed.orderedIds },
            input.signal,
            observe,
          );
    if (addressed !== undefined)
      await akumas!.notify(outcomePluginObserver({ world: addressed.path, reportDiagnostic: stderrPluginDiagnostic }));
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    akumas?.clear();
  }
}
