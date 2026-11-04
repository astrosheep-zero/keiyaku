import { setTimeout as delay } from "node:timers/promises";
import { contractId, type ContractHead, type ContractId, type ContractState } from "../core/facts/types.js";
import { observeContractsForAdmissionAt } from "../git/observe.js";
import { withGitDecodeChannel } from "../git/read-observation.js";
import type { RepositoryScope } from "../protocol/operations.js";
import { optionalSignal, requireInput } from "./input.js";
import { readContractValue } from "./outcome.js";
import { scopeForRepo, type Repo } from "./repo.js";

export type ContractWaitOptions = Readonly<{ completion?: "any" | "all"; timeoutMs?: number; signal?: AbortSignal }>;
export type ContractWaitInput = ContractWaitOptions & Readonly<{ repo: Repo; contracts: readonly string[] }>;

// An unknown presence means the deadline interrupted the initial observation.
export type ContractWaitMember = Readonly<{
  contract: ContractId;
  baseline: ContractHead | null;
  head: ContractHead | null;
  changed: boolean;
  present: boolean | null;
  terminal: "claimed" | "abandoned" | null;
}>;
export type ContractWaitResult = Readonly<{
  kind: "changed" | "terminal" | "deadline" | "missing";
  completion: "any" | "all";
  contracts: readonly ContractWaitMember[];
}>;

export type ValidatedWait = Readonly<{
  scope: RepositoryScope;
  ids: readonly ContractId[];
  completion: "any" | "all";
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

export function validateContractWait(input: unknown): ValidatedWait {
  const values = requireInput(input, "Contract wait input", ["repo", "contracts", "completion", "timeoutMs", "signal"]);
  return validateContractWaitValues(values, scopeForRepo(values.repo));
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
  const timeoutMs = values.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0))
    throw new TypeError("timeoutMs must be a nonnegative finite number");
  const signal = optionalSignal(values.signal);
  return {
    scope,
    ids,
    completion,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(signal === undefined ? {} : { signal }),
  };
}

function readiness(members: ContractWaitMember[], completion: "any" | "all"): ContractWaitResult["kind"] | undefined {
  if (members.some((member) => member.present === false)) return "missing";
  const satisfied = (member: ContractWaitMember): boolean =>
    member.present === true && (member.changed || member.terminal !== null);
  if (completion === "any" ? members.some(satisfied) : members.every(satisfied))
    return members.some((member) => member.changed) ? "changed" : "terminal";
  return undefined;
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
  let members: ContractWaitMember[] = ids.map((contract) => ({
    contract,
    baseline: null,
    head: null,
    changed: false,
    present: null,
    terminal: null,
  }));
  const result = (kind: ContractWaitResult["kind"]): ContractWaitResult => ({ kind, completion, contracts: members });
  try {
    const initial = await read();
    signal?.throwIfAborted();
    members = members.map((member, index) => {
      const state = initial[index] ?? null;
      return {
        ...member,
        baseline: state?.head ?? null,
        head: state?.head ?? null,
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
          head,
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
