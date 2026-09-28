import type { SystemPromptMode } from "../../provider-recipe.js";

export type AcpExecutionConfig = Readonly<{
  argvBefore: readonly string[];
  argvAfter: readonly string[];
  modelArg?: string;
  effortArg?: string;
  modelConfigId?: string;
  effortConfigId?: string;
  systemPromptArg?: string;
  systemPromptMode?: SystemPromptMode;
}>;

function argumentName(
  value: Readonly<Record<string, unknown>>,
  key: "modelArg" | "effortArg" | "modelConfigId" | "effortConfigId" | "systemPromptArg",
): string | undefined {
  const selected = value[key];
  if (selected === undefined) return undefined;
  if (typeof selected !== "string" || selected.trim().length === 0) {
    throw new TypeError(`ACP provider config ${key} must be a nonblank string`);
  }
  return selected;
}

function validateSelectorMappings(
  config: Readonly<{
    modelArg: string | undefined;
    effortArg: string | undefined;
    modelConfigId: string | undefined;
    effortConfigId: string | undefined;
  }>,
): void {
  if (config.modelArg !== undefined && config.modelConfigId !== undefined) {
    throw new TypeError("ACP provider config cannot map model to both an argument and a session option");
  }
  if (config.effortArg !== undefined && config.effortConfigId !== undefined) {
    throw new TypeError("ACP provider config cannot map effort to both an argument and a session option");
  }
  if (config.modelConfigId !== undefined && config.modelConfigId === config.effortConfigId) {
    throw new TypeError("ACP provider config model and effort must use different session options");
  }
}

export function decodeAcpConfig(value: unknown): AcpExecutionConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("ACP provider config must be an object");
  }
  const config = value as Readonly<Record<string, unknown>>;
  const unknown = Object.keys(config).find(
    (key) =>
      ![
        "argvBefore",
        "argvAfter",
        "effortArg",
        "modelArg",
        "modelConfigId",
        "effortConfigId",
        "systemPromptArg",
        "systemPromptMode",
      ].includes(key),
  );
  if (unknown !== undefined) throw new TypeError(`ACP provider config has unknown field ${unknown}`);
  if (
    !Array.isArray(config.argvBefore) ||
    config.argvBefore.some((arg) => typeof arg !== "string" || arg.trim().length === 0)
  ) {
    throw new TypeError("ACP provider config argvBefore must be an array of nonblank strings");
  }
  if (
    !Array.isArray(config.argvAfter) ||
    config.argvAfter.some((arg) => typeof arg !== "string" || arg.trim().length === 0)
  ) {
    throw new TypeError("ACP provider config argvAfter must be an array of nonblank strings");
  }
  const modelArg = argumentName(config, "modelArg");
  const effortArg = argumentName(config, "effortArg");
  const modelConfigId = argumentName(config, "modelConfigId");
  const effortConfigId = argumentName(config, "effortConfigId");
  validateSelectorMappings({ modelArg, effortArg, modelConfigId, effortConfigId });
  const systemPromptArg = argumentName(config, "systemPromptArg");
  const systemPromptMode = config.systemPromptMode;
  if (systemPromptMode !== undefined && systemPromptMode !== "append" && systemPromptMode !== "replace") {
    throw new TypeError("ACP provider config systemPromptMode must be append, replace");
  }
  if (systemPromptMode !== undefined && systemPromptArg === undefined) {
    throw new TypeError("ACP provider config systemPromptMode requires systemPromptArg");
  }
  return Object.freeze({
    argvBefore: Object.freeze([...config.argvBefore] as string[]),
    argvAfter: Object.freeze([...config.argvAfter] as string[]),
    ...(modelArg === undefined ? {} : { modelArg }),
    ...(effortArg === undefined ? {} : { effortArg }),
    ...(modelConfigId === undefined ? {} : { modelConfigId }),
    ...(effortConfigId === undefined ? {} : { effortConfigId }),
    ...(systemPromptArg === undefined ? {} : { systemPromptArg }),
    ...(systemPromptMode === undefined ? {} : { systemPromptMode }),
  });
}
