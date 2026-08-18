import { execFile, spawn } from "node:child_process";
import { lstat, readlink, symlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function installDependencies(cwd) {
  const child = spawn("npm", ["ci", "--ignore-scripts", "--prefer-offline"], { cwd, stdio: "inherit" });
  const code = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      if (signal !== null) reject(new Error(`npm ci terminated by ${signal}`));
      else resolveExit(exitCode);
    });
  });
  if (code !== 0) throw new Error(`npm ci exited with code ${code}`);
}

const cwd = process.cwd();
const { stdout } = await execFileAsync(
  "git",
  ["rev-parse", "--path-format=absolute", "--git-common-dir"],
  { cwd },
);
const commonDirectory = stdout.trim();
const managedWorktrees = join(commonDirectory, "keiyaku", "wt");
const isManagedWorktree = dirname(cwd) === managedWorktrees;

if (!isManagedWorktree) {
  await installDependencies(cwd);
} else {
  const sharedDependencies = join(dirname(commonDirectory), "node_modules");
  const sharedStat = await lstat(sharedDependencies);
  if (!sharedStat.isDirectory()) throw new Error(`${sharedDependencies} is not a dependency directory`);

  const worktreeDependencies = join(cwd, "node_modules");
  try {
    const worktreeStat = await lstat(worktreeDependencies);
    const linkedTarget = worktreeStat.isSymbolicLink()
      ? resolve(dirname(worktreeDependencies), await readlink(worktreeDependencies))
      : undefined;
    if (linkedTarget !== sharedDependencies) {
      throw new Error(`${worktreeDependencies} already exists and is not the shared dependency link`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await symlink(relative(cwd, sharedDependencies), worktreeDependencies, "dir");
  }
}
