import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { lstat, readlink, realpath } from "node:fs/promises";

/** A path the model asked for, both as it will be opened and as it will be echoed. */
export interface ResolvedPath {
  /** Absolute path on disk, after every symbolic link has been resolved. */
  absolute: string;
  /** The path as the model supplied it, safe to show back to it. */
  display: string;
  /** Real path of the configured root directory, when there is one. */
  root?: string;
}

export type PathResolver = (path: string) => Promise<ResolvedPath>;

const MAX_LINK_HOPS = 40;

export function createPathResolver(rootDir: string | undefined): PathResolver {
  if (rootDir === undefined) {
    return async (path) => {
      requireAbsolutePath(path);
      return { absolute: path, display: path };
    };
  }

  const root = requireDirectory(rootDir);
  return async (path) => {
    requirePathString(path);
    if (process.platform === "win32" && parse(path).root.length === 1) throw outsideMessage();
    const realRoot = await canonical(root);
    const realTarget = await canonical(resolve(root, path));
    if (!isWithin(realRoot, realTarget)) throw outsideMessage();
    return { absolute: realTarget, display: path, root: realRoot };
  };
}

/**
 * Rewrite a filesystem error so it speaks in the model's own path vocabulary.
 *
 * Node's `fs` errors embed the absolute path that was opened, which is the resolved
 * path here. That path is not something the model supplied and, inside a root
 * directory, not something it may learn. Replacing it with the path the model gave
 * keeps the error actionable: the code and the reason survive, the location does not.
 */
export function hideResolvedPath(error: unknown, path: ResolvedPath): Error {
  const message = error instanceof Error ? error.message : String(error);
  let text = message;
  if (path.absolute !== path.display) text = text.replaceAll(path.absolute, path.display);
  if (path.root !== undefined) text = text.replaceAll(path.root, ".");
  return error instanceof Error && text === message
    ? error
    : Object.assign(new Error(text), { cause: error });
}

function requireAbsolutePath(path: string): void {
  // A Windows root-only path such as \file still depends on the current drive.
  if (!isAbsolute(path) || (process.platform === "win32" && parse(path).root.length === 1)) {
    throw new Error("An absolute file path is required. Ask the user for the full path.");
  }
}

function requirePathString(path: string): void {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("A nonempty file path is required.");
  }
}

function requireDirectory(rootDir: string): string {
  if (typeof rootDir !== "string" || rootDir.length === 0 || !isAbsolute(rootDir)) {
    throw new Error("rootDir must be an absolute directory path.");
  }
  return resolve(rootDir);
}

/**
 * Resolve every symbolic link in a path, including one whose target does not exist.
 *
 * `realpath` covers the ordinary case. It fails on a path that does not exist yet,
 * which is how a new file arrives, and on a link whose target is absent, which is how
 * a write through a dangling link would land outside the root. A dangling link is
 * therefore read with `readlink` and resolved as its target; a path that is simply
 * absent is resolved by following its deepest existing ancestor, since the missing
 * segments cannot be links.
 */
async function canonical(target: string, hops = 0): Promise<string> {
  if (hops > MAX_LINK_HOPS) throw unresolvable();

  try {
    return await realpath(target);
  } catch (error) {
    if (!isMissing(error)) throw unresolvable();
  }

  const link = await readLink(target);
  if (link !== undefined) return canonical(resolve(dirname(target), link), hops + 1);

  const missing: string[] = [];
  let current = target;
  while (true) {
    const parent = dirname(current);
    if (parent === current) throw unresolvable();
    missing.unshift(parse(current).base);
    current = parent;

    try {
      return join(await realpath(current), ...missing);
    } catch (error) {
      if (!isMissing(error)) throw unresolvable();
    }

    const ancestorLink = await readLink(current);
    if (ancestorLink !== undefined) {
      return canonical(join(resolve(dirname(current), ancestorLink), ...missing), hops + 1);
    }
  }
}

/** The target of a symbolic link, or `undefined` when the path is not one. */
async function readLink(path: string): Promise<string | undefined> {
  try {
    if (!(await lstat(path)).isSymbolicLink()) return undefined;
    return await readlink(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw unresolvable();
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function outsideMessage(): Error {
  return new Error("The path must stay inside the allowed directory.");
}

function unresolvable(): Error {
  return new Error("The path could not be resolved. Check that it is reachable.");
}

/** The path convention a tool describes to the model, matching its resolver. */
export function pathRule(rootDir: string | undefined): string {
  return rootDir === undefined
    ? "An absolute path is required."
    : "Paths are resolved against the tool's root directory and must stay inside it.";
}
