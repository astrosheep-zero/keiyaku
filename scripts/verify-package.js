import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const artifact = resolve(root, "build/src/runtime/proc/windows-launch.exe");

function assertWindowsArtifact(path) {
  if (!existsSync(path)) throw new Error(`Windows launcher artifact is missing: ${path}`);
  const bytes = readFileSync(path);
  if (bytes.toString("ascii", 0, 2) !== "MZ") throw new Error("Windows launcher is not a PE image");
  const peOffset = bytes.readUInt32LE(0x3c);
  if (bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") throw new Error("Windows launcher has no PE signature");
  if (bytes.readUInt16LE(peOffset + 4) !== 0x8664) throw new Error("Windows launcher is not x64");
  const optionalHeader = peOffset + 24;
  if (bytes.readUInt16LE(optionalHeader) !== 0x20b) throw new Error("Windows launcher is not a PE32+ image");
  if (bytes.readUInt16LE(optionalHeader + 68) !== 2) throw new Error("Windows launcher is not a GUI-subsystem image");
}

function archiveCandidates() {
  const destination = process.env.npm_config_pack_destination === undefined
    ? root
    : resolve(root, process.env.npm_config_pack_destination);
  const packageName = (process.env.npm_package_name ?? "astrosheep-keiyaku").replace(/^@/, "").replaceAll("/", "-");
  const version = process.env.npm_package_version ?? "";
  const prefix = `${packageName}-${version}`;
  return readdirSync(destination)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".tgz"))
    .map((name) => join(destination, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
}

function assertArchive(path) {
  const listing = execFileSync("tar", ["-tzf", path], { cwd: root, encoding: "utf8" });
  if (!listing.split(/\r?\n/u).includes("package/build/src/runtime/proc/windows-launch.exe")) {
    throw new Error(`npm tarball omits package/build/src/runtime/proc/windows-launch.exe: ${path}`);
  }
}

if (process.platform !== "win32") process.exit(0);
assertWindowsArtifact(artifact);
if (process.env.npm_lifecycle_event === "postpack") {
  const archive = archiveCandidates()[0];
  if (archive === undefined) throw new Error("npm pack did not expose its tarball for Windows launcher inspection");
  assertArchive(archive);
}
