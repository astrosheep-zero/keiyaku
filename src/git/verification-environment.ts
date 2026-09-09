import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, realpath, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runGit, type GitRepository } from "./process.js";

/** A source or destination filesystem shape that cannot safely be inherited. */
export class VerificationEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationEnvironmentError";
  }
}

type FileFingerprint = Readonly<{
  dev: number | bigint;
  ino: number | bigint;
  size: number | bigint;
  mtimeMs: number | bigint;
  ctimeMs: number | bigint;
}>;

function cancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true)
    throw new VerificationEnvironmentError("verification environment inheritance cancelled");
}

function repositoryWithSignal(repository: GitRepository, signal: AbortSignal | undefined): GitRepository {
  if (signal === undefined || signal === repository.signal) return repository;
  return { ...repository, signal };
}

function fingerprint(value: Awaited<ReturnType<typeof lstat>>): FileFingerprint {
  return {
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
  };
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function isDescendant(root: string, path: string): boolean {
  const value = relative(root, path);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function sourcePath(root: string, path: string): string {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new VerificationEnvironmentError(`Git returned an unsafe environment path: ${JSON.stringify(path)}`);
  }
  return join(root, ...path.split("/"));
}

function isKeiyakuAuthorityPath(path: string): boolean {
  const parts = path.split("/");
  return parts.includes(".git") || parts[0] === ".keiyaku" || path === "KEIYAKU.md";
}

function hasCandidateDescendant(candidatePaths: ReadonlySet<string>, path: string): boolean {
  const prefix = `${path}/`;
  for (const candidate of candidatePaths) if (candidate.startsWith(prefix)) return true;
  return false;
}

async function gitPaths(repository: GitRepository, worktree: string, args: readonly string[]): Promise<Set<string>> {
  const output = await runGit(repository, ["-C", worktree, ...args]);
  return new Set(
    output
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((path) => (path.endsWith("/") ? path.slice(0, -1) : path)),
  );
}

async function existingDirectory(path: string, label: string): Promise<string> {
  let state: Awaited<ReturnType<typeof lstat>>;
  try {
    state = await lstat(path);
  } catch {
    throw new VerificationEnvironmentError(`${label} does not exist: ${path}`);
  }
  if (state.isSymbolicLink() || !state.isDirectory()) {
    throw new VerificationEnvironmentError(`${label} is not a real directory: ${path}`);
  }
  return await realpath(path);
}

async function destinationDirectory(root: string, path: string, candidatePaths: ReadonlySet<string>): Promise<boolean> {
  const relativePath = relative(root, path);
  if (!isDescendant(root, path) && path !== root)
    throw new VerificationEnvironmentError(`destination escapes candidate: ${path}`);
  try {
    const state = await lstat(path);
    if (state.isSymbolicLink() || !state.isDirectory()) {
      if (candidatePaths.has(relativePath)) return false;
      throw new VerificationEnvironmentError(`destination ancestor is not a real directory: ${path}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path, { mode: 0o755 });
    const made = await lstat(path);
    if (made.isSymbolicLink() || !made.isDirectory()) {
      throw new VerificationEnvironmentError(`destination ancestor is not a real directory: ${path}`);
    }
    return true;
  }
}

async function prepareDestination(root: string, path: string, candidatePaths: ReadonlySet<string>): Promise<boolean> {
  if (!isDescendant(root, path)) throw new VerificationEnvironmentError(`destination escapes candidate: ${path}`);
  const relativePath = relative(root, path);
  if (candidatePaths.has(relativePath)) return false;
  const parents = relativePath.split(sep).slice(0, -1);
  let current = root;
  for (const part of parents) {
    current = join(current, part);
    if (!(await destinationDirectory(root, current, candidatePaths))) return false;
  }
  try {
    await lstat(path);
    throw new VerificationEnvironmentError(`destination environment path already exists: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function copyRegularFile(source: string, destination: string, signal: AbortSignal | undefined): Promise<void> {
  cancelled(signal);
  const before = await lstat(source);
  if (!before.isFile() || before.isSymbolicLink())
    throw new VerificationEnvironmentError(`source changed while reading: ${source}`);
  const beforeFingerprint = fingerprint(before);
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const opened = await input.stat();
    if (!opened.isFile() || !sameFingerprint(beforeFingerprint, fingerprint(opened))) {
      throw new VerificationEnvironmentError(`source changed while reading: ${source}`);
    }
    bytes = await input.readFile();
    const afterRead = await input.stat();
    if (!sameFingerprint(beforeFingerprint, fingerprint(afterRead))) {
      throw new VerificationEnvironmentError(`source changed while reading: ${source}`);
    }
  } finally {
    await input.close();
  }
  cancelled(signal);
  const after = await lstat(source);
  if (!after.isFile() || after.isSymbolicLink() || !sameFingerprint(beforeFingerprint, fingerprint(after))) {
    throw new VerificationEnvironmentError(`source changed while reading: ${source}`);
  }
  const output = await open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    before.mode & 0o777,
  );
  try {
    await output.writeFile(bytes);
  } finally {
    await output.close();
  }
  cancelled(signal);
}

async function copyLink(
  input: Readonly<{
    sourceRoot: string;
    sourceAlias: string;
    destinationRoot: string;
    source: string;
    destination: string;
    signal: AbortSignal | undefined;
  }>,
): Promise<void> {
  const { sourceRoot, sourceAlias, destinationRoot, source, destination, signal } = input;
  cancelled(signal);
  const before = await lstat(source);
  if (!before.isSymbolicLink()) throw new VerificationEnvironmentError(`source changed while reading link: ${source}`);
  const target = await readlink(source);
  const resolvedSourceTarget = resolve(dirname(source), target);
  const targetPath = isDescendant(sourceRoot, resolvedSourceTarget)
    ? relative(sourceRoot, resolvedSourceTarget).split(sep).join("/")
    : isAbsolute(target) && isDescendant(sourceAlias, target)
      ? relative(sourceAlias, target).split(sep).join("/")
      : null;
  if (targetPath === null) {
    throw new VerificationEnvironmentError(`environment link escapes source appointment: ${source}`);
  }
  if (isKeiyakuAuthorityPath(targetPath)) {
    throw new VerificationEnvironmentError(`environment link targets Keiyaku authority: ${source}`);
  }
  const after = await lstat(source);
  if (!after.isSymbolicLink() || !sameFingerprint(fingerprint(before), fingerprint(after))) {
    throw new VerificationEnvironmentError(`source changed while reading link: ${source}`);
  }
  const relocated = isAbsolute(target) ? join(destinationRoot, ...targetPath.split("/")) : target;
  await symlink(relocated, destination);
  cancelled(signal);
}

async function copyEntry(
  input: Readonly<{
    sourceRoot: string;
    sourceAlias: string;
    destinationRoot: string;
    relativePath: string;
    sourceTracked: ReadonlySet<string>;
    candidatePaths: ReadonlySet<string>;
    signal: AbortSignal | undefined;
  }>,
): Promise<void> {
  const { sourceRoot, sourceAlias, destinationRoot, relativePath, sourceTracked, candidatePaths, signal } = input;
  cancelled(signal);
  if (relativePath.split("/").includes(".git")) {
    throw new VerificationEnvironmentError(`environment contains nested repository state: ${relativePath}`);
  }
  if (isKeiyakuAuthorityPath(relativePath) || sourceTracked.has(relativePath) || candidatePaths.has(relativePath))
    return;
  const source = sourcePath(sourceRoot, relativePath);
  const destination = sourcePath(destinationRoot, relativePath);
  const state = await lstat(source);
  if (state.isSymbolicLink()) {
    if (hasCandidateDescendant(candidatePaths, relativePath)) return;
    if (!(await prepareDestination(destinationRoot, destination, candidatePaths))) return;
    await copyLink({ sourceRoot, sourceAlias, destinationRoot, source, destination, signal });
    return;
  }
  if (state.isFile()) {
    if (hasCandidateDescendant(candidatePaths, relativePath)) return;
    if (!(await prepareDestination(destinationRoot, destination, candidatePaths))) return;
    await copyRegularFile(source, destination, signal);
    return;
  }
  if (!state.isDirectory()) throw new VerificationEnvironmentError(`unsupported environment special file: ${source}`);
  if (hasCandidateDescendant(candidatePaths, relativePath)) {
    const destinationState = await lstat(destination);
    if (destinationState.isSymbolicLink() || !destinationState.isDirectory()) return;
  } else if (!(await prepareDestination(destinationRoot, destination, candidatePaths))) {
    return;
  }
  const children = (await readdir(source)).sort();
  for (const child of children) {
    await copyEntry({ ...input, relativePath: `${relativePath}/${child}` });
  }
}

/**
 * Copy the selected appointment's ignored and untracked execution state into a
 * materialized candidate without changing either Git worktree's authority.
 */
export async function inheritVerificationEnvironment(
  repository: GitRepository,
  source: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  const activeSignal =
    signal === undefined
      ? repository.signal
      : repository.signal === undefined
        ? signal
        : AbortSignal.any([repository.signal, signal]);
  const activeRepository = repositoryWithSignal(repository, activeSignal);
  cancelled(activeSignal);
  const sourceAlias = resolve(source);
  const sourceRoot = await existingDirectory(source, "verification environment source");
  const destinationRoot = await existingDirectory(destination, "verification environment destination");
  if (
    sourceRoot === destinationRoot ||
    isDescendant(sourceRoot, destinationRoot) ||
    isDescendant(destinationRoot, sourceRoot)
  ) {
    throw new VerificationEnvironmentError(
      "verification environment source and destination must be independent directories",
    );
  }
  const [sourceTracked, candidatePaths, untracked, ignored] = await Promise.all([
    gitPaths(activeRepository, sourceRoot, ["ls-files", "--cached", "-z"]),
    gitPaths(activeRepository, destinationRoot, ["ls-files", "--cached", "-z"]),
    gitPaths(activeRepository, sourceRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
    gitPaths(activeRepository, sourceRoot, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ]),
  ]);
  const environmentPaths = [...new Set([...untracked, ...ignored])];
  const roots = environmentPaths
    .filter((path) => !environmentPaths.some((other) => other !== path && path.startsWith(`${other}/`)))
    .sort();
  for (const relativePath of roots) {
    await copyEntry({
      sourceRoot,
      sourceAlias,
      destinationRoot,
      relativePath,
      sourceTracked,
      candidatePaths,
      signal: activeSignal,
    });
  }
}
