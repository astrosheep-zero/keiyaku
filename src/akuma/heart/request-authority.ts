import type { AkuId, AkumaPaths } from "../identity.js";
import type { RequestFact, RequestInput, UpstreamRequestService } from "./facts.js";
import {
  insertRequestFact,
  nonterminalRequestFacts,
  requestFact,
  updateRequestRefused,
  updateRequestReserved,
  updateRequestServed,
  updateRequestVoided,
  updateUpstreamRequestServed,
} from "./request-rows.js";
import { transaction, withHeart } from "./storage.js";
import { soulFact } from "./soul.js";
import { clipAllowedActions } from "../allowed.js";
import { isTaskMutationAction } from "../../task/mutation.js";

function sameDeliverRequestInput(
  fact: Extract<RequestFact, { action: "contract.deliver" }>,
  input: Extract<RequestInput, { action: "contract.deliver" }>,
): boolean {
  return fact.repoRoot === input.repoRoot
    && fact.contractId === input.contractId
    && fact.message === input.message
    && fact.includeDirty === input.includeDirty;
}

function sameReviewRequestInput(
  fact: Extract<RequestFact, { action: "contract.review" }>,
  input: Extract<RequestInput, { action: "contract.review" }>,
): boolean {
  return fact.repoRoot === input.repoRoot
    && fact.contractId === input.contractId
    && fact.verdict === input.verdict
    && fact.summary === input.summary;
}

function sameContractRequestInput(
  fact: Extract<RequestFact, { action: "contract.deliver" | "contract.review" }>,
  input: Extract<RequestInput, { action: "contract.deliver" | "contract.review" }>,
): boolean {
  if (fact.action === "contract.deliver" && input.action === "contract.deliver") {
    return sameDeliverRequestInput(fact, input);
  }
  return fact.action === "contract.review" && input.action === "contract.review"
    && sameReviewRequestInput(fact, input);
}

function taskRequestPayload(input: Extract<RequestInput, { action: `task.${string}` }>): string {
  return JSON.stringify(input.request);
}

function sameTaskRequestInput(
  fact: Extract<RequestFact, { action: `task.${string}` }>,
  input: Extract<RequestInput, { action: `task.${string}` }>,
): boolean {
  return fact.action === input.action
    && fact.world === input.world
    && taskRequestPayload(fact) === taskRequestPayload(input);
}

function sameRequestInput(fact: RequestFact, input: RequestInput): boolean {
  if (fact.id !== input.id || fact.action !== input.action) return false;
  if (fact.action === "akuma.call") {
    const call = input as Extract<RequestInput, { action: "akuma.call" }>;
    return fact.archetype === call.archetype
      && fact.body === call.body
      && fact.cwd === call.cwd
      && fact.world === call.world
      && JSON.stringify(fact.recipe) === JSON.stringify(call.recipe);
  }
  if (fact.action === "akuma.wait") {
    const wait = input as Extract<RequestInput, { action: "akuma.wait" }>;
    return fact.completion === wait.completion
      && fact.timeoutMs === wait.timeoutMs
      && JSON.stringify(fact.targets) === JSON.stringify(wait.targets);
  }
  if (fact.action === "akuma.tell") {
    const tell = input as Extract<RequestInput, { action: "akuma.tell" }>;
    return fact.target === tell.target && fact.body === tell.body;
  }
  if (fact.action === "contract.deliver" || fact.action === "contract.review") {
    return sameContractRequestInput(
      fact,
      input as Extract<RequestInput, { action: "contract.deliver" | "contract.review" }>,
    );
  }
  if (isTaskMutationAction(fact.action) && isTaskMutationAction(input.action)) {
    const taskInput = input as Extract<RequestInput, { action: `task.${string}` }>;
    if (taskInput.action !== taskInput.request.action) return false;
    return sameTaskRequestInput(
      fact as Extract<RequestFact, { action: `task.${string}` }>,
      taskInput,
    );
  }
  return fact.action === "akuma.kill" && input.action === "akuma.kill"
    && JSON.stringify(fact.targets) === JSON.stringify(input.targets);
}

export async function admitRequest(
  paths: AkumaPaths,
  input: RequestInput & Readonly<{ admittedAt: string }>,
): Promise<RequestFact> {
  return await withHeart(paths, (heart) =>
    transaction(heart, () => {
      const soul = soulFact(heart);
      if (soul === null) throw new Error("Akuma request admission requires a born Soul");
      const action = input.action;
      const parentAllowed = soul.allowed;
      const permitted = action === "akuma.wait" || parentAllowed.includes(action);
      const normalized: RequestInput = input.action === "akuma.call"
        ? {
            ...input,
            recipe: {
              ...input.recipe,
              allowed: permitted ? clipAllowedActions(input.recipe.allowed, parentAllowed) : input.recipe.allowed,
            },
          }
        : input;
      insertRequestFact(heart, {
        ...normalized,
        requester: soul.id,
        admittedAt: input.admittedAt,
        ...(permitted ? {} : { refusal: `not-allowed: ${action}` }),
      });
      const fact = requestFact(heart, input.id);
      if (fact === null) throw new Error(`Akuma request ${input.id} was not admitted`);
      if (fact.requester !== soul.id || !sameRequestInput(fact, normalized)) {
        throw new Error(`Akuma request ${input.id} reused different input`);
      }
      return fact;
    }));
}

export async function reserveRequest(paths: AkumaPaths, id: string, child: AkuId): Promise<RequestFact> {
  return await withHeart(paths, (heart) =>
    transaction(heart, () => {
      const before = requestFact(heart, id);
      if (before === null) throw new Error(`unknown Akuma request ${id}`);
      if (before.action !== "akuma.call") throw new Error(`Akuma request ${id} cannot reserve a child`);
      if (before.state === "admitted") updateRequestReserved(heart, id, child);
      else if ((before.state !== "reserved" && before.state !== "served") || before.child !== child) {
        throw new Error(`Akuma request ${id} cannot reserve ${child}`);
      }
      return requestFact(heart, id)!;
    }));
}

export async function serveRequest(paths: AkumaPaths, id: string, child: AkuId): Promise<RequestFact> {
  return await withHeart(paths, (heart) =>
    transaction(heart, () => {
      const before = requestFact(heart, id);
      if (before === null) throw new Error(`unknown Akuma request ${id}`);
      if (before.action !== "akuma.call") throw new Error(`Akuma request ${id} cannot serve a child`);
      if (before.state === "reserved" && before.child === child) updateRequestServed(heart, id, child);
      else if (before.state !== "served" || before.child !== child) {
        throw new Error(`Akuma request ${id} cannot serve ${child}`);
      }
      return requestFact(heart, id)!;
    }));
}

export async function serveUpstreamRequest(
  paths: AkumaPaths,
  id: string,
  service: UpstreamRequestService,
): Promise<RequestFact> {
  return await withHeart(paths, (heart) =>
    transaction(heart, () => {
      const before = requestFact(heart, id);
      if (before === null) throw new Error(`unknown Akuma request ${id}`);
      if (before.action === "akuma.call" || service.action !== before.action) {
        throw new Error(`Akuma request ${id} has a mismatched service reference`);
      }
      if (before.state === "admitted") updateUpstreamRequestServed(heart, id, service);
      else if (before.state !== "served" || JSON.stringify(before.service) !== JSON.stringify(service)) {
        throw new Error(`Akuma request ${id} cannot be served as ${service.action}`);
      }
      return requestFact(heart, id)!;
    }));
}

export async function refuseRequest(paths: AkumaPaths, id: string, diagnostic: string): Promise<RequestFact> {
  return await withHeart(paths, (heart) =>
    transaction(heart, () => {
      const before = requestFact(heart, id);
      if (before === null) throw new Error(`unknown Akuma request ${id}`);
      if (before.state === "admitted") updateRequestRefused(heart, id, diagnostic);
      else if (before.state !== "refused" || before.diagnostic !== diagnostic) {
        throw new Error(`Akuma request ${id} cannot be refused`);
      }
      return requestFact(heart, id)!;
    }));
}

export async function voidRequest(paths: AkumaPaths, id: string, evidence: string): Promise<RequestFact> {
  return await withHeart(paths, (heart) =>
    transaction(heart, () => {
      const before = requestFact(heart, id);
      if (before === null) throw new Error(`unknown Akuma request ${id}`);
      if (before.state === "admitted" || before.state === "reserved") {
        updateRequestVoided(heart, id, evidence);
      } else if (before.state !== "voided" || before.evidence !== evidence) {
        throw new Error(`Akuma request ${id} cannot be voided`);
      }
      return requestFact(heart, id)!;
    }));
}

export async function readRequest(paths: AkumaPaths, id: string): Promise<RequestFact | null> {
  return await withHeart(paths, (heart) => requestFact(heart, id));
}

export async function readNonterminalRequests(paths: AkumaPaths): Promise<readonly RequestFact[]> {
  return await withHeart(paths, nonterminalRequestFacts);
}
