import type { ProviderAdapter, ProviderOptionAdmission, Session } from "../../provider.js";
import type { ProviderExecution, ProviderOptions } from "../../provider-recipe.js";
import { startAcpSession, type AcpDependencies, type AcpLiveSession, type AcpStartInput } from "../acp/core.js";

const INTERJECT_METHOD = "x.ai/interject";

type InterjectParams = Readonly<{
  sessionId: string;
  text: string;
  interjectionId: string;
}>;

type InterjectResponse = Readonly<{ status: "queued" }>;

function optionAdmission(options: ProviderOptions): ProviderOptionAdmission {
  if (options.network !== undefined) {
    return { kind: "refused", diagnostic: "Grok Build does not support the network option" };
  }
  if (options.systemPrompt !== undefined && options.systemPrompt.length > 0) {
    return { kind: "refused", diagnostic: "Grok Build does not support the systemPrompt option" };
  }
  return {
    kind: "admitted",
    options,
    ...(options.readonly === undefined ? {} : {
      readonly: {
        enforcement: "none" as const,
        diagnostic: "Grok Build cannot remove task-surface mutation capabilities",
      },
    }),
  };
}

function argv(execution: ProviderExecution, options: ProviderOptions): readonly [string, ...string[]] {
  if (execution.executable === undefined) throw new Error("Grok Build provider execution requires executable");
  const values = [execution.executable, "agent", "--always-approve"];
  if (options.model !== undefined) values.push("--model", options.model);
  if (options.effort !== undefined) values.push("--reasoning-effort", options.effort);
  values.push("stdio");
  return values as [string, ...string[]];
}

function withInterject(live: AcpLiveSession): Session {
  return {
    ...live.session,
    tell: async (tell) => {
      if (!live.open()) return { kind: "turn-ended" };
      const response = await live.agent.request<InterjectResponse, InterjectParams>(INTERJECT_METHOD, {
        sessionId: live.sessionId,
        text: tell.text,
        interjectionId: tell.id,
      });
      if (!live.open()) return { kind: "turn-ended" };
      if (response === null || typeof response !== "object" || response.status !== "queued") {
        throw new Error("Grok Build interject did not return queued");
      }
      return { kind: "accepted", fence: tell.id };
    },
  };
}

export function createGrokBuildProvider(
  execution: ProviderExecution,
  dependencies: AcpDependencies = {},
): ProviderAdapter {
  if (execution.executable === undefined) throw new TypeError("Grok Build provider execution requires executable");
  if (execution.config !== undefined) throw new TypeError("Grok Build provider does not support execution config");
  const drive = async (input: AcpStartInput) => {
    const launch = {
      argv: argv(execution, input.options),
      ...(execution.env === undefined ? {} : { env: execution.env }),
    };
    return withInterject(await startAcpSession(launch, input, dependencies));
  };
  return {
    confinement: () => ({ kind: "unconfined" }),
    admitOptions: optionAdmission,
    start: async (input) => await drive(input),
    resume: async (input) => await drive(input),
  };
}
