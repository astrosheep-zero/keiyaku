export type SystemPromptMode = "append" | "replace";

export type ProviderOptions = Readonly<{
  model?: string;
  effort?: string;
  readonly?: true;
  network?: "disabled" | "enabled";
  systemPrompt?: string;
  systemPromptMode?: SystemPromptMode;
}>;

export type ReadonlyRestraint = Readonly<
  { enforcement: "native"; diagnostic?: never } | { enforcement: "none"; diagnostic: string }
>;

export type ProviderExecution = Readonly<{
  name: string;
  kind: "acp" | "claude-agent-sdk" | "codex-app-server" | "grok-build" | "opencode-sdk" | "pi";
  executable?: string;
  config?: Readonly<Record<string, unknown>>;
  env?: Readonly<Record<string, string>>;
}>;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function snapshot(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(snapshot));
  const object = record(value);
  if (object === null) return value;
  return Object.freeze(Object.fromEntries(Object.entries(object).map(([key, item]) => [key, snapshot(item)])));
}

function optionText(
  options: Readonly<Record<string, unknown>>,
  field: "model" | "effort" | "systemPrompt",
  blank: "allow" | "refuse",
): string | undefined {
  const selected = options[field];
  if (selected === undefined) return undefined;
  if (typeof selected !== "string" || (blank === "refuse" && selected.trim().length === 0)) {
    throw new TypeError(`provider option ${field} must be ${blank === "allow" ? "a string" : "a nonblank string"}`);
  }
  return selected;
}

export function decodeProviderOptions(value: unknown): ProviderOptions {
  const options = record(value);
  if (options === null) throw new TypeError("provider options must be an object");
  const model = optionText(options, "model", "refuse");
  const effort = optionText(options, "effort", "refuse");
  if (options.readonly !== undefined && options.readonly !== true) {
    throw new TypeError("provider option readonly must be true");
  }
  const network = options.network;
  if (network !== undefined && network !== "disabled" && network !== "enabled") {
    throw new TypeError("provider option network must be disabled, enabled");
  }
  const systemPrompt = optionText(options, "systemPrompt", "allow");
  const systemPromptMode = options.systemPromptMode;
  if (systemPromptMode !== undefined) {
    if (systemPromptMode !== "append" && systemPromptMode !== "replace") {
      throw new TypeError("provider option systemPromptMode must be append, replace");
    }
    if (systemPrompt === undefined) {
      throw new TypeError("provider option systemPromptMode requires systemPrompt");
    }
  }
  return Object.freeze({
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(options.readonly === undefined ? {} : { readonly: true as const }),
    ...(network === undefined ? {} : { network }),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(systemPromptMode === undefined ? {} : { systemPromptMode }),
  });
}

export function decodeReadonlyRestraint(value: unknown): ReadonlyRestraint {
  const restraint = record(value);
  if (restraint === null) throw new TypeError("readonly restraint must be an object");
  if (restraint.enforcement === "native") {
    return Object.freeze({ enforcement: "native" });
  }
  if (
    restraint.enforcement === "none" &&
    typeof restraint.diagnostic === "string" &&
    restraint.diagnostic.trim().length > 0
  ) {
    return Object.freeze({ enforcement: "none", diagnostic: restraint.diagnostic });
  }
  throw new TypeError("readonly restraint must be native or none with a diagnostic");
}

function providerKind(value: unknown): value is ProviderExecution["kind"] {
  return (
    value === "acp" ||
    value === "claude-agent-sdk" ||
    value === "codex-app-server" ||
    value === "grok-build" ||
    value === "opencode-sdk" ||
    value === "pi"
  );
}

export function decodeProviderRecipe(input: unknown): ProviderExecution {
  const value = record(input);
  if (value === null) throw new TypeError("provider execution must be an object");
  if (typeof value.name !== "string" || value.name.trim().length === 0) {
    throw new TypeError("provider execution name must be a nonblank string");
  }
  if (!providerKind(value.kind)) throw new TypeError("provider execution has unknown kind");
  if (
    value.executable !== undefined &&
    (typeof value.executable !== "string" || value.executable.trim().length === 0)
  ) {
    throw new TypeError("provider execution executable must be a nonblank string");
  }
  const config = value.config === undefined ? undefined : record(value.config);
  if (config === null) throw new TypeError("provider execution config must be an object");
  const env = value.env === undefined ? undefined : record(value.env);
  if (env === null) throw new TypeError("provider execution env must be an object");
  if (env !== undefined && Object.values(env).some((item) => typeof item !== "string")) {
    throw new TypeError("provider execution env must contain only string values");
  }
  return Object.freeze({
    name: value.name,
    kind: value.kind,
    ...(value.executable === undefined ? {} : { executable: value.executable }),
    ...(config === undefined ? {} : { config: snapshot(config) as Readonly<Record<string, unknown>> }),
    ...(env === undefined ? {} : { env: Object.freeze({ ...env }) as Readonly<Record<string, string>> }),
  });
}
