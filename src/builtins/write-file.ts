import { writeFile } from "node:fs/promises";
import { defineTool, type ToolDefinition } from "../tools/definition.js";
import { textResult } from "../tools/results.js";
import { requireAbsolutePath } from "./paths.js";
import type { WriteFileArgs, WriteFileToolOptions } from "./options.js";

/** Create or overwrite a UTF-8 file. Parent directories must already exist. */
export function createWriteFileTool(options: WriteFileToolOptions = {}): ToolDefinition<WriteFileArgs> {
  return defineTool<WriteFileArgs>({
    name: options.name ?? "write_file",
    description: "Write UTF-8 text to an absolute file path, replacing all existing contents or creating the file. Parent directories must already exist.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Absolute path of the file to create or overwrite." },
        content: { type: "string", description: "Complete text to write. An empty string empties the file." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    execute: async ({ path, content }, ctx) => {
      requireAbsolutePath(path);
      ctx.signal?.throwIfAborted();
      await writeFile(path, content, { encoding: "utf8", flag: "w", signal: ctx.signal });
      return textResult(`Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}.`);
    },
  });
}
