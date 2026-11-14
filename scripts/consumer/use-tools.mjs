// Optional built-in tools, consumed by package name from an installed tarball.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Agent } from "agent-framework";
import { createEditFileTool, createReadFileTool, createReadImageTool, createWriteFileTool } from "agent-framework/tools";
import { fauxClient } from "agent-framework/faux";

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
const writePath = resolve("builtin-written.txt");
const writer = createWriteFileTool({ name: "save_text", timeoutMs: 1000 });
await writer.execute({ path: writePath, content: "a long initial value" }, { callId: "write", turn: 1 });
const written = await writer.execute({ path: writePath, content: "新" }, { callId: "write", turn: 2 });
assert.equal(await readFile(writePath, "utf8"), "新");
assert.deepEqual(written.content, [{ type: "text", text: `Wrote 3 bytes to ${writePath}.` }]);
await writer.execute({ path: writePath, content: "one\r\ntwo\r\nthree" }, { callId: "write", turn: 3 });
assert.deepEqual((await createReadFileTool().execute({ path: writePath, offset: 1, limit: 1 }, { callId: "range", turn: 1 })).content,
  [{ type: "text", text: "two\r\n" }]);
await assert.rejects(createReadFileTool().execute({ path: writePath, offset: 1 }, { callId: "range", turn: 1 }), /provided together/);
const editor = createEditFileTool({ name: "replace_text", timeoutMs: 1000 });
await writer.execute({ path: writePath, content: "old old" }, { callId: "write", turn: 4 });
await assert.rejects(editor.execute({ file_path: writePath, old_string: "old", new_string: "new" }, { callId: "edit", turn: 1 }), /multiple locations/);
assert.equal(await readFile(writePath, "utf8"), "old old");
await editor.execute({ file_path: writePath, old_string: "old", new_string: "new", replease_all: true }, { callId: "edit", turn: 2 });
assert.equal(await readFile(writePath, "utf8"), "new new");
console.log("  built-in tool consumer: passed");
