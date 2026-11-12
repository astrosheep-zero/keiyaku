import { KeiyakuError, KeiyakuUsageError } from "../../index.js";
import { KeiyakuArcDocumentError } from "../../library/keiyaku.js";
import { classifyVerb } from "../../library/keiyaku-verbs.js";
import { renderVerb } from "../render/verbs.js";
import { validateContractMarkdown } from "../../library/input.js";
import { SettingsError } from "../../settings.js";
import { resolveInvocationCwd } from "../coordinates.js";
import { BindDraftError, preserveBindDraft } from "../draft.js";
import { renderBindDraftReceipt, type RenderableRefusal } from "../render/refusal.js";
import type { CliRuntime } from "../runtime.js";
import type { PendingRequest, VerbRequest } from "../parse.js";
import { type CliOutcome, displayContext, emit } from "../streams.js";
import { CliUsageError, isBlankInput } from "../usage.js";

function draftWarning(error: unknown): Readonly<{ warning: string }> {
  return { warning: `bind draft could not be preserved: ${error instanceof Error ? error.message : String(error)}` };
}

/** Admit bind Markdown before coordinate resolution and retain a malformed draft. */
export async function admitBindMarkdown(
  input: Readonly<{ markdown: string; processCwd?: string; cwd?: string }>,
): Promise<void> {
  if (isBlankInput(input.markdown)) throw new CliUsageError("bind requires a nonblank stdin document");
  try {
    validateContractMarkdown(input.markdown);
  } catch (error) {
    if (error instanceof Error && "executionReceipt" in error) throw error;
    if (!(error instanceof TypeError) && !(error instanceof KeiyakuError && error.category === "invalid-input"))
      throw error;
    throw new BindDraftError(error, await bindDraftReceipt(() => resolveInvocationCwd(input), input.markdown));
  }
}

async function bindDraftReceipt(world: () => Promise<string>, markdown: string) {
  try {
    return await preserveBindDraft(await world(), markdown);
  } catch (error) {
    if (error instanceof Error && "executionReceipt" in error) throw error;
    return draftWarning(error);
  }
}

export async function acquireContractRequest(
  request: Exclude<PendingRequest, { name: "spawn" | "tell" | "ask" | "status" }>,
  runtime: CliRuntime,
): Promise<VerbRequest> {
  const bytes = await runtime.readStdin();
  if (request.name === "review") {
    if (isBlankInput(bytes)) throw new CliUsageError("review requires a nonblank summary");
    return { name: request.name, input: { ...request.input, summary: bytes }, output: request.output };
  }
  if (request.name === "amend" && isBlankInput(bytes))
    throw new CliUsageError("amend requires a nonblank stdin document");
  return { name: request.name, input: { ...request.input, markdown: bytes }, output: request.output };
}

async function invokeAndFinish(request: VerbRequest, runtime: CliRuntime, alias?: string): Promise<CliOutcome> {
  const progressing = request.name === "deliver" || request.name === "verify" || request.name === "review";
  const driver = progressing && request.output === "text" ? await runtime.progress() : undefined;
  const cancellable =
    progressing ||
    request.name === "wait" ||
    request.name === "tell" ||
    request.name === "fork" ||
    request.name === "kill";
  const value = await runtime.facet
    .run(request.name, request.input, {
      ...(cancellable ? { signal: runtime.signal } : {}),
      ...(driver === undefined ? {} : { observe: driver.observe }),
    })
    .finally(async () => {
      if (driver !== undefined) await driver.finish().catch(() => undefined);
    });
  const completion = { kind: "returned" as const, value };
  return emit(
    request.output,
    value,
    () =>
      renderVerb(request.name, request.input, completion, {
        ...displayContext(),
        ...(alias === undefined ? {} : { alias }),
        ...(request.name === "ls" &&
        "mine" in request.input &&
        request.input.mine === true &&
        runtime.environment.KEIYAKU_ACTOR_ID !== undefined
          ? { actor: runtime.environment.KEIYAKU_ACTOR_ID }
          : {}),
      }),
    classifyVerb(request.name, request.input, completion),
  );
}

async function runBind(request: VerbRequest<"bind">, runtime: CliRuntime): Promise<CliOutcome> {
  const { input, output } = request;
  if ("forkOf" in input) return invokeAndFinish(request, runtime);
  const markdown = input.markdown;
  try {
    const answer = await runtime.facet.run("bind", input);
    const completion = { kind: "returned" as const, value: answer };
    const draft = answer.kind === "refused" ? await bindDraftReceipt(runtime.draftWorld, markdown) : undefined;
    return emit(
      output,
      answer,
      () =>
        `${renderVerb("bind", input, completion, displayContext())}${draft === undefined ? "" : `\n${renderBindDraftReceipt(draft)}`}`,
      classifyVerb("bind", input, completion),
    );
  } catch (error) {
    if (error instanceof Error && "executionReceipt" in error) throw error;
    if (error instanceof KeiyakuUsageError) throw error;
    // A selected Settings namespace failure is the owner's invalid input, not a bad draft.
    if (error instanceof KeiyakuError && error.category === "invalid-input" && error.cause instanceof SettingsError)
      throw error;
    if (!(error instanceof TypeError) && !(error instanceof KeiyakuError && error.category === "invalid-input"))
      throw error;
    throw new BindDraftError(error, await bindDraftReceipt(runtime.draftWorld, markdown));
  }
}

export async function runContractRequest(
  request: VerbRequest,
  runtime: CliRuntime,
  alias?: string,
): Promise<CliOutcome> {
  if (request.name === "bind") return runBind(request, runtime);
  if (request.name === "arc") {
    try {
      return await invokeAndFinish(request, runtime);
    } catch (error) {
      if (!(error instanceof KeiyakuArcDocumentError)) throw error;
      const completion = { kind: "threw" as const, error };
      const refusal: RenderableRefusal = { kind: "invalid-document", diagnostic: error.message };
      return emit(
        request.output,
        { kind: "refused", contractId: error.contract, reason: refusal },
        () => renderVerb("arc", request.input, completion, displayContext()),
        classifyVerb("arc", request.input, completion),
      );
    }
  }
  if (request.name === "review" && isBlankInput(request.input.summary))
    throw new CliUsageError("review requires a nonblank summary");
  return invokeAndFinish(request, runtime, alias);
}
