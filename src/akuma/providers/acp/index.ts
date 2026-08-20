import type { ProviderAdapter, ProviderOptionAdmission } from "../../provider.js";
import type { ProviderExecution, ProviderOptions } from "../../provider-recipe.js";
import { decodeAcpConfig, type AcpExecutionConfig } from "./config.js";
import { startAcpSession, type AcpDependencies, type AcpStartInput } from "./core.js";

export { decodeAcpConfig, type AcpExecutionConfig } from "./config.js";

function optionAdmission(options: ProviderOptions, config: AcpExecutionConfig): ProviderOptionAdmission {
  if (options.network !== undefined) {
    return { kind: "refused", diagnostic: "ACP provider does not support the network option" };
  }
  if (options.model !== undefined && config.modelArg === undefined) {
    return { kind: "refused", diagnostic: "ACP provider has no model argument mapping" };
  }
  if (options.effort !== undefined && config.effortArg === undefined) {
    return { kind: "refused", diagnostic: "ACP provider has no effort argument mapping" };
  }
  if (options.systemPrompt !== undefined && options.systemPrompt.length > 0 && config.systemPromptArg === undefined) {
    return { kind: "refused", diagnostic: "ACP provider has no systemPrompt argument mapping" };
  }
  return {
    kind: "admitted",
    options,
    ...(options.readonly === undefined ? {} : {
      readonly: {
        enforcement: "none" as const,
        diagnostic: "ACP cannot remove task-surface mutation capabilities",
      },
    }),
  };
}

function argv(
  execution: ProviderExecution,
  config: AcpExecutionConfig,
  options: ProviderOptions,
): readonly [string, ...string[]] {
  if (execution.executable === undefined) throw new Error("ACP provider execution requires executable");
  const values = [execution.executable, ...config.argvBefore];
  if (options.model !== undefined) values.push(config.modelArg!, options.model);
  if (options.effort !== undefined) values.push(config.effortArg!, options.effort);
  if (options.systemPrompt !== undefined && config.systemPromptArg !== undefined) {
    values.push(config.systemPromptArg, options.systemPrompt);
  }
  values.push(...config.argvAfter);
  return values as [string, ...string[]];
}

export function createAcpProvider(
  execution: ProviderExecution,
  dependencies: AcpDependencies = {},
): ProviderAdapter {
  if (execution.executable === undefined) throw new TypeError("ACP provider execution requires executable");
  const config = decodeAcpConfig(execution.config);
  const drive = async (input: AcpStartInput) => {
    const launch = {
      argv: argv(execution, config, input.options),
      ...(execution.env === undefined ? {} : { env: execution.env }),
    };
    return (await startAcpSession(launch, input, dependencies)).session;
  };
  return {
    admitOptions: (options) => optionAdmission(options, config),
    start: async (input) => await drive(input),
    resume: async (input) => await drive(input),
  };
}
