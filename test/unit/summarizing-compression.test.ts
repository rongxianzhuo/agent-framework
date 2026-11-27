import { describe, expect, it } from "vitest";
import {
  Agent,
  createSummarizingCompression,
  type Message,
  type Usage,
} from "../../src/index.js";
import { fauxClient } from "../../src/faux.js";

const usage = (inputTokens: number, outputTokens = 10): Usage => ({
  inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: inputTokens + outputTokens,
});

const prompt = "You are a coding agent.";
const system: Message = { role: "system", content: [{ type: "text", text: prompt }] };

function user(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistant(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }], toolCalls: [], stopReason: "stop" };
}

function summaryClient(text = "The user asked for a refactor; it is finished.") {
  return fauxClient({ turns: [{ text }], onExhausted: "repeatLast" });
}

const context = (messages: Message[], usageValue?: Usage) => ({
  messages,
  request: { model: "main", messages, tools: [] },
  signal: undefined,
  lastRequest: usageValue === undefined ? undefined : { model: "main", usage: usageValue },
});

describe("createSummarizingCompression", () => {
  it("declines below the threshold", () => {
    const strategy = createSummarizingCompression({ client: summaryClient(), model: "summary-model", threshold: 1_000 });
    expect(strategy.shouldCompress(context([system, user("a"), assistant("b")], usage(500)))).toBe(false);
  });

  it("declines when the provider reported no usage", () => {
    const strategy = createSummarizingCompression({ client: summaryClient(), model: "summary-model", threshold: 1_000 });
    expect(strategy.shouldCompress(context([system, user("a"), assistant("b")]))).toBe(false);
  });

  it("counts input and output tokens together against the threshold", () => {
    const strategy = createSummarizingCompression({ client: summaryClient(), model: "summary-model", threshold: 1_000, keepRecentMessages: 2 });
    const transcript = [system, user("a"), assistant("b"), user("c"), assistant("d"), user("e")];
    expect(strategy.shouldCompress(context(transcript, usage(950, 60)))).toBe(true);
  });

  it("declines when the transcript is already short enough to keep", () => {
    const strategy = createSummarizingCompression({ client: summaryClient(), model: "summary-model", threshold: 10, keepRecentMessages: 4 });
    const short = [system, user("a"), assistant("b"), user("c")];
    expect(strategy.shouldCompress(context(short, usage(5_000)))).toBe(false);
  });

  it("places the summary after the system prompt and keeps the recent messages", async () => {
    const messages = [system, user("goal"), assistant("step one"), user("next"), assistant("step two"), user("latest")];
    const strategy = createSummarizingCompression({ client: summaryClient(), model: "summary-model", threshold: 10, keepRecentMessages: 3 });
    const result = await strategy.compress(context(messages, usage(5_000)));

    expect(result[0]).toEqual(system);
    expect(result[1]?.role).toBe("user");
    const text = result[1]?.content[0];
    expect(text?.type === "text" && text.text).toContain("[Earlier conversation summary]");
    expect(result.slice(2)).toEqual(messages.slice(3));
  });

  it("never drops the system prompt", async () => {
    const strategy = createSummarizingCompression({ client: summaryClient(), model: "summary-model", threshold: 10, keepRecentMessages: 1 });
    const result = await strategy.compress(context([system, user("a"), assistant("b"), user("c")], usage(5_000)));
    expect(result[0]).toEqual(system);
  });

  it("moves the cut back so a kept tool result keeps its call", async () => {
    const messages: Message[] = [
      system,
      user("goal"),
      { role: "assistant", content: [], toolCalls: [{ id: "c1", name: "read", args: {} }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "output" }], isError: false },
      assistant("done"),
      user("next"),
    ];
    const strategy = createSummarizingCompression({ client: summaryClient(), model: "summary-model", threshold: 10, keepRecentMessages: 3 });
    const result = await strategy.compress(context(messages, usage(5_000)));

    expect(result[0]).toEqual(system);
    expect(result[1]).toMatchObject({ role: "user" });
    expect(result.slice(2)).toEqual(messages.slice(2));
    const callKept = result.some((m) => m.role === "assistant" && m.toolCalls.length > 0);
    expect(callKept).toBe(true);
  });

  it("sends the system prompt, the dropped messages unchanged, and one instruction", async () => {
    const client = summaryClient();
    const dropped: Message[] = [
      user("goal"),
      { role: "assistant", content: [], toolCalls: [{ id: "c1", name: "read", args: { path: "a" } }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "output" }], isError: false },
    ];
    const messages: Message[] = [system, ...dropped, assistant("done"), user("after")];
    const strategy = createSummarizingCompression({ client, model: "summary-model", threshold: 10, keepRecentMessages: 2 });
    await strategy.compress(context(messages, usage(5_000)));

    const sent = client.requests[0]?.messages ?? [];
    expect(sent[0]).toEqual(system);
    expect(sent.slice(1, 1 + dropped.length)).toEqual(dropped);
    expect(sent).toHaveLength(dropped.length + 2);
    const instruction = sent.at(-1);
    expect(instruction?.role).toBe("user");
    expect(instruction?.content[0]?.type === "text" && instruction.content[0].text).toContain("Summarize the conversation above");
    expect(client.requests[0]?.tools).toEqual([]);
  });

  it("sends the agent's system prompt unchanged", async () => {
    const client = summaryClient();
    const custom: Message = { role: "system", content: [{ type: "text", text: "Answer in French." }] };
    const strategy = createSummarizingCompression({ client, model: "summary-model", threshold: 10, keepRecentMessages: 1 });
    await strategy.compress(context([custom, user("a"), assistant("b"), user("c")], usage(5_000)));
    expect(client.requests[0]?.messages[0]).toEqual(custom);
  });

  it("forwards images and reasoning blocks as they are", async () => {
    const client = summaryClient();
    const image: Message = { role: "user", content: [{ type: "image", mimeType: "image/png", data: "AAAA" }] };
    const reasoning: Message = {
      role: "assistant", content: [{ type: "thinking", text: "private reasoning" }], toolCalls: [], stopReason: "stop",
    };
    const strategy = createSummarizingCompression({ client, model: "summary-model", threshold: 10, keepRecentMessages: 1 });
    await strategy.compress(context([system, image, reasoning, user("after")], usage(5_000)));

    const sent = client.requests[0]?.messages ?? [];
    expect(sent[0]).toEqual(system);
    expect(sent[1]).toEqual(image);
    expect(sent[2]).toEqual(reasoning);
  });

  it("uses the configured model for the summary, not the request model", async () => {
    const client = summaryClient();
    const strategy = createSummarizingCompression({ client, model: "cheap", threshold: 10, keepRecentMessages: 1 });
    await strategy.compress(context([system, user("a"), assistant("b"), user("c")], usage(5_000)));
    expect(client.requests[0]?.model).toBe("cheap");
  });

  it("leaves history untouched when the summary request fails", async () => {
    const client = fauxClient({ turns: [{ error: { kind: "network", message: "offline" } }], onExhausted: "repeatLast" });
    const messages = [system, user("a"), assistant("b"), user("c")];
    const strategy = createSummarizingCompression({ client, model: "summary-model", threshold: 10, keepRecentMessages: 1 });
    expect(await strategy.compress(context(messages, usage(5_000)))).toEqual(messages);
  });

  it("leaves history untouched when the model answers with an error stop reason", async () => {
    const client = fauxClient({ turns: [{ text: "boom", stopReason: "error" }], onExhausted: "repeatLast" });
    const messages = [system, user("a"), assistant("b"), user("c")];
    const strategy = createSummarizingCompression({ client, model: "summary-model", threshold: 10, keepRecentMessages: 1 });
    expect(await strategy.compress(context(messages, usage(5_000)))).toEqual(messages);
  });

  it("leaves history untouched when the summary is empty", async () => {
    const client = summaryClient("   ");
    const messages = [system, user("a"), assistant("b"), user("c")];
    const strategy = createSummarizingCompression({ client, model: "summary-model", threshold: 10, keepRecentMessages: 1 });
    expect(await strategy.compress(context(messages, usage(5_000)))).toEqual(messages);
  });

  it("rejects invalid configuration at creation time", () => {
    const client = summaryClient();
    expect(() => createSummarizingCompression({ client, model: "summary-model", threshold: 0 })).toThrow("threshold must be a positive");
    expect(() => createSummarizingCompression({ client, model: "summary-model", threshold: Number.NaN })).toThrow("threshold must be a positive");
    expect(() => createSummarizingCompression({ client, model: "summary-model", threshold: 10, keepRecentMessages: 0 })).toThrow("keepRecentMessages must be a positive");
    expect(() => createSummarizingCompression({ client, model: "summary-model", threshold: 10, keepRecentMessages: 1.5 })).toThrow("keepRecentMessages must be a positive");
    expect(() => createSummarizingCompression({ client, model: "", threshold: 10 })).toThrow("model must be a nonempty string");
    // @ts-expect-error a model is required
    expect(() => createSummarizingCompression({ client, threshold: 10 })).toThrow("model must be a nonempty string");
    // @ts-expect-error a client is required
    expect(() => createSummarizingCompression({ model: "summary-model", threshold: 10 })).toThrow("requires a client");
  });
});

describe("the bundled strategy inside an Agent", () => {
  it("replaces history and sends the shortened transcript on the next request", async () => {
    const summarizer = summaryClient("Earlier: the user described a bug.");
    const client = fauxClient({ turns: [
      { text: "answer one", usage: usage(5_000) },
      { text: "answer two", usage: usage(10) },
    ] });
    const agent = new Agent({
      system: prompt, client, model: "main",
      contextCompression: createSummarizingCompression({ client: summarizer, model: "summary-model", threshold: 1_000, keepRecentMessages: 2 }),
    });

    await agent.run("first question");
    expect(agent.messages).toHaveLength(3);

    await agent.run("second question");
    const sent = client.requests[1]?.messages ?? [];
    expect(sent[0]).toEqual(system);
    expect(sent.some((m) => m.role === "user" && JSON.stringify(m.content).includes("Earlier: the user described a bug."))).toBe(true);
    expect(client.requests[1]?.messages.length).toBeLessThan(5);
  });

  it("carries a previous summary into the next summary", async () => {
    const summarizer = summaryClient("second summary");
    const client = fauxClient({ turns: [
      { text: "one", usage: usage(5_000) },
      { text: "two", usage: usage(5_000) },
      { text: "three", usage: usage(5_000) },
      { text: "four", usage: usage(10) },
    ] });
    const agent = new Agent({
      system: prompt, client, model: "main",
      contextCompression: createSummarizingCompression({ client: summarizer, model: "summary-model", threshold: 1_000, keepRecentMessages: 1 }),
    });

    await agent.run("a");
    await agent.run("b");
    await agent.run("c");
    const second = summarizer.requests[1]?.messages;
    expect(second?.[0]).toEqual(system);
    expect(JSON.stringify(second)).toContain("second summary");
  });

  it("does not overwrite the agent's own last-request usage with the summary call", async () => {
    const summarizer = summaryClient();
    const client = fauxClient({ turns: [{ text: "answer", usage: usage(5_000, 250) }] });
    const agent = new Agent({
      system: prompt, client, model: "main",
      contextCompression: createSummarizingCompression({ client: summarizer, model: "summary-model", threshold: 1_000, keepRecentMessages: 1 }),
    });

    await agent.run("question");
    expect(agent.lastRequest?.usage?.inputTokens).toBe(5_000);
  });

  it("keeps the run intact when the summary fails", async () => {
    const summarizer = fauxClient({ turns: [{ error: { kind: "network", message: "offline" } }], onExhausted: "repeatLast" });
    const client = fauxClient({ turns: [
      { text: "answer one", usage: usage(5_000) },
      { text: "answer two", usage: usage(10) },
    ] });
    const agent = new Agent({
      system: prompt, client, model: "main",
      contextCompression: createSummarizingCompression({ client: summarizer, model: "summary-model", threshold: 1_000, keepRecentMessages: 1 }),
    });

    await agent.run("first");
    const second = await agent.run("second");
    expect(second.stopReason).toBe("completed");
    expect(agent.messages).toHaveLength(5);
  });

  it("persists the summary through historyFile", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "agent-framework-summary-"));
    const file = join(directory, "history.json");
    try {
      const summarizer = summaryClient("persisted summary");
      const client = fauxClient({ turns: [
        { text: "answer one", usage: usage(5_000) },
        { text: "answer two", usage: usage(10) },
      ] });
      const agent = new Agent({
        system: prompt, client, model: "main", historyFile: file,
        contextCompression: createSummarizingCompression({ client: summarizer, model: "summary-model", threshold: 1_000, keepRecentMessages: 2 }),
      });

      await agent.run("first");
      await agent.run("second");
      const saved = JSON.parse(await readFile(file, "utf8")) as Message[];
      expect(saved.every((message) => message.role !== "system")).toBe(true);
      expect(JSON.stringify(saved)).toContain("persisted summary");

      const reloaded = new Agent({ system: prompt, client, model: "main", historyFile: file });
      expect(JSON.stringify(reloaded.messages)).toContain("persisted summary");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
