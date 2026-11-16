import { describe, expect, it } from "vitest";
import { Agent, defineTool, textResult, type AgentEvent, type ContentBlock, type Message } from "../../src/index.js";
import { fauxClient } from "../../src/faux.js";

describe("Agent", () => {
  it("carries previous exchanges into subsequent calls", async () => {
    const client = fauxClient({ turns: [{ text: "first answer" }, { text: "second answer" }] });
    const agent = new Agent({ client, model: "test", system: "Be brief." });
    await agent.run("first question");
    const result = await agent.run("second question");
    expect(client.requests[1]?.messages.map(m => m.role)).toEqual([
      "system", "user", "assistant", "user",
    ]);
    expect(client.requests[1]?.messages[2]?.content).toEqual([{ type: "text", text: "first answer" }]);
    expect(agent.messages).toEqual(result.messages);
  });

  it("accepts structured user content", async () => {
    const client = fauxClient({ turns: [{ text: "an image" }] });
    const agent = new Agent({ client, model: "test" });
    const content: ContentBlock[] = [
      { type: "text", text: "Describe this." },
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
    ];
    await agent.run(content);
    expect(client.requests[0]?.messages[0]?.content).toEqual(content);
    expect(agent.messages[0]?.role).toBe("user");
  });

  it("reuses defaults and applies per-call overrides without changing them", async () => {
    const client = fauxClient({ turns: [{ text: "one" }, { text: "two" }] });
    const defaults: AgentEvent[] = [];
    const overrides: AgentEvent[] = [];
    const agent = new Agent({
      client, model: "test", temperature: 0.2, reasoningEffort: "high",
      hooks: { onBeforeRequest: ({ request }) => ({ ...request, maxOutputTokens: 123 }) },
      onEvent: event => { defaults.push(event); },
    });
    await agent.run("one", { temperature: 0.8, onEvent: event => { overrides.push(event); } });
    expect(defaults).toHaveLength(0);
    expect(overrides.some(e => e.type === "text_delta")).toBe(true);
    await agent.run("two");
    expect(defaults.some(e => e.type === "text_delta")).toBe(true);
    expect(client.requests.map(r => r.temperature)).toEqual([0.8, 0.2]);
    expect(client.requests.every(r => r.reasoningEffort === "high" && r.maxOutputTokens === 123)).toBe(true);
  });

  it("keeps tool exchanges and continues after a turn limit without new input", async () => {
    let calls = 0;
    const tool = defineTool({
      name: "read", description: "Read.", parameters: { type: "object" },
      execute: () => { calls++; return textResult("file contents"); },
    });
    const client = fauxClient({ turns: [
      { toolCalls: [{ id: "c1", name: "read", args: {} }] }, { text: "summary" },
    ] });
    const agent = new Agent({ client, model: "test", tools: [tool] });
    expect((await agent.run("read", { maxTurns: 1 })).stopReason).toBe("maxTurns");
    expect((await agent.run()).stopReason).toBe("completed");
    expect(calls).toBe(1);
    expect(client.requests[1]?.messages.map(m => m.role)).toEqual(["user", "assistant", "toolResult"]);
  });

  it("isolates instances, restored history, snapshots and returned results", async () => {
    const client = fauxClient({ turns: () => ({ text: "answer" }) });
    const agent = new Agent({ client, model: "test", system: "original system" });
    const other = new Agent({ client, model: "test" });
    const restored: Message[] = [{ role: "user", content: [{ type: "text", text: "restored" }] }];
    agent.replaceMessages("original system", restored);
    restored[0]!.content.length = 0;
    const result = await agent.run();
    // messages[0] is the system prompt; the restored turn sits after it.
    result.messages[1]!.content.length = 0;
    const snapshot = agent.messages;
    snapshot[1]!.content.length = 0;
    expect(agent.messages.map(m => m.role)).toEqual(["system", "user", "assistant"]);
    expect(agent.messages[1]?.content).toEqual([{ type: "text", text: "restored" }]);
    expect(other.messages).toEqual([]);
    agent.reset();
    expect(agent.messages).toEqual([{ role: "system", content: [{ type: "text", text: "original system" }] }]);
  });

  it("takes the system prompt and the messages separately", async () => {
    const client = fauxClient({ turns: () => ({ text: "answer" }) });
    const agent = new Agent({ client, model: "test", system: "original" });
    const turns: Message[] = [{ role: "user", content: [{ type: "text", text: "restored" }] }];

    // A different prompt replaces the constructor's one rather than joining it.
    agent.replaceMessages("replacement", turns);
    expect(agent.system).toBe("replacement");
    expect(agent.messages.map(m => m.role)).toEqual(["system", "user"]);
    expect(agent.messages[0]?.content).toEqual([{ type: "text", text: "replacement" }]);

    // A prompt is required and must say something. A blank one is rejected
    // rather than becoming a prompt that instructs nothing.
    for (const blank of ["", "   ", "\n\t "]) {
      expect(() => agent.replaceMessages(blank, turns)).toThrow("non-empty system prompt");
    }
    expect(() => agent.replaceMessages(undefined as unknown as string, turns)).toThrow(TypeError);
    expect(() => agent.replaceMessages(42 as unknown as string, turns)).toThrow("requires a system prompt string");

    // A rejected call changes nothing: the prompt and turns are still the ones
    // the last successful call installed.
    expect(agent.system).toBe("replacement");
    expect(agent.messages.map(m => m.role)).toEqual(["system", "user"]);

    // A transcript carrying its own system message is rejected: the prompt has
    // one home, and accepting both would leave the caller guessing which wins.
    expect(() => agent.replaceMessages("x", [
      { role: "system", content: [{ type: "text", text: "sneaky" }] },
    ])).toThrow("must not contain system messages");
    expect(agent.system).toBe("replacement");
    expect(agent.messages.map(m => m.role)).toEqual(["system", "user"]);

    // The installed prompt is configuration: reset() keeps it.
    agent.replaceMessages("kept", turns);
    agent.reset();
    expect(agent.messages).toEqual([{ role: "system", content: [{ type: "text", text: "kept" }] }]);
  });

  it("rejects concurrent runs and history edits while busy", async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const agent = new Agent({
      client: fauxClient({ turns: () => ({ text: "ok" }) }), model: "test",
    });
    const pending = agent.run("one", { hooks: { onBeforeRequest: async () => { entered(); await gate; } } });
    await started;
    await expect(agent.run("two")).rejects.toThrow("already running");
    expect(() => agent.reset()).toThrow("already running");
    expect(() => agent.replaceMessages("p", [])).toThrow("already running");
    release();
    await pending;
    await expect(agent.run("three")).resolves.toMatchObject({ stopReason: "completed" });
  });

  it("retains failed model requests so they can be retried without duplicating input", async () => {
    const client = fauxClient({ turns: [
      { error: { kind: "network", message: "offline" } }, { text: "recovered" },
    ] });
    const agent = new Agent({ client, model: "test" });
    expect((await agent.run("hello")).stopReason).toBe("error");
    expect(agent.messages).toHaveLength(1);
    expect((await agent.run()).stopReason).toBe("completed");
    expect(client.requests[1]?.messages).toHaveLength(1);
  });

  it("blocks incomplete tool history after cancellation until explicitly repaired", async () => {
    const controller = new AbortController();
    let calls = 0;
    const tool = defineTool({
      name: "write", description: "A side effect.", parameters: { type: "object" },
      execute: () => { calls++; controller.abort(); return textResult("written"); },
    });
    const client = fauxClient({ turns: [
      { toolCalls: [{ id: "pending", name: "write", args: {} }] }, { text: "continued" },
    ] });
    const agent = new Agent({ client, model: "test", tools: [tool] });
    expect((await agent.run("write", { signal: controller.signal })).stopReason).toBe("aborted");
    await expect(agent.run("next")).rejects.toThrow("replaceMessages()");
    expect(calls).toBe(1);
    expect(client.requests).toHaveLength(1);
    expect(() => agent.replaceMessages("p", agent.messages)).toThrow("no result");
    agent.replaceMessages("p", [...agent.messages, {
      role: "toolResult", toolCallId: "pending", toolName: "write",
      content: [{ type: "text", text: "Caller confirmed the write completed." }], isError: false,
    }]);
    await expect(agent.run()).resolves.toMatchObject({ stopReason: "completed" });
    expect(calls).toBe(1);
  });

  it("releases the running guard after a listener throws", async () => {
    const agent = new Agent({ client: fauxClient({ turns: [{ text: "ok" }] }), model: "test" });
    await expect(agent.run("first", { onEvent: () => { throw new Error("listener failed"); } })).rejects.toThrow("listener failed");
    expect(agent.messages).toEqual([]);
    await expect(agent.run("second")).resolves.toMatchObject({ stopReason: "completed" });
  });

  it("preserves opaque tool details without requiring them to be cloneable", async () => {
    const details = { callback: () => "application object" };
    const tool = defineTool({
      name: "read", description: "Read.", parameters: { type: "object" },
      execute: () => textResult("contents", details),
    });
    const agent = new Agent({
      client: fauxClient({ turns: [
        { toolCalls: [{ id: "c1", name: "read", args: {} }] }, { text: "done" },
      ] }), model: "test", tools: [tool],
    });
    await agent.run("read");
    const result = agent.messages.find(m => m.role === "toolResult");
    expect(result?.details).toBe(details);
    expect(result?.content).toEqual([{ type: "text", text: "contents" }]);
  });
});
