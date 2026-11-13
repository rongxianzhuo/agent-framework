import { describe, expect, it } from "vitest";

import {
  defineTool,
  run,
  textResult,
  type AgentEvent,
  type LLMRequest,
  type Message,
} from "../../src/index.js";
import { fauxClient } from "../../src/faux.js";

const hello: Message = { role: "user", content: [{ type: "text", text: "hi" }] };

const echo = defineTool<{ text: string }>({
  name: "echo",
  description: "Echo text back.",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  execute: (args) => textResult(`echoed: ${args.text}`),
});

function lastUserText(request: LLMRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const message = request.messages[i];
    if (message?.role !== "user") continue;
    return message.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
  }
  return "";
}

describe("fauxClient", () => {
  it("answers a fixed script turn by turn", async () => {
    const client = fauxClient({
      turns: [
        { toolCalls: [{ id: "c1", name: "echo", args: { text: "a" } }] },
        { text: "finished" },
      ],
    });

    const result = await run({ client, model: "faux-1", messages: [hello], tools: [echo] });

    expect(result.stopReason).toBe("completed");
    expect(result.turns).toBe(2);
    expect(client.requests).toHaveLength(2);
  });

  it("streams text in the requested chunk size", async () => {
    const client = fauxClient({ turns: [{ text: "abcdefghij" }], chunkSize: 3 });
    const deltas: string[] = [];

    await run({
      client,
      model: "m",
      messages: [hello],
      onEvent: (event: AgentEvent) => {
        if (event.type === "text_delta") deltas.push(event.text);
      },
    });

    expect(deltas).toEqual(["abc", "def", "ghi", "j"]);
  });

  it("never splits a surrogate pair", async () => {
    const client = fauxClient({ turns: [{ text: "🚀🚀🚀" }], chunkSize: 1 });
    const deltas: string[] = [];

    await run({
      client,
      model: "m",
      messages: [hello],
      onEvent: (event: AgentEvent) => {
        if (event.type === "text_delta") deltas.push(event.text);
      },
    });

    expect(deltas).toEqual(["🚀", "🚀", "🚀"]);
    expect(deltas.join("")).toBe("🚀🚀🚀");
  });

  it("streams tool arguments as fragments that the accumulator reassembles", async () => {
    const client = fauxClient({
      turns: [
        { toolCalls: [{ id: "c1", name: "echo", args: { text: "a long value to split up" } }] },
        { text: "done" },
      ],
      chunkSize: 4,
    });

    const result = await run({ client, model: "m", messages: [hello], tools: [echo] });
    const assistant = result.messages[1];

    expect(assistant?.role).toBe("assistant");
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.toolCalls[0]?.args).toEqual({ text: "a long value to split up" });
  });

  it("emits thinking before text", async () => {
    const client = fauxClient({ turns: [{ thinking: "let me think", text: "answer" }] });

    const result = await run({ client, model: "m", messages: [hello] });
    const assistant = result.messages[1];

    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.content).toEqual([
      { type: "thinking", text: "let me think" },
      { type: "text", text: "answer" },
    ]);
  });

  it("defers to an explicit stop reason", async () => {
    const client = fauxClient({ turns: [{ text: "cut off", stopReason: "length" }] });

    const result = await run({ client, model: "m", messages: [hello] });
    const assistant = result.messages[1];

    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.stopReason).toBe("length");
  });

  it("reports an error turn as an error event", async () => {
    const client = fauxClient({ turns: [{ error: { kind: "rateLimit", message: "slow down" } }] });

    const result = await run({ client, model: "m", messages: [hello] });

    expect(result.stopReason).toBe("error");
    expect(result.error?.kind).toBe("rateLimit");
  });

  it("reports an exhausted script instead of hanging", async () => {
    const client = fauxClient({ turns: [{ text: "only one" }] });

    await run({ client, model: "m", messages: [hello] });
    const second = await run({ client, model: "m", messages: [hello] });

    expect(second.stopReason).toBe("error");
    expect(second.error?.message).toContain("no scripted response for turn 2");
  });

  it("can repeat the last turn forever", async () => {
    const client = fauxClient({
      turns: [{ toolCalls: [{ id: "c1", name: "echo", args: { text: "again" } }] }],
      onExhausted: "repeatLast",
    });

    const result = await run({ client, model: "m", messages: [hello], tools: [echo], maxTurns: 3 });

    expect(result.stopReason).toBe("maxTurns");
    expect(result.turns).toBe(3);
  });

  it("supports a request-driven script", async () => {
    const client = fauxClient({
      turns: (request) => (lastUserText(request).includes("tools") ? { text: "I have tools" } : { text: "plain" }),
    });

    const first = await run({ client, model: "m", messages: [hello] });
    const second = await run({
      client,
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "what tools?" }] }],
    });

    expect(first.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "plain" }] });
    expect(second.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "I have tools" }] });
  });

  it("estimates usage from the transcript when none is given", async () => {
    const client = fauxClient({ turns: [{ text: "four four four four" }] });
    const result = await run({ client, model: "m", messages: [hello] });

    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.usage.totalTokens).toBeGreaterThanOrEqual(result.usage.inputTokens);
  });

  it("honours explicit usage verbatim", async () => {
    const client = fauxClient({
      turns: [{ text: "x", usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 1, totalTokens: 15 } }],
    });

    const result = await run({ client, model: "m", messages: [hello] });
    expect(result.usage).toEqual({
      inputTokens: 7,
      outputTokens: 2,
      cacheReadTokens: 5,
      cacheWriteTokens: 1,
      totalTokens: 15,
    });
  });

  it("stamps the model and provider on each message", async () => {
    const client = fauxClient({ turns: [{ text: "x" }], name: "my-faux" });
    const result = await run({ client, model: "faux-model", messages: [hello] });
    const assistant = result.messages[1];

    expect(assistant).toMatchObject({ model: "faux-model", provider: "my-faux" });
  });

  it("can be rewound with reset()", async () => {
    const client = fauxClient({ turns: [{ text: "one" }] });

    await run({ client, model: "m", messages: [hello] });
    expect(client.requests).toHaveLength(1);

    client.reset();
    expect(client.requests).toHaveLength(0);

    const result = await run({ client, model: "m", messages: [hello] });
    expect(result.stopReason).toBe("completed");
  });

  it("stops before responding when the run is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = fauxClient({ turns: [{ text: "never" }] });

    const result = await run({ client, model: "m", messages: [hello], signal: controller.signal });
    expect(result.stopReason).toBe("aborted");
  });

  it("does not see later messages in an earlier request", async () => {
    const client = fauxClient({
      turns: [{ toolCalls: [{ id: "c1", name: "echo", args: { text: "x" } }] }, { text: "done" }],
    });

    await run({ client, model: "m", messages: [hello], tools: [echo] });

    expect(client.requests[0]?.messages).toHaveLength(1);
    expect(client.requests[1]?.messages).toHaveLength(3);
  });
});
