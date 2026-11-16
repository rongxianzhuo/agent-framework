import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Agent, defineTool, textResult, type Message } from "../../src/index.js";
import { fauxClient } from "../../src/faux.js";

const prefix = resolve(tmpdir(), "agent-framework-history-");
let directory: string;
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }], toolCalls: [], stopReason: "stop" });
// What a saved file holds: the turns, with only the fields the file keeps.
// System messages are never written, so they are dropped here too.
const stored = (messages: Message[]) => messages
  .filter(message => message.role !== "system")
  .map(message => Object.fromEntries(
    Object.entries(message).filter(([key]) => !["stopReason", "isError", "usage", "model", "provider", "details"].includes(key)),
  ));
const saved = async (path: string): Promise<Message[]> => JSON.parse(await readFile(path, "utf8")) as Message[];

beforeAll(async () => { directory = await mkdtemp(prefix); });
afterAll(async () => {
  if (directory === undefined) return;
  if (!resolve(directory).startsWith(prefix)) throw new Error("Unexpected fixture directory");
  await rm(directory, { recursive: true, force: true });
});

describe("Agent JSON history", () => {
  it("loads history at construction, prepends the current system prompt and appends only new dialogue", async () => {
    const path = join(directory, "loaded.json");
    const previous = [user("old question"), assistant("old answer")];
    await writeFile(path, JSON.stringify(previous));
    const client = fauxClient({ turns: [{ text: "new answer" }, { text: "another answer" }] });
    const agent = new Agent({ client, model: "test", system: "current system", historyFile: path });
    expect(agent.messages.map(m => m.role)).toEqual(["system", "user", "assistant"]);
    expect(agent.lastRequest).toBeUndefined();
    await agent.run("new question");
    expect(client.requests[0]?.messages.slice(1)).toEqual([...previous, user("new question")]);
    expect((await saved(path)).map(m => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    await agent.run("another question");
    expect(await saved(path)).toHaveLength(6);
    const restored = new Agent({ client, model: "test", system: "different system", historyFile: path });
    expect(stored(restored.messages.slice(1))).toEqual(await saved(path));
    expect(restored.messages[0]?.content).toEqual([{ type: "text", text: "different system" }]);
  });

  it("creates a missing history file only after a completed run", async () => {
    const path = join(directory, "new.json");
    const agent = new Agent({ client: fauxClient({ turns: [{ text: "answer" }] }), model: "test", historyFile: path });
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await agent.run("question", { onEvent: async event => {
      if (event.type === "text_delta" || event.type === "run_end") {
        await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } });
    expect(await saved(path)).toHaveLength(2);
  });

  it("supports relative paths and UTF-8 BOMs", async () => {
    const path = join(directory, "bom.json");
    await writeFile(path, "\uFEFF" + JSON.stringify([user("old"), assistant("answer")]));
    const agent = new Agent({ client: fauxClient({ turns: [] }), model: "test", historyFile: relative(process.cwd(), path) });
    expect(agent.messages).toHaveLength(2);
  });

  it.each([
    "", "{", "{}", '[{"role":"system","content":[]}]',
    '[{"role":"user","content":"bad"}]',
    '[{"role":"assistant","content":[],"toolCalls":"bad","stopReason":"stop"}]',
    '[{"role":"toolResult","toolCallId":"orphan","toolName":"read","content":[],"isError":false}]',
    '[{"role":"assistant","content":[],"toolCalls":[{"id":"pending","name":"read"}],"stopReason":"toolUse"}]',
  ])("rejects malformed or incomplete initial history: %s", async content => {
    const path = join(directory, "invalid.json");
    await writeFile(path, content);
    expect(() => new Agent({ client: fauxClient({ turns: [] }), model: "test", historyFile: path })).toThrow();
    expect(await readFile(path, "utf8")).toBe(content);
  });

  it("does not persist a failed request; a successful retry commits the original input once", async () => {
    const path = join(directory, "retry.json");
    const initial = [user("prior"), assistant("prior answer")];
    await writeFile(path, JSON.stringify(initial));
    const agent = new Agent({ client: fauxClient({ turns: [
      { error: { kind: "network", message: "offline" } }, { text: "recovered" },
    ] }), model: "test", historyFile: path });
    expect((await agent.run("question")).stopReason).toBe("error");
    expect(await saved(path)).toEqual(initial);
    await agent.run();
    expect((await saved(path)).map(m => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect((await saved(path))[2]).toEqual(user("question"));
  });

  it("waits through maxTurns and persists all tool messages only after continuation completes", async () => {
    const path = join(directory, "tool.json");
    const tool = defineTool({ name: "read", description: "Read.", parameters: { type: "object" }, execute: () => textResult("contents") });
    const agent = new Agent({ client: fauxClient({ turns: [
      { toolCalls: [{ id: "c1", name: "read", args: {} }] }, { text: "final answer" },
    ] }), model: "test", historyFile: path, tools: [tool] });
    expect((await agent.run("read", { maxTurns: 1 })).stopReason).toBe("maxTurns");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await agent.run();
    expect((await saved(path)).map(m => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
  });

  it("does not persist an aborted run or listener exception", async () => {
    const path = join(directory, "abort.json");
    await writeFile(path, "[]");
    const agent = new Agent({ client: fauxClient({ turns: [{ text: "answer" }] }), model: "test", historyFile: path });
    const controller = new AbortController();
    controller.abort();
    expect((await agent.run("cancel", { signal: controller.signal })).stopReason).toBe("aborted");
    expect(await saved(path)).toEqual([]);
    agent.reset();
    await expect(agent.run("listener", { onEvent: () => { throw new Error("UI failed"); } })).rejects.toThrow("UI failed");
    expect(await saved(path)).toEqual([]);
  });

  it("saves only conversation fields and restores images and parallel tool results", async () => {
    const path = join(directory, "images.json");
    await writeFile(path, "[]");
    const tool = defineTool({ name: "image", description: "Image.", parameters: { type: "object" }, execute: () => ({
      content: [{ type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" }], details: { source: "fixture" },
    }) });
    const client = fauxClient({ turns: [
      { toolCalls: [{ id: "c1", name: "image", args: {} }, { id: "c2", name: "image", args: {} }] },
      { text: "both images", usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      { text: "continued" },
    ] });
    const agent = new Agent({ client, model: "test", historyFile: path, tools: [tool] });
    await agent.run([{ type: "image", url: "https://example.com/image.png" }], { onEvent: async event => {
      if (event.type === "tool_end" || event.type === "run_end") expect(await saved(path)).toEqual([]);
    } });
    const archive = await saved(path);
    expect(archive).toEqual(stored(agent.messages));
    expect(archive.map(m => m.role)).toEqual(["user", "assistant", "toolResult", "toolResult", "assistant"]);
    expect(archive[2]).toMatchObject({ toolCallId: "c1" });
    for (const message of archive) {
      expect(Object.keys(message).every(key => ["role", "content", "toolCalls", "toolCallId", "toolName"].includes(key))).toBe(true);
    }
    expect(agent.messages.at(-1)).toHaveProperty("usage");
    expect(archive.at(-1)).not.toHaveProperty("usage");
    expect(archive[3]).toMatchObject({ toolCallId: "c2" });
    const restored = new Agent({ client, model: "test", historyFile: path });
    expect(stored(restored.messages)).toEqual(archive);
    expect(restored.messages[1]).toHaveProperty("stopReason", "toolUse");
    expect(restored.messages[2]).toHaveProperty("isError", false);
    expect(restored.messages.at(-1)).toHaveProperty("stopReason", "stop");
    expect((await restored.run("continue")).stopReason).toBe("completed");
    expect(client.requests.at(-1)?.messages).toEqual([...restored.messages.slice(0, -2), user("continue")]);
  });

  it("saves the compressed current context when context is compressed", async () => {
    const path = join(directory, "compression.json");
    const previous = [user("original"), assistant("original answer")];
    await writeFile(path, JSON.stringify(previous));
    const client = fauxClient({ turns: [{ text: "new answer" }] });
    const agent = new Agent({ client, model: "test", system: "system", historyFile: path, contextCompression: {
      shouldCompress: () => true,
      compress: () => [user("synthetic summary")],
    } });
    await agent.run("actual new input");
    expect(agent.messages[0]).toEqual(user("synthetic summary"));
    const archive = await saved(path);
    expect(archive).toEqual(stored(agent.messages));
    expect(archive[0]).toEqual(user("synthetic summary"));
    expect(archive.some(m => m.role === "system")).toBe(false);
    expect(JSON.stringify(archive)).not.toContain("original answer");
  });

  it("retains messages after a save failure and saves the full context on the next completed run", async () => {
    const parent = join(directory, "create-parent-later");
    const path = join(parent, "history.json");
    const client = fauxClient({ turns: [{ text: "answer" }, { text: "next answer" }] });
    const agent = new Agent({ client, model: "test", historyFile: path });
    await expect(agent.run("question")).rejects.toMatchObject({ code: "ENOENT" });
    expect(agent.messages).toHaveLength(2);
    await mkdir(parent);
    await agent.run("next question");
    expect(await saved(path)).toEqual(stored(agent.messages));
    expect(await saved(path)).toHaveLength(4);
    expect(client.requests).toHaveLength(2);
  });

  it("ignores non-serializable tool details when saving", async () => {
    const path = join(directory, "serialization.json");
    await writeFile(path, "[]");
    const tool = defineTool({ name: "read", description: "Read.", parameters: { type: "object" }, execute: () => textResult("ok", { value: 1n }) });
    const agent = new Agent({ client: fauxClient({ turns: [
      { toolCalls: [{ id: "c1", name: "read", args: {} }] }, { text: "done" },
    ] }), model: "test", historyFile: path, tools: [tool] });
    expect((await agent.run("read")).stopReason).toBe("completed");
    expect(await saved(path)).toHaveLength(4);
    expect((await saved(path))[2]).not.toHaveProperty("details");
  });

  it("saves the replaced context on the next completed run", async () => {
    const path = join(directory, "reset.json");
    const previous = [user("previous"), assistant("answer")];
    await writeFile(path, JSON.stringify(previous));
    const agent = new Agent({ client: fauxClient({ turns: [{ text: "new answer" }] }), model: "test", system: "system", historyFile: path });
    agent.reset();
    expect(agent.messages.map(m => m.role)).toEqual(["system"]);
    agent.replaceMessages("replacement prompt", [user("external context")]);
    expect(await saved(path)).toEqual(previous);
    await agent.run("new input");
    expect(await saved(path)).toEqual(stored(agent.messages));
    expect((await saved(path))[0]).toEqual(user("external context"));
    expect((await saved(path))[1]).toEqual(user("new input"));
  });
});
