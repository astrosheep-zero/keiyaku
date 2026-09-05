import { randomUUID } from "node:crypto";
import { handoffPendingTells, type TellResult, type TellWakeRuntime, wakeRecordedTell } from "./body.js";
import {
  HeldAkumaLeash,
  activitySlice,
  readForkPoint,
  readHeart,
  readKill,
  readLastAnsweredTurn,
  readSoul,
  recordTell,
  requestPause,
  requestStop,
  type KillEvidence,
  type ResumeCoordinate,
  type SessionFact,
} from "./heart/index.js";
import { acquireLeash } from "./control.js";
import { parsePublicHistoryId, pathsForAkuId, type AkuId, type AkumaPaths } from "./identity.js";
import {
  projectTurns,
  selectHistory,
  selectExactHistory,
  type ActivityHistory,
  type ExactHistory,
} from "./projection.js";
import { resolveProviderExecution } from "./providers/index.js";
import { publishAkuma } from "./publication.js";
import { spawnAkumaBody } from "./body.js";
import { AkumaNotBornError } from "./akuma-errors.js";
import { bornStatus } from "./akuma-observe.js";
import type { AkumaCallExecution, AkumaStatus, ForkReceipt, InterruptReceipt } from "./akuma.js";
import type { WorldRoot } from "../world.js";
const CALL_EXECUTION: unique symbol = Symbol("akuma-call-execution");
const POLL_MS = 100;
const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function defaultWaitComplete(status: AkumaStatus): boolean {
  return (
    status.life !== "running" &&
    !status.timeline.entries.some(
      (entry) => entry.kind === "row" && entry.row.kind === "tell" && entry.row.state === "pending",
    )
  );
}
async function takeLeashUntilSignal(
  paths: AkumaPaths,
  bodySequence: number,
  signal?: AbortSignal,
): Promise<HeldAkumaLeash | Readonly<{ kind: "unavailable"; evidence: "hung" | "untidy" | "unavailable" }>> {
  const leash = await acquireLeash(paths, { bodySequence, ...(signal === undefined ? {} : { signal }) });
  if (leash !== null) return leash;
  const latestBody = (await readHeart(paths)).latestBody;
  if (latestBody?.sequence === bodySequence && latestBody.hung !== undefined)
    return { kind: "unavailable", evidence: "hung" };
  if (latestBody?.sequence === bodySequence && latestBody.end !== undefined)
    return { kind: "unavailable", evidence: "untidy" };
  return { kind: "unavailable", evidence: "unavailable" };
}
export async function settleAkumaKill(
  paths: AkumaPaths,
  signal?: AbortSignal,
  retainLeash = false,
): Promise<Readonly<{ evidence: KillEvidence; leash?: HeldAkumaLeash }>> {
  const request = await requestStop(paths, new Date().toISOString());
  if (request.kind !== "requested") {
    if (!retainLeash) return { evidence: request.kind };
    const leash = await acquireLeash(paths, signal === undefined ? {} : { signal });
    return leash === null ? { evidence: "unavailable" } : { evidence: request.kind, leash };
  }
  const target = request.body;
  const waited = await takeLeashUntilSignal(paths, target.sequence, signal);
  if ("kind" in waited) {
    if ((await readKill(paths, target.sequence)) !== null) return { evidence: "killed" };
    return { evidence: waited.evidence };
  }
  const leash = waited;
  let retain = false;
  try {
    if ((await readKill(paths, target.sequence)) !== null) return { evidence: "killed" };
    const settledBody = (await readHeart(paths)).latestBody;
    if (settledBody?.sequence !== target.sequence) {
      return { evidence: (await readKill(paths, target.sequence)) === null ? "unavailable" : "killed" };
    }
    if (settledBody.end !== "put-down") {
      await leash.clearStop(paths);
      return { evidence: "untidy" };
    }
    const settled = await leash.settleStop(paths, target.sequence);
    if (settled === null) return { evidence: "unavailable" };
    retain = retainLeash;
    return retainLeash ? { evidence: "killed", leash } : { evidence: "killed" };
  } finally {
    if (!retain) leash.release();
  }
}

export async function killAkumaWithRecovery(
  paths: AkumaPaths,
  recover?: (paths: AkumaPaths) => Promise<void>,
  signal?: AbortSignal,
): Promise<KillEvidence> {
  try {
    return (await settleAkumaKill(paths, signal)).evidence;
  } finally {
    if (recover !== undefined) void recover(paths).catch(() => undefined);
  }
}

export class AkumaHandle {
  readonly [CALL_EXECUTION]?: AkumaCallExecution;

  constructor(
    readonly id: AkuId,
    private readonly worldPath: WorldRoot,
    execution?: AkumaCallExecution,
  ) {
    if (execution !== undefined) this[CALL_EXECUTION] = execution;
  }

  private get paths(): AkumaPaths {
    return pathsForAkuId(this.worldPath, this.id);
  }

  private async projectHistoryTurns() {
    const slice = await activitySlice(this.paths);
    return projectTurns(slice.rows, { lowestRetained: slice.lowestRetained, highest: slice.highest });
  }

  private async exactHistory(
    input: Readonly<{ id?: string; before?: number; since?: number; limit?: number }>,
  ): Promise<ExactHistory> {
    if (typeof input.id !== "string" || input.id.trim() === "")
      throw new TypeError("Akuma history id must be a nonblank string");
    if (input.before !== undefined || input.since !== undefined || input.limit !== undefined)
      throw new TypeError("Akuma history id cannot be combined with before, since, or limit");
    if (parsePublicHistoryId(input.id) === null)
      throw new TypeError("Akuma history id must match turn/<positive safe integer>");
    return selectExactHistory((await this.projectHistoryTurns()).rows, input.id);
  }

  async status(): Promise<AkumaStatus> {
    return (await bornStatus(this.paths, this.id, { aperture: "monitoring" })).status;
  }

  async history(
    input: Readonly<{ id?: string; before?: number; since?: number; limit?: number }> = {},
  ): Promise<ActivityHistory | ExactHistory> {
    if (input.id !== undefined) return this.exactHistory(input);
    if (input.before !== undefined && input.since !== undefined) {
      throw new TypeError("Akuma history before and since are mutually exclusive");
    }
    for (const [name, value] of [
      ["before", input.before],
      ["since", input.since],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new TypeError(`Akuma history ${name} must be a positive safe integer`);
      }
    }
    const limit = input.limit ?? 12;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 5_000) {
      throw new TypeError("Akuma history limit must be a positive safe integer no greater than 5000");
    }
    return selectHistory(await this.projectHistoryTurns(), {
      ...(input.before === undefined ? {} : { before: input.before }),
      ...(input.since === undefined ? {} : { since: input.since }),
      limit,
    });
  }

  async wait(
    predicate: (status: AkumaStatus) => boolean = defaultWaitComplete,
    options: Readonly<{ timeoutMs?: number }> = {},
  ): Promise<AkumaStatus> {
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
      throw new TypeError("Akuma wait timeoutMs must be a nonnegative finite millisecond duration");
    }
    const deadline = options.timeoutMs === undefined ? undefined : performance.now() + options.timeoutMs;
    for (;;) {
      const status = await this.status();
      if (predicate(status) || (deadline !== undefined && performance.now() >= deadline)) return status;
      await wait(deadline === undefined ? POLL_MS : Math.min(POLL_MS, Math.max(0, deadline - performance.now())));
    }
  }

  async tell(
    body: string,
    tellId: string = randomUUID(),
    recordedAt = new Date().toISOString(),
    runtime?: TellWakeRuntime,
    schemaJson?: string,
  ): Promise<TellResult> {
    const admitted = await recordTell(this.paths, {
      kind: "tell",
      id: tellId,
      body,
      recordedAt,
      ...(schemaJson === undefined ? {} : { schemaJson }),
    });
    if (admitted.kind === "not-born") throw new AkumaNotBornError(this.id);
    return await wakeRecordedTell(this.paths, admitted.tell.id, runtime);
  }

  async interrupt(
    body: string,
    options: Readonly<{ tellId?: string; schemaJson?: string; signal?: AbortSignal }> = {},
  ): Promise<InterruptReceipt> {
    const request = await requestPause(this.paths, new Date().toISOString());
    if (request.kind === "not-born") {
      throw new AkumaNotBornError(this.id);
    }

    let putDown: "was-idle" | "self-aborted" = "was-idle";
    let leash = await HeldAkumaLeash.try(this.paths);
    if (leash === null) {
      const waited = await takeLeashUntilSignal(this.paths, request.body.sequence, options.signal);
      if ("kind" in waited) return waited;
      leash = waited;
      putDown = "self-aborted";
    }
    let recorded: Readonly<{ kind: "recorded"; tellId: string }>;
    try {
      options.signal?.throwIfAborted();

      const settledBody = (await readHeart(this.paths)).latestBody;
      if (settledBody?.sequence === request.body.sequence && settledBody.hung !== undefined) {
        await leash.clearPause(this.paths);
        return { kind: "unavailable", evidence: "hung" };
      }
      if (settledBody?.sequence !== request.body.sequence || settledBody.end === undefined) {
        await leash.clearPause(this.paths);
        return { kind: "unavailable", evidence: "untidy" };
      }
      if (request.body.end !== undefined || settledBody.end !== "put-down") putDown = "was-idle";

      options.signal?.throwIfAborted();
      const id = randomUUID();
      const admitted = await leash.recordInterruptTell(this.paths, {
        kind: "tell",
        id: options.tellId ?? id,
        body,
        recordedAt: new Date().toISOString(),
        ...(options.schemaJson === undefined ? {} : { schemaJson: options.schemaJson }),
      });
      if (admitted.kind === "not-born") throw new AkumaNotBornError(this.id);
      recorded = { kind: "recorded", tellId: admitted.tell.id };
    } finally {
      leash.release();
    }
    return { kind: "interrupted", putDown, tell: await wakeRecordedTell(this.paths, recorded.tellId) };
  }

  async fork(input: Readonly<{ at: string }>): Promise<ForkReceipt> {
    const source = await readSoul(this.paths);
    if (source === null) throw new AkumaNotBornError(this.id);
    if (source.id !== this.id) throw new Error("Akuma soul does not match its coordinate");
    const adapter = (await resolveProviderExecution(source.provider)).adapter;
    if (adapter.fork === undefined) return { kind: "provider-cannot-fork", provider: source.provider.name };
    const point = await readForkPoint(this.paths, input.at);
    if (point === null) return { kind: "unknown-history", at: input.at };
    if (point.provider !== source.provider.name)
      throw new Error(`Akuma fork point ${input.at} has a mismatched provider`);

    let childSession: ResumeCoordinate;
    try {
      const attempt = adapter.fork({ session: point.session, at: point.historyId, cwd: point.cwd });
      childSession = (await attempt.result).session;
      await attempt.closed;
    } catch (error) {
      return { kind: "fork-failed", diagnostic: diagnostic(error) };
    }

    const admittedAt = new Date().toISOString();
    const birthSession: Omit<SessionFact, "sequence"> = {
      provider: point.provider,
      coordinate: childSession,
      cwd: point.cwd,
      options: point.options,
      admittedAt,
    };
    try {
      const child = await publishAkuma({
        worldPath: this.worldPath,
        archetype: source.archetype,
        awaitAsleep: true,
        launch: async (allocated) => {
          return await spawnAkumaBody({
            paths: allocated.paths,
            seed: {
              id: allocated.id,
              archetype: source.archetype,
              ...(source.description === undefined ? {} : { description: source.description }),
              provider: source.provider,
              options: source.options,
              ...(source.readonly === undefined ? {} : { readonly: source.readonly }),
              allowed: source.allowed,
              cwd: source.cwd,
              origin: { kind: "fork", parent: this.id, at: input.at },
            },
            birthSession,
          });
        },
      });
      return { kind: "forked", child: child.id };
    } catch (error) {
      return {
        kind: "upstream-forked",
        childSession,
        diagnostic: diagnostic(error),
      };
    }
  }

  async kill(options: Readonly<{ signal?: AbortSignal }> = {}): Promise<KillEvidence> {
    return await killAkumaWithRecovery(this.paths, handoffPendingTells, options.signal);
  }

  async lastAnswer(): Promise<LastAnswer> {
    const turn = await readLastAnsweredTurn(this.paths);
    return turn?.end?.outcome.kind === "answered"
      ? { kind: "answer", answer: turn.end.outcome.answer }
      : { kind: "no-answer" };
  }
}

/** Package-internal provenance retained only by the handle returned from call. */
export function akumaCallExecution(handle: AkumaHandle): AkumaCallExecution | undefined {
  return handle[CALL_EXECUTION];
}

export type LastAnswer = Readonly<{ kind: "answer"; answer: string }> | Readonly<{ kind: "no-answer" }>;
