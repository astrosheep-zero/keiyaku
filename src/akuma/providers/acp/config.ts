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
