import { describe, expect, it } from "vitest";

import { openaiClient, parseSSE, run, type Message } from "../../src/index.js";

// ---------------------------------------------------------------------------
// A fake fetch that replays canned SSE bytes, chunked the way a socket arrives.
// ---------------------------------------------------------------------------

interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Split the body across this many enqueues, to exercise buffer boundaries. */
  chunks?: number;
  /** Throw instead of responding, to simulate a transport failure. */
  throws?: Error;
}

function fakeFetch(responses: FakeResponse[], calls: { url: string; body: unknown; headers: Record<string, string> }[]) {
  let index = 0;
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const spec = responses[index];
    index += 1;
    if (spec === undefined) throw new Error("fake fetch ran out of responses");
    if (spec.throws !== undefined) throw spec.throws;

    const body = spec.body ?? "";
    const encoder = new TextEncoder();
    const pieces = spec.chunks === undefined || spec.chunks <= 1 ? [body] : splitInto(body, spec.chunks);

    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const piece of pieces) controller.enqueue(encoder.encode(piece));
          controller.close();
        },
      }),
      { status: spec.status ?? 200, headers: spec.headers ?? { "content-type": "text/event-stream" } },
    );
  }) as unknown as typeof fetch;
  return fn;
}

/** Split a string into n roughly equal pieces, without breaking it. */
function splitInto(text: string, n: number): string[] {
  const size = Math.ceil(text.length / n);
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
  return pieces;
}

/** Build an SSE body from JSON chunks, as a provider would emit them. */
function sse(chunks: unknown[], options: { done?: boolean } = {}): string {
  const lines = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`);
  if (options.done !== false) lines.push("data: [DONE]\n\n");
  return lines.join("");
}

const textChunk = (text: string, finish: string | null = null) => ({
  id: "chatcmpl-1",
  object: "chat.completion.chunk",
  model: "gpt-test",
  choices: [{ index: 0, delta: { content: text }, finish_reason: finish }],
});

/**
 * A tool-call delta.
 *
 * `name` and `arguments` nest under `function`, which is what OpenAI actually
 * sends: `{"index":0,"id":"call_1","type":"function","function":{...}}`.
 */
const toolChunk = (
  index: number,
  fragments: { id?: string; name?: string; arguments?: string },
  finish: string | null = null,
) => {
  const { id, name, arguments: args } = fragments;
  const toolCall: Record<string, unknown> = { index };
  if (id !== undefined) {
    toolCall["id"] = id;
    toolCall["type"] = "function";
  }
  const fn: Record<string, string> = {};
  if (name !== undefined) fn["name"] = name;
  if (args !== undefined) fn["arguments"] = args;
  if (Object.keys(fn).length > 0) toolCall["function"] = fn;

  return { choices: [{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: finish }] };
};

const hello: Message = { role: "user", content: [{ type: "text", text: "hi" }] };

function client(responses: FakeResponse[], calls: Parameters<typeof fakeFetch>[1], extra: Partial<Parameters<typeof openaiClient>[0]> = {}) {
  return openaiClient({
    baseURL: "https://example.test/v1",
    apiKey: "test-key",
    fetch: fakeFetch(responses, calls),
    ...extra,
  });
}

/**
 * The assistant message in a transcript.
 *
 * Not `messages.at(-1)`: when the model calls a tool, the loop appends the tool
 * result after the assistant message in the same turn.
 */
function assistantIn(messages: readonly Message[]) {
  const message = messages.find((m) => m.role === "assistant");
  if (message?.role !== "assistant") throw new Error("no assistant message in the transcript");
  return message;
}

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

describe("request", () => {
  it("posts to /chat/completions with bearer auth and a streaming body", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const c = client([{ body: sse([textChunk("hi", "stop")]) }], calls);

    await run({ client: c, model: "gpt-test", messages: [hello] });

    expect(calls[0]?.url).toBe("https://example.test/v1/chat/completions");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer test-key");
    expect(calls[0]?.body).toMatchObject({ model: "gpt-test", stream: true });
  });

  it("trims a trailing slash from the base URL", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const c = client([{ body: sse([textChunk("hi", "stop")]) }], calls, { baseURL: "https://example.test/v1///" });

    await run({ client: c, model: "m", messages: [hello] });
    expect(calls[0]?.url).toBe("https://example.test/v1/chat/completions");
  });

  it("requests usage by default and can be told not to", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    await run({ client: client([{ body: sse([textChunk("a", "stop")]) }], calls), model: "m", messages: [hello] });
    expect((calls[0]?.body as { stream_options?: unknown } | undefined)?.stream_options).toEqual({
      include_usage: true,
    });

    const calls2: typeof calls = [];
    await run({
      client: client([{ body: sse([textChunk("a", "stop")]) }], calls2, { includeUsage: false }),
      model: "m",
      messages: [hello],
    });
    expect("stream_options" in ((calls2[0]?.body ?? {}) as object)).toBe(false);
  });

  it("omits optional parameters instead of sending undefined", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    await run({ client: client([{ body: sse([textChunk("a", "stop")]) }], calls), model: "m", messages: [hello] });

    const body = calls[0]?.body as Record<string, unknown>;
    expect("max_tokens" in body).toBe(false);
    expect("temperature" in body).toBe(false);
    expect("tools" in body).toBe(false);
  });

  it("forwards max output tokens under the configured field name", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    await run({
      client: client([{ body: sse([textChunk("a", "stop")]) }], calls),
      model: "m",
      messages: [hello],
      maxOutputTokens: 100,
      temperature: 0.3,
    });
    expect(calls[0]?.body).toMatchObject({ max_tokens: 100, temperature: 0.3 });
  });

  it("can send max_completion_tokens for newer models", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    await run({
      client: client([{ body: sse([textChunk("a", "stop")]) }], calls, { maxTokensField: "max_completion_tokens" }),
      model: "m",
      messages: [hello],
      maxOutputTokens: 100,
    });
    expect(calls[0]?.body).toMatchObject({ max_completion_tokens: 100 });
  });

  it("merges providerOptions last so a per-request override wins", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    await run({
      client: client([{ body: sse([textChunk("a", "stop")]) }], calls, { bodyDefaults: { temperature: 0.9 } }),
      model: "m",
      messages: [hello],
      providerOptions: { temperature: 0.1, seed: 7 },
    });
    expect(calls[0]?.body).toMatchObject({ temperature: 0.1, seed: 7 });
  });

  it("rejects a missing base URL at construction", () => {
    expect(() => openaiClient({ baseURL: "  " })).toThrow(/requires a baseURL/);
  });
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

describe("streaming a reply", () => {
  it("assembles text from many chunks", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const c = client(
      [{ body: sse([textChunk("Hello"), textChunk(", "), textChunk("world", "stop")]) }],
      calls,
    );

    const result = await run({ client: c, model: "m", messages: [hello] });

    expect(result.stopReason).toBe("completed");
    expect(result.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Hello, world" }],
      toolCalls: [],
    });
  });

  it("survives a body split across arbitrary byte boundaries", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const body = sse([textChunk("alpha"), textChunk("beta", "stop")]);
    const c = client([{ body, chunks: 7 }], calls);

    const result = await run({ client: c, model: "m", messages: [hello] });
    expect(result.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "alphabeta" }] });
  });

  it("forwards text deltas as they arrive", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const c = client([{ body: sse([textChunk("one"), textChunk("two", "stop")]) }], calls);
    const deltas: string[] = [];

    await run({
      client: c,
      model: "m",
      messages: [hello],
      onEvent: (event) => {
        if (event.type === "text_delta") deltas.push(event.text);
      },
    });

    expect(deltas).toEqual(["one", "two"]);
  });

  it("maps reasoning_content to a thinking block", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const body = sse([
      { choices: [{ index: 0, delta: { reasoning_content: "thinking..." }, finish_reason: null }] },
      textChunk("answer", "stop"),
    ]);
    const c = client([{ body }], calls);

    const result = await run({ client: c, model: "m", messages: [hello] });
    expect(result.messages.at(-1)).toMatchObject({
      content: [
        { type: "thinking", text: "thinking..." },
        { type: "text", text: "answer" },
      ],
    });
  });

  it("accepts a stream with no [DONE] terminator", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const c = client([{ body: sse([textChunk("done implicitly", "stop")], { done: false }) }], calls);

    const result = await run({ client: c, model: "m", messages: [hello] });
    expect(result.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "done implicitly" }] });
  });

  it("reports usage from the final chunk", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const body = sse([
      textChunk("counted", "stop"),
      {
        choices: [],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          total_tokens: 150,
          prompt_tokens_details: { cached_tokens: 100 },
        },
      },
    ]);
    const c = client([{ body }], calls);

    const result = await run({ client: c, model: "m", messages: [hello] });

    expect(result.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      totalTokens: 150,
    });
  });
});

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

describe("streaming tool calls", () => {
  it("assembles one call whose arguments arrive in fragments", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const body = sse([
      toolChunk(0, { id: "call_1", name: "read" }),
      toolChunk(0, { arguments: '{"pa' }),
      toolChunk(0, { arguments: 'th":"a' }),
      toolChunk(0, { arguments: '.ts"}' }, "tool_calls"),
    ]);
    const c = client([{ body }], calls);

    const result = await run({ client: c, model: "m", messages: [hello] });
    const assistant = assistantIn(result.messages);

    expect(assistant).toMatchObject({
      role: "assistant",
      toolCalls: [{ id: "call_1", name: "read", args: { path: "a.ts" } }],
      stopReason: "toolUse",
    });
  });

  it("keeps parallel calls in index order", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    // Interleaved fragments, as some gateways emit them.
    const body = sse([
      toolChunk(0, { id: "c1", name: "read" }),
      toolChunk(1, { id: "c2", name: "bash" }),
      toolChunk(0, { arguments: '{"path":"a"}' }),
      toolChunk(1, { arguments: '{"command":"ls"}' }, "tool_calls"),
    ]);
    const c = client([{ body }], calls);

    const result = await run({ client: c, model: "m", messages: [hello] });
    const assistant = assistantIn(result.messages);

    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.toolCalls.map((call) => call.name)).toEqual(["read", "bash"]);
    expect(assistant.toolCalls.map((call) => call.args)).toEqual([
      { path: "a" },
      { command: "ls" },
    ]);
  });

  it("leaves args undefined when the fragment was truncated", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const body = sse([toolChunk(0, { id: "c1", name: "read", arguments: '{"path":' }, "tool_calls")]);
    const c = client([{ body }], calls);

    const result = await run({ client: c, model: "m", messages: [hello] });
    const assistant = assistantIn(result.messages);

    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.toolCalls[0]?.args).toBeUndefined();
  });

  it("falls back to array position when a gateway omits index", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const body = sse([
      { choices: [{ index: 0, delta: { tool_calls: [{ id: "c1", function: { name: "read", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
    ]);
    const c = client([{ body }], calls);

    const result = await run({ client: c, model: "m", messages: [hello] });
    const assistant = assistantIn(result.messages);

    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.toolCalls).toEqual([{ id: "c1", name: "read", args: {} }]);
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe("errors", () => {
  it("maps 401 to auth and does not retry", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const c = client(
      [{ status: 401, body: JSON.stringify({ error: { message: "invalid api key" } }) }],
      calls,
      { maxRetries: 3 },
    );

    const result = await run({ client: c, model: "m", messages: [hello] });

    expect(result.stopReason).toBe("error");
    expect(result.error?.kind).toBe("auth");
    expect(result.error?.message).toContain("invalid api key");
    expect(calls).toHaveLength(1);
  });

  it("maps 429 to rateLimit with retry-after seconds", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const c = client(
      [{ status: 429, headers: { "retry-after": "7" }, body: JSON.stringify({ error: { message: "slow down" } }) }],
      calls,
    );

    const result = await run({ client: c, model: "m", messages: [hello] });

    expect(result.error?.kind).toBe("rateLimit");
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.retryAfterSeconds).toBe(7);
  });

  it("retries a 429 and succeeds on the second attempt", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const c = client(
      [
        { status: 429, headers: { "retry-after": "0" }, body: "{}" },
        { body: sse([textChunk("finally", "stop")]) },
      ],
      calls,
      { maxRetries: 2, retryBaseMs: 1 },
    );

    const result = await run({ client: c, model: "m", messages: [hello] });

    expect(result.stopReason).toBe("completed");
    expect(calls).toHaveLength(2);
    expect(c.callCount).toBe(2);
  });

  it("stops retrying once the budget is spent", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const c = client(
      [
        { status: 503, body: "{}" },
        { status: 503, body: "{}" },
        { status: 503, body: "{}" },
      ],
      calls,
      { maxRetries: 1, retryBaseMs: 1 },
    );

    const result = await run({ client: c, model: "m", messages: [hello] });

    expect(result.error?.kind).toBe("overloaded");
    expect(calls).toHaveLength(2);
  });

  it("does not retry a 400", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const c = client([{ status: 400, body: JSON.stringify({ error: { message: "bad model" } }) }], calls, {
      maxRetries: 3,
    });

    const result = await run({ client: c, model: "m", messages: [hello] });

    expect(result.error?.kind).toBe("invalidRequest");
    expect(calls).toHaveLength(1);
  });

  it("does not retry after it has already streamed output", async () => {
    // A failure mid-stream cannot be replayed without duplicating the text the
    // consumer has already seen.
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const encoder = new TextEncoder();
    const fake: typeof fetch = async (_url, init) => {
      calls.push({ url: String(_url), body: JSON.parse(String(init?.body)), headers: {} });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(textChunk("partial"))}\n\n`));
            // Then the connection dies mid-stream. Deferred by a tick because a
            // stream that errors immediately discards its queued chunks, and the
            // point here is that the consumer already saw one.
            setTimeout(() => controller.error(new TypeError("socket hang up")), 1);
          },
        }),
        { status: 200 },
      );
    };
    const c = openaiClient({ baseURL: "https://example.test/v1", apiKey: "k", fetch: fake, maxRetries: 3, retryBaseMs: 1 });

    const result = await run({ client: c, model: "m", messages: [hello] });

    expect(result.stopReason).toBe("error");
    expect(calls).toHaveLength(1);
  });

  it("maps a transport TypeError to network", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const c = client([{ throws: new TypeError("fetch failed") }], calls);

    const result = await run({ client: c, model: "m", messages: [hello] });

    expect(result.error?.kind).toBe("network");
    expect(result.error?.retryable).toBe(true);
  });

  it("maps 413 to contextOverflow", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const c = client([{ status: 413, body: "{}" }], calls);

    const result = await run({ client: c, model: "m", messages: [hello] });
    expect(result.error?.kind).toBe("contextOverflow");
  });

  it("surfaces an error object delivered inside a 200 stream", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const c = client([{ body: sse([{ error: { message: "upstream overloaded" } }], { done: false }) }], calls);

    const result = await run({ client: c, model: "m", messages: [hello] });

    expect(result.stopReason).toBe("error");
    expect(result.error?.message).toContain("upstream overloaded");
  });

  it("reports unparseable stream data as a provider error", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const c = client([{ body: "data: {not json}\n\n" }], calls);

    const result = await run({ client: c, model: "m", messages: [hello] });

    expect(result.error?.kind).toBe("provider");
    expect(result.error?.message).toContain("could not parse");
  });

  it("treats an abort as aborted, not as a failure", async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const fake: typeof fetch = async (_url) => {
      calls.push({ url: String(_url), body: {}, headers: {} });
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller2) {
            controller2.enqueue(encoder.encode(`data: ${JSON.stringify(textChunk("first"))}\n\n`));
            await new Promise((resolve) => setTimeout(resolve, 20));
            controller2.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
          },
        }),
        { status: 200 },
      );
    };

    const c = openaiClient({ baseURL: "https://example.test/v1", apiKey: "k", fetch: fake });
    setTimeout(() => controller.abort(), 5);

    const result = await run({ client: c, model: "m", messages: [hello], signal: controller.signal });

    expect(result.stopReason).toBe("aborted");
    expect(result.error?.kind).toBe("aborted");
  });
});

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

describe("parseSSE", () => {
  async function parse(body: string, chunkSize = body.length): Promise<string[]> {
    const encoder = new TextEncoder();
    const pieces: string[] = [];
    for (let i = 0; i < body.length; i += chunkSize) pieces.push(body.slice(i, i + chunkSize));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(encoder.encode(piece));
        controller.close();
      },
    });
    const out: string[] = [];
    for await (const message of parseSSE(stream)) out.push(message.data);
    return out;
  }

  it("splits events on blank lines", async () => {
    expect(await parse("data: a\n\ndata: b\n\n")).toEqual(["a", "b"]);
  });

  it("joins multi-line data fields", async () => {
    expect(await parse("data: one\ndata: two\n\n")).toEqual(["one\ntwo"]);
  });

  it("skips comment lines", async () => {
    expect(await parse(":keep-alive\n\ndata: real\n\n")).toEqual(["real"]);
  });

  it("handles CRLF line endings", async () => {
    expect(await parse("data: a\r\n\r\ndata: b\r\n\r\n")).toEqual(["a", "b"]);
  });

  it("emits a final event with no trailing newline", async () => {
    expect(await parse("data: last")).toEqual(["last"]);
  });

  it("is indifferent to how the bytes were chopped up", async () => {
    const body = "data: first\n\ndata: second\n\n";
    expect(await parse(body, 1)).toEqual(["first", "second"]);
    expect(await parse(body, 3)).toEqual(["first", "second"]);
  });

  it("keeps an event name when one is present", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: chunk\ndata: x\n\n"));
        controller.close();
      },
    });
    const events = [];
    for await (const message of parseSSE(stream)) events.push(message);
    expect(events[0]).toEqual({ data: "x", event: "chunk" });
  });
});
