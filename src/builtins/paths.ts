import { isAbsolute, parse } from "node:path";

export function requireAbsolutePath(path: string): void {
  // A Windows root-only path such as \file still depends on the current drive.
  if (!isAbsolute(path) || (process.platform === "win32" && parse(path).root.length === 1)) {
    throw new Error("An absolute file path is required. Ask the user for the full path.");
  }
}
