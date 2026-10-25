import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inbox, Square, SquareError, squareAssignedParticipantName } from "@astrosheep/square";
import type { WorldRoot } from "../world.js";

/**
 * The Square integration's submitting-edge identity policy. Call, fork, tell, and
 * ask share this one adapter, so no command and no generic caller decoder has to
 * know how Square names a participant. Every Square read below is rooted in the
 * submitted environment's own coordinates, never in this process's ambient ones.
 */

/** Square's own harness-session coordinates, in its resolution order. */
const HARNESS_SESSIONS = [
  { provider: "claude", variable: "CLAUDE_CODE_SESSION_ID" },
  { provider: "codex", variable: "CODEX_THREAD_ID" },
  { provider: "opencode", variable: "OPENCODE_SESSION_ID" },
  { provider: "pi", variable: "PI_SESSION_ID" },
  { provider: undefined, variable: "PASEO_AGENT_ID" },
] as const;

const SEAT_PREFIX = "keiyaku-assigned-";
const SEAT_DIGEST_DOMAIN = "keiyaku/square-seat/v1";
const SEAT_DIGEST_LENGTH = 12;
/** One bounded identity observation; a non-cooperative Square never holds a submission. */
const IDENTITY_BUDGET_MS = 5_000;

function declared(environment: NodeJS.ProcessEnv, variable: string): string | undefined {
  const value = environment[variable]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/** A stable, collision-resistant seat for one provider session coordinate. */
function squareSeatName(provider: string, session: string): string {
  const digest = createHash("sha256")
    .update(`${SEAT_DIGEST_DOMAIN}\u0000${provider}\u0000${session}`, "utf8")
    .digest("hex");
  return `${SEAT_PREFIX}${digest.slice(0, SEAT_DIGEST_LENGTH)}`;
}

/** Every harness session coordinate this process declares, able to name a seat or not. */
function sessionIds(environment: NodeJS.ProcessEnv): readonly string[] {
  return HARNESS_SESSIONS.flatMap(({ variable }) => {
    const session = declared(environment, variable);
    return session === undefined ? [] : [session];
  });
}

/**
 * The deterministic candidate for this process. Only one provider-backed session
 * may exist: a second coordinate — another provider, or the same raw token under
 * a different one — is ambiguous and selects nothing.
 */
function seatCandidate(environment: NodeJS.ProcessEnv): string | undefined {
  const names = HARNESS_SESSIONS.flatMap(({ provider, variable }) => {
    const session = declared(environment, variable);
    return provider === undefined || session === undefined ? [] : [squareSeatName(provider, session)];
  });
  return names.length === 1 ? names[0] : undefined;
}

/**
 * Square owns the name grammar, so the edge borrows one of Square's own handles
 * instead of restating it. An in-memory square validates without touching any
 * artifact.
 */
async function usableName(name: string): Promise<boolean> {
  try {
    await Square.inMemory({ markdown: "" }).participant(name);
    return true;
  } catch {
    return false;
  }
}

/** What the submitting session already stands as in this World's local Square. */
type Standing =
  | Readonly<{ kind: "standing"; name: string }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "indeterminate" }>;

/** Square's own canonical coordinate for a location it already published. */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Bindings this session already holds in this Square. Square's session inbox
 * reads the same host registry as native hooks, and it is the only public read
 * that takes the caller's own environment coordinate. Its page is bounded, so a
 * view that hides rows proves nothing about absence here.
 */
async function joinedBindings(
  environment: NodeJS.ProcessEnv,
  ids: readonly string[],
  location: string,
  signal: AbortSignal,
): Promise<Readonly<{ here: number; complete: boolean }>> {
  const pages = await Promise.all(
    ids.map(async (session) => await inbox({ env: environment }, session, {}, { signal })),
  );
  const here = await canonical(location);
  return {
    here: pages.flatMap(({ rows }) => rows).filter(({ squarePath }) => squarePath === here).length,
    complete: pages.every(({ rows, total }) => total === rows.length),
  };
}

/**
 * A session whose former participant already finished here has no replacement
 * identity: releasing the binding leaves Square's roster as the only evidence of
 * that standing, and a fresh seat would rename a finished caller into a new one.
 */
async function finishedHere(square: Square, environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<boolean> {
  const former = squareAssignedParticipantName(environment);
  const previous = seatCandidate(environment)?.replace(SEAT_PREFIX, "keiyaku-seat-");
  if (former === undefined && previous === undefined) return false;
  const { participants } = await square.participants({}, { signal });
  return participants.some(({ name, state }) => (name === former || name === previous) && state === "done");
}

/**
 * A binding this edge cannot stand on is never replaced by a fresh name: Square
 * adjudicates standing, ownership, and lifecycle. The edge only distinguishes a
 * Square that is genuinely not there yet from evidence it cannot trust.
 */
async function standingAt(
  location: string,
  environment: NodeJS.ProcessEnv,
  ids: readonly string[],
  signal: AbortSignal,
): Promise<Standing> {
  let square: Square;
  try {
    square = await Square.at({ path: location, env: environment }, { signal });
  } catch (error) {
    // Only a Square that is genuinely not there yet may receive a new seat.
    return error instanceof SquareError && error.code === "unavailable"
      ? { kind: "absent" }
      : { kind: "indeterminate" };
  }
  try {
    const recognized = await square.recognize(environment);
    if (recognized !== null) return { kind: "standing", name: recognized.name };
    const bindings = await joinedBindings(environment, ids, square.location, signal);
    if (bindings.here > 0 || !bindings.complete) return { kind: "indeterminate" };
    return (await finishedHere(square, environment, signal)) ? { kind: "indeterminate" } : { kind: "absent" };
  } catch {
    return { kind: "indeterminate" };
  } finally {
    await square.close().catch(() => undefined);
  }
}

export type SquareSeatInput = Readonly<{ path: WorldRoot; environment: NodeJS.ProcessEnv }>;

export type SquareSeatControl = Readonly<{ signal?: AbortSignal; budgetMs?: number }>;

/**
 * The one bounded attempt. A late settlement keeps no authority: the adapter only
 * reads Square, so nothing arrives after the caller has settled, and no refusal
 * escapes as an unhandled rejection.
 */
async function bounded<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  control: SquareSeatControl,
): Promise<T | undefined> {
  const budget = new AbortController();
  const timer = setTimeout(
    () => budget.abort(new Error("Square identity observation expired")),
    control.budgetMs ?? IDENTITY_BUDGET_MS,
  );
  const signal = control.signal === undefined ? budget.signal : AbortSignal.any([control.signal, budget.signal]);
  const pending = attempt(signal);
  pending.catch(() => undefined);
  try {
    return await Promise.race([pending, whenAborted(signal)]);
  } finally {
    clearTimeout(timer);
  }
}

function whenAborted(signal: AbortSignal): Promise<undefined> {
  return new Promise((settle) => {
    if (signal.aborted) settle(undefined);
    else signal.addEventListener("abort", () => settle(undefined), { once: true });
  });
}

/**
 * The Square participant name this submitting session should speak as, or
 * undefined when no honest choice exists. Identity preparation is optional, so it
 * never refuses the enclosing operation and always settles within one budget.
 */
export async function squareSeat(input: SquareSeatInput, control: SquareSeatControl = {}): Promise<string | undefined> {
  const name = declared(input.environment, "SQUARE_PARTICIPANT_NAME");
  if (name !== undefined) return (await usableName(name)) ? name : undefined;
  const ids = sessionIds(input.environment);
  // No session coordinate: nothing to reuse, nothing to derive, nothing to read.
  if (ids.length === 0) return undefined;
  const location = join(input.path, ".square", "KEIYAKU.square");
  const standing = await bounded(async (signal) => await standingAt(location, input.environment, ids, signal), control);
  if (standing?.kind === "standing") return standing.name;
  return standing?.kind === "absent" ? seatCandidate(input.environment) : undefined;
}
