import type { ProviderAdapter, ProviderOptionAdmission } from "../../provider.js";
import type { ProviderExecution, ProviderOptions } from "../../provider-recipe.js";
import { startAcpSession, type AcpDependencies, type AcpStartInput } from "./core.js";

export type AcpExecutionConfig = Readonly<{
  argvBefore: readonly string[];
  argvAfter: readonly string[];
  modelArg?: string;
  effortArg?: string;
  systemPromptArg?: string;
}>;

function argumentName(
  value: Readonly<Record<string, unknown>>,
  key: "modelArg" | "effortArg" | "systemPromptArg",
): string | undefined {
  const selected = value[key];
  if (selected === undefined) return undefined;
  if (typeof selected !== "string" || selected.trim().length === 0) {
    throw new TypeError(`ACP provider config ${key} must be a nonblank string`);
  }
  return selected;
}

export function decodeAcpConfig(value: unknown): AcpExecutionConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("ACP provider config must be an object");
  }
  const config = value as Readonly<Record<string, unknown>>;
  const unknown = Object.keys(config)
    .find((key) => !["argvBefore", "argvAfter", "effortArg", "modelArg", "systemPromptArg"].includes(key));
  if (unknown !== undefined) throw new TypeError(`ACP provider config has unknown field ${unknown}`);
  if (!Array.isArray(config.argvBefore)
    || config.argvBefore.some((arg) => typeof arg !== "string" || arg.trim().length === 0)) {
    throw new TypeError("ACP provider config argvBefore must be an array of nonblank strings");
  }
  if (!Array.isArray(config.argvAfter)
    || config.argvAfter.some((arg) => typeof arg !== "string" || arg.trim().length === 0)) {
    throw new TypeError("ACP provider config argvAfter must be an array of nonblank strings");
  }
  const modelArg = argumentName(config, "modelArg");
  const effortArg = argumentName(config, "effortArg");
  const systemPromptArg = argumentName(config, "systemPromptArg");
  return Object.freeze({
    argvBefore: Object.freeze([...config.argvBefore] as string[]),
    argvAfter: Object.freeze([...config.argvAfter] as string[]),
    ...(modelArg === undefined ? {} : { modelArg }),
    ...(effortArg === undefined ? {} : { effortArg }),
    ...(systemPromptArg === undefined ? {} : { systemPromptArg }),
  });
}

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
    confinement: () => ({ kind: "unconfined" }),
    admitOptions: (options) => optionAdmission(options, config),
    start: async (input) => await drive(input),
    resume: async (input) => await drive(input),
  };
}
