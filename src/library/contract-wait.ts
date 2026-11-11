import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { contractIdSchema } from "../git/identity.js";
import { contractId, type ContractId, type ContractState } from "../core/facts/types.js";
import { observeContractsForAdmissionAt } from "../git/observe.js";
import { withGitDecodeChannel } from "../git/read-observation.js";
import type { RepositoryScope } from "../protocol/operations.js";
import { optionalSignal, requireInput } from "./input.js";
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
    throw new TypeError("contracts must be a nonempty array");
  const ids = [
    ...new Set(
      values.contracts.map((value: unknown) => {
        if (typeof value !== "string") throw new TypeError("contract ID must be a string");
        try {
          return contractId(value);
        } catch (error) {
          throw new TypeError(error instanceof Error ? error.message : String(error));
        }
      }),
    ),
  ];
  const completion = values.completion === undefined ? "any" : values.completion;
  if (completion !== "any" && completion !== "all") throw new TypeError("completion must be any or all");
  const parsedTimeout = contractWaitDurationSchema.optional().safeParse(values.timeoutMs);
  if (!parsedTimeout.success) throw new TypeError(parsedTimeout.error.message);
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

function readiness(
  members: readonly WaitObservation[],
  completion: "any" | "all",
): ContractWaitResult["reason"] | undefined {
  if (members.some((member) => member.present === false)) return "missing";
  const satisfied = (member: WaitObservation): boolean =>
    member.present === true && (member.changed || member.terminal !== null);
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
  const scope = { ...input.scope, signal: readSignal };
  const read = async (): Promise<(ContractState | null)[]> =>
    await readContractValue(() =>
      withGitDecodeChannel(scope, async (channel) => {
        const observed = await observeContractsForAdmissionAt(scope, channel, ids);
        return ids.map((id) => {
          const record = observed.journals.get(id);
          if (record === undefined) throw new Error(`missing requested contract observation: ${id}`);
          return record.state;
        });
      }),
    );
  let members: WaitObservation[] = ids.map((id) => ({
    id,
    baseline: null,
    changed: false,
    present: null,
    terminal: null,
  }));
  const result = (reason: ContractWaitResult["reason"]): ContractWaitResult => waitResult(members, reason);
  try {
    const initial = await read();
    signal?.throwIfAborted();
    members = members.map((member, index) => {
      const state = initial[index] ?? null;
      return {
        ...member,
        baseline: state?.head ?? null,
        present: state !== null,
        terminal: state?.terminal?.kind ?? null,
      };
    });
    const initialResult = readiness(members, completion);
    if (initialResult !== undefined) return result(initialResult);
    if (performance.now() >= deadline) return result("deadline");
    for (;;) {
      const states = await read();
      signal?.throwIfAborted();
      members = members.map((member, index) => {
        const state = states[index] ?? null;
        const head = state?.head ?? null;
        return {
          ...member,
          present: state !== null,
          terminal: state?.terminal?.kind ?? null,
          changed: member.changed || (state !== null && head !== member.baseline),
        };
      });
      const observedResult = readiness(members, completion);
      if (observedResult !== undefined) return result(observedResult);
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
