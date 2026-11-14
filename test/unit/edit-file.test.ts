import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent, executeTool } from "../../src/index.js";
import { createEditFileTool, createReadFileTool } from "../../src/tools.js";
import { fauxClient } from "../../src/faux.js";

const prefix = resolve(tmpdir(), "agent-framework-editor-");
let directory: string;
const ctx = { callId: "edit", turn: 1 };

beforeAll(async () => { directory = await mkdtemp(prefix); });
afterAll(async () => {
  if (directory === undefined) return;
  if (!resolve(directory).startsWith(prefix)) throw new Error("Unexpected fixture directory");
  await rm(directory, { recursive: true, force: true });
});

describe("edit_file", () => {
  it("replaces a unique match while preserving UTF-8 BOMs and CRLF endings", async () => {
    const file_path = join(directory, "unique.txt");
    await writeFile(file_path, "\uFEFF第一行\r\nold\r\n最后一行\r\n");
    const result = await createEditFileTool().execute({ file_path, old_string: "old", new_string: "新 😀" }, ctx);
    expect(await readFile(file_path, "utf8")).toBe("\uFEFF第一行\r\n新 😀\r\n最后一行\r\n");
    expect(result.content).toEqual([{ type: "text", text: `Replaced 1 occurrence in ${file_path}.` }]);
  });

  it.each([undefined, false])("rejects multiple matches when replease_all is %s without modifying the file", async flag => {
    const file_path = join(directory, `ambiguous-${flag}.txt`);
    const original = "old / old / old";
    await writeFile(file_path, original);
    const tool = createEditFileTool();
    const result = await executeTool(tool, { id: "edit", name: tool.name, args: {
      file_path, old_string: "old", new_string: "new", ...(flag === undefined ? {} : { replease_all: flag }),
    } }, ctx);
    expect(result.message.isError).toBe(true);
    expect(result.message.content[0]).toMatchObject({ text: expect.stringContaining("multiple locations") });
    expect(await readFile(file_path, "utf8")).toBe(original);
  });

  it("replaces all original matches with literal replacement text", async () => {
    const file_path = join(directory, "all.txt");
    await writeFile(file_path, "a.* / a.* / a.*");
    const replacement = "$& $$ $` $' a.*";
    const result = await createEditFileTool().execute({ file_path, old_string: "a.*", new_string: replacement, replease_all: true }, ctx);
    expect(await readFile(file_path, "utf8")).toBe([replacement, replacement, replacement].join(" / "));
    expect(result.content[0]).toMatchObject({ text: `Replaced 3 occurrences in ${file_path}.` });
  });

  it("rejects overlapping ambiguous positions unless all replacement is requested", async () => {
    const file_path = join(directory, "overlap.txt");
    await writeFile(file_path, "aaa");
    const tool = createEditFileTool();
    await expect(tool.execute({ file_path, old_string: "aa", new_string: "b" }, ctx)).rejects.toThrow("multiple locations");
    expect(await readFile(file_path, "utf8")).toBe("aaa");
    await tool.execute({ file_path, old_string: "aa", new_string: "b", replease_all: true }, ctx);
    expect(await readFile(file_path, "utf8")).toBe("ba");
  });

  it("supports multiline exact matches and empty replacement text", async () => {
    const file_path = join(directory, "multiline.txt");
    await writeFile(file_path, "start\r\ndelete\r\nthese\r\nend");
    await createEditFileTool().execute({ file_path, old_string: "delete\r\nthese\r\n", new_string: "" }, ctx);
    expect(await readFile(file_path, "utf8")).toBe("start\r\nend");
  });

  it.each([false, true])("rejects missing matches even with replease_all=%s", async replease_all => {
    const file_path = join(directory, `missing-match-${replease_all}.txt`);
    await writeFile(file_path, "ABC\r\nunchanged");
    await expect(createEditFileTool().execute({ file_path, old_string: "abc", new_string: "new", replease_all }, ctx))
      .rejects.toThrow("not found");
    expect(await readFile(file_path, "utf8")).toBe("ABC\r\nunchanged");
  });

  it.each([
    { old_string: "", new_string: "new" },
    { old_string: "old" },
    { old_string: 123, new_string: "new" },
    { old_string: "old", new_string: null },
    { old_string: "old", new_string: "new", replease_all: "true" },
    { old_string: "old", new_string: "new", replace_all: true },
  ])("validates arguments before modifying files: %j", async args => {
    const file_path = join(directory, "schema.txt");
    await writeFile(file_path, "old");
    const tool = createEditFileTool();
    const result = await executeTool(tool, { id: "edit", name: tool.name, args: { file_path, ...args } }, ctx);
    expect(result.error?.kind).toBe("invalidToolCall");
    expect(await readFile(file_path, "utf8")).toBe("old");
  });

  it("requires absolute paths and never creates a missing file", async () => {
    const tool = createEditFileTool();
    const paths = ["relative.txt", "./relative.txt", "../relative.txt"];
    if (process.platform === "win32") paths.push("C:relative.txt", "\\relative.txt", "/relative.txt");
    for (const file_path of paths) {
      await expect(tool.execute({ file_path, old_string: "old", new_string: "new" }, ctx)).rejects.toThrow("absolute file path");
    }
    const file_path = join(directory, "missing.txt");
    const result = await executeTool(tool, { id: "edit", name: tool.name, args: { file_path, old_string: "old", new_string: "new" } }, ctx);
    expect(result.message.isError).toBe(true);
    expect(result.error?.kind).toBe("toolFailed");
    await expect(stat(file_path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["binary", Buffer.from([0, 65, 66])],
    ["invalid-utf8", Buffer.from([0xc3, 0x28])],
  ] as const)("refuses %s input without rewriting bytes", async (name, original) => {
    const file_path = join(directory, `${name}.txt`);
    await writeFile(file_path, original);
    await expect(createEditFileTool().execute({ file_path, old_string: "A", new_string: "B" }, ctx)).rejects.toThrow();
    expect(await readFile(file_path)).toEqual(original);
  });

  it("does not change a file when already cancelled", async () => {
    const file_path = join(directory, "cancel.txt");
    await writeFile(file_path, "old");
    const controller = new AbortController();
    controller.abort();
    await expect(createEditFileTool().execute({ file_path, old_string: "old", new_string: "new" }, { ...ctx, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(await readFile(file_path, "utf8")).toBe("old");
  });

  it("supports custom names and timeouts", () => {
    const tool = createEditFileTool({ name: "replace_text", timeoutMs: 1000 });
    expect([tool.name, tool.timeoutMs]).toEqual(["replace_text", 1000]);
    expect(createEditFileTool().parameters.properties?.["replease_all"]?.default).toBe(false);
  });

  it("lets an Agent recover from an ambiguous edit and read back the replacement", async () => {
    const file_path = join(directory, "agent.txt");
    await writeFile(file_path, "old old");
    const agent = new Agent({
      client: fauxClient({ turns: [
        { toolCalls: [{ id: "bad", name: "edit_file", args: { file_path, old_string: "old", new_string: "new" } }] },
        { toolCalls: [{ id: "good", name: "edit_file", args: { file_path, old_string: "old", new_string: "new", replease_all: true } }] },
        { toolCalls: [{ id: "read", name: "read_file", args: { path: file_path } }] },
        { text: "Edited." },
      ] }), model: "test", tools: [createEditFileTool(), createReadFileTool()],
    });
    const result = await agent.run("Replace old with new.");
    const outputs = result.messages.filter(message => message.role === "toolResult");
    expect(result.stopReason).toBe("completed");
    expect(outputs.map(output => output.isError)).toEqual([true, false, false]);
    expect(outputs[2]?.content).toEqual([{ type: "text", text: "new new" }]);
  });
});
