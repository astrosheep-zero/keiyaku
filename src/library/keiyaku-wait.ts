/** @architectureCompositionRoot */
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { createAkumaWaitObserver, isWaitAbort, startWaitClock, waitReportSchema } from "../akuma/akuma-wait.js";
import { OBSERVATION_POLL_MS } from "../akuma/akuma-observe.js";
import type { AkumaId } from "../akuma/identity.js";
import { akumaWaitItemSchema } from "../akuma/selection-observation.js";
import type { ContractId } from "../core/facts/types.js";
import { errorCategory, KeiyakuError } from "../errors.js";
import { contractIdSchema } from "../git/identity.js";
import { outcomePluginObserver, stderrPluginDiagnostic, withAkumaWaitDeferrals } from "../plugin/akuma-signals.js";
import { contractSummarySchema } from "../protocol/read/status.js";
import type { WorldRoot } from "../world.js";
import { addressAkumaSet } from "./address.js";
import { createContractWaitObserver, type ContractWaitMember } from "./contract-wait.js";
import { scopeForRepo, type Repo } from "./repo.js";

const contractMember = contractSummarySchema
  .unwrap()
  .pick({ title: true, gates: true })
  .extend({
    contract: contractIdSchema,
    phase: contractSummarySchema.unwrap().shape.phase.exactOptional(),
    state: z.enum(["changed", "accepted", "abandoned", "waiting", "missing", "unavailable"]),
  })
  .readonly();
const akumaMember = z.union(
  akumaWaitItemSchema.options.map((member) =>
    member.unwrap().extend({ report: waitReportSchema.exactOptional() }).readonly(),
  ),
);
export const invocationWaitMemberSchema = z.union([contractMember, akumaMember]);
export type InvocationWaitMember = z.output<typeof invocationWaitMemberSchema>;
const waitResult = z
  .strictObject({
    kind: z.literal("wait"),
    members: z.array(invocationWaitMemberSchema).nonempty().readonly(),
    elapsedMs: z.number().int().nonnegative().exactOptional(),
  })
  .readonly();
export const invocationWaitResultSchema = waitResult;
export type InvocationWaitResult = z.output<typeof invocationWaitResultSchema>;

const incompleteStates = ["running", "waiting"] as const;
const failedStates = ["failed", "canceled", "missing", "unavailable"] as const;
const hasState = (result: InvocationWaitResult, states: readonly InvocationWaitMember["state"][]) =>
  result.members.some(({ state }) => states.includes(state));
export function waitDisposition(result: InvocationWaitResult) {
  return hasState(result, incompleteStates) ? "incomplete" : hasState(result, failedStates) ? "failed" : "accepted";
}

const containsState = (states: readonly InvocationWaitMember["state"][]) => ({
  properties: { members: { contains: { properties: { state: { enum: states } }, required: ["state"] } } },
});
export const invocationWaitNormalResultSchema = waitResult
  .refine((answer) => waitDisposition(answer) !== "failed")
  .meta({ anyOf: [containsState(incompleteStates), { not: containsState(failedStates) }] });

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

function contractEvidence({
  id,
  changed,
  terminal,
  presence,
  summary,
}: ContractWaitMember): z.output<typeof contractMember> {
  const state =
    presence === "missing"
      ? "missing"
      : presence === "unknown"
        ? "unavailable"
        : terminal === "claimed"
          ? "accepted"
          : terminal === "abandoned"
            ? "abandoned"
            : changed
              ? "changed"
              : "waiting";
  return {
    contract: id,
    state,
    ...(summary === undefined
      ? {}
      : {
          phase: summary.phase,
          ...(summary.title === undefined ? {} : { title: summary.title }),
          ...(summary.gates === undefined ? {} : { gates: summary.gates }),
        }),
  };
}

function rejectWaitFailures(
  reads: readonly PromiseSettledResult<void>[],
  caller?: AbortSignal,
  unavailable?: Iterable<unknown>,
): void {
  const failures = reads.flatMap((read) => (read.status === "rejected" ? [read.reason as unknown] : []));
  if (caller?.aborted) {
    failures.unshift(caller.reason);
    for (const cause of unavailable ?? []) if (!failures.includes(cause)) failures.push(cause);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    const cause = failures[0];
    const message = failures.map((error) => (error instanceof Error ? error.message : String(error))).join("; ");
    throw new KeiyakuError(caller?.aborted ? "aborted" : errorCategory(cause), message, {
      cause: new AggregateError(failures, message, { cause }),
    });
  }
}

async function observeSubjects(
  input: WaitInput,
  subjects: readonly Subject[],
  addressed: Awaited<ReturnType<typeof addressAkumaSet>> | undefined,
): Promise<InvocationWaitResult> {
  const ids = subjects.flatMap((subject) => (subject.kind === "contract" ? [subject.id] : []));
  const journals = ids.length === 0 ? undefined : createContractWaitObserver(scopeForRepo(input.repo!), ids);
  const akumas =
    addressed === undefined ? undefined : createAkumaWaitObserver(addressed.path, addressed.orderedIds, true);
  const complete = () => {
    const contracts = new Set(journals?.satisfied());
    const ready = (subject: Subject) =>
      subject.kind === "contract" ? contracts.has(subject.id) : akumas!.satisfied(subject.id);
    return input.completion === "all" ? subjects.every(ready) : subjects.some(ready);
  };
  const missing = () =>
    journals?.reason("all") === "missing" ||
    [...(akumas?.items.values() ?? [])].some((member) => member.state === "missing");
  const clock = startWaitClock(input.timeoutMs, input.signal);
  const { signal, stop } = clock;
  const observe = async (): Promise<InvocationWaitResult> => {
    do {
      const round = async (read: () => Promise<unknown>): Promise<void> => {
        try {
          clock.beforeRead();
          await read();
          if (input.timeoutMs !== 0 && (complete() || missing() || akumas?.reported() !== undefined)) stop.abort();
        } catch (error) {
          if (isWaitAbort(error, signal)) return;
          stop.abort();
          throw error;
        }
      };
      const reads = await Promise.allSettled([
        ...(journals === undefined ? [] : [round(() => journals.observe(signal))]),
        ...(akumas === undefined ? [] : [round(() => akumas.observe(signal, clock.beforeRead))]),
      ]);
      rejectWaitFailures(reads, input.signal, akumas?.unavailableCauses());
      if (signal.aborted || clock.remaining() <= 0) break;
      try {
        await delay(Math.min(OBSERVATION_POLL_MS, clock.remaining()), undefined, { signal });
      } catch (error) {
        if (!isWaitAbort(error, signal)) throw error;
        break;
      }
    } while (clock.remaining() > 0);
    rejectWaitFailures([], input.signal, akumas?.unavailableCauses());
    const contracts = new Map(journals?.members().map((member) => [member.id, contractEvidence(member)]));
    const report = complete() ? undefined : akumas?.reported();
    const members: InvocationWaitMember[] = subjects.map((subject) =>
      subject.kind === "contract"
        ? contracts.get(subject.id)!
        : {
            ...(akumas?.items.get(subject.id) ?? { akuma: subject.id, state: "unavailable" as const }),
            ...(report?.id === subject.id ? { report: report.preview } : {}),
          },
    );
    return {
      kind: "wait",
      members,
      ...(input.timeoutMs === 0 ? {} : { elapsedMs: Math.floor(performance.now() - clock.startedAt) }),
    };
  };
  try {
    if (addressed === undefined) return await observe();
    const host = { world: addressed.path, reportDiagnostic: stderrPluginDiagnostic };
    const answer = await withAkumaWaitDeferrals(host, { akumaIds: addressed.orderedIds }, input.signal, observe);
    await akumas!.notify(outcomePluginObserver(host));
    return answer;
  } finally {
    clock.close();
    akumas?.clear();
  }
}
