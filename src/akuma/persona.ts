import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { personaName } from "./identity.js";
import type { ProviderAdapter, ProviderOptions } from "./provider.js";
import { providerNamed } from "./providers/index.js";

type DecodedPersona = Readonly<{
  name: string;
  path: string;
  provider: string;
  description?: string;
  options: ProviderOptions;
}>;

type PersonaDefinition = DecodedPersona & Readonly<{ adapter: ProviderAdapter }>;

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
    options: Object.freeze({
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(access === undefined ? {} : { access }),
      ...(network === undefined ? {} : { network }),
      systemPrompt,
    }),
  });
}

function admitPersona(persona: DecodedPersona): PersonaDefinition {
  let adapter: ProviderAdapter;
  try {
    adapter = providerNamed(persona.provider);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new AkumaPersonaError(persona.name, [persona.path], `uses unknown provider ${persona.provider}`);
    }
    throw error;
  }
  const admission = adapter.admitOptions(persona.options);
  if (admission.kind === "refused") {
    throw new AkumaPersonaError(persona.name, [persona.path], `is unsupported: ${admission.diagnostic}`);
  }
  return Object.freeze({ ...persona, adapter, options: admission.options });
}

export function loadPersona(input: Readonly<{ name: string; keiyakuHome?: string }>): PersonaDefinition {
  const name = personaName(input.name);
  const path = join(input.keiyakuHome ?? join(homedir(), ".keiyaku"), "akuma", `${name}.md`);
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
    return admitPersona(decodePersona(name, path, markdown));
  } catch (error) {
    if (error instanceof AkumaPersonaError) throw error;
    throw new AkumaPersonaError(name, [path], `is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}
