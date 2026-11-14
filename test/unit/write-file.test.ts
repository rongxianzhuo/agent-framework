import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent, executeTool } from "../../src/index.js";
import { createReadFileTool, createWriteFileTool } from "../../src/tools.js";
import { fauxClient } from "../../src/faux.js";

const prefix = resolve(tmpdir(), "agent-framework-writer-");
let directory: string;
const ctx = { callId: "write", turn: 1 };

beforeAll(async () => { directory = await mkdtemp(prefix); });
afterAll(async () => {
  if (directory === undefined) return;
  if (!resolve(directory).startsWith(prefix)) throw new Error("Unexpected fixture directory");
  await rm(directory, { recursive: true, force: true });
});

describe("write_file", () => {
  it("creates a UTF-8 file and reports byte count", async () => {
    const path = join(directory, "new.txt");
    const content = "你好 😀\n";
    const result = await createWriteFileTool().execute({ path, content }, ctx);
    expect(await readFile(path, "utf8")).toBe(content);
    expect(result.content).toEqual([{ type: "text", text: `Wrote ${Buffer.byteLength(content)} bytes to ${path}.` }]);
  });

  it("overwrites and truncates old contents rather than appending", async () => {
    const path = join(directory, "overwrite.txt");
    await writeFile(path, "a much longer original file");
    await createWriteFileTool().execute({ path, content: "new" }, ctx);
    expect(await readFile(path, "utf8")).toBe("new");
  });

  it("accepts empty text to truncate a file to zero bytes", async () => {
    const path = join(directory, "empty.txt");
    await writeFile(path, "original");
    await createWriteFileTool().execute({ path, content: "" }, ctx);
    expect((await stat(path)).size).toBe(0);
  });

  it("rejects relative and Windows drive-relative paths", async () => {
    const paths = ["relative.txt", "./relative.txt", "../relative.txt"];
    if (process.platform === "win32") paths.push("C:relative.txt", "\\relative.txt", "/relative.txt");
    for (const path of paths) {
      await expect(createWriteFileTool().execute({ path, content: "never written" }, ctx)).rejects.toThrow("absolute file path");
    }
  });

  it.each([
    {}, { content: "text" }, { path: "placeholder" },
    { path: "placeholder", content: 123 },
    { path: "placeholder", content: "text", append: true },
  ])("validates arguments before writing: %j", async args => {
    const path = join(directory, "schema.txt");
    await writeFile(path, "unchanged");
    const tool = createWriteFileTool();
    const provided = { ...args, ...("path" in args ? { path } : {}) };
    const result = await executeTool(tool, { id: "write", name: tool.name, args: provided }, ctx);
    expect(result.error?.kind).toBe("invalidToolCall");
    expect(await readFile(path, "utf8")).toBe("unchanged");
  });

  it("returns ordinary tool errors for missing parent directories", async () => {
    const path = join(directory, "missing-parent", "file.txt");
    const tool = createWriteFileTool();
    const result = await executeTool(tool, { id: "write", name: tool.name, args: { path, content: "text" } }, ctx);
    expect(result.message.isError).toBe(true);
    expect(result.error?.kind).toBe("toolFailed");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not modify an existing file if already cancelled", async () => {
    const path = join(directory, "cancel.txt");
    await writeFile(path, "unchanged");
    const controller = new AbortController();
    controller.abort();
    await expect(createWriteFileTool().execute({ path, content: "replacement" }, { ...ctx, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(await readFile(path, "utf8")).toBe("unchanged");
  });

  it("supports custom tool names and timeouts", () => {
    const tool = createWriteFileTool({ name: "save_text", timeoutMs: 1000 });
    expect(tool.name).toBe("save_text");
    expect(tool.timeoutMs).toBe(1000);
    expect(createWriteFileTool().name).toBe("write_file");
  });

  it("works through Agent and lets a subsequent tool call read the new contents", async () => {
    const path = join(directory, "agent.txt");
    const agent = new Agent({
      client: fauxClient({ turns: [
        { toolCalls: [{ id: "write", name: "write_file", args: { path, content: "Agent wrote this." } }] },
        { toolCalls: [{ id: "read", name: "read_file", args: { path } }] },
        { text: "Written and verified." },
      ] }), model: "test", tools: [createWriteFileTool(), createReadFileTool()],
    });
    const result = await agent.run("Write and verify.");
    expect(result.stopReason).toBe("completed");
    expect(result.turns).toBe(3);
    const outputs = result.messages.filter(m => m.role === "toolResult");
    expect(outputs.map(m => m.isError)).toEqual([false, false]);
    expect(outputs[1]?.content).toEqual([{ type: "text", text: "Agent wrote this." }]);
    expect(await readFile(path, "utf8")).toBe("Agent wrote this.");
  });
});
