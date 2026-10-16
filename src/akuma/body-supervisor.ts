import { abortableDelay } from "./abort.js";
import { isDeepStrictEqual } from "node:util";
import { createBodyHeartReader, type BodyControlSnapshot, type HeldAkumaLeash } from "./heart/index.js";
import type { AkumaPaths } from "./identity.js";

const BODY_CONTROL_OBSERVATION_MS = 100;
export const CONTROL_RESPONSE_MS = 1_000;

export class BodySupervisor {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly finished = new AbortController();
  private readonly observer: Promise<void>;
  private waiter: ((snapshot: BodyControlSnapshot) => void) | undefined;
  private observation: BodyControlSnapshot;
  private stopping?: "control" | "heart-gone";

  private constructor(
    private readonly paths: AkumaPaths,
    private readonly bodySequence: number,
    private readonly leash: HeldAkumaLeash,
    private readonly reader: ReturnType<typeof createBodyHeartReader>,
    observation: BodyControlSnapshot,
  ) {
    this.signal = this.controller.signal;
    this.observation = observation;
    this.observer = this.observe();
  }

  static async open(paths: AkumaPaths, bodySequence: number, leash: HeldAkumaLeash): Promise<BodySupervisor> {
    const reader = createBodyHeartReader(paths);
    return new BodySupervisor(paths, bodySequence, leash, reader, await reader.read());
  }

  get reason(): "control" | "heart-gone" | undefined {
    return this.stopping;
  }
  current(): BodyControlSnapshot {
    return this.observation;
  }

  async recordHung(diagnostic: string, at: string): Promise<void> {
    await this.leash.recordBodyHung(this.paths, { sequence: this.bodySequence, diagnostic, at });
  }

  async refresh(): Promise<BodyControlSnapshot> {
    const snapshot = await this.reader.read();
    if (!isDeepStrictEqual(snapshot, this.observation)) {
      this.observation = snapshot;
      this.waiter?.(snapshot);
      this.waiter = undefined;
    }
    return this.observation;
  }

  next(after: BodyControlSnapshot): Promise<BodyControlSnapshot> {
    if (this.observation !== after) return Promise.resolve(this.observation);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  cancel(reason: "control" | "heart-gone"): void {
    if (this.stopping !== undefined) return;
    this.stopping = reason;
    this.controller.abort(
      new Error(reason === "control" ? "Akuma Body interrupted by durable control" : "Akuma Heart disappeared"),
    );
    this.waiter?.(this.observation);
    this.waiter = undefined;
  }

  async close(): Promise<void> {
    this.finished.abort();
    try {
      await this.observer;
    } finally {
      this.reader.clear();
      this.waiter = undefined;
    }
  }

  private async observe(): Promise<void> {
    for (;;) {
      const snapshot = this.observation;
      if (snapshot.soul === null) return this.cancel("heart-gone");
      if (snapshot.stop?.bodySequence === this.bodySequence || snapshot.pause?.bodySequence === this.bodySequence) {
        return this.cancel("control");
      }
      try {
        await abortableDelay(BODY_CONTROL_OBSERVATION_MS, this.finished.signal);
      } catch {
        return;
      }
      await this.refresh();
    }
  }
}
