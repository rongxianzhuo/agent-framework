import { isUtf8 } from "node:buffer";

/** Heuristic binary detection plus strict UTF-8 validation; no extension guessing. */
export function requireTextContent(bytes: Buffer): void {
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
