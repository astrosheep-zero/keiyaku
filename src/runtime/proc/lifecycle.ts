export type ProcessLifecycle = Readonly<{
  markInert(): void;
  terminate(force?: boolean): Promise<void>;
  release(): void;
}>;

export function createProcessLifecycle(
  runTermination: (force: boolean) => Promise<void>,
  releaseCustody: () => void,
): ProcessLifecycle {
  let state: "active" | "terminating" | "inert" = "active";
  let termination: Promise<void> | undefined;
  return {
    markInert(): void {
      state = "inert";
    },
    terminate(force = false): Promise<void> {
      if (state === "inert") return Promise.resolve();
      if (termination !== undefined) return termination;
      state = "terminating";
      termination = runTermination(force).finally(() => {
        state = "inert";
      });
      return termination;
    },
    release(): void {
      if (state !== "active") return;
      state = "inert";
      releaseCustody();
    },
  };
}
