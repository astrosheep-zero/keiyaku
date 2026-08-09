import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseDocument } from "yaml";
import type { Settings } from "../settings.js";
import { personaName } from "./identity.js";
import { decodeProviderOptions, type ProviderAdapter, type ProviderOptions } from "./provider.js";
import type { ProviderExecution } from "./heart/index.js";
import { decodeProviderExecution, providerNamed } from "./providers/index.js";

type DecodedPersona = Readonly<{
  name: string;
  path: string;
  provider: string;
  description?: string;
  options: ProviderOptions;
}>;

type PersonaDefinition = DecodedPersona & Readonly<{ adapter: ProviderAdapter }>;
type AdmittedPersona = Omit<PersonaDefinition, "provider"> & Readonly<{ provider: ProviderExecution }>;

const PERSONA_KEYS = new Set(["provider", "model", "access", "network", "effort", "description"]);

export class AkumaPersonaError extends Error {
  readonly kind = "akuma-persona";
  constructor(
    readonly persona: string,
    readonly searched: readonly string[],
    readonly reason: string,
  ) {
    super(`Akuma persona ${persona} ${reason}\n${searched.map((path) => `searched ${path}`).join("\n")}`);
    this.name = "AkumaPersonaError";
  }
}

function personaField(
  values: Readonly<Record<string, unknown>>,
  key: string,
  required = false,
): string | undefined {
  const value = values[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`Persona ${key} must be a nonblank string`);
  }
  return value;
}

function personaEnum<T extends string>(
  values: Readonly<Record<string, unknown>>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = personaField(values, key);
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) throw new TypeError(`Persona ${key} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function decodePersona(name: string, path: string, markdown: string): DecodedPersona {
  const lines = markdown.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") throw new TypeError("Persona must begin with YAML frontmatter");
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing < 0) throw new TypeError("Persona frontmatter is not closed");
  const document = parseDocument(lines.slice(1, closing).join("\n"), { uniqueKeys: true });
  if (document.errors.length > 0) throw new TypeError(`Persona frontmatter is invalid: ${document.errors[0]!.message}`);
  const decoded = document.toJS() as unknown;
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new TypeError("Persona frontmatter must be one mapping");
  }
  const values = decoded as Readonly<Record<string, unknown>>;
  const unknown = Object.keys(values).find((key) => !PERSONA_KEYS.has(key));
  if (unknown !== undefined) throw new TypeError(`unknown Persona frontmatter key: ${unknown}`);
  const provider = personaField(values, "provider", true)!;
  const model = personaField(values, "model");
  const effort = personaField(values, "effort");
  const access = personaEnum(values, "access", ["read", "write", "auto"] as const);
  const network = personaEnum(values, "network", ["disabled", "enabled"] as const);
  const description = personaField(values, "description");
  const systemPrompt = lines.slice(closing + 1).join("\n");
  return Object.freeze({
    name,
    path,
    provider,
    ...(description === undefined ? {} : { description }),
    options: decodeProviderOptions({
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(access === undefined ? {} : { access }),
      ...(network === undefined ? {} : { network }),
      systemPrompt,
    }),
  });
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
}

function optionalProviderText(value: Readonly<Record<string, unknown>>, name: string, field: "description"): string | undefined {
  const selected = value[field];
  if (selected === undefined) return undefined;
  if (typeof selected !== "string" || selected.trim().length === 0) {
    throw new TypeError(`provider ${name} ${field} must be a nonblank string`);
  }
  return selected;
}

function configuredProvider(name: string, selected: unknown): ProviderExecution {
  const value = record(selected);
  if (value === null) throw new TypeError(`provider ${name} must be an object`);
  const unknown = Object.keys(value).find((key) => !["kind", "description", "executable", "config", "env"].includes(key));
  if (unknown !== undefined) throw new TypeError(`provider ${name} has unknown field ${unknown}`);
  optionalProviderText(value, name, "description");
  return decodeProviderExecution({
    name,
    kind: value.kind,
    ...(value.executable === undefined ? {} : { executable: value.executable }),
    ...(value.config === undefined ? {} : { config: value.config }),
    ...(value.env === undefined ? {} : { env: value.env }),
  });
}

function providerExecution(settings: Settings, name: string): ProviderExecution {
  const view = settings.namespace("providers");
  if (view.kind === "failed") throw new TypeError(view.failures.map((failure) => `${failure.scope}: ${failure.diagnostic}`).join("; "));
  const selected = view.entries.find((entry) => entry.name === name)?.value;
  if (selected !== undefined) return configuredProvider(name, selected);
  if (name === "claude") return Object.freeze({ name, kind: "claude-agent-sdk" });
  if (name === "codex-app-server") return Object.freeze({ name, kind: "codex-app-server" });
  throw new TypeError(`unknown provider ${name}`);
}

function admitPersona(persona: DecodedPersona, settings: Settings): AdmittedPersona {
  let execution: ProviderExecution;
  try { execution = providerExecution(settings, persona.provider); }
  catch (error) {
    if (error instanceof TypeError) throw new AkumaPersonaError(persona.name, [persona.path], `uses ${error.message}`);
    throw error;
  }
  const adapter = providerNamed(execution);
  const admission = adapter.admitOptions(persona.options);
  if (admission.kind === "refused") {
    throw new AkumaPersonaError(persona.name, [persona.path], `is unsupported: ${admission.diagnostic}`);
  }
  return Object.freeze({ ...persona, provider: execution, adapter, options: admission.options });
}

export function loadPersona(input: Readonly<{ name: string; settings: Settings }>): AdmittedPersona {
  const name = personaName(input.name);
  const userPath = input.settings.scopes.user.path;
  if (userPath === undefined) throw new AkumaPersonaError(name, [], "has no user Settings coordinate");
  const path = join(dirname(userPath), "akuma", `${name}.md`);
  let markdown: string;
  try {
    markdown = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AkumaPersonaError(name, [path], "was not found");
    }
    throw new AkumaPersonaError(name, [path], `could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return admitPersona(decodePersona(name, path, markdown), input.settings);
  } catch (error) {
    if (error instanceof AkumaPersonaError) throw error;
    throw new AkumaPersonaError(name, [path], `is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}
