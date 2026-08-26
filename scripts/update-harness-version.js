import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const releaseVersion = process.argv[2];
if (releaseVersion === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(releaseVersion)) {
  throw new Error("usage: node scripts/update-harness-version.js <semver-without-build-metadata>");
}

const root = resolve(import.meta.dirname, "..");
const plugin = resolve(root, "integrations/marketplace/plugins/keiyaku");
const codexPath = resolve(plugin, ".codex-plugin/plugin.json");
const manifestPaths = [codexPath, resolve(plugin, ".claude-plugin/plugin.json"), resolve(plugin, "package.json")];

const manifests = manifestPaths.map((path) => {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (typeof manifest.version !== "string") throw new Error(`${path} must declare a string version`);
  return { path, manifest };
});
const codex = manifests.find(({ path }) => path === codexPath);
const codexMetadata = codex?.manifest.version.split("+").slice(1).join("+");
if (codex === undefined || codexMetadata === undefined || !/^codex\.[0-9A-Za-z.-]+$/u.test(codexMetadata)) {
  throw new Error(`${codexPath} must carry one Codex cachebuster`);
}

for (const { path, manifest } of manifests) {
  manifest.version = path === codexPath ? `${releaseVersion}+${codexMetadata}` : releaseVersion;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}
