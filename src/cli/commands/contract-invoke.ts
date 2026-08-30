import { resolveActor } from "../actor.js";
import { CliUsageError } from "../usage.js";
import type { InvocationResult } from "../result.js";
import type { ParsedCommand } from "../parse.js";
import type { SelectedContract } from "../selectors.js";
import type { ActorId, ContractId, Keiyaku as KeiyakuContract, KeiyakuLibrary } from "../../index.js";
import type { WorktreeHooks } from "../../library/configuration.js";
import type { Repo } from "../../library/repo.js";
import type { Settings } from "../../settings.js";
import type { WorldRoot } from "../../world.js";
import type { ExecutionContext } from "../../akuma/requests.js";

type ContractMutation = Extract<
  ParsedCommand,
  { command: "bind" | "amend" | "deliver" | "review" | "arc" | "abandon" | "audit" }
>;
type ExistingCommand = Exclude<ContractMutation, { command: "bind" }>;
type InvocationEdge = Readonly<{ environment: NodeJS.ProcessEnv; readStdin: () => Promise<string> }>;

export type ContractMutationInput = Readonly<{
  parsed: ContractMutation;
  repo: Repo;
  edge: InvocationEdge;
  scope: string;
  configuration?: Settings;
  hooks?: WorktreeHooks;
  establishWorld: () => Promise<WorldRoot>;
  execution: ExecutionContext;
}>;

function actorFromEdge(actor: string | undefined, environment: NodeJS.ProcessEnv): ActorId | undefined {
  try {
    return resolveActor({ env: environment, ...(actor === undefined ? {} : { actor }) });
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }
}

function consumeSettings<T>(run: () => T, ErrorType: new (message: string) => Error): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof ErrorType) throw new CliUsageError(error.message);
    throw error;
  }
}

async function selectedGates(value: Settings, names?: readonly string[]) {
  const { gatesFrom, SettingsError } = await import("../../library/configuration.js");
  return consumeSettings(
    () => gatesFrom({ settings: value, ...(names === undefined ? {} : { names }) }),
    SettingsError,
  );
}

async function selectedGitPolicy(value: Settings): Promise<boolean> {
  const { requireBranchesToBeUpToDateFrom, SettingsError } = await import("../../library/configuration.js");
  return consumeSettings(() => requireBranchesToBeUpToDateFrom({ settings: value }), SettingsError);
}

async function selectContract(
  repo: Repo,
  selector: string | undefined,
  scope: string,
  library: KeiyakuLibrary,
): Promise<SelectedContract> {
  const { contractFromInput, resolveContextualContract } = await import("../selectors.js");
  const id =
    selector !== undefined && !selector.startsWith("@")
      ? contractFromInput(repo, selector).id
      : resolveContextualContract(await library.list({ repo }), selector, scope);
  return { id, contract: library.of({ repo, id }) };
}

async function bindDraftReceipt(establishWorld: () => Promise<WorldRoot>, markdown: string) {
  const { preserveBindDraft } = await import("../draft.js");
  try {
    return preserveBindDraft(await establishWorld(), markdown);
  } catch (error) {
    return { warning: `bind draft could not be preserved: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function invokeBind(input: ContractMutationInput): Promise<InvocationResult> {
  const { parsed, repo, edge, configuration, hooks, establishWorld } = input;
  if (parsed.command !== "bind") throw new Error("bind invocation requires bind syntax");
  const actor = actorFromEdge(parsed.actor, edge.environment);
  const { bindFromCommand } = await import("./bind.js");
  const { acceptedBind, resultFromMutationCall } = await import("../accepted.js");
  if (parsed.forkOf !== undefined) {
    return resultFromMutationCall(
      "bind",
      () =>
        bindFromCommand({
          command: parsed,
          repo,
          ...(actor === undefined ? {} : { actor }),
          ...(hooks === undefined ? {} : { hooks }),
        }),
      (accepted) => {
        const bound = accepted.facts.find((fact) => fact.kind === "bind");
        if (bound === undefined || bound.kind !== "bind") throw new Error("accepted bind is missing its bind fact");
        return acceptedBind(accepted, bound.data.coordinates);
      },
    );
  }
  if (configuration === undefined) throw new Error("bind invocation requires Settings");
  const markdown = await edge.readStdin();
  const gates = await selectedGates(configuration, parsed.gates);
  try {
    const result = await resultFromMutationCall(
      "bind",
      () =>
        bindFromCommand({
          command: parsed,
          repo,
          markdown,
          gates,
          ...(actor === undefined ? {} : { actor }),
          ...(hooks === undefined ? {} : { hooks }),
        }),
      (accepted) => {
        const bound = accepted.facts.find((fact) => fact.kind === "bind");
        if (bound === undefined || bound.kind !== "bind") throw new Error("accepted bind is missing its bind fact");
        return acceptedBind(accepted, bound.data.coordinates);
      },
    );
    if (result.kind !== "refused") return result;
    return { ...result, draft: await bindDraftReceipt(establishWorld, markdown) };
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    const { BindDraftError } = await import("../draft.js");
    throw new BindDraftError(error, await bindDraftReceipt(establishWorld, markdown));
  }
}

type ExistingSeat = Readonly<{
  contract: KeiyakuContract;
  id: ContractId;
  actor?: ActorId;
  hooks?: WorktreeHooks;
}>;

function deliverRefusal(refusal: unknown): unknown {
  if (typeof refusal !== "object" || refusal === null || !("kind" in refusal) || refusal.kind !== "dirty-workspace") {
    return refusal;
  }
  const submodules = "submodules" in refusal && Array.isArray(refusal.submodules) ? refusal.submodules : [];
  return { ...refusal, option: { flag: "--include-dirty", available: submodules.length === 0 } };
}

async function existingSeat(
  input: ContractMutationInput,
  parsed: ExistingCommand,
  library: KeiyakuLibrary,
): Promise<ExistingSeat> {
  const { repo, edge, scope, hooks } = input;
  const { id, contract } = await selectContract(repo, parsed.contract, scope, library);
  const actor = "actor" in parsed ? actorFromEdge(parsed.actor, edge.environment) : undefined;
  return { contract, id, ...(actor === undefined ? {} : { actor }), ...(hooks === undefined ? {} : { hooks }) };
}

async function invokeDeliver(
  parsed: Extract<ExistingCommand, { command: "deliver" }>,
  seat: ExistingSeat,
): Promise<InvocationResult> {
  const { acceptedDeliver } = await import("../accepted.js");
  try {
    const delivered = await seat.contract.deliver({
      ...(parsed.message === undefined ? {} : { message: parsed.message }),
      includeDirty: parsed.includeDirty,
      materializeConflict: parsed.materializeConflict,
    });
    if (!("facts" in delivered)) return delivered;
    return acceptedDeliver(delivered, seat.id);
  } catch (error) {
    const { KeiyakuRefused, KeiyakuRetry } = await import("../../library/keiyaku.js");
    if (error instanceof KeiyakuRefused) {
      return { kind: "refused", verb: "deliver", contract: seat.id, refusal: deliverRefusal(error.refusal) };
    }
    if (error instanceof KeiyakuRetry)
      return { kind: "retry", verb: "deliver", contract: seat.id, detail: error.reason };
    throw error;
  }
}

async function invokeReview(
  parsed: Extract<ExistingCommand, { command: "review" }>,
  seat: ExistingSeat,
  readStdin: () => Promise<string>,
): Promise<InvocationResult> {
  const summary = parsed.summaryFromStdin === true ? await readStdin() : parsed.summary;
  const { acceptedReview, resultFromMutationCall } = await import("../accepted.js");
  return resultFromMutationCall(
    "review",
    () =>
      seat.contract.review({
        verdict: parsed.verdict,
        ...(summary === undefined ? {} : { summary }),
      }),
    (result) => acceptedReview(result, seat.id),
    { coordinate: seat.id },
  );
}

async function contractLibrary(input: ContractMutationInput, parsed: ExistingCommand): Promise<KeiyakuLibrary> {
  const { configuration, edge, hooks } = input;
  if (input.execution.channel.kind !== "local" || !["audit", "deliver", "review"].includes(parsed.command)) {
    const { Keiyaku } = await import("../../library/keiyaku.js");
    return Keiyaku.withExecution({ execution: input.execution });
  }
  const requireBranchesToBeUpToDate =
    parsed.command !== "review" && configuration !== undefined ? await selectedGitPolicy(configuration) : false;
  const actor = actorFromEdge(undefined, edge.environment);
  const { Keiyaku } = await import("../../library/keiyaku.js");
  return Keiyaku.withLocal({
    ...(actor === undefined ? {} : { actor }),
    ...(hooks === undefined ? {} : { hooks }),
    requireBranchesToBeUpToDate,
  });
}

export async function invokeContractMutation(input: ContractMutationInput): Promise<InvocationResult> {
  const { parsed, repo, edge, configuration, hooks } = input;
  if (parsed.command === "bind") return invokeBind(input);
  const seat = await existingSeat(input, parsed, await contractLibrary(input, parsed));
  const { id, contract, actor } = seat;
  switch (parsed.command) {
    case "amend": {
      if (configuration === undefined) throw new Error("amend invocation requires Settings");
      const markdown = parsed.stdin === true ? await edge.readStdin() : undefined;
      const gates = parsed.gates === undefined ? undefined : await selectedGates(configuration, parsed.gates);
      const { amendFromCommand } = await import("./amend.js");
      const { acceptedAmend, resultFromMutationCall } = await import("../accepted.js");
      return resultFromMutationCall(
        "amend",
        () =>
          amendFromCommand({
            command: parsed,
            repo,
            contract,
            ...(markdown === undefined ? {} : { markdown }),
            gates,
            ...(actor === undefined ? {} : { actor }),
            ...(hooks === undefined ? {} : { hooks }),
          }),
        (result) => acceptedAmend(result, id),
        { coordinate: id },
      );
    }
    case "deliver":
      return invokeDeliver(parsed, seat);
    case "review":
      return invokeReview(parsed, seat, edge.readStdin);
    case "arc": {
      const markdown = await edge.readStdin();
      const { acceptedArc, resultFromMutationCall } = await import("../accepted.js");
      return resultFromMutationCall(
        "arc",
        () =>
          contract.arc({
            markdown,
            ...(actor === undefined ? {} : { actor }),
            ...(hooks === undefined ? {} : { hooks }),
          }),
        (result) => acceptedArc(result, id),
        { coordinate: id },
      );
    }
    case "abandon": {
      const { acceptedAbandon, resultFromMutationCall } = await import("../accepted.js");
      return resultFromMutationCall(
        "abandon",
        () =>
          contract.abandon({
            ...(actor === undefined ? {} : { actor }),
            ...(parsed.note === undefined ? {} : { note: parsed.note }),
            ...(hooks === undefined ? {} : { hooks }),
          }),
        (result) => acceptedAbandon(result, id),
        { coordinate: id },
      );
    }
    case "audit": {
      const { acceptedAudit, resultFromMutationCall } = await import("../accepted.js");
      return resultFromMutationCall(
        "audit",
        () =>
          contract.audit({
            includeDirty: parsed.includeDirty,
            showDiff: parsed.showDiff,
          }),
        (result) => acceptedAudit(result, id),
        { coordinate: id },
      );
    }
  }
}
