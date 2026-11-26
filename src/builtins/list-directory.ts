import { readdir } from "node:fs/promises";
import { defineTool, type ToolDefinition } from "../tools/definition.js";
import { textResult } from "../tools/results.js";
import { createPathResolver, hideResolvedPath, pathRule } from "./paths.js";
import type { ListDirectoryArgs, ListDirectoryToolOptions } from "./options.js";

interface ListedEntry {
  name: string;
  kind: "directory" | "file" | "symlink" | "other";
}

/** Create an opt-in reader for one directory level. Listing never recurses. */
export function createListDirectoryTool(options: ListDirectoryToolOptions = {}): ToolDefinition<ListDirectoryArgs> {
  const { maxEntries } = options;
  if (maxEntries !== undefined && (!Number.isSafeInteger(maxEntries) || maxEntries < 0)) {
    throw new Error("maxEntries must be a non-negative safe integer.");
  }
  const toPath = createPathResolver(options.rootDir);
  const paths = pathRule(options.rootDir);
  return defineTool<ListDirectoryArgs>({
    name: options.name ?? "list_directory",
    description: `List the entries of one directory. ${paths} Returns the immediate files and folders only, one per line, with no recursion into subdirectories. A trailing / marks a directory, a trailing @ marks a symbolic link, and a plain name is a regular file.` +
      (maxEntries === undefined ? "" : ` At most ${maxEntries} entries are returned.`),
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Path of the directory to list." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    execute: async ({ path }, ctx) => {
      const target = await toPath(path);
      ctx.signal?.throwIfAborted();
      let dirents;
      try {
        dirents = await readdir(target.absolute, { withFileTypes: true });
      } catch (error) {
        throw hideResolvedPath(error, target);
      }
      ctx.signal?.throwIfAborted();

      const entries: ListedEntry[] = dirents
        .map((dirent): ListedEntry => ({ name: dirent.name, kind: kindOf(dirent) }))
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      const shown = maxEntries === undefined ? entries : entries.slice(0, maxEntries);
      const details = { path, entries: shown, total: entries.length, truncated: shown.length < entries.length };

      if (entries.length === 0) return textResult("The directory is empty.", details);
      const lines = shown.map((entry) => `${entry.name}${markerOf(entry.kind)}`);
      const hidden = entries.length - shown.length;
      if (hidden > 0) lines.push(`... ${hidden} more entr${hidden === 1 ? "y" : "ies"} not shown.`);
      return textResult(lines.join("\n"), details);
    },
  });
}

function kindOf(dirent: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): ListedEntry["kind"] {
  if (dirent.isSymbolicLink()) return "symlink";
  if (dirent.isDirectory()) return "directory";
  if (dirent.isFile()) return "file";
  return "other";
}

function markerOf(kind: ListedEntry["kind"]): string {
  if (kind === "directory") return "/";
  if (kind === "symlink") return "@";
  return "";
}
