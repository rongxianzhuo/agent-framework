import { readFile } from "node:fs/promises";
import { defineTool, type ToolDefinition } from "../tools/definition.js";
import { requireAbsolutePath } from "./paths.js";
import type { ReadPathArgs, ReadToolOptions } from "./options.js";

/** Create an opt-in PNG/JPEG/GIF/WebP reader returning a Base64 image block. */
export function createReadImageTool(options: ReadToolOptions = {}): ToolDefinition<ReadPathArgs> {
  return defineTool<ReadPathArgs>({
    name: options.name ?? "read_image",
    description: "Read a local PNG, JPEG, GIF or WebP image using an absolute path and return its image content.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", minLength: 1, description: "Absolute path of the image to read." } },
      required: ["path"],
      additionalProperties: false,
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    execute: async ({ path }, ctx) => {
      requireAbsolutePath(path);
      const bytes = await readFile(path, { signal: ctx.signal });
      return { content: [{ type: "image", mimeType: imageMimeType(bytes), data: bytes.toString("base64") }] };
    },
  });
}

/** Identify common image signatures, independent of the filename extension. */
function imageMimeType(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new Error("Unsupported image format. Use PNG, JPEG, GIF or WebP.");
}
