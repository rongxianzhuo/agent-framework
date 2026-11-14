import { readFile } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import { defineTool, type ToolDefinition } from "../tools/definition.js";
import { textResult } from "../tools/results.js";
import { requireAbsolutePath } from "./paths.js";
import type { ReadPathArgs, ReadToolOptions } from "./options.js";

/** Create an opt-in UTF-8 text reader. Filesystem access occurs only on execution. */
export function createReadFileTool(options: ReadToolOptions = {}): ToolDefinition<ReadPathArgs> {
  return defineTool<ReadPathArgs>({
    name: options.name ?? "read_file",
    description: "Read a local UTF-8 text file using an absolute path. Relative paths, obvious binary content and invalid UTF-8 are rejected.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", minLength: 1, description: "Absolute path of the text file to read." } },
      required: ["path"],
      additionalProperties: false,
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    execute: async ({ path }, ctx) => {
      requireAbsolutePath(path);
      const bytes = await readFile(path, { signal: ctx.signal });
      requireTextContent(bytes);
      return textResult(bytes.toString("utf8"));
    },
  });
}

/** Heuristic binary detection plus strict UTF-8 validation; no extension guessing. */
function requireTextContent(bytes: Buffer): void {
  // These formats can have ASCII-only contents, so UTF-8 validity alone is insufficient.
  const header = bytes.toString("latin1", 0, 12);
  const knownBinary = header.startsWith("%PDF-") || header.startsWith("GIF87a") || header.startsWith("GIF89a") ||
    (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") ||
    ["PK\x03\x04", "PK\x05\x06", "PK\x07\x08"].some(signature => header.startsWith(signature));
  // Permit normal whitespace and common terminal controls used in text logs.
  let controls = 0;
  for (const byte of bytes) {
    if ((byte < 32 && ![8, 9, 10, 11, 12, 13, 27].includes(byte)) || byte === 127) controls++;
  }
  if (knownBinary || bytes.includes(0) || controls > bytes.length * 0.1) {
    throw new Error("The file appears to contain binary data. read_file only supports UTF-8 text; use a tool appropriate for this file format.");
  }
  if (!isUtf8(bytes)) {
    throw new Error("The file is not valid UTF-8 text. It may be binary or use an unsupported text encoding.");
  }
}
