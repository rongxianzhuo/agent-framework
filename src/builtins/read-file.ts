import { open, readFile } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import { defineTool, type ToolDefinition } from "../tools/definition.js";
import { textResult } from "../tools/results.js";
import { requireAbsolutePath } from "./paths.js";
import type { ReadFileToolOptions, ReadPathArgs } from "./options.js";

/** Create an opt-in UTF-8 text reader. Filesystem access occurs only on execution. */
export function createReadFileTool(options: ReadFileToolOptions = {}): ToolDefinition<ReadPathArgs> {
  const { maxBytes } = options;
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw new Error("maxBytes must be a non-negative safe integer.");
  }
  return defineTool<ReadPathArgs>({
    name: options.name ?? "read_file",
    description: "Read a local UTF-8 text file using an absolute path. Relative paths, obvious binary content and invalid UTF-8 are rejected." +
      (maxBytes === undefined ? "" : ` Maximum file size: ${maxBytes} bytes.`),
    parameters: {
      type: "object",
      properties: { path: { type: "string", minLength: 1, description: "Absolute path of the text file to read." } },
      required: ["path"],
      additionalProperties: false,
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    execute: async ({ path }, ctx) => {
      requireAbsolutePath(path);
      const bytes = maxBytes === undefined
        ? await readFile(path, { signal: ctx.signal })
        : await readWithinLimit(path, maxBytes, ctx.signal);
      requireTextContent(bytes);
      return textResult(bytes.toString("utf8"));
    },
  });
}

/** Check and read the same open file, bounded even if it grows after stat(). */
async function readWithinLimit(path: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const file = await open(path, "r");
  try {
    signal?.throwIfAborted();
    const stats = await file.stat({ bigint: true });
    signal?.throwIfAborted();
    const tooLarge = () => new Error(`File exceeds the maximum size of ${maxBytes} bytes.`);
    if (stats.size > BigInt(maxBytes)) throw tooLarge();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      signal?.throwIfAborted();
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - total + 1));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      signal?.throwIfAborted();
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw tooLarge();
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await file.close();
  }
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
