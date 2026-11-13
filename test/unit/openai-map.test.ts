import { describe, expect, it } from "vitest";

import { run, textResult, defineTool, type Message, type ToolSpec } from "../../src/index.js";
import { openaiClient } from "../../src/openai.js";
import { mapFinishReason, toOpenAIMessages, toOpenAITools } from "../../src/providers/openai/map.js";

describe("toOpenAIMessages", () => {
  it("keeps a system message first and as a plain string", () => {
    const messages: Message[] = [
      { role: "system", content: [{ type: "text", text: "You are terse." }] },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ];

    expect(toOpenAIMessages(messages)).toEqual([
      { role: "system", content: "You are terse." },
      { role: "user", content: "hi" },
    ]);
  });

  it("concatenates multiple text blocks into one string", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "one " }, { type: "text", text: "two" }] },
    ];

    expect(toOpenAIMessages(messages)[0]).toEqual({ role: "user", content: "one two" });
  });

  it("sends an image as a data URL part alongside text", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
        ],
      },
    ];

    expect(toOpenAIMessages(messages)[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
      ],
    });
  });

  it("drops thinking blocks by default", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "internal reasoning", signature: "sig" },
          { type: "text", text: "the answer" },
        ],
        toolCalls: [],
        stopReason: "stop",
      },
    ];

    const [mapped] = toOpenAIMessages(messages);
    expect(mapped).toEqual({ role: "assistant", content: "the answer" });
    expect(JSON.stringify(mapped)).not.toContain("internal reasoning");
  });

  it("sends thinking blocks back as reasoning_content when asked", () => {
    // DeepSeek's thinking mode: a request carrying `tools` must echo the
    // reasoning of every prior assistant turn, or the API returns 400.
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "I need the date first. " },
          { type: "thinking", text: "Then the weather.", signature: "sig" },
          { type: "text", text: "Let me check." },
        ],
        toolCalls: [{ id: "call_1", name: "get_date", args: {} }],
        stopReason: "toolUse",
      },
      { role: "toolResult", toolCallId: "call_1", toolName: "get_date", content: [{ type: "text", text: "2026-04-19" }], isError: false },
    ];

    const [mapped] = toOpenAIMessages(messages, { reasoningContent: "when-present" });

    expect(mapped).toEqual({
      role: "assistant",
      content: "Let me check.",
      reasoning_content: "I need the date first. Then the weather.",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "get_date", arguments: "{}" } }],
    });
  });

  it("sends an empty reasoning_content for a thinking-free turn when asked to always echo", () => {
    // DeepSeek, measured: a tools-carrying request replaying an assistant tool
    // turn the caller built itself is rejected without the field, and accepts an
    // empty string.
    const messages: Message[] = [
      {
        role: "assistant",
        content: [],
        toolCalls: [{ id: "call_1", name: "read", args: { path: "a.txt" } }],
        stopReason: "toolUse",
      },
    ];

    expect(toOpenAIMessages(messages, { reasoningContent: "always" })[0]).toEqual({
      role: "assistant",
      content: null,
      reasoning_content: "",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } },
      ],
    });
  });

  it("omits reasoning_content when a message has no thinking", () => {
    // A transcript from a provider without thinking must stay wire-identical:
    // an absent field is fine, a blank one is a different request.
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "hi" }], toolCalls: [], stopReason: "stop" },
    ];

    expect(toOpenAIMessages(messages, { reasoningContent: "when-present" })[0]).toEqual({
      role: "assistant",
      content: "hi",
    });
  });

  it("serialises tool calls with arguments as a JSON string", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [],
        toolCalls: [{ id: "call_1", name: "read", args: { path: "a.ts", limit: 5 } }],
        stopReason: "toolUse",
      },
    ];

    expect(toOpenAIMessages(messages)[0]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read", arguments: '{"path":"a.ts","limit":5}' },
        },
      ],
    });
  });

  it("sends an empty object for arguments that never parsed", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [],
        toolCalls: [{ id: "call_1", name: "read", args: undefined }],
        stopReason: "toolUse",
      },
    ];

    const [mapped] = toOpenAIMessages(messages);
    const call = (mapped as { tool_calls: { function: { arguments: string } }[] }).tool_calls[0];
    expect(call?.function.arguments).toBe("{}");
  });

  it("keeps assistant text and tool calls together", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "checking" }],
        toolCalls: [{ id: "c1", name: "read", args: {} }],
        stopReason: "toolUse",
      },
    ];

    const [mapped] = toOpenAIMessages(messages);
    expect(mapped).toMatchObject({ role: "assistant", content: "checking" });
    expect((mapped as { tool_calls: unknown[] }).tool_calls).toHaveLength(1);
  });

  it("maps a tool result to a tool message keyed by call id", () => {
    const messages: Message[] = [
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
        isError: false,
      },
    ];

    expect(toOpenAIMessages(messages)[0]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "file contents",
    });
  });

  it("preserves the full round trip order", () => {
    const messages: Message[] = [
      { role: "system", content: [{ type: "text", text: "sys" }] },
      { role: "user", content: [{ type: "text", text: "q" }] },
      {
        role: "assistant",
        content: [],
        toolCalls: [{ id: "c1", name: "read", args: { path: "a" } }],
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        content: [{ type: "text", text: "data" }],
        isError: false,
      },
    ];

    expect(toOpenAIMessages(messages).map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
  });
});

describe("toOpenAITools", () => {
  it("wraps each tool in the function envelope", () => {
    const tools: ToolSpec[] = [
      {
        name: "read",
        description: "Read a file.",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    ];

    expect(toOpenAITools(tools)).toEqual([
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a file.",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      },
    ]);
  });
});

describe("mapFinishReason", () => {
  it("maps the reasons the core distinguishes", () => {
    expect(mapFinishReason("stop")).toBe("stop");
    expect(mapFinishReason("length")).toBe("length");
    expect(mapFinishReason("tool_calls")).toBe("toolUse");
    expect(mapFinishReason("function_call")).toBe("toolUse");
    expect(mapFinishReason("content_filter")).toBe("contentFilter");
  });

  it("treats a missing reason as a normal stop", () => {
    expect(mapFinishReason(null)).toBe("stop");
    expect(mapFinishReason(undefined)).toBe("stop");
  });

  it("treats an unknown reason as a stop rather than an error", () => {
    // A new provider value should not break a run; the model finished saying
    // what it had to say either way.
    expect(mapFinishReason("some_future_reason")).toBe("stop");
  });
});

// A reminder that the mapping is exercised through the loop as well.
describe("mapping inside a run", () => {
  it("sends a well-formed body for a transcript with a tool result", async () => {
    const bodies: unknown[] = [];
    const encoder = new TextEncoder();

    const fakeFetch: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const sse = [
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n");
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(sse));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    const client = openaiClient({ baseURL: "https://example.test/v1", apiKey: "k", fetch: fakeFetch });
    const tool = defineTool({ name: "read", description: "Read.", parameters: { type: "object", properties: {} }, execute: () => textResult("") });

    const messages: Message[] = [
      { role: "system", content: [{ type: "text", text: "sys" }] },
      { role: "user", content: [{ type: "text", text: "q" }] },
      {
        role: "assistant",
        content: [],
        toolCalls: [{ id: "c1", name: "read", args: {} }],
        stopReason: "toolUse",
      },
      { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "d" }], isError: false },
    ];

    await run({ client, model: "gpt-test", messages, tools: [tool] });

    expect(bodies[0]).toMatchObject({ model: "gpt-test", stream: true });
    expect((bodies[0] as { messages: { role: string }[] }).messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
  });
});
