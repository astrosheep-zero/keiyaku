import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { contractIdSchema } from "../git/identity.js";
import { type ContractId, type ContractState } from "../core/facts/types.js";
import { KeiyakuError } from "../errors.js";
import { observeContractsForAdmissionAt } from "../git/observe.js";
import { withGitDecodeChannel } from "../git/read-observation.js";
import type { RepositoryScope } from "../protocol/operations.js";
import { callerContractId, optionalSignal, requireInput } from "./input.js";
import { readContractValue } from "./outcome.js";

const waitDurationDiagnostic = "timeoutMs must be a nonnegative finite integer millisecond duration";
export const contractWaitDurationSchema = z
  .number({ error: waitDurationDiagnostic })
  .nonnegative({ error: waitDurationDiagnostic })
  .multipleOf(1, { error: waitDurationDiagnostic });

export type ContractWaitOptions = Readonly<{ completion?: "any" | "all"; timeoutMs?: number; signal?: AbortSignal }>;
export type ContractWaitInput = ContractWaitOptions & Readonly<{ contracts: readonly string[] }>;

// Missing presence is observed present; unknown means the deadline interrupted the initial read.
export const contractWaitMemberSchema = z
  .strictObject({
    id: contractIdSchema,
    changed: z.literal(true).exactOptional(),
    presence: z.enum(["missing", "unknown"]).exactOptional(),
    terminal: z.enum(["claimed", "abandoned"]).exactOptional(),
  })
  .readonly();
function waitResultSchema<Reason extends z.ZodType, Members extends z.ZodType>(reason: Reason, contracts: Members) {
  return z.strictObject({ kind: z.literal("contract"), reason, contracts }).readonly();
}
export const contractWaitResultSchema = waitResultSchema(
  z.enum(["changed", "terminal", "deadline", "missing"]),
  z.array(contractWaitMemberSchema).readonly(),
);
const presentMember = contractWaitMemberSchema.unwrap().omit({ presence: true });
const terminalMember = presentMember.omit({ changed: true });
const unknownMember = presentMember.pick({ id: true }).extend({ presence: z.literal("unknown") });
const presentMembers = z.array(presentMember.readonly()).nonempty().readonly();
export const contractWaitNormalResultSchema = z.union([
  waitResultSchema(z.literal("changed"), presentMembers),
  waitResultSchema(z.literal("terminal"), z.array(terminalMember.readonly()).nonempty().readonly()),
  waitResultSchema(
    z.literal("deadline"),
    z.union([presentMembers, z.array(unknownMember.readonly()).nonempty().readonly()]),
  ),
]);
type WaitObservation = Readonly<{
  id: ContractId;
  baseline: ContractState["head"];
  changed: boolean;
  present: boolean | null;
  terminal: "claimed" | "abandoned" | null;
}>;

export type ContractWaitMember = z.output<typeof contractWaitMemberSchema>;
export type ContractWaitResult = z.output<typeof contractWaitResultSchema>;

export type ValidatedWait = Readonly<{
  scope: RepositoryScope;
  ids: readonly ContractId[];
  completion: "any" | "all";
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

export function validateContractWait(scope: RepositoryScope, input: unknown): ValidatedWait {
  const values = requireInput(input, "Contract wait input", ["contracts", "completion", "timeoutMs", "signal"]);
  return validateContractWaitValues(values, scope);
}

export function validateContractWaitHandle(
  scope: RepositoryScope,
  id: ContractId,
  input?: ContractWaitOptions,
): ValidatedWait {
  const values =
    input === undefined ? {} : requireInput(input, "Contract wait options", ["completion", "timeoutMs", "signal"]);
  return validateContractWaitValues({ ...values, contracts: [id] }, scope);
}

function validateContractWaitValues(values: Record<string, unknown>, scope: RepositoryScope): ValidatedWait {
  if (!Array.isArray(values.contracts) || values.contracts.length === 0)
    throw new KeiyakuError("invalid-input", "contracts must be a nonempty array");
  const ids = [
    ...new Set(
      values.contracts.map((value: unknown) => {
        if (typeof value !== "string") throw new KeiyakuError("invalid-input", "contract ID must be a string");
        return callerContractId(value);
      }),
    ),
  ];
  const completion = values.completion === undefined ? "any" : values.completion;
  if (completion !== "any" && completion !== "all")
    throw new KeiyakuError("invalid-input", "completion must be any or all");
  const parsedTimeout = contractWaitDurationSchema.optional().safeParse(values.timeoutMs);
  if (!parsedTimeout.success) throw new KeiyakuError("invalid-input", parsedTimeout.error.message);
  const timeoutMs = parsedTimeout.data;
  const signal = optionalSignal(values.signal);
  return {
    scope,
    ids,
    completion,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(signal === undefined ? {} : { signal }),
  };
}

function satisfied(member: WaitObservation): boolean {
  return member.present === true && (member.changed || member.terminal !== null);
}

function readiness(
  members: readonly WaitObservation[],
  completion: "any" | "all",
): ContractWaitResult["reason"] | undefined {
  if (members.some((member) => member.present === false)) return "missing";
  if (completion === "any" ? members.some(satisfied) : members.every(satisfied))
    return members.some((member) => member.changed) ? "changed" : "terminal";
  return undefined;
}

function waitResult(members: readonly WaitObservation[], reason: ContractWaitResult["reason"]): ContractWaitResult {
  return {
    kind: "contract",
    reason,
    contracts: members.map((member) => ({
      id: member.id,
      ...(member.changed ? { changed: true } : {}),
      ...(member.present === null
        ? { presence: "unknown" as const }
        : member.present === false
          ? { presence: "missing" as const }
          : {}),
      ...(member.terminal === null ? {} : { terminal: member.terminal }),
    })),
  };
}

/** One invocation's journal baselines and witnessed progress, shared with mixed observation. */
export function createContractWaitObserver(scope: RepositoryScope, ids: readonly ContractId[]) {
  let initialized = false;
  let members: WaitObservation[] = ids.map((id) => ({
    id,
    baseline: null,
    changed: false,
    present: null,
    terminal: null,
  }));
  return {
    members: (): readonly ContractWaitMember[] => waitResult(members, "deadline").contracts,
    reason: (completion: "any" | "all") => readiness(members, completion),
    satisfied: () => members.filter(satisfied).map((member) => member.id),

    async observe(signal?: AbortSignal): Promise<void> {
      const reading = { ...scope, ...(signal === undefined ? {} : { signal }) };
      const states = await readContractValue(() =>
        withGitDecodeChannel(reading, async (channel) => {
          const observed = await observeContractsForAdmissionAt(reading, channel, ids);
          return ids.map((id) => {
            const record = observed.journals.get(id);
            if (record === undefined) throw new Error(`missing requested contract observation: ${id}`);
            return record.state;
          });
        }),
      );
      signal?.throwIfAborted();
      members = members.map((member, index) => {
        const state = states[index] ?? null;
        return {
          ...member,
          baseline: initialized ? member.baseline : (state?.head ?? null),
          changed: member.changed || (initialized && state !== null && state.head !== member.baseline),
          present: state !== null,
          terminal: state?.terminal?.kind ?? null,
        };
      });
      initialized = true;
    },
  };
}

export async function waitContractLocal(input: ValidatedWait): Promise<ContractWaitResult> {
  const { ids, completion, timeoutMs, signal } = input;
  signal?.throwIfAborted();
  const deadline = timeoutMs === undefined ? Infinity : performance.now() + timeoutMs;
  const deadlineController = new AbortController();
  // Zero means an unbounded baseline-only read. Positive durations also bound that read.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleDeadline = (): void => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) deadlineController.abort();
    else timer = setTimeout(scheduleDeadline, Math.min(remaining, 2_147_483_647));
  };
  if (timeoutMs !== undefined && timeoutMs > 0) scheduleDeadline();
  const readSignal =
    signal === undefined ? deadlineController.signal : AbortSignal.any([signal, deadlineController.signal]);
  const observer = createContractWaitObserver(input.scope, ids);
  const result = (reason: ContractWaitResult["reason"]): ContractWaitResult => ({
    kind: "contract",
    reason,
    contracts: observer.members(),
  });
  try {
    for (;;) {
      await observer.observe(readSignal);
      signal?.throwIfAborted();
      const reason = observer.reason(completion);
      if (reason !== undefined) return result(reason);
      const remaining = deadline - performance.now();
      if (remaining <= 0) return result("deadline");
      await delay(Math.min(remaining, 100), undefined, { signal: readSignal });
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (deadlineController.signal.aborted) return result("deadline");
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
