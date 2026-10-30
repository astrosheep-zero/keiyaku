import { setMaxListeners } from "node:events";
import type { BodyLauncher, BodyLaunchEnd, LiveBodyLaunch } from "./akuma/body-launch.js";
import { spawnAkumaBody } from "./akuma/detached-body.js";
import { launchInProcessBody } from "./akuma/in-process-body.js";
import { bodyProcessConfiguration, externalRequestCommandsFor } from "./body-requests.js";

export type AkumaHostOptions = Readonly<{
  /** Detached by default. In-process Bodies share this Node runtime's lifetime. */
  hosting?: "detached" | "in-process";
  /** Plugin diagnostics produced in this host, never remote Body logs. */
  reportDiagnostic?: (message: string) => void;
}>;

function inProcessLauncher(
  scopeSignal?: AbortSignal,
  enroll?: (launch: Promise<LiveBodyLaunch>) => void,
): BodyLauncher {
  const spawn: BodyLauncher = (launch) => {
    scopeSignal?.throwIfAborted();
    const pending = launchInProcessBody(
      launch,
      async (signal) => {
        signal.throwIfAborted();
        const { world, commands, executionAssociation } = await externalRequestCommandsFor(
          launch,
          bodyProcessConfiguration(),
          spawnAkumaBody,
        );
        return { world, externalCommands: commands, executionAssociation, spawn, requestSpawn: spawnAkumaBody };
      },
      undefined,
      scopeSignal,
    );
    // Every launch, including automatic succession, enrols before yielding.
    enroll?.(pending);
    return pending;
  };
  return spawn;
}

const inProcessBody = inProcessLauncher();
class ScopedAkumaHost {
  static launcher(scope: ScopedAkumaHost): BodyLauncher {
    return scope.#launch;
  }
  readonly hosting = "in-process" as const;
  readonly reportDiagnostic?: (message: string) => void;
  #controller = new AbortController();
  #active = new Set<Promise<BodyLaunchEnd>>();
  #failures: unknown[] = [];
  #closing?: Promise<void>;
  #launch: BodyLauncher;

  constructor(options?: Pick<AkumaHostOptions, "reportDiagnostic">) {
    setMaxListeners(0, this.#controller.signal);
    const reportDiagnostic = captureAkumaHost(options).reportDiagnostic;
    if (reportDiagnostic !== undefined) this.reportDiagnostic = reportDiagnostic;
    this.#launch = inProcessLauncher(this.#controller.signal, (pending) => {
      const done = pending.then((child) => child.completed);
      this.#active.add(done);
      void done.then(
        () => this.#active.delete(done),
        (error: unknown) => {
          this.#active.delete(done);
          this.#failures.push(error);
        },
      );
    });
    Object.freeze(this);
  }

  /** Stop only this scope's exact launches. Hung/failed retirement rejects; no identity-wide kill is issued. */
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#controller.abort(new Error("Akuma host scope is closed"));
    this.#closing = (async () => {
      await Promise.allSettled([...this.#active]);
      if (this.#failures.length) throw new AggregateError(this.#failures, "Akuma host scope retirement failed");
    })();
    return this.#closing;
  }
}

/** An ephemeral capability, not an Akuma identity set or persisted hosting policy. */
export type AkumaHostScope = ScopedAkumaHost;
export const AkumaHost = Object.freeze({
  /** Create an in-process launch scope. Pass the scope itself as the public host option. */
  inProcess(options?: Pick<AkumaHostOptions, "reportDiagnostic">): AkumaHostScope {
    return new ScopedAkumaHost(options);
  },
});

/** Capture host capabilities once, independently of observation and request routing. */
export function captureAkumaHost(host?: AkumaHostOptions): Readonly<{
  spawn: BodyLauncher;
  reportDiagnostic?: (message: string) => void;
}> {
  if (host !== undefined && (typeof host !== "object" || host === null || Array.isArray(host)))
    throw new TypeError("Akuma host options must be an object");
  const unknown = Object.keys(host ?? {}).find((key) => key !== "reportDiagnostic" && key !== "hosting");
  if (unknown !== undefined) throw new TypeError(`Akuma host options has unknown field: ${unknown}`);
  const hosting = host?.hosting;
  if (hosting !== undefined && hosting !== "detached" && hosting !== "in-process")
    throw new TypeError("Akuma host hosting must be detached or in-process");
  const reportDiagnostic = host?.reportDiagnostic;
  if (reportDiagnostic !== undefined && typeof reportDiagnostic !== "function")
    throw new TypeError("Akuma host reportDiagnostic must be a function");
  return Object.freeze({
    spawn:
      host instanceof ScopedAkumaHost
        ? ScopedAkumaHost.launcher(host)
        : hosting === "in-process"
          ? inProcessBody
          : spawnAkumaBody,
    ...(reportDiagnostic === undefined ? {} : { reportDiagnostic }),
  });
}
