import type { AgentEventChannel, TurnResult } from "../provider.js";

/** The native outcome, not proof that the attempt's resources retired. */
export function providerTurn(events: AgentEventChannel, beforeEnd: () => void = () => undefined) {
  let resolve!: (result: TurnResult) => void;
  let reject!: (error: unknown) => void;
  const completion = new Promise<TurnResult>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  let terminal = false;
  const settle = (publish: () => void): boolean => {
    if (terminal) return false;
    terminal = true;
    try {
      beforeEnd();
      publish();
    } catch (error) {
      reject(error);
    } finally {
      events.end();
    }
    return true;
  };
  // Setup can fail before a Session is exposed to a consumer.
  void completion.catch(() => undefined);
  return {
    events,
    completion,
    get terminal() {
      return terminal;
    },
    finish: (result: TurnResult) => settle(() => resolve(result)),
    fail: (error: unknown) => settle(() => reject(error)),
  };
}
