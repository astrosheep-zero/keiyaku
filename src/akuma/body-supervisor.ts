import { abortableDelay } from "./abort.js";
import { heartExists, readHeart, type HeartSnapshot, type HeldAkumaLeash } from "./heart/index.js";
import type { AkumaPaths } from "./identity.js";

const BODY_CONTROL_OBSERVATION_MS = 100;
export const CONTROL_RESPONSE_MS = 1_000;

export class BodySupervisor {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly finished = new AbortController();
  private readonly observer: Promise<void>;
  private waiter: ((snapshot: HeartSnapshot) => void) | undefined;
  private observation: HeartSnapshot;
  private stopping?: "control" | "heart-gone";

  private constructor(
    private readonly paths: AkumaPaths,
    private readonly bodySequence: number,
    private readonly leash: HeldAkumaLeash,
    observation: HeartSnapshot,
  ) {
    this.signal = this.controller.signal;
    this.observation = observation;
    this.observer = this.observe();
  }

  static async open(paths: AkumaPaths, bodySequence: number, leash: HeldAkumaLeash): Promise<BodySupervisor> {
    return new BodySupervisor(paths, bodySequence, leash, await readHeart(paths));
  }

  get reason(): "control" | "heart-gone" | undefined {
    return this.stopping;
  }
  current(): HeartSnapshot {
    return this.observation;
  }

  async recordHung(diagnostic: string, at: string): Promise<void> {
    await this.leash.recordBodyHung(this.paths, { sequence: this.bodySequence, diagnostic, at });
  }

  async refresh(): Promise<HeartSnapshot> {
    this.publish(await readHeart(this.paths));
    return this.observation;
  }

  next(after: HeartSnapshot): Promise<HeartSnapshot> {
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
    await this.observer;
    this.waiter = undefined;
  }

  private publish(snapshot: HeartSnapshot): void {
    this.observation = snapshot;
    this.waiter?.(snapshot);
    this.waiter = undefined;
  }

  private async observe(): Promise<void> {
    for (;;) {
      const snapshot = this.observation;
      if (!(await heartExists(this.paths))) return this.cancel("heart-gone");
      if (snapshot.stop?.bodySequence === this.bodySequence || snapshot.pause?.bodySequence === this.bodySequence) {
        return this.cancel("control");
      }
      try {
        await abortableDelay(BODY_CONTROL_OBSERVATION_MS, this.finished.signal);
      } catch {
        return;
      }
      try {
        await this.refresh();
      } catch (error) {
        if (await heartExists(this.paths)) throw error;
        return this.cancel("heart-gone");
      }
    }
  }
}
