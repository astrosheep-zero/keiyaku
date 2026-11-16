/** @architectureCompositionRoot */
import { isAbsolute, resolve } from "node:path";
import { requireOwner, type Owner } from "@astrosheep/square";
import { parseDuration } from "../duration.js";
import { ZodError, type z } from "zod";
import {
  verbs,
  type KeiyakuRunOptions,
  type VerbName,
  type VerbInput,
  type VerbOutput,
  type VerbRunFor,
  type VerbProgress,
} from "./keiyaku-verbs.js";
import { canonicalBirthCwd } from "../akuma/call-input.js";
import { World, WorldError } from "../world.js";
import { Akuma } from "../akuma/akuma-instance.js";
import { Kanshi, type KanshiRegionSelection } from "../kanshi/index.js";
import { Akumas } from "./akumas.js";
import { observeNamedAddress, resolveNamedAddress } from "./address.js";
import { waitInvocation } from "./keiyaku-wait.js";
import type { AskObserver } from "../akuma/akuma-selection-execution.js";
import { deliveryOwner } from "./keiyaku-attribution.js";
import { akumaCallerFromEnvironment } from "./keiyaku-identity.js";
import { contractId, type ContractId } from "../core/facts/types.js";
import { Settings } from "../settings.js";
import { Keis } from "./contract-composition.js";
import type { BindOutcome } from "./contract-outcomes.js";
import { validateArcMarkdown } from "./input.js";
import { errorCategory } from "../errors.js";
import { invocationCoordinates, KeiyakuArcDocumentError, KeiyakuUsageError } from "./keiyaku-coordinates.js";
import { whoami } from "./keiyaku-identity.js";
import { nukeKeiyaku } from "./nuke.js";
import type { AkumaCaller } from "../akuma/caller.js";
import * as debt from "./keiyaku-debt.js";
import type { AkumaAlias } from "../identity/selector.js";
import { validateAkumaName } from "../identity/normalize.js";
export { KeiyakuArcDocumentError, KeiyakuUsageError } from "./keiyaku-coordinates.js";

export type KeiyakuFor = Readonly<{
  cwd: string;
  environment: Readonly<Record<string, string | undefined>>;
  home?: string;
  repo?: string;
  identity?: Readonly<{ owner: Owner }>;
}>;

type ParsedInput<K extends VerbName> = z.output<(typeof verbs)[K]["input"]>;

/** Invocation composition captures caller coordinates, never ambient process state. */
type VerbRequest = { [K in VerbName]: Readonly<{ name: K; input: ParsedInput<K> }> }[VerbName];

type ExecutionControls<K extends VerbName> = KeiyakuRunOptions &
  Readonly<{ observe?: (event: VerbProgress<K>) => void }>;
type Executions = {
  [K in VerbName]: (input: ParsedInput<K>, controls: ExecutionControls<K>) => Promise<VerbOutput<K>>;
};

function executionSignal(controls: KeiyakuRunOptions) {
  return controls.signal === undefined ? {} : { signal: controls.signal };
}

function mutationProgress<K extends "deliver" | "verify" | "review">(controls: ExecutionControls<K>) {
  return controls.observe === undefined ? undefined : { observe: controls.observe };
}

function observationTimeout(timeout: string): number {
  const duration = parseDuration(timeout);
  if (duration.kind !== "parsed") throw new KeiyakuUsageError("invalid timeout duration");
  return duration.milliseconds;
}

export class Keiyaku {
  static readonly verbs: typeof verbs = verbs;
  readonly #input: KeiyakuFor;

  private constructor(input: KeiyakuFor) {
    let owner: Owner | undefined;
    const identity = input.identity;
    if (identity !== undefined) {
      try {
        if (typeof identity !== "object" || identity === null || Array.isArray(identity))
          throw new Error("identity must be an object");
        owner = requireOwner(identity.owner);
        if (!owner.trim()) throw new Error("owner must be nonblank");
      } catch (error) {
        throw new KeiyakuUsageError(`invalid identity: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.#input = {
      ...input,
      environment: { ...input.environment },
      ...(owner === undefined ? {} : { identity: { owner } }),
    };
  }

  static for(input: KeiyakuFor): Keiyaku {
    if (typeof input?.cwd !== "string" || !isAbsolute(input.cwd))
      throw new KeiyakuUsageError("cwd must be an absolute string");
    if (
      typeof input.environment !== "object" ||
      input.environment === null ||
      Array.isArray(input.environment) ||
      Object.values(input.environment).some((value) => value !== undefined && typeof value !== "string")
    )
      throw new KeiyakuUsageError("environment must be a string record");
    if (input.home !== undefined && typeof input.home !== "string")
      throw new KeiyakuUsageError("home must be a string");
    if (input.repo !== undefined && typeof input.repo !== "string")
      throw new KeiyakuUsageError("repo must be a string");
    return new Keiyaku(input);
  }

  async run<K extends VerbName>(name: K, input: VerbInput<K>, run?: VerbRunFor<K>): Promise<VerbOutput<K>> {
    run?.signal?.throwIfAborted();
    let parsed: ParsedInput<K>;
    try {
      parsed = verbs[name].input.parse(input) as ParsedInput<K>;
    } catch (error) {
      if (error instanceof ZodError) throw new KeiyakuUsageError(error.message);
      throw error;
    }
    const observe = run?.observe;
    const notify = (event: VerbProgress<K>): void => {
      try {
        const result = observe?.(event);
        if (result !== undefined) void Promise.resolve(result).catch(() => undefined);
      } catch {
        /* Observation cannot affect execution. */
      }
    };
    return this.#execute[name](parsed, {
      ...executionSignal(run ?? {}),
      ...(observe === undefined ? {} : { observe: notify }),
    });
  }

  readonly #execute: Executions = {
    bind: async (input) => {
      const { library } = await this.#keis();
      if ("forkOf" in input)
        return await library.bind({
          ...input,
          forkOf: this.#fullId(library, input.forkOf),
        });
      const { after, ...rest } = input;
      return await library.bind({
        ...rest,
        ...(after === undefined ? {} : { after: after.map((id) => this.#fullId(library, id)) }),
      });
    },
    amend: async ({ contract, ...input }) => {
      const { cwd, library } = await this.#keis();
      const id = await this.#resolve(library, contract, cwd);
      const { after, ...rest } = input;
      return await library.kei({ id }).amend({
        ...rest,
        ...(after === undefined ? {} : { after: after.map((value) => this.#fullId(library, value)) }),
      });
    },
    arc: async ({ contract, ...input }) => {
      const selected = await this.#selected(contract);
      try {
        validateArcMarkdown(input.body);
      } catch (error) {
        if (errorCategory(error) === "invalid-input") throw new KeiyakuArcDocumentError(selected.id, error as Error);
        throw error;
      }
      return await selected.contract.arc(input);
    },
    deliver: async ({ contract, ...input }, controls) => {
      const selected = (await this.#selected(contract)).contract;
      const { dryRun, ...native } = input;
      return dryRun
        ? await selected.previewDelivery({ ...native, ...executionSignal(controls) }, mutationProgress(controls))
        : await selected.deliver({ ...native, ...executionSignal(controls) }, mutationProgress(controls));
    },
    verify: async ({ contract, ...input }, controls) => {
      return await (
        await this.#selected(contract)
      ).contract.verify({ ...input, ...executionSignal(controls) }, mutationProgress(controls));
    },
    review: async ({ contract, ...input }, controls) => {
      const selected = await this.#selected(contract);
      return await selected.contract.review({ ...input, ...executionSignal(controls) }, mutationProgress(controls));
    },
    abandon: async ({ contract, ...input }) => {
      const selected = await this.#selected(contract);
      return await selected.contract.abandon(input);
    },
    show: async ({ selector }) => {
      if (selector.startsWith("debt/")) return debt.debtShow(this.#input, selector);
      return await (await this.#selected(selector)).contract.guidance();
    },
    reconcile: async (input) => {
      const { cwd, library } = await this.#keis();
      if (input.contract === undefined) return await library.reconcile(input);
      const id = await this.#resolve(library, input.contract, cwd);
      return await library.reconcile({ ...input, contract: id });
    },
    spawn: async ({ prompt, contract, workdir, alias, ...input }, controls) => {
      const at = await this.#coordinates(contract === undefined ? "none" : "required");
      const cwd =
        workdir === undefined
          ? at.cwd
          : await canonicalBirthCwd(resolve(at.cwd, workdir), `workdir is not an existing directory: ${workdir}`);
      const caller = await this.#caller();
      const initiator = deliveryOwner(this.#input.environment, this.#input.identity?.owner);
      const world = at.candidateWorld ?? (await at.establishWorld());
      await World.at(world);
      const configuration = await Settings.load({
        cwd: world,
        ...(this.#input.home === undefined ? {} : { home: this.#input.home }),
      });
      const selected =
        contract === undefined ? undefined : Keis.of(at.repo!).kei({ id: this.#fullId(Keis.of(at.repo!), contract) });
      return await Akumas.of(world).spawn({
        ...input,
        ...executionSignal(controls),
        cwd,
        settings: configuration,
        ...(alias === undefined ? {} : { alias: alias as AkumaAlias }),
        ...(this.#input.home === undefined ? {} : { home: this.#input.home }),
        ...(prompt === undefined ? {} : { body: prompt }),
        ...(selected === undefined ? {} : { contract: selected }),
        ...(caller === undefined ? {} : { caller }),
        ...(initiator === undefined ? {} : { initiator }),
      });
    },
    fork: async (input) => {
      const { at, akumas } = await this.#akumas();
      const caller = await this.#caller();
      const initiator = deliveryOwner(this.#input.environment, this.#input.identity?.owner);
      return await akumas.fork({
        ...input,
        ...(at.repo === undefined ? {} : { repo: at.repo }),
        ...(caller === undefined ? {} : { caller }),
        ...(initiator === undefined ? {} : { initiator }),
      });
    },
    tell: (input, controls) => this.#tell({ name: "tell", input }, executionSignal(controls)),
    ask: (input, controls) =>
      this.#tell(
        { name: "ask", input },
        {
          ...executionSignal(controls),
          ...(controls.observe === undefined
            ? {}
            : {
                observe: {
                  admitted: (tell, id) => controls.observe?.({ kind: "admitted", tell, id }),
                  observe: (observation) => controls.observe?.({ kind: "live", observation }),
                },
              }),
        },
      ),
    kill: async (input, controls) => {
      const { at, akumas } = await this.#akumas();
      return await akumas.kill({
        ...input,
        ...executionSignal(controls),
        ...(at.repo === undefined ? {} : { repo: at.repo }),
      });
    },
    wait: async ({ selectors, timeout, ...input }, controls) => {
      const hasContracts = selectors.some((selector) => selector.startsWith("kei/"));
      const contractOnly = selectors.every((selector) => selector.startsWith("kei/"));
      const at = await this.#coordinates(hasContracts ? "required" : "optional", contractOnly);
      if (hasContracts && at.repo === undefined) throw new KeiyakuUsageError("Contract wait requires a repository");
      if (!contractOnly && at.world === null) throw new KeiyakuUsageError("Akuma wait requires a World");
      return await waitInvocation({
        selectors,
        ...input,
        ...executionSignal(controls),
        ...(at.repo === undefined ? {} : { repo: at.repo }),
        ...(at.world === null ? {} : { world: at.world }),
        ...(timeout === undefined ? {} : { timeoutMs: observationTimeout(timeout) }),
      });
    },
    history: async ({ selector, ...input }) => {
      if (selector.startsWith("kei/")) {
        const at = await this.#coordinates("required");
        if (at.repo === undefined) throw new KeiyakuUsageError("this command requires a resolved Repo");
        const library = Keis.of(at.repo);
        return await library
          .kei({ id: this.#fullId(library, selector) })
          .history("details" in input ? { details: input.details } : undefined);
      }
      const { at, akumas } = await this.#akumas();
      return await akumas.history({
        akuma: selector,
        ...("item" in input ? (input.item === "last" ? { last: true } : { id: input.item }) : input),
        ...(at.repo === undefined ? {} : { repo: at.repo }),
      });
    },
    report: async (input, controls) => {
      await this.#coordinates("none");
      let caller;
      try {
        caller = await this.#caller();
      } catch (error) {
        if (error instanceof WorldError) throw new KeiyakuUsageError(error.message);
        throw error;
      }
      if (caller?.kind !== "akuma")
        throw new KeiyakuUsageError(
          this.#input.identity === undefined
            ? "report requires explicit KEIYAKU_ACTOR_ID and KEIYAKU_ACTOR_WORLD"
            : "report requires explicit Akuma execution identity",
        );
      return Akuma.select(caller.world, caller.akumaId).report(input.text, executionSignal(controls));
    },
    whoami: async () => {
      return await whoami(await this.#coordinates("optional"), this.#input.environment, this.#input.identity?.owner);
    },
    settings: async () => {
      const at = await this.#coordinates("none");
      return await Settings.load({
        ...(at.world === null ? {} : { cwd: at.world }),
        ...(this.#input.home === undefined ? {} : { home: this.#input.home }),
      });
    },
    nuke: async (input) => {
      const at = await this.#coordinates("none");
      if (at.world === null) throw new KeiyakuUsageError("no Keiyaku world contains the invocation cwd");
      return await nukeKeiyaku({ world: at.world, ...input });
    },
    kanshi: async () => {
      const at = await this.#coordinates("optional");
      return Kanshi.of({ world: at.world, ...(at.repo === undefined ? {} : { repo: at.repo }) }).board();
    },
    status: async (input) => {
      const at = await this.#coordinates("optional");
      const selector = input.selector;
      const id = selector.startsWith("@")
        ? resolveNamedAddress({
            selector,
            ...(await observeNamedAddress({ world: at.world, repo: at.repo ?? null, selectors: [selector] })),
          }).id
        : selector;
      if (id.startsWith("aku/")) {
        if (at.world === null) throw new KeiyakuUsageError("no Keiyaku world contains the invocation cwd");
        return Akumas.of(at.world).status({
          akuma: id,
          ...(at.repo === undefined ? {} : { repo: at.repo }),
        });
      }
      if (at.repo === undefined) throw new KeiyakuUsageError("this command requires a resolved Repo");
      const report = await Kanshi.of({ world: at.world, repo: at.repo }).contract(contractId(id));
      if (report.kind === "contract-absent") throw new Error("Contract observation with a Repo cannot be absent");
      return report;
    },
    region: async (input) => {
      const at = await this.#coordinates("required");
      if (at.repo === undefined) throw new KeiyakuUsageError("this command requires a resolved Repo");
      const repo = at.repo;
      const selected: KanshiRegionSelection =
        input.paths !== undefined
          ? { kind: "path", patterns: input.paths }
          : input.contract === undefined
            ? { kind: "declarations" }
            : { kind: "contract", contract: await this.#resolve(Keis.of(repo), input.contract, at.cwd) };
      const result = await Kanshi.of({ world: at.world, repo }).region(selected);
      if (result.kind === "absent") throw new Error("Region observation with a Repo cannot be absent");
      return result;
    },
    ls: async (input) => {
      const bound = input.limit === undefined ? {} : { limit: input.limit };
      const lifecycle = input.lifecycle === undefined ? {} : { selection: input.lifecycle };
      if (input.selector === "kei" || input.selector === "kei/") {
        const at = await this.#coordinates("required");
        return Keis.of(at.repo!).list({ ...bound, ...lifecycle });
      }
      if (input.selector === "debt" || input.selector === "debt/")
        return debt.debtLs(this.#input, {
          ...bound,
          ...lifecycle,
        });
      if (input.selector === "aku" || input.selector === "aku/") {
        const at = await this.#coordinates("none");
        return Akumas.akumaNames({
          ...bound,
          ...(at.world === null ? {} : { cwd: at.world }),
          ...(this.#input.home === undefined ? {} : { home: this.#input.home }),
        });
      }
      const name = input.selector.split("/")[1]!;
      const akumaName = name === "*" ? undefined : validateAkumaName(name);
      const { at, akumas } = await this.#akumas();
      const caller = await this.#resolveLsCaller(input.mine);
      return akumas.list({
        ...bound,
        ...lifecycle,
        ...(akumaName === undefined ? {} : { akumaName }),
        ...(caller === undefined ? {} : { caller }),
        ...(at.repo === undefined ? {} : { repo: at.repo }),
      });
    },
    "debt.add": (input, controls) => debt.debtAdd(this.#input, { ...input, ...executionSignal(controls) }, false),
    "debt.addDocument": (input, controls) =>
      debt.debtAdd(this.#input, { ...input, ...executionSignal(controls) }, true),
    "debt.update": (input, controls) => debt.debtUpdate(this.#input, { ...input, ...executionSignal(controls) }),
    "debt.doctor": () => debt.debtDoctor(this.#input),
  };

  bind(input: VerbInput<"bind">, run?: VerbRunFor<"bind">): Promise<BindOutcome> {
    // Generic output describes the wire form; the same execution retains the native handle.
    return this.run("bind", input, run) as Promise<BindOutcome>;
  }
  amend = this.#verb("amend", {});
  arc = this.#verb("arc");
  deliver = this.#verb("deliver", {});
  verify = this.#verb("verify", {});
  review = this.#verb("review");
  abandon = this.#verb("abandon", {});
  show = this.#verb("show");
  reconcile = this.#verb("reconcile", {});
  spawn = this.#verb("spawn");
  fork = this.#verb("fork");
  tell = this.#verb("tell");
  ask = this.#verb("ask");
  kill = this.#verb("kill");
  wait = this.#verb("wait");
  history = this.#verb("history");
  report = this.#verb("report");
  ls = this.#verb("ls");
  debtAdd = this.#verb("debt.add");
  debtAddDocument = this.#verb("debt.addDocument");
  debtUpdate = this.#verb("debt.update");
  debtDoctor = this.#verb("debt.doctor", {});
  kanshi = this.#verb("kanshi", {});
  status = this.#verb("status");
  region = this.#verb("region", {});
  whoami = this.#verb("whoami", {});
  settings = this.#verb("settings", {});
  nuke = this.#verb("nuke", {});

  #verb<K extends VerbName>(name: K): (input: VerbInput<K>, run?: VerbRunFor<K>) => Promise<VerbOutput<K>>;
  #verb<K extends VerbName>(
    name: K,
    empty: VerbInput<K>,
  ): (input?: VerbInput<K>, run?: VerbRunFor<K>) => Promise<VerbOutput<K>>;
  #verb<K extends VerbName>(name: K, empty?: VerbInput<K>) {
    return (input: VerbInput<K> = empty!, run?: VerbRunFor<K>): Promise<VerbOutput<K>> => this.run(name, input, run);
  }

  #coordinates(use: "none" | "optional" | "required", contractWait = false) {
    return invocationCoordinates({ ...this.#input, use, contractWait });
  }

  async #keis() {
    const at = await this.#coordinates("required");
    if (at.repo === undefined) throw new KeiyakuUsageError("this command requires a resolved Repo");
    const configuration = await Settings.load({
      ...(at.world === null ? {} : { cwd: at.world }),
      ...(this.#input.home === undefined ? {} : { home: this.#input.home }),
    });
    return {
      cwd: at.cwd,
      library: Keis.of(at.repo, { settings: configuration }),
    };
  }

  #fullId(library: Keis, value: string): ContractId {
    try {
      library.kei({ id: value as ContractId });
      return value as ContractId;
    } catch (error) {
      throw new KeiyakuUsageError(error instanceof Error ? error.message : String(error));
    }
  }

  async #resolve(library: Keis, selector: string | undefined, cwd: string): Promise<ContractId> {
    const result = await library.resolve({ ...(selector === undefined ? {} : { selector }), cwd });
    if (result.kind === "resolved") return result.id;
    const refusal = result.refusal;
    switch (refusal.kind) {
      case "invalid-selector":
        throw new KeiyakuUsageError(refusal.diagnostic);
      case "redundant-short-selector":
        throw new KeiyakuUsageError(`redundant short contract selector: ${refusal.selector}`);
      case "unknown-short-selector":
        throw new KeiyakuUsageError(`unknown contract selector: ${refusal.selector}`);
      case "ambiguous-selector":
        throw new KeiyakuUsageError(
          "selector" in refusal
            ? `ambiguous contract selector: ${refusal.selector}`
            : "ambiguous managed worktree contract selector",
        );
      case "no-contextual-match":
        throw new KeiyakuUsageError("an explicit full or @ contract selector is required outside a managed worktree");
    }
  }

  async #selected(selector: string | undefined) {
    const { cwd, library } = await this.#keis();
    const id = await this.#resolve(library, selector, cwd);
    return { id, contract: library.kei({ id }) };
  }

  #caller() {
    return akumaCallerFromEnvironment(this.#input.environment, this.#input.identity?.owner);
  }

  async #akumas(use: "optional" | "required" = "optional") {
    const at = await this.#coordinates(use);
    if (at.world === null) throw new KeiyakuUsageError("no Keiyaku world contains the invocation cwd");
    return { at, akumas: Akumas.of(at.world) };
  }

  #tell(request: Extract<VerbRequest, { name: "tell" }>, controls: KeiyakuRunOptions): Promise<VerbOutput<"tell">>;
  #tell(
    request: Extract<VerbRequest, { name: "ask" }>,
    controls: KeiyakuRunOptions & Readonly<{ observe?: AskObserver }>,
  ): Promise<VerbOutput<"ask">>;
  async #tell(
    request: Extract<VerbRequest, { name: "tell" | "ask" }>,
    controls: KeiyakuRunOptions & Readonly<{ observe?: AskObserver }>,
  ) {
    const { at, akumas } = await this.#akumas();
    const initiator = deliveryOwner(this.#input.environment, this.#input.identity?.owner);
    const common = {
      ...controls,
      body: request.input.prompt,
      ...(at.repo === undefined ? {} : { repo: at.repo }),
      ...(initiator === undefined ? {} : { initiator }),
    };
    if (request.name === "ask") {
      const { prompt: _prompt, timeout, ...input } = request.input;
      return akumas.ask({
        ...input,
        ...common,
        ...(timeout === undefined ? {} : { timeoutMs: observationTimeout(timeout) }),
      });
    }
    const { prompt: _prompt, ...input } = request.input;
    return akumas.tell({ ...input, ...common });
  }

  async #resolveLsCaller(mine: boolean | undefined): Promise<AkumaCaller | undefined> {
    if (mine !== true) return undefined;
    let caller: AkumaCaller | undefined;
    try {
      caller = await this.#caller();
    } catch (error) {
      throw new KeiyakuUsageError(error instanceof Error ? error.message : String(error));
    }
    if (caller === undefined) {
      throw new KeiyakuUsageError(
        "listing the caller's own Akumas requires a caller identity; set KEIYAKU_ACTOR_ID and KEIYAKU_ACTOR_WORLD or run inside a calling host",
      );
    }
    return caller;
  }
}
