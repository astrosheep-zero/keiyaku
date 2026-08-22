import type { AkuId } from "./identity.js";
import type { UpstreamRequestService } from "./heart/index.js";
import type { TaskRequestClaim } from "./request-wire.js";
import type { ServeInput, UpstreamFact } from "./request-serve.js";

export async function executeRequest(
  input: ServeInput,
  request: UpstreamFact,
): Promise<Readonly<{ result: unknown; service?: UpstreamRequestService }>> {
  if (input.upstream === undefined) throw new Error("upstream execution port is unavailable");
  if (request.action === "akuma.wait")
    return {
      result: await input.upstream.wait({
        targets: request.targets,
        completion: request.completion,
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        signal: input.signal,
      }),
      service: { action: request.action },
    };
  if (request.action === "akuma.tell")
    return {
      result: await input.upstream.tell({
        target: request.target,
        body: request.body,
        tellId: request.id,
        recordedAt: request.admittedAt,
        signal: input.signal,
      }),
      service: { action: request.action, target: request.target, tellId: request.id },
    };
  if (request.action === "akuma.kill") {
    const served = await input.upstream.kill({ targets: request.targets, signal: input.signal });
    return { result: served.result, service: { action: request.action, results: served.service } };
  }
  if (request.action === "contract.deliver") {
    const served = await input.upstream.deliver({
      repoRoot: request.repoRoot,
      contractId: request.contractId,
      ...(request.message === undefined ? {} : { message: request.message }),
      includeDirty: request.includeDirty,
      materializeConflict: request.materializeConflict,
      requester: request.requester,
      signal: input.signal,
    });
    return {
      result: served.result,
      ...(served.deliveryFactId === undefined
        ? {}
        : {
            service: {
              action: request.action,
              repoRoot: request.repoRoot,
              contractId: request.contractId,
              deliveryFactId: served.deliveryFactId,
            },
          }),
    };
  }
  if (request.action === "contract.review") {
    const served = await input.upstream.review({
      repoRoot: request.repoRoot,
      contractId: request.contractId,
      verdict: request.verdict,
      ...(request.summary === undefined ? {} : { summary: request.summary }),
      requester: request.requester,
      signal: input.signal,
    });
    return {
      result: served.result,
      ...(served.reviewFactId === undefined
        ? {}
        : {
            service: {
              action: request.action,
              repoRoot: request.repoRoot,
              contractId: request.contractId,
              reviewFactId: served.reviewFactId,
            },
          }),
    };
  }
  const task = request as TaskRequestClaim & Readonly<{ requester: AkuId }>;
  return {
    result: await input.upstream.task({
      world: task.world,
      request: task.request,
      requester: task.requester,
      signal: input.signal,
    }),
    service: { action: task.action },
  };
}
