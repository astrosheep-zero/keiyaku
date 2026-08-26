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
import { requestPayloadJson } from "./request-rows.js";

// This stays out of the public Heart index: only transport service projects it as a refusal.
class RequestInputConflictError extends Error {
  constructor(id: string) {
    super(`Akuma request ${id} reused different input`);
    this.name = "RequestInputConflictError";
  }
}

export function isRequestInputConflict(error: unknown): error is Error {
  return error instanceof RequestInputConflictError;
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
      const normalized: RequestInput =
        input.action === "akuma.call"
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
      if (
        fact.requester !== soul.id ||
        fact.id !== normalized.id ||
        fact.action !== normalized.action ||
        requestPayloadJson(fact) !== requestPayloadJson(normalized)
      ) {
        throw new RequestInputConflictError(input.id);
      }
      return fact;
    }),
  );
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
    }),
  );
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
    }),
  );
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
      else if (before.state !== "served") {
        throw new Error(`Akuma request ${id} cannot be served as ${service.action}`);
      }
      return requestFact(heart, id)!;
    }),
  );
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
    }),
  );
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
    }),
  );
}

export async function readRequest(paths: AkumaPaths, id: string): Promise<RequestFact | null> {
  return await withHeart(paths, (heart) => requestFact(heart, id));
}

export async function readNonterminalRequests(paths: AkumaPaths): Promise<readonly RequestFact[]> {
  return await withHeart(paths, nonterminalRequestFacts);
}
