import { describe, expect, it } from "vitest";
import {
  Agent, defineTool, textResult,
  type AgentEvent, type Message, type Usage,
} from "../../src/index.js";
import { fauxClient } from "../../src/faux.js";

const usage = (inputTokens: number, outputTokens = 10): Usage => ({
  inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: inputTokens + outputTokens,
});

const system: Message = { role: "system", content: [{ type: "text", text: "completion prompt" }] };

function user(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

describe("Agent.complete", () => {
  it("returns the reply without touching the agent's conversation", async () => {
    const client = fauxClient({ turns: [{ text: "done" }] });
    const agent = new Agent({ client, model: "test", system: "Be brief." });
    const before = agent.messages;

    const result = await agent.complete([system, user("do a thing")]);

    expect(result.stopReason).toBe("completed");
    expect(result.messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "done" }] });
    expect(agent.messages).toEqual(before);
    expect(agent.lastRequest).toBeUndefined();
  });

  it("uses the messages exactly as given, including their system prompt", async () => {
    const client = fauxClient({ turns: [{ text: "ok" }] });
    const agent = new Agent({ client, model: "test", system: "the agent prompt" });
    await agent.complete([system, user("hello")]);

    expect(client.requests[0]?.messages).toEqual([system, user("hello")]);
    expect(agent.system).toBe("the agent prompt");
  });

  it("adds no system message when the transcript has none", async () => {
    const client = fauxClient({ turns: [{ text: "ok" }] });
    const agent = new Agent({ client, model: "test", system: "the agent prompt" });
    await agent.complete([user("hello")]);

    expect(client.requests[0]?.messages).toEqual([user("hello")]);
  });

  it("reuses the agent's model, tools and sampling settings", async () => {
    const tool = defineTool({
      name: "echo", description: "Echo.", parameters: { type: "object" },
      execute: () => textResult("echoed"),
    });
    const client = fauxClient({ turns: [{ text: "ok" }] });
    const agent = new Agent({
      client, model: "agent-model", system: "prompt",
      tools: [tool], temperature: 0.3, maxOutputTokens: 321, reasoningEffort: "low",
    });
    await agent.complete([user("hi")]);

    const request = client.requests[0];
    expect(request?.model).toBe("agent-model");
    expect(request?.tools.map(spec => spec.name)).toEqual(["echo"]);
    expect(request?.temperature).toBe(0.3);
    expect(request?.maxOutputTokens).toBe(321);
    expect(request?.reasoningEffort).toBe("low");
  });

  it("runs tools for as long as the model asks for them", async () => {
    const calls: unknown[] = [];
    const tool = defineTool({
      name: "echo", description: "Echo.", parameters: { type: "object" },
      execute: () => { calls.push({}); return textResult("echoed"); },
    });
    const client = fauxClient({ turns: [
      { toolCalls: [{ id: "c1", name: "echo", args: {} }] },
      { toolCalls: [{ id: "c2", name: "echo", args: {} }] },
      { text: "finished" },
    ] });
    const agent = new Agent({ client, model: "test", system: "prompt", tools: [tool] });

    const result = await agent.complete([user("work")]);

    expect(result.turns).toBe(3);
    expect(result.stopReason).toBe("completed");
    expect(calls).toHaveLength(2);
    expect(result.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "finished" }] });
  });

  it("accumulates usage across the turns of one completion", async () => {
    const client = fauxClient({ turns: [
      { toolCalls: [{ id: "c1", name: "echo", args: {} }], usage: usage(100, 10) },
      { text: "done", usage: usage(200, 20) },
    ] });
    const agent = new Agent({ client, model: "test", system: "prompt", tools: [defineTool({
      name: "echo", description: "Echo.", parameters: { type: "object" },
      execute: () => textResult("echoed"),
    })] });

    const result = await agent.complete([user("work")]);

    expect(result.usage.inputTokens).toBe(300);
    expect(result.usage.outputTokens).toBe(30);
  });

  it("does not compress, even when the agent has a compression strategy", async () => {
    let checks = 0;
    const client = fauxClient({ turns: [{ text: "ok", usage: usage(500_000) }] });
    const agent = new Agent({
      client, model: "test", system: "prompt",
      contextCompression: {
        shouldCompress: () => { checks++; return true; },
        compress: () => { throw new Error("must not compress a stateless completion"); },
      },
    });

    const result = await agent.complete([system, user("hi")]);

    expect(checks).toBe(0);
    expect(result.messages).toEqual([system, user("hi"), expect.objectContaining({ role: "assistant" })]);
  });

  it("does not run the agent's default hooks or onEvent", async () => {
    let hookCalls = 0;
    const events: AgentEvent[] = [];
    const client = fauxClient({ turns: [{ text: "ok" }] });
    const agent = new Agent({
      client, model: "test", system: "prompt",
      hooks: { onBeforeRequest: ({ request }) => { hookCalls++; return request; } },
      onEvent: event => { events.push(event); },
    });

    await agent.complete([user("hi")]);

    expect(hookCalls).toBe(0);
    expect(events).toEqual([]);
  });

  it("accepts hooks and onEvent per call", async () => {
    let hookCalls = 0;
    const events: AgentEvent[] = [];
    const client = fauxClient({ turns: [{ text: "ok" }] });
    const agent = new Agent({ client, model: "test", system: "prompt" });

    await agent.complete([user("hi")], {
      hooks: { onBeforeRequest: ({ request }) => { hookCalls++; return request; } },
      onEvent: event => { events.push(event); },
    });

    expect(hookCalls).toBe(1);
    expect(events.some(event => event.type === "run_end")).toBe(true);
  });

  it("applies per-call sampling overrides", async () => {
    const client = fauxClient({ turns: [{ text: "ok" }] });
    const agent = new Agent({ client, model: "test", system: "prompt", temperature: 0.1 });
    await agent.complete([user("hi")], { temperature: 0.9, maxTurns: 1 });
    expect(client.requests[0]?.temperature).toBe(0.9);
  });

  it("leaves the agent's history and metadata intact", async () => {
    const client = fauxClient({ turns: [
      { text: "conversation answer", usage: usage(111) },
      { text: "completion answer", usage: usage(222) },
    ] });
    const agent = new Agent({ client, model: "test", system: "prompt" });
    await agent.run("first");
    const messagesBefore = agent.messages;
    const lastRequestBefore = agent.lastRequest;

    await agent.complete([user("side question")]);

    expect(agent.messages).toEqual(messagesBefore);
    expect(agent.lastRequest).toEqual(lastRequestBefore);
    expect(agent.lastRequest?.usage?.inputTokens).toBe(111);
  });

  it("can run while the agent itself is running", async () => {
    const client = fauxClient({
      turns: request => {
        const texts = request.messages.flatMap(message => message.content)
          .map(block => (block.type === "text" ? block.text : ""));
        return texts.includes("first")
          ? { text: "slow answer", chunkSize: 1, chunkDelayMs: 20 }
          : { text: "side answer" };
      },
    });
    const agent = new Agent({ client, model: "test", system: "prompt" });

    const running = agent.run("first");
    const completion = agent.complete([user("side")]);

    await expect(completion).resolves.toMatchObject({ stopReason: "completed" });
    await expect(running).resolves.toMatchObject({ stopReason: "completed" });
    expect(agent.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "slow answer" }] });
    expect(agent.messages).toHaveLength(3);
  });

  it("does not write to historyFile", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "agent-framework-complete-"));
    try {
      const file = join(directory, "history.json");
      const client = fauxClient({ turns: [{ text: "conversation" }, { text: "side" }] });
      const agent = new Agent({ client, model: "test", system: "prompt", historyFile: file });
      await agent.run("first");
      const saved = await readFile(file, "utf8");

      await agent.complete([user("side")]);
      expect(await readFile(file, "utf8")).toBe(saved);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not write to the caller's array or its messages", async () => {
    const client = fauxClient({ turns: [{ text: "ok" }] });
    const agent = new Agent({ client, model: "test", system: "prompt" });
    const input = [system, user("hi")];
    const snapshot = JSON.stringify(input);

    await agent.complete(input);

    expect(input).toHaveLength(2);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("reports failures in the result rather than throwing", async () => {
    const client = fauxClient({ turns: [{ error: { kind: "network", message: "offline" } }] });
    const agent = new Agent({ client, model: "test", system: "prompt" });

    const result = await agent.complete([user("hi")]);

    expect(result.stopReason).toBe("error");
    expect(result.error?.kind).toBe("network");
    expect(agent.messages).toEqual([{ role: "system", content: [{ type: "text", text: "prompt" }] }]);
  });

  it("reports an invalid transcript in the result", async () => {
    const client = fauxClient({ turns: [{ text: "never" }] });
    const agent = new Agent({ client, model: "test", system: "prompt" });

    const result = await agent.complete([
      user("hi"),
      { role: "toolResult", toolCallId: "orphan", toolName: "read", content: [], isError: false },
    ]);

    expect(result.stopReason).toBe("error");
    expect(result.error?.kind).toBe("invalidRequest");
    expect(client.requests).toHaveLength(0);
  });

  it("accepts a cancellation signal per call", async () => {
    const controller = new AbortController();
    const client = fauxClient({ turns: [{ text: "slow", chunkSize: 1, chunkDelayMs: 20 }] });
    const agent = new Agent({ client, model: "test", system: "prompt" });

    setTimeout(() => controller.abort(), 10);
    const result = await agent.complete([user("hi")], { signal: controller.signal });

    expect(result.stopReason).toBe("aborted");
    expect(agent.messages).toEqual([{ role: "system", content: [{ type: "text", text: "prompt" }] }]);
  });
});
