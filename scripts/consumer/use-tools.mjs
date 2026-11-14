// Optional built-in tools, consumed by package name from an installed tarball.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Agent } from "agent-core";
import { createReadFileTool, createReadImageTool } from "agent-core/tools";
import { fauxClient } from "agent-core/faux";

const textPath = resolve("builtin-text.txt");
const imagePath = resolve("builtin-image.png");
const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5E8AAAAASUVORK5CYII=";
await writeFile(textPath, "Hello, 内置工具!");
await writeFile(imagePath, Buffer.from(base64, "base64"));
const agent = new Agent({
  client: fauxClient({ turns: [
    { toolCalls: [
      { id: "text", name: "open_text", args: { path: textPath } },
      { id: "image", name: "read_image", args: { path: imagePath } },
    ] },
    { text: "Done." },
  ] }),
  model: "test",
  tools: [createReadFileTool({ name: "open_text", timeoutMs: 1000 }), createReadImageTool()],
});
const result = await agent.run("Read these files.");
assert.equal(result.stopReason, "completed");
const outputs = result.messages.filter(message => message.role === "toolResult");
assert.deepEqual(outputs[0].content, [{ type: "text", text: "Hello, 内置工具!" }]);
assert.deepEqual(outputs[1].content, [{ type: "image", mimeType: "image/png", data: base64 }]);
await assert.rejects(createReadFileTool().execute({ path: "relative.txt" }, { callId: "test", turn: 1 }), /absolute file path/);
await assert.rejects(createReadFileTool().execute({ path: imagePath }, { callId: "test", turn: 1 }), /binary data/);
const textBytes = Buffer.byteLength("Hello, 内置工具!", "utf8");
assert.deepEqual((await createReadFileTool({ maxBytes: textBytes }).execute({ path: textPath }, { callId: "test", turn: 1 })).content,
  [{ type: "text", text: "Hello, 内置工具!" }]);
await assert.rejects(createReadFileTool({ maxBytes: textBytes - 1 }).execute({ path: textPath }, { callId: "test", turn: 1 }), /maximum size/);
console.log("  built-in tool consumer: passed");
