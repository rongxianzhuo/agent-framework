import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent, executeTool } from "../../src/index.js";
import { createReadFileTool, createReadImageTool } from "../../src/tools.js";
import { fauxClient } from "../../src/faux.js";

const prefix = resolve(tmpdir(), "agent-core-readers-");
let directory: string;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5E8AAAAASUVORK5CYII=", "base64");
const ctx = { callId: "test", turn: 1 };

beforeAll(async () => {
  directory = await mkdtemp(prefix);
  await writeFile(join(directory, "text.txt"), "你好, agent!\nSecond line.");
  await writeFile(join(directory, "picture.bin"), png);
});

afterAll(async () => {
  if (directory === undefined) return;
  if (!resolve(directory).startsWith(prefix)) throw new Error("Unexpected fixture directory");
  await rm(directory, { recursive: true, force: true });
});

describe("built-in file readers", () => {
  it("reads a UTF-8 text file", async () => {
    const result = await createReadFileTool().execute({ path: join(directory, "text.txt") }, ctx);
    expect(result.content).toEqual([{ type: "text", text: "你好, agent!\nSecond line." }]);
  });

  it.each([
    ["empty", ""],
    ["unicode", "中文 😀 café\n"],
    ["bom", "\uFEFFUTF-8 with BOM\r\n"],
    ["logs", "\u001b[32mOK\u001b[0m\tvalue\r\n\fnext page"],
    ["replacement", "A literal replacement character: �"],
  ])("preserves valid %s text without lossy decoding", async (name, text) => {
    const path = join(directory, `${name}.png`); // An extension is not a content detector.
    await writeFile(path, text);
    expect((await createReadFileTool().execute({ path }, ctx)).content).toEqual([{ type: "text", text }]);
  });

  it.each([
    ["png", png],
    ["pdf", Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF")],
    ["gif", Buffer.from("GIF89a")],
    ["webp", Buffer.from("RIFF0000WEBP")],
    ["zip", Buffer.from([80, 75, 3, 4, 65, 66, 67, 68])],
    ["controls", Buffer.from([1, 2, 3, 4, 5, 6, 7, 14, 15, 127])],
    ["late-nul", Buffer.concat([Buffer.alloc(10_000, 65), Buffer.from([0])])],
  ] as const)("blocks obvious %s binary content as a tool failure", async (name, bytes) => {
    const path = join(directory, `${name}.txt`);
    await writeFile(path, bytes);
    const tool = createReadFileTool();
    const outcome = await executeTool(tool, { id: "test", name: tool.name, args: { path } }, ctx);
    expect(outcome.message.isError).toBe(true);
    expect(outcome.error?.kind).toBe("toolFailed");
    expect(outcome.message.content).toEqual([
      { type: "text", text: expect.stringContaining("appears to contain binary data") },
    ]);
  });

  it.each([
    ["invalid", Buffer.from([0xc3, 0x28])],
    ["gbk", Buffer.from([0xc4, 0xe3, 0xba, 0xc3])],
  ] as const)("rejects %s UTF-8 instead of returning replacement characters", async (name, bytes) => {
    const path = join(directory, `${name}.txt`);
    await writeFile(path, bytes);
    await expect(createReadFileTool().execute({ path }, ctx)).rejects.toThrow("not valid UTF-8");
  });

  it("returns raw Base64 and detects PNG independently of the extension", async () => {
    const result = await createReadImageTool().execute({ path: join(directory, "picture.bin") }, ctx);
    expect(result.content).toEqual([{ type: "image", mimeType: "image/png", data: png.toString("base64") }]);
  });

  it.each([
    ["jpeg", Buffer.from([255, 216, 255, 224]), "image/jpeg"],
    ["gif87", Buffer.from("GIF87a"), "image/gif"],
    ["gif89", Buffer.from("GIF89a"), "image/gif"],
    ["webp", Buffer.from("RIFF0000WEBP"), "image/webp"],
  ] as const)("recognizes the %s signature", async (name, bytes, mimeType) => {
    // Header-only fixtures exercise format identification, not image decoding.
    const path = join(directory, name);
    await writeFile(path, bytes);
    const result = await createReadImageTool().execute({ path }, ctx);
    expect(result.content).toEqual([{ type: "image", mimeType, data: bytes.toString("base64") }]);
  });

  it("rejects non-image and empty files", async () => {
    const tool = createReadImageTool();
    await expect(tool.execute({ path: join(directory, "text.txt") }, ctx)).rejects.toThrow("Unsupported image format");
    const empty = join(directory, "empty.png");
    await writeFile(empty, "");
    await expect(tool.execute({ path: empty }, ctx)).rejects.toThrow("Unsupported image format");
  });

  it.each([createReadFileTool, createReadImageTool])("requires absolute paths for %s", async create => {
    const paths = ["relative.txt", "./relative.txt", "../relative.txt"];
    if (process.platform === "win32") paths.push("C:relative.txt", "\\relative.txt", "/relative.txt");
    for (const path of paths) {
      await expect(create().execute({ path }, ctx)).rejects.toThrow("absolute file path");
    }
  });

  it.each([createReadFileTool, createReadImageTool])("returns read errors through the normal executor for %s", async create => {
    const tool = create();
    const outcome = await executeTool(tool, {
      id: "test", name: tool.name, args: { path: join(directory, "missing") },
    }, ctx);
    expect(outcome.message.isError).toBe(true);
    expect(outcome.error?.kind).toBe("toolFailed");
    expect(outcome.message.content[0]).toMatchObject({ text: expect.stringContaining("ENOENT") });
  });

  it.each([createReadFileTool, createReadImageTool])("forwards the cancellation signal for %s", async create => {
    const controller = new AbortController();
    controller.abort();
    await expect(create().execute({ path: join(directory, "picture.bin") }, { ...ctx, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("supports custom names and timeouts without sharing mutable schemas", () => {
    const text = createReadFileTool({ name: "open_text", timeoutMs: 1000 });
    const image = createReadImageTool({ name: "open_image", timeoutMs: 2000 });
    expect([text.name, text.timeoutMs, image.name, image.timeoutMs]).toEqual(["open_text", 1000, "open_image", 2000]);
    text.parameters.required!.length = 0;
    expect(createReadFileTool().parameters.required).toEqual(["path"]);
    expect(() => createReadImageTool({ timeoutMs: -1 })).toThrow("non-positive timeoutMs");
    expect(() => createReadFileTool({ name: "bad name" })).toThrow("Invalid tool name");
  });

  it("works in an Agent alongside other tools", async () => {
    const textPath = join(directory, "text.txt");
    const imagePath = join(directory, "picture.bin");
    const agent = new Agent({
      client: fauxClient({ turns: [
        { toolCalls: [
          { id: "text", name: "read_file", args: { path: textPath } },
          { id: "image", name: "read_image", args: { path: imagePath } },
        ] },
        { text: "Read both." },
      ] }), model: "test", tools: [createReadFileTool(), createReadImageTool()],
    });
    const result = await agent.run("Read these files.");
    expect(result.stopReason).toBe("completed");
    const outputs = result.messages.filter(m => m.role === "toolResult");
    expect(outputs).toHaveLength(2);
    expect(outputs[0]?.content).toEqual([{ type: "text", text: await readFile(textPath, "utf8") }]);
    expect(outputs[1]?.content).toEqual([{ type: "image", mimeType: "image/png", data: png.toString("base64") }]);
  });
});
