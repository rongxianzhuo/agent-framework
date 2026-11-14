import { readFile, writeFile } from "node:fs/promises";
import { defineTool, type ToolDefinition } from "../tools/definition.js";
import { textResult } from "../tools/results.js";
import { requireAbsolutePath } from "./paths.js";
import { requireTextContent } from "./text.js";
import type { EditFileArgs, EditFileToolOptions } from "./options.js";

/** Replace literal text in an existing UTF-8 file, rejecting ambiguous edits. */
export function createEditFileTool(options: EditFileToolOptions = {}): ToolDefinition<EditFileArgs> {
  return defineTool<EditFileArgs>({
    name: options.name ?? "edit_file",
    description: "Replace exact literal text in an existing UTF-8 file at an absolute file_path. old_string must be nonempty and must match. By default it must occur exactly once; multiple matches are an error. Set replease_all to true to replace all non-overlapping matches. new_string may be empty to delete text.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", minLength: 1, description: "Absolute path of the existing text file to edit." },
        old_string: { type: "string", minLength: 1, description: "Exact, nonempty text to replace, including whitespace and line endings." },
        new_string: { type: "string", description: "Literal replacement text. An empty string deletes the match." },
        replease_all: { type: "boolean", default: false, description: "Replace all non-overlapping matches. When false, multiple matches are an error." },
      },
      required: ["file_path", "old_string", "new_string"],
      additionalProperties: false,
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    execute: async ({ file_path, old_string, new_string, replease_all = false }, ctx) => {
      requireAbsolutePath(file_path);
      if (old_string.length === 0) throw new Error("old_string must not be empty.");
      const bytes = await readFile(file_path, { signal: ctx.signal });
      requireTextContent(bytes);
      const text = bytes.toString("utf8");
      const first = text.indexOf(old_string);
      if (first === -1) throw new Error("old_string was not found in the file. No changes were made.");
      if (!replease_all && text.indexOf(old_string, first + 1) !== -1) {
        throw new Error("old_string matches multiple locations. Supply more specific text or set replease_all to true. No changes were made.");
      }
      const parts = replease_all ? text.split(old_string) : undefined;
      const count = parts === undefined ? 1 : parts.length - 1;
      const updated = parts === undefined
        ? text.slice(0, first) + new_string + text.slice(first + old_string.length)
        : parts.join(new_string);
      ctx.signal?.throwIfAborted();
      await writeFile(file_path, updated, { encoding: "utf8", flag: "w", signal: ctx.signal });
      return textResult(`Replaced ${count} occurrence${count === 1 ? "" : "s"} in ${file_path}.`);
    },
  });
}
