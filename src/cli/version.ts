import { readFile } from "node:fs/promises";
const PACKAGE_NAME = "@astrosheep/keiyaku";

export async function installedPackageVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(owningManifestUrl(), "utf8")) as unknown;
  if (!isOwningManifest(manifest)) {
    throw new Error(`Keiyaku package manifest must name ${PACKAGE_NAME} and contain a nonempty version`);
  }
  return manifest.version;
}

function owningManifestUrl(): URL {
  const relativePath = import.meta.url.endsWith("/src/cli/version.ts")
    ? "../../package.json"
    : import.meta.url.endsWith("/build/src/cli/version.js")
      ? "../../../package.json"
      : undefined;
  if (relativePath === undefined) throw new Error("Keiyaku package metadata has an unsupported module layout");
  return new URL(relativePath, import.meta.url);
}

function isOwningManifest(value: unknown): value is Readonly<{ name: string; version: string }> {
  if (typeof value !== "object" || value === null) return false;
  const manifest = value as Readonly<Record<string, unknown>>;
  return manifest.name === PACKAGE_NAME && typeof manifest.version === "string" && manifest.version.trim().length > 0;
}
