import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseDocument } from "yaml";
import type { Settings } from "../settings.js";
import { archetypeName } from "./identity.js";
import { decodeProviderOptions, type ProviderAdapter, type ProviderOptions } from "./provider.js";
import type { ProviderExecution } from "./heart/index.js";
import { decodeProviderExecution, providerNamed } from "./providers/index.js";

type DecodedArchetype = Readonly<{
  name: string;
  path: string;
  provider: string;
  description?: string;
  options: ProviderOptions;
}>;

export type ArchetypeCatalogRow = Readonly<{
  name: string;
  model?: string;
  description?: string;
}>;

type ArchetypeDefinition = DecodedArchetype & Readonly<{ adapter: ProviderAdapter }>;
type AdmittedArchetype = Omit<ArchetypeDefinition, "provider"> & Readonly<{ provider: ProviderExecution }>;

export class AkumaArchetypeError extends Error {
  readonly kind = "akuma-archetype";
  constructor(
    readonly archetype: string,
    readonly searched: readonly string[],
    readonly reason: string,
  ) {
    super(`Akuma archetype ${archetype} ${reason}\n${searched.map((path) => `searched ${path}`).join("\n")}`);
    this.name = "AkumaArchetypeError";
  }
}

function archetypeDirectory(settings: Settings): string | null {
  const userPath = settings.scopes.user.path;
  return userPath === undefined ? null : join(dirname(userPath), "akuma");
}

function archetypePaths(settings: Settings): readonly Readonly<{ name: string; path: string }>[] {
  const directory = archetypeDirectory(settings);
  if (directory === null) return [];
  try {
    return readdirSync(directory, { withFileTypes: true })
      .flatMap((entry) => {
        if (!entry.isFile() || !entry.name.endsWith(".md")) return [];
        const name = entry.name.slice(0, -3);
        try { return [{ name: archetypeName(name), path: join(directory, entry.name) }]; }
        catch { return []; }
      })
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function listArchetypes(input: Readonly<{ settings: Settings }>): readonly string[] {
  return archetypePaths(input.settings).map(({ name }) => name);
}

function archetypeField(
  values: Readonly<Record<string, unknown>>,
  key: string,
  required = false,
): string | undefined {
  const value = values[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`Archetype ${key} must be a nonblank string`);
  }
  return value;
}

function archetypeEnum<T extends string>(
  values: Readonly<Record<string, unknown>>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = archetypeField(values, key);
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) throw new TypeError(`Archetype ${key} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function decodeArchetype(name: string, path: string, markdown: string): DecodedArchetype {
  const lines = markdown.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") throw new TypeError("Archetype must begin with YAML frontmatter");
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing < 0) throw new TypeError("Archetype frontmatter is not closed");
  const document = parseDocument(lines.slice(1, closing).join("\n"), { uniqueKeys: true });
  if (document.errors.length > 0) throw new TypeError(`Archetype frontmatter is invalid: ${document.errors[0]!.message}`);
  const decoded = document.toJS() as unknown;
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new TypeError("Archetype frontmatter must be one mapping");
  }
  const values = decoded as Readonly<Record<string, unknown>>;
  const provider = archetypeField(values, "provider", true)!;
  const model = archetypeField(values, "model");
  const effort = archetypeField(values, "effort");
  const access = archetypeEnum(values, "access", ["read", "write", "auto"] as const);
  const network = archetypeEnum(values, "network", ["disabled", "enabled"] as const);
  const description = archetypeField(values, "description");
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

export function listArchetypeDefinitions(input: Readonly<{ settings: Settings }>): readonly ArchetypeCatalogRow[] {
  return archetypePaths(input.settings).map(({ name, path }) => {
    try {
      const definition = decodeArchetype(name, path, readFileSync(path, "utf8"));
      return Object.freeze({
        name: definition.name,
        ...(definition.options.model === undefined ? {} : { model: definition.options.model }),
        ...(definition.description === undefined ? {} : { description: definition.description }),
      });
    } catch (error) {
      throw new AkumaArchetypeError(
        name,
        [path],
        `is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
  if (name === "opencode-sdk") return Object.freeze({ name, kind: "opencode-sdk" });
  throw new TypeError(`unknown provider ${name}`);
}

function admitArchetype(archetype: DecodedArchetype, settings: Settings): AdmittedArchetype {
  let execution: ProviderExecution;
  try { execution = providerExecution(settings, archetype.provider); }
  catch (error) {
    if (error instanceof TypeError) throw new AkumaArchetypeError(archetype.name, [archetype.path], `uses ${error.message}`);
    throw error;
  }
  const adapter = providerNamed(execution);
  const admission = adapter.admitOptions(archetype.options);
  if (admission.kind === "refused") {
    throw new AkumaArchetypeError(archetype.name, [archetype.path], `is unsupported: ${admission.diagnostic}`);
  }
  return Object.freeze({ ...archetype, provider: execution, adapter, options: admission.options });
}

export function loadArchetype(input: Readonly<{ name: string; settings: Settings }>): AdmittedArchetype {
  const name = archetypeName(input.name);
  const directory = archetypeDirectory(input.settings);
  if (directory === null) throw new AkumaArchetypeError(name, [], "has no user Settings coordinate");
  const path = join(directory, `${name}.md`);
  let markdown: string;
  try {
    markdown = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AkumaArchetypeError(name, [path], "was not found");
    }
    throw new AkumaArchetypeError(name, [path], `could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return admitArchetype(decodeArchetype(name, path, markdown), input.settings);
  } catch (error) {
    if (error instanceof AkumaArchetypeError) throw error;
    throw new AkumaArchetypeError(name, [path], `is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}
