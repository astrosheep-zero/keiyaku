import { createProviderAttempt, type AttemptCustody, type ProviderAdapter, type Session } from "../provider.js";

type DriveInput = Parameters<ProviderAdapter["start"]>[0] | Parameters<NonNullable<ProviderAdapter["resume"]>>[0];

/**
 * Start and resume share one custody descriptor: each creates one attempt whose
 * own controller signal reaches the adapter, and the caller's signal stays a
 * cancellation notification.
 */
export function providerLifecycle(
  drive: (input: DriveInput, custody: AttemptCustody) => Promise<Session>,
): Pick<ProviderAdapter, "start" | "resume"> {
  const attempt = (input: DriveInput) =>
    createProviderAttempt(input.signal, async (custody) => await drive({ ...input, signal: custody.signal }, custody));
  return { start: attempt, resume: attempt };
}
