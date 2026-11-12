/** @architectureCompositionRoot */
import { isAbsolute, resolve } from "node:path";
import { ZodError } from "zod";
import {
  verbs,
  type VerbName,
  type VerbInput,
  type VerbOutput,
  type VerbRun,
  type VerbRunFor,
} from "./keiyaku-verbs.js";
import type { AskProgress } from "../akuma/akuma-selection-execution.js";
import type { SpawnProgress } from "./akuma-creation.js";
import { canonicalBirthCwd } from "../akuma/call-input.js";
import { World, WorldError } from "../world.js";
import { Akuma } from "../akuma/akuma-instance.js";
import { Kanshi, type KanshiRegionSelection } from "../kanshi/index.js";
import {
  Akumas,
  type SpawnInput,
  type ForkInput,
  type AkumaAskInput,
  type AkumaTellInput,
  type AkumaKillInput,
  type AkumaHistoryInput,
} from "./akumas.js";
import type { ContractWaitInput } from "./contract-wait.js";
import { deliveryOwner, resolveActor } from "./keiyaku-attribution.js";
import { akumaCallerFromEnvironment } from "./keiyaku-identity.js";
import { contractId, type ContractId } from "../core/facts/types.js";
import { Settings } from "../settings.js";
import { Keis, type ReconcileInput } from "./contract-composition.js";
import type { MutationObservation } from "./contract-outcomes.js";
import type { AbandonInput, AmendInput, ArcInput, BindInput, ReviewInput, VerifyInput } from "./contract-types.js";
import { validateArcMarkdown } from "./input.js";
import { KeiyakuError } from "./outcome.js";
import { invocationCoordinates, KeiyakuArcDocumentError, KeiyakuUsageError } from "./keiyaku-coordinates.js";
import { whoami } from "./keiyaku-identity.js";
import { nukeKeiyaku } from "./nuke.js";
import type { AkumaCaller } from "../akuma/caller.js";
import type { AddDebtInput, AddDebtDocumentInput } from "../debt/index.js";
import * as debt from "./keiyaku-debt.js";
import { validateAkumaName } from "../identity/normalize.js";
import type { DebtUpdateInvocation } from "./keiyaku-debt.js";
export type { DebtUpdateInvocation } from "./keiyaku-debt.js";
export { KeiyakuArcDocumentError, KeiyakuUsageError } from "./keiyaku-coordinates.js";

export type KeiyakuAt = Readonly<{
  cwd: string;
  environment: Readonly<Record<string, string | undefined>>;
  home?: string;
  repo?: string;
}>;

type Selected<T> = T & Readonly<{ contract?: string }>;
type BindInvocation =
  | (Omit<Extract<BindInput, { markdown: string }>, "after"> & Readonly<{ after?: readonly string[] }>)
  | (Omit<Extract<BindInput, { forkOf: ContractId }>, "forkOf"> & Readonly<{ forkOf: string }>);
type AmendInvocation = Omit<AmendInput, "after"> & Readonly<{ after?: readonly string[] }>;
type SpawnInvocation = Omit<SpawnInput, "body" | "cwd" | "contract" | "home" | "settings" | "caller" | "initiator"> &
  Readonly<{
    prompt?: string;
    contract?: string;
    workdir?: string;
  }>;
type TellInvocation = Omit<AkumaTellInput, "body" | "repo" | "initiator"> & Readonly<{ prompt: string }>;
type AskInvocation = Omit<AkumaAskInput, "body" | "repo" | "initiator"> & Readonly<{ prompt: string }>;
type ForkInvocation = Omit<ForkInput, "repo" | "caller" | "initiator">;
type KillInvocation = Omit<AkumaKillInput, "repo">;
type HistoryInvocation = Omit<AkumaHistoryInput, "akuma" | "repo"> & Readonly<{ selector: string; full?: boolean }>;
type WaitInvocation = Omit<ContractWaitInput, "contracts"> & Readonly<{ selectors: readonly string[] }>;

/** Invocation composition captures caller coordinates, never ambient process state. */
type VerbRequest = { [K in VerbName]: Readonly<{ name: K; input: VerbInput<K> }> }[VerbName];

export class Keiyaku {
  static readonly verbs: typeof verbs = verbs;
  readonly #input: KeiyakuAt;

  private constructor(input: KeiyakuAt) {
    this.#input = { ...input, environment: { ...input.environment } };
  }

  static at(input: KeiyakuAt): Keiyaku {
    if (typeof input?.cwd !== "string" || !isAbsolute(input.cwd)) throw new TypeError("cwd must be an absolute string");
    if (
      typeof input.environment !== "object" ||
      input.environment === null ||
      Array.isArray(input.environment) ||
      Object.values(input.environment).some((value) => value !== undefined && typeof value !== "string")
    )
      throw new TypeError("environment must be a string record");
    if (input.home !== undefined && typeof input.home !== "string") throw new TypeError("home must be a string");
    if (input.repo !== undefined && typeof input.repo !== "string") throw new TypeError("repo must be a string");
    return new Keiyaku(input);
  }

  async run<K extends VerbName>(name: K, input: VerbInput<K>, run?: VerbRunFor<K>): Promise<VerbOutput<K>> {
    let parsed: unknown;
    try {
      parsed = verbs[name].input.parse(input);
    } catch (error) {
      if (error instanceof ZodError) throw new KeiyakuUsageError(error.message);
      throw error;
    }
    const observe = run?.observe;
    const notify = (event: unknown): void => {
      try {
        const result = (observe as ((event: unknown) => void | PromiseLike<void>) | undefined)?.(event);
        if (result !== undefined) void Promise.resolve(result).catch(() => undefined);
      } catch {
        /* Observation cannot affect execution. */
      }
    };
    return (await this.#dispatch({ name, input: parsed } as VerbRequest, run, notify)) as VerbOutput<K>;
  }

  async #dispatch(
    request: VerbRequest,
    run: VerbRunFor<VerbName> | undefined,
    notify: (event: unknown) => void,
  ): Promise<unknown> {
    const signal = run?.signal === undefined ? {} : { signal: run.signal };
    const observe = run?.observe;
    switch (request.name) {
      case "bind":
        return this.#bind(request.input as BindInvocation);
      case "amend":
        return this.#amend(request.input);
      case "arc":
        return this.#arc(request.input);
      case "deliver":
        return this.#deliver(
          { ...request.input, ...signal },
          observe === undefined ? undefined : { observe: (event) => notify(event) },
        );
      case "verify":
        return this.#verify(
          { ...request.input, ...signal },
          observe === undefined ? undefined : { observe: (event) => notify(event) },
        );
      case "review":
        return this.#review(
          { ...request.input, ...signal },
          observe === undefined ? undefined : { observe: (event) => notify(event) },
        );
      case "abandon":
        return this.#abandon(request.input);
      case "show":
        return this.#show(request.input);
      case "reconcile":
        return this.#reconcile(request.input);
      case "spawn":
      case "fork":
      case "tell":
      case "ask":
      case "kill":
      case "wait":
      case "history":
      case "report":
        return this.#dispatchAkuma(request, run, notify);
      case "whoami":
        return this.#whoami();
      case "settings":
        return this.#settings();
      case "nuke":
        return this.#nuke(request.input);
      case "kanshi": {
        const at = await this.#coordinates("optional");
        return Kanshi.of({ world: at.world, ...(at.repo === undefined ? {} : { repo: at.repo }) }).board();
      }
      case "status": {
        const at = await this.#coordinates("optional");
        if (request.input.id.startsWith("aku/")) {
          if (at.world === null) throw new KeiyakuUsageError("no Keiyaku world contains the invocation cwd");
          return Akumas.of(at.world).status({
            akuma: request.input.id,
            ...(at.repo === undefined ? {} : { repo: at.repo }),
          });
        }
        if (at.repo === undefined) throw new KeiyakuUsageError("this command requires a resolved Repo");
        const report = await Kanshi.of({ world: at.world, repo: at.repo }).contract(contractId(request.input.id));
        if (report.kind === "contract-absent") throw new Error("Contract observation with a Repo cannot be absent");
        return report;
      }
      case "region":
        return this.#region(request.input);
      case "ls":
        return this.#ls(request.input);
      default:
        return this.#dispatchDebt(request, signal);
    }
  }

  async #dispatchAkuma(
    request: Extract<
      VerbRequest,
      {
        name: "spawn" | "fork" | "tell" | "ask" | "kill" | "wait" | "history" | "report";
      }
    >,
    run: VerbRunFor<VerbName> | undefined,
    notify: (event: unknown) => void,
  ) {
    const signal = run?.signal === undefined ? {} : { signal: run.signal };
    const observe = run?.observe;
    switch (request.name) {
      case "spawn": {
        return this.#spawn({
          ...request.input,
          ...signal,
          ...(observe === undefined
            ? {}
            : {
                observe: {
                  admitted: (tell, id, head) => notify({ kind: "admitted", tell, id, head }),
                  observe: (observation) => notify({ kind: "live", observation }),
                },
              }),
        } as SpawnInvocation);
      }
      case "fork":
        return this.#fork(request.input);
      case "tell":
      case "ask": {
        const input: TellInvocation | AskInvocation = {
          ...request.input,
          ...signal,
          ...(observe === undefined
            ? {}
            : {
                observe: {
                  admitted: (tell, id) => notify({ kind: "admitted", tell, id }),
                  observe: (observation) => notify({ kind: "live", observation }),
                },
              }),
        };
        return "schema" in input ? this.#ask(input) : this.#tell(input);
      }
      case "kill":
        return this.#kill({ ...request.input, ...signal });
      case "wait":
        return this.#wait({ ...request.input, ...signal });
      case "history":
        return this.#history(request.input);
      case "report":
        return this.#report({ ...request.input, ...signal });
    }
  }

  #dispatchDebt(request: Extract<VerbRequest, { name: `debt.${string}` }>, signal: Readonly<{ signal?: AbortSignal }>) {
    switch (request.name) {
      case "debt.add":
        return debt.debtAdd(this.#input, { ...request.input, ...signal } as AddDebtInput, false);
      case "debt.addDocument":
        return debt.debtAdd(this.#input, { ...request.input, ...signal }, true);
      case "debt.update":
        return debt.debtUpdate(this.#input, { ...request.input, ...signal } as DebtUpdateInvocation);
      case "debt.doctor":
        return debt.debtDoctor(this.#input);
    }
  }

  async bind(input: VerbInput<"bind">) {
    const parsed = verbs.bind.input.safeParse(input);
    if (!parsed.success) throw new KeiyakuUsageError(parsed.error.message);
    return this.#bind(parsed.data);
  }
  amend(input: VerbInput<"amend">) {
    return this.run("amend", input);
  }
  arc(input: Selected<ArcInput>) {
    return this.run("arc", input);
  }
  deliver(input: VerbInput<"deliver">, run?: VerbRunFor<"deliver">) {
    return this.run("deliver", input, run);
  }
  verify(input: Omit<Selected<VerifyInput>, "signal">, run?: VerbRunFor<"verify">) {
    return this.run("verify", input, run);
  }
  review(input: Omit<Selected<ReviewInput>, "signal">, run?: VerbRunFor<"review">) {
    return this.run("review", input, run);
  }
  abandon(input: Selected<AbandonInput>) {
    return this.run("abandon", input);
  }
  show(input: VerbInput<"show"> = {}) {
    return this.run("show", input);
  }
  reconcile(input: ReconcileInput = {}) {
    return this.run("reconcile", input);
  }
  spawn(input: VerbInput<"spawn">, run?: VerbRun<SpawnProgress>) {
    return this.run("spawn", input, run);
  }
  fork(input: ForkInvocation) {
    return this.run("fork", input);
  }
  tell(input: VerbInput<"tell">, run?: VerbRun<AskProgress>) {
    return this.run("tell", input, run);
  }
  ask(input: Omit<AskInvocation, "signal" | "observe">, run?: VerbRun<AskProgress>) {
    return this.run("ask", input, run);
  }
  kill(input: Omit<KillInvocation, "signal">, run?: VerbRun) {
    return this.run("kill", input, run);
  }
  wait(input: Omit<WaitInvocation, "signal">, run?: VerbRun) {
    return this.run("wait", input, run);
  }
  history(input: VerbInput<"history">) {
    return this.run("history", input);
  }
  report(input: Readonly<{ text: string }>, run?: VerbRun) {
    return this.run("report", input, run);
  }
  ls(input: VerbInput<"ls">) {
    return this.run("ls", input);
  }
  debtAdd({ signal, ...input }: AddDebtInput) {
    return this.run("debt.add", input, signal === undefined ? {} : { signal });
  }
  debtAddDocument({ signal, ...input }: AddDebtDocumentInput) {
    return this.run("debt.addDocument", input, signal === undefined ? {} : { signal });
  }
  debtUpdate({ signal, ...input }: DebtUpdateInvocation) {
    return this.run("debt.update", input, signal === undefined ? {} : { signal });
  }
  debtDoctor(input: VerbInput<"debt.doctor">) {
    return this.run("debt.doctor", input);
  }
  kanshi(input: VerbInput<"kanshi">) {
    return this.run("kanshi", input);
  }
  status(input: VerbInput<"status">) {
    return this.run("status", input);
  }
  region(input: VerbInput<"region"> = {}) {
    return this.run("region", input);
  }
  whoami(input: VerbInput<"whoami">) {
    return this.run("whoami", input);
  }
  settings(input: VerbInput<"settings">) {
    return this.run("settings", input);
  }
  nuke(input: Readonly<{ confirm?: string }> = {}) {
    return this.run("nuke", input);
  }

  #coordinates(use: "none" | "optional" | "required", contractWait = false) {
    return invocationCoordinates({ ...this.#input, use, contractWait });
  }

  #actor(explicit?: string) {
    try {
      const actor = resolveActor({
        env: this.#input.environment,
        ...(explicit === undefined ? {} : { actor: explicit }),
      });
      return actor === undefined ? {} : { actor };
    } catch (error) {
      throw new KeiyakuUsageError(error instanceof Error ? error.message : String(error));
    }
  }

  async #keis(actor?: string) {
    const at = await this.#coordinates("required");
    if (at.repo === undefined) throw new KeiyakuUsageError("this command requires a resolved Repo");
    const configuration = await Settings.load({
      ...(at.world === null ? {} : { cwd: at.world }),
      ...(this.#input.home === undefined ? {} : { home: this.#input.home }),
    });
    const selected = this.#actor(actor);
    return {
      cwd: at.cwd,
      actor: selected,
      library: Keis.of(at.repo, { settings: configuration, ...selected }),
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

  async #selected(selector: string | undefined, actor?: string) {
    const { cwd, library, actor: selectedActor } = await this.#keis(actor);
    const id = await this.#resolve(library, selector, cwd);
    return { id, contract: library.kei({ id }), actor: selectedActor };
  }

  async #bind(input: BindInvocation) {
    const { library, actor } = await this.#keis(input.actor);
    if ("forkOf" in input)
      return await library.bind({
        ...input,
        forkOf: this.#fullId(library, input.forkOf),
        ...actor,
      });
    const { after, ...rest } = input;
    return await library.bind({
      ...rest,
      ...(after === undefined ? {} : { after: after.map((id) => this.#fullId(library, id)) }),
      ...actor,
    });
  }

  async #amend({ contract, ...input }: Selected<AmendInvocation>) {
    const { cwd, library, actor } = await this.#keis(input.actor);
    const id = await this.#resolve(library, contract, cwd);
    const { after, ...rest } = input;
    return await library.kei({ id }).amend({
      ...rest,
      ...(after === undefined ? {} : { after: after.map((value) => this.#fullId(library, value)) }),
      ...actor,
    });
  }

  async #arc({ contract, ...input }: Selected<ArcInput>) {
    const selected = await this.#selected(contract, input.actor);
    try {
      validateArcMarkdown(input.markdown);
    } catch (error) {
      if (error instanceof TypeError || (error instanceof KeiyakuError && error.category === "invalid-input"))
        throw new KeiyakuArcDocumentError(selected.id, error);
      throw error;
    }
    return await selected.contract.arc({ ...input, ...selected.actor });
  }

  async #deliver(
    { contract, ...input }: VerbInput<"deliver"> & Readonly<{ signal?: AbortSignal }>,
    progress?: MutationObservation,
  ) {
    const selected = (await this.#selected(contract)).contract;
    const { dryRun, ...native } = input;
    return dryRun ? await selected.previewDelivery(native, progress) : await selected.deliver(native, progress);
  }

  async #verify({ contract, ...input }: Selected<VerifyInput>, progress?: MutationObservation) {
    return await (await this.#selected(contract)).contract.verify(input, progress);
  }

  async #review({ contract, ...input }: Selected<ReviewInput>, progress?: MutationObservation) {
    const selected = await this.#selected(contract, input.actor);
    return await selected.contract.review({ ...input, ...selected.actor }, progress);
  }

  async #abandon({ contract, ...input }: Selected<AbandonInput>) {
    const selected = await this.#selected(contract, input.actor);
    return await selected.contract.abandon({ ...input, ...selected.actor });
  }

  async #show(input: VerbInput<"show">) {
    if ("ids" in input) return debt.debtShow(this.#input, input.ids);
    if (input.id?.startsWith("debt/") === true) return debt.debtShow(this.#input, [input.id]);
    return await (await this.#selected(input.id)).contract.guidance();
  }

  async #reconcile(input: ReconcileInput = {}) {
    const { cwd, library } = await this.#keis();
    if (input.contract === undefined) return await library.reconcile(input);
    const id = await this.#resolve(library, input.contract, cwd);
    return await library.reconcile({ ...input, contract: id });
  }

  async #spawn({ prompt, contract, workdir, writableDirectories, observe, ...input }: SpawnInvocation) {
    const at = await this.#coordinates(contract === undefined ? "none" : "required");
    const cwd =
      workdir === undefined
        ? at.cwd
        : await canonicalBirthCwd(resolve(at.cwd, workdir), `workdir is not an existing directory: ${workdir}`);
    const directories =
      writableDirectories === undefined
        ? undefined
        : await Promise.all(
            writableDirectories.map((path) => {
              if (path.trim() === "") throw new TypeError("--add-dir requires a nonblank directory");
              return canonicalBirthCwd(resolve(at.cwd, path));
            }),
          );
    const caller = await this.#caller();
    const initiator = deliveryOwner(this.#input.environment);
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
      cwd,
      settings: configuration,
      ...(this.#input.home === undefined ? {} : { home: this.#input.home }),
      ...(prompt === undefined ? {} : { body: prompt }),
      ...(directories === undefined ? {} : { writableDirectories: directories }),
      ...(selected === undefined ? {} : { contract: selected }),
      ...(caller === undefined ? {} : { caller }),
      ...(initiator === undefined ? {} : { initiator }),
      ...(observe === undefined
        ? {}
        : {
            observe: {
              ...(observe.observe === undefined ? {} : { observe: observe.observe }),
              ...(observe.admitted === undefined
                ? {}
                : {
                    admitted: (tell, id, head) => observe.admitted!(tell, id, { ...head, cwd }),
                  }),
            },
          }),
    });
  }

  async #caller() {
    try {
      return await akumaCallerFromEnvironment(this.#input.environment);
    } catch (error) {
      if (error instanceof TypeError) throw new KeiyakuUsageError(error.message);
      throw error;
    }
  }

  async #akumas(use: "optional" | "required" = "optional") {
    const at = await this.#coordinates(use);
    if (at.world === null) throw new KeiyakuUsageError("no Keiyaku world contains the invocation cwd");
    return { at, akumas: Akumas.of(at.world) };
  }

  async #fork(input: ForkInvocation) {
    const { at, akumas } = await this.#akumas();
    const caller = await this.#caller();
    const initiator = deliveryOwner(this.#input.environment);
    return await akumas.fork({
      ...input,
      ...(at.repo === undefined ? {} : { repo: at.repo }),
      ...(caller === undefined ? {} : { caller }),
      ...(initiator === undefined ? {} : { initiator }),
    });
  }

  async #tell({ prompt, ...input }: TellInvocation) {
    const { at, akumas } = await this.#akumas();
    const initiator = deliveryOwner(this.#input.environment);
    return await akumas.tell({
      ...input,
      body: prompt,
      ...(at.repo === undefined ? {} : { repo: at.repo }),
      ...(initiator === undefined ? {} : { initiator }),
    });
  }

  async #ask({ prompt, ...input }: AskInvocation) {
    const { at, akumas } = await this.#akumas();
    const initiator = deliveryOwner(this.#input.environment);
    return await akumas.ask({
      ...input,
      body: prompt,
      ...(at.repo === undefined ? {} : { repo: at.repo }),
      ...(initiator === undefined ? {} : { initiator }),
    });
  }

  async #kill(input: KillInvocation) {
    const { at, akumas } = await this.#akumas();
    return await akumas.kill({ ...input, ...(at.repo === undefined ? {} : { repo: at.repo }) });
  }

  async #wait({ selectors, ...input }: WaitInvocation) {
    const contracts = selectors.filter((selector) => selector.startsWith("kei/"));
    if (contracts.length > 0) {
      const at = await this.#coordinates("required", true);
      if (at.repo === undefined) throw new KeiyakuUsageError("Contract wait requires a repository");
      return await Keis.of(at.repo).wait({ contracts, ...input });
    }
    const { at, akumas } = await this.#akumas();
    return await akumas.wait({ akuma: selectors, ...input, ...(at.repo === undefined ? {} : { repo: at.repo }) });
  }

  async #history({ selector, full, ...input }: HistoryInvocation) {
    if (selector.startsWith("kei/")) {
      const at = await this.#coordinates("required");
      if (at.repo === undefined) throw new KeiyakuUsageError("this command requires a resolved Repo");
      const library = Keis.of(at.repo);
      return await library
        .kei({ id: this.#fullId(library, selector) })
        .history(full === undefined ? undefined : { full });
    }
    const { at, akumas } = await this.#akumas();
    return await akumas.history({ akuma: selector, ...input, ...(at.repo === undefined ? {} : { repo: at.repo }) });
  }

  async #report(input: Readonly<{ text: string; signal?: AbortSignal }>) {
    await this.#coordinates("none");
    const environment = this.#input.environment;
    if (environment.KEIYAKU_ACTOR_ID === undefined || environment.KEIYAKU_ACTOR_WORLD === undefined)
      throw new KeiyakuUsageError("report requires explicit KEIYAKU_ACTOR_ID and KEIYAKU_ACTOR_WORLD");
    let caller;
    try {
      caller = await akumaCallerFromEnvironment(environment);
    } catch (error) {
      if (error instanceof TypeError || error instanceof WorldError) throw new KeiyakuUsageError(error.message);
      throw error;
    }
    if (caller?.kind !== "akuma") throw new KeiyakuUsageError("report requires explicit Akuma identity");
    return Akuma.select(caller.world, caller.akumaId).report(
      input.text,
      input.signal === undefined ? {} : { signal: input.signal },
    );
  }

  async #resolveLsCaller(mine: boolean | undefined): Promise<AkumaCaller | undefined> {
    if (mine !== true) return undefined;
    let caller: AkumaCaller | undefined;
    try {
      caller = await akumaCallerFromEnvironment(this.#input.environment);
    } catch (error) {
      throw new KeiyakuUsageError(error instanceof Error ? error.message : String(error));
    }
    if (caller === undefined) {
      throw new KeiyakuUsageError(
        "--mine requires a caller identity; set KEIYAKU_ACTOR_ID and KEIYAKU_ACTOR_WORLD or run inside a calling host",
      );
    }
    return caller;
  }

  async #ls(input: VerbInput<"ls">) {
    const bound = input.limit === undefined ? {} : { limit: input.limit };
    if (input.selector === "kei" || input.selector === "kei/") {
      const at = await this.#coordinates("required");
      return Keis.of(at.repo!).list(bound);
    }
    if (input.selector === "debt" || input.selector === "debt/")
      return debt.debtLs(this.#input, {
        ...bound,
        ...("selection" in input && input.selection !== undefined ? { selection: input.selection } : {}),
      });
    if (input.selector === "aku" || input.selector === "aku/") {
      const at = await this.#coordinates("none");
      return Akumas.archetypes({
        ...bound,
        ...(at.world === null ? {} : { cwd: at.world }),
        ...(this.#input.home === undefined ? {} : { home: this.#input.home }),
      });
    }
    const name = input.selector.split("/")[1]!;
    const akumaName = name === "*" ? undefined : validateAkumaName(name);
    const { at, akumas } = await this.#akumas();
    const caller = await this.#resolveLsCaller("mine" in input ? input.mine : undefined);
    return akumas.list({
      ...bound,
      ...(akumaName === undefined ? {} : { akumaName }),
      ...(caller === undefined ? {} : { caller }),
      ...(at.repo === undefined ? {} : { repo: at.repo }),
    });
  }

  async #region(input: Readonly<{ contract?: string; paths?: readonly string[] }> = {}) {
    const at = await this.#coordinates("required");
    if (at.repo === undefined) throw new KeiyakuUsageError("this command requires a resolved Repo");
    const repo = at.repo;
    let selected: KanshiRegionSelection;
    if (input.paths !== undefined) {
      const [first, ...rest] = input.paths;
      if (first === undefined) throw new TypeError("Region query requires one or more path patterns");
      selected = { kind: "path", patterns: [first, ...rest] };
    } else {
      selected =
        input.contract === undefined
          ? { kind: "declarations" }
          : { kind: "contract", contract: await this.#resolve(Keis.of(repo), input.contract, at.cwd) };
    }
    const result = await Kanshi.of({ world: at.world, repo }).region(selected);
    if (result.kind === "absent") throw new Error("Region observation with a Repo cannot be absent");
    return result;
  }

  async #whoami() {
    return await whoami(await this.#coordinates("optional"), this.#input.environment);
  }

  async #settings() {
    const at = await this.#coordinates("none");
    return await Settings.load({
      ...(at.world === null ? {} : { cwd: at.world }),
      ...(this.#input.home === undefined ? {} : { home: this.#input.home }),
    });
  }

  async #nuke(input: Readonly<{ confirm?: string }> = {}) {
    const at = await this.#coordinates("none");
    if (at.world === null) throw new KeiyakuUsageError("no Keiyaku world contains the invocation cwd");
    return await nukeKeiyaku({ world: at.world, ...input });
  }
}
