import {
  Akuma,
  type ActivityHistory,
  type AkumaStatus,
  type InterruptReceipt,
  type KillEvidence,
  type TellResult,
} from "../akuma/index.js";
import { readActionFeedbackStatus } from "../akuma/akuma.js";
import type { ContractId } from "../core/facts/types.js";
import { readDispatch } from "../dispatch/index.js";
import type { Settings } from "../settings.js";
import type { WorldRoot } from "../world.js";
import { addressAkuma, addressAkumaSet, type AkumaAddressInput, type AkumaSetAddressInput } from "./address.js";
import { requireInput } from "./input.js";
import { scopeForRepo, type Repo } from "./repo.js";

export type AkumaWaitInput = AkumaSetAddressInput & Readonly<{
  completion?: "any" | "all";
  timeoutMs?: number;
}>;

export type AkumaWaitResult = Readonly<{
  completion: "any" | "all";
  statuses: readonly AkumaStatusView[];
}>;

export type AkumaStatusView = AkumaStatus & Readonly<{ contractId?: ContractId }>;

export type AkumaKillResult = Readonly<{
  results: readonly Readonly<{ id: AkumaStatus["id"]; evidence: KillEvidence; observation: AkumaStatusView }>[];
}>;

export type AkumaTellInput = AkumaAddressInput & Readonly<{ body: string }>;
export type AkumaTellResult = Readonly<{ akuma: AkumaStatus["id"]; tell: TellResult; observation: AkumaStatusView }>;
export type AkumaInterruptInput = AkumaAddressInput & Readonly<{ body: string }>;
export type AkumaInterruptResult = Readonly<{ id: AkumaStatus["id"]; receipt: InterruptReceipt; contractId?: ContractId }>;
export type AkumaHistoryInput = AkumaAddressInput & Readonly<{
  before?: number;
  since?: number;
  limit?: number;
  last?: boolean;
}>;
export type AkumaHistoryResult =
  | Readonly<{ kind: "history"; id: AkumaStatus["id"]; history: ActivityHistory; contractId?: ContractId }>
  | Readonly<{ kind: "last"; id: AkumaStatus["id"]; answer: string; contractId?: ContractId }>
  | Readonly<{ kind: "no-answer"; id: AkumaStatus["id"]; contractId?: ContractId }>;

function source(path: WorldRoot, settings?: Settings): Akuma {
  return Akuma.of(path, settings);
}

function contractFor(repo: Repo | undefined, id: AkumaStatus["id"]): ContractId | undefined {
  return repo === undefined ? undefined : readDispatch(scopeForRepo(repo), id)?.contractId;
}

function statusView(status: AkumaStatus, repo?: Repo): AkumaStatusView {
  const contractId = contractFor(repo, status.id);
  return contractId === undefined ? status : { ...status, contractId };
}

function timeout(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError("timeoutMs must be a nonnegative finite number");
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const PLURAL_DETAIL_LIMIT = 32;

function pinned(entry: AkumaStatus["activity"]["entries"][number]): boolean {
  return entry.kind === "row"
    && ((entry.row.kind === "tool" && entry.row.state === "running")
      || (entry.row.kind === "tell" && entry.row.state === "pending"));
}

function budgetStatus(status: AkumaStatus, allowance: number): Readonly<{ status: AkumaStatus; used: number }> {
  const entries: typeof status.activity.entries[number][] = [];
  const ordinary = status.activity.entries.filter((entry) => entry.kind === "row" && !pinned(entry));
  const kept = new Set(allowance === 0 ? [] : ordinary.slice(-allowance));
  const used = kept.size;
  let hidden = 0;
  let single: Extract<typeof status.activity.entries[number], { kind: "row" }> | undefined;
  const flush = (): void => {
    if (hidden === 1 && single !== undefined) entries.push(single);
    else if (hidden > 0) entries.push({ kind: "gap", count: hidden });
    hidden = 0;
    single = undefined;
  };
  for (const entry of status.activity.entries) {
    if (pinned(entry)) {
      flush();
      entries.push(entry);
      continue;
    }
    if (entry.kind === "row" && kept.has(entry)) {
      flush();
      entries.push(entry);
      continue;
    }
    const count = entry.kind === "gap" ? entry.count : 1;
    if (hidden === 0 && count === 1 && entry.kind === "row") single = entry;
    else single = undefined;
    hidden += count;
  }
  flush();
  return { status: { ...status, activity: { ...status.activity, entries } }, used };
}

function budgetPlural(statuses: readonly AkumaStatus[]): readonly AkumaStatus[] {
  let remaining = PLURAL_DETAIL_LIMIT;
  return statuses.map((status) => {
    const budgeted = budgetStatus(status, remaining);
    remaining -= budgeted.used;
    return budgeted.status;
  });
}

function directAddress(values: Record<string, unknown>): AkumaAddressInput {
  return {
    path: values.path as WorldRoot,
    akuma: values.akuma as string,
    ...(values.settings === undefined ? {} : { settings: values.settings as Settings }),
    ...(values.repo === undefined ? {} : { repo: values.repo as Repo }),
  };
}

function setAddress(values: Record<string, unknown>): AkumaSetAddressInput {
  return {
    path: values.path as WorldRoot,
    akuma: values.akuma as readonly string[],
    ...(values.settings === undefined ? {} : { settings: values.settings as Settings }),
    ...(values.repo === undefined ? {} : { repo: values.repo as NonNullable<AkumaSetAddressInput["repo"]> }),
  };
}

export function statusAkuma(input: AkumaAddressInput): AkumaStatusView {
  const addressed = addressAkuma(input);
  return statusView(source(addressed.path, addressed.settings).of({ id: addressed.id }).status(), input.repo);
}

export async function waitAkuma(input: AkumaWaitInput): Promise<AkumaWaitResult> {
  const values = requireInput(input, "Keiyaku.wait input");
  for (const key of Object.keys(values)) {
    if (!["path", "akuma", "settings", "repo", "completion", "timeoutMs"].includes(key)) {
      throw new TypeError(`Keiyaku.wait input has unknown field: ${key}`);
    }
  }
  const addressed = await addressAkumaSet(setAddress(values));
  const completion = values.completion;
  if (addressed.ids.length > 1 && completion !== "any" && completion !== "all") {
    throw new TypeError("completion must be any or all when waiting for multiple Akuma");
  }
  if (completion !== undefined && completion !== "any" && completion !== "all") throw new TypeError("completion must be any or all");
  const selected = completion ?? "all";
  const timeoutMs = timeout(values.timeoutMs);
  const handles = addressed.ids.map((id) => source(addressed.path, addressed.settings).of({ id }));
  const deadline = timeoutMs === undefined ? undefined : performance.now() + timeoutMs;
  for (;;) {
    const statuses = handles.map((handle) => handle.status());
    const settled = statuses.map((status) => status.life !== "running");
    if ((selected === "any" ? settled.some(Boolean) : settled.every(Boolean))
      || (deadline !== undefined && performance.now() >= deadline)) {
      const observed = statuses.length > 1 ? budgetPlural(statuses) : statuses;
      return { completion: selected, statuses: observed.map((status) => statusView(status, values.repo as Repo | undefined)) };
    }
    await delay(deadline === undefined ? 25 : Math.min(25, Math.max(0, deadline - performance.now())));
  }
}

export async function killAkuma(input: AkumaSetAddressInput): Promise<AkumaKillResult> {
  const addressed = await addressAkumaSet(input);
  const handles = addressed.ids.map((id) => source(addressed.path, addressed.settings).of({ id }));
  const evidence = await Promise.all(handles.map(async (handle) => await handle.kill()));
  return {
    results: addressed.ids.map((id, index) => ({
      id,
      evidence: evidence[index]!,
      observation: statusView(readActionFeedbackStatus(addressed.path, id), input.repo),
    })),
  };
}

export async function tellAkuma(input: AkumaTellInput): Promise<AkumaTellResult> {
  const values = requireInput(input, "Keiyaku.tell input");
  for (const key of Object.keys(values)) {
    if (!["path", "akuma", "settings", "body", "repo"].includes(key)) throw new TypeError(`Keiyaku.tell input has unknown field: ${key}`);
  }
  if (typeof values.body !== "string") throw new TypeError("body must be a string");
  const addressed = addressAkuma(directAddress(values));
  const handle = source(addressed.path, addressed.settings).of({ id: addressed.id });
  const tell = await handle.tell(values.body);
  return { akuma: addressed.id, tell, observation: statusView(readActionFeedbackStatus(addressed.path, addressed.id), values.repo as Repo | undefined) };
}

export async function interruptAkuma(input: AkumaInterruptInput): Promise<AkumaInterruptResult> {
  const values = requireInput(input, "Keiyaku.interrupt input");
  for (const key of Object.keys(values)) {
    if (!["path", "akuma", "settings", "body", "repo"].includes(key)) throw new TypeError(`Keiyaku.interrupt input has unknown field: ${key}`);
  }
  if (typeof values.body !== "string") throw new TypeError("body must be a string");
  const addressed = addressAkuma(directAddress(values));
  const contractId = contractFor(values.repo as Repo | undefined, addressed.id);
  return {
    id: addressed.id,
    receipt: await source(addressed.path, addressed.settings).of({ id: addressed.id }).interrupt(values.body),
    ...(contractId === undefined ? {} : { contractId }),
  };
}

export function historyAkuma(input: AkumaHistoryInput): AkumaHistoryResult {
  const values = requireInput(input, "Keiyaku.history input");
  for (const key of Object.keys(values)) {
    if (!["path", "akuma", "settings", "before", "since", "limit", "last", "repo"].includes(key)) {
      throw new TypeError(`Keiyaku.history input has unknown field: ${key}`);
    }
  }
  if (values.last !== undefined && typeof values.last !== "boolean") throw new TypeError("last must be a boolean");
  const addressed = addressAkuma(directAddress(values));
  const handle = source(addressed.path, addressed.settings).of({ id: addressed.id });
  if (values.last === true) {
    const answer = handle.lastAnswer();
    const contractId = contractFor(values.repo as Repo | undefined, addressed.id);
    return answer.kind === "answer"
      ? { kind: "last", id: addressed.id, answer: answer.answer, ...(contractId === undefined ? {} : { contractId }) }
      : { kind: "no-answer", id: addressed.id, ...(contractId === undefined ? {} : { contractId }) };
  }
  const history = handle.history({
    ...(values.before === undefined ? {} : { before: values.before as number }),
    ...(values.since === undefined ? {} : { since: values.since as number }),
    ...(values.limit === undefined ? {} : { limit: values.limit as number }),
  });
  const contractId = contractFor(values.repo as Repo | undefined, addressed.id);
  return { kind: "history", id: addressed.id, history, ...(contractId === undefined ? {} : { contractId }) };
}
