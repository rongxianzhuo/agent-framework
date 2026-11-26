import { isAbsolute, parse, relative, resolve, sep } from "node:path";

/** Resolve a model-supplied path against the directory the tool was configured with. */
export type PathResolver = (path: string) => string;

export function createPathResolver(rootDir: string | undefined): PathResolver {
  if (rootDir === undefined) {
    return (path) => {
      requireAbsolutePath(path);
      return path;
    };
  }

  const root = requireDirectory(rootDir);
  return (path) => {
    const target = resolve(root, requirePathString(path));
    if (!isWithin(root, target)) throw outsideMessage(root);
    return target;
  };
}

function requireAbsolutePath(path: string): void {
  // A Windows root-only path such as \file still depends on the current drive.
  if (!isAbsolute(path) || (process.platform === "win32" && parse(path).root.length === 1)) {
    throw new Error("An absolute file path is required. Ask the user for the full path.");
  }
}

function requirePathString(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("A nonempty file path is required.");
  }
  return path;
}

function requireDirectory(rootDir: string): string {
  if (typeof rootDir !== "string" || rootDir.length === 0 || !isAbsolute(rootDir)) {
    throw new Error("rootDir must be an absolute directory path.");
  }
  return resolve(rootDir);
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function outsideMessage(root: string): Error {
  return new Error(`The path must stay inside ${root}.`);
}

/** The path convention a tool describes to the model, matching its resolver. */
export function pathRule(rootDir: string | undefined): string {
  return rootDir === undefined
    ? "An absolute path is required."
    : `Paths are relative to ${rootDir} and must stay inside it.`;
}
