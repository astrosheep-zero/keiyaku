import { parseAkuId, type AkuId, type AkumaPaths } from "../identity.js";
import type { RequestFact, RequestInput } from "./facts.js";
import {
  insertRequestFact,
  nonterminalRequestFacts,
  requestFact,
  updateRequestRefused,
  updateRequestBegun,
  updateRequestReserved,
  updateRequestServed,
  updateRequestUnproven,
  updateRequestVoided,
  updateUpstreamRequestServed,
} from "./request-rows.js";
import { transaction, withHeart } from "./storage.js";
import { soulFact } from "./soul.js";
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
  input: RequestInput & Readonly<{ admittedAt: string; permitted: boolean }>,
): Promise<RequestFact> {
  return await withHeart(paths, (heart) =>
    transaction(heart, () => {
      const soul = soulFact(heart);
      if (soul === null) throw new Error("Akuma request admission requires a born Soul");
      const { permitted, ...request } = input;
      insertRequestFact(heart, {
        ...request,
        requester: soul.id,
        ...(permitted ? {} : { refusal: `not-allowed: ${input.action}` }),
      });
      const fact = requestFact(heart, input.id);
      if (fact === null) throw new Error(`Akuma request ${input.id} was not admitted`);
      if (
        fact.requester !== soul.id ||
        fact.id !== input.id ||
        fact.action !== input.action ||
        requestPayloadJson(fact) !== requestPayloadJson(input)
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
      if (before.state === "admitted") updateRequestReserved(heart, id, child);
      else if (
        (before.state !== "reserved" && before.state !== "served") ||
        !("child" in before) ||
        before.child !== child
      ) {
        throw new Error(`Akuma request ${id} cannot reserve ${child}`);
      }
      return requestFact(heart, id)!;
    }),
  );
}

export async function serveRequest(paths: AkumaPaths, id: string, child: string): Promise<RequestFact> {
  const parsed = parseAkuId(child);
  if (parsed.id !== child) throw new Error(`Akuma request ${id} has a noncanonical child`);
  return await withHeart(paths, (heart) =>
    transaction(heart, () => {
      const before = requestFact(heart, id);
      if (before === null) throw new Error(`unknown Akuma request ${id}`);
      if (before.state === "reserved" && before.child === parsed.id) updateRequestServed(heart, id, parsed.id);
      else if (before.state !== "served" || !("child" in before) || before.child !== parsed.id) {
        throw new Error(`Akuma request ${id} cannot serve ${child}`);
      }
      return requestFact(heart, id)!;
    }),
  );
}

export async function serveUpstreamRequest(paths: AkumaPaths, id: string, serviceJson: string): Promise<RequestFact> {
  return await withHeart(paths, (heart) =>
    transaction(heart, () => {
      const before = requestFact(heart, id);
      if (before === null) throw new Error(`unknown Akuma request ${id}`);
      if (before.state === "begun") updateUpstreamRequestServed(heart, id, serviceJson);
      else if (before.state !== "served" || !("serviceJson" in before) || before.serviceJson !== serviceJson) {
        throw new Error(`Akuma request ${id} cannot be served with this service reference`);
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
      if (before.state === "admitted" || before.state === "reserved" || before.state === "begun") {
        updateRequestVoided(heart, id, evidence);
      } else if (before.state !== "voided" || before.evidence !== evidence) {
        throw new Error(`Akuma request ${id} cannot be voided`);
      }
      return requestFact(heart, id)!;
    }),
  );
}

export async function beginRequest(paths: AkumaPaths, id: string): Promise<RequestFact> {
  return await withHeart(paths, (heart) =>
    transaction(heart, () => {
      const before = requestFact(heart, id);
      if (before === null) throw new Error(`unknown Akuma request ${id}`);
      if (before.state === "admitted") updateRequestBegun(heart, id);
      else if (before.state !== "begun") throw new Error(`Akuma request ${id} cannot begin`);
      return requestFact(heart, id)!;
    }),
  );
}

export async function unproveRequest(paths: AkumaPaths, id: string, evidence: string): Promise<RequestFact> {
  return await withHeart(paths, (heart) =>
    transaction(heart, () => {
      const before = requestFact(heart, id);
      if (before === null) throw new Error(`unknown Akuma request ${id}`);
      if (before.state === "begun") updateRequestUnproven(heart, id, evidence);
      else if (before.state !== "unproven" || before.evidence !== evidence) {
        throw new Error(`Akuma request ${id} cannot be marked unproven`);
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
