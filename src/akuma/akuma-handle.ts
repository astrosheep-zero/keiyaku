import { randomUUID } from "node:crypto";
import { CONTROL_RESPONSE_MS, type TellResult, wakeRecordedTell } from "./body.js";
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
async function takeLeashUntil(paths: AkumaPaths, deadline: number): Promise<HeldAkumaLeash | null> {
  for (;;) {
    const leash = await HeldAkumaLeash.try(paths);
    if (leash !== null) return leash;
    if (performance.now() >= deadline) return null;
    await wait(Math.min(POLL_MS, Math.max(0, deadline - performance.now())));
  }
}
async function recordTellBody(
  paths: AkumaPaths,
  akuma: AkuId,
  body: string,
  id = randomUUID(),
  recordedAt = new Date().toISOString(),
): Promise<Readonly<{ kind: "recorded"; tellId: string }>> {
  const admitted = await recordTell(paths, { kind: "tell", id, body, recordedAt });
  if (admitted.kind === "not-born") throw new AkumaNotBornError(akuma);
  return { kind: "recorded", tellId: admitted.tell.id };
}
async function killAkumaWithRecovery(
  paths: AkumaPaths,
  recover: (paths: AkumaPaths) => Promise<void> = async () => {},
): Promise<KillEvidence> {
  try {
    const request = await requestStop(paths, new Date().toISOString());
    if (request.kind !== "requested") return request.kind;
    const target = request.body;
    const leash = await takeLeashUntil(paths, performance.now() + CONTROL_RESPONSE_MS);
    if ((await readKill(paths, target.sequence)) !== null) {
      leash?.release();
      return "killed";
    }
    if (leash === null) {
      if ((await readKill(paths, target.sequence)) !== null) return "killed";
      const body = (await readHeart(paths)).latestBody;
      return body?.sequence === target.sequence && body.hung !== undefined ? "hung" : "unavailable";
    }
    try {
      const settledBody = (await readHeart(paths)).latestBody;
      if (settledBody?.sequence !== target.sequence)
        return (await readKill(paths, target.sequence)) === null ? "unavailable" : "killed";
      if (settledBody.end !== "put-down") {
        await leash.clearStop(paths);
        return "untidy";
      }
      const settled = await leash.settleStop(paths, target.sequence);
      return settled === null ? "unavailable" : "killed";
    } finally {
      leash.release();
    }
  } finally {
    void recover(paths).catch(() => undefined);
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

  private async exactHistory(
    input: Readonly<{ id?: string; before?: number; since?: number; limit?: number }>,
  ): Promise<ExactHistory> {
    if (typeof input.id !== "string" || input.id.trim() === "")
      throw new TypeError("Akuma history id must be a nonblank string");
    if (input.before !== undefined || input.since !== undefined || input.limit !== undefined)
      throw new TypeError("Akuma history id cannot be combined with before, since, or limit");
    if (parsePublicHistoryId(input.id) === null)
      throw new TypeError("Akuma history id must match turn/<positive safe integer>");
    const slice = await activitySlice(this.paths);
    return selectExactHistory(
      projectTurns(slice.rows, { lowestRetained: slice.lowestRetained, highest: slice.highest }).rows,
      input.id,
    );
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
    const slice = await activitySlice(this.paths);
    return selectHistory(
      projectTurns(slice.rows, {
        lowestRetained: slice.lowestRetained,
        highest: slice.highest,
      }),
      {
        ...(input.before === undefined ? {} : { before: input.before }),
        ...(input.since === undefined ? {} : { since: input.since }),
        limit,
      },
    );
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

  async tell(body: string): Promise<TellResult> {
    const recorded = await recordTellBody(this.paths, this.id, body);
    return await wakeRecordedTell(this.paths, recorded.tellId);
  }

  async interrupt(body: string): Promise<InterruptReceipt> {
    const request = await requestPause(this.paths, new Date().toISOString());
    if (request.kind === "not-born") {
      throw new AkumaNotBornError(this.id);
    }

    let putDown: "was-idle" | "self-aborted" = "was-idle";
    let leash = await HeldAkumaLeash.try(this.paths);
    if (leash === null) {
      leash = await takeLeashUntil(this.paths, performance.now() + CONTROL_RESPONSE_MS);
      putDown = "self-aborted";
    }
    if (leash === null) {
      const body = (await readHeart(this.paths)).latestBody;
      return {
        kind: "unavailable",
        evidence: body?.sequence === request.body.sequence && body.hung !== undefined ? "hung" : "unavailable",
      };
    }

    const settledBody = (await readHeart(this.paths)).latestBody;
    if (settledBody?.sequence === request.body.sequence && settledBody.hung !== undefined) {
      try {
        await leash.clearPause(this.paths);
      } finally {
        leash.release();
      }
      return { kind: "unavailable", evidence: "hung" };
    }
    if (settledBody?.sequence !== request.body.sequence || settledBody.end === undefined) {
      try {
        await leash.clearPause(this.paths);
      } finally {
        leash.release();
      }
      return { kind: "unavailable", evidence: "untidy" };
    }
    if (request.body.end !== undefined || settledBody.end !== "put-down") putDown = "was-idle";

    let recorded: Readonly<{ kind: "recorded"; tellId: string }>;
    try {
      const id = randomUUID();
      const admitted = await leash.recordInterruptTell(this.paths, {
        kind: "tell",
        id,
        body,
        recordedAt: new Date().toISOString(),
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
      childSession = (await adapter.fork({ session: point.session, at: point.historyId, cwd: point.cwd })).session;
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

  async kill(): Promise<KillEvidence> {
    return await killAkumaWithRecovery(this.paths);
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
