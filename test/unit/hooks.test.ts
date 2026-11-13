import { describe, expect, it } from "vitest";

import {
  defineTool,
  describeTranscriptProblems,
  findTranscriptProblems,
  hasHooks,
  resolveHooks,
  run,
  textResult,
  type AgentEvent,
  type LLMRequest,
  type Message,
  type RunHooks,
} from "../../src/index.js";
import { fauxClient } from "../../src/faux.js";

const hello: Message = { role: "user", content: [{ type: "text", text: "hi" }] };

const echo = defineTool<{ text: string }>({
  name: "echo",
  description: "Echo text back.",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  execute: (args) => textResult(`echoed: ${args.text}`),
});

const toolCallTurn = { toolCalls: [{ id: "c1", name: "echo", args: { text: "a" } }] };

// ---------------------------------------------------------------------------
// onBeforeRequest
// ---------------------------------------------------------------------------

describe("onBeforeRequest", () => {
  it("can drop messages before they are sent", async () => {
    const client = fauxClient({ turns: [{ text: "ok" }] });
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "old question" }] },
      { role: "assistant", content: [{ type: "text", text: "old answer" }], toolCalls: [], stopReason: "stop" },
      { role: "user", content: [{ type: "text", text: "new question" }] },
    ];

    await run({
      client,
      model: "m",
      messages: history,
      hooks: { onBeforeRequest: ({ request }) => ({ ...request, messages: request.messages.slice(-1) }) },
    });

    expect(client.requests[0]?.messages).toHaveLength(1);
    expect(client.requests[0]?.messages[0]).toMatchObject({ role: "user" });
  });

  it("leaves the request alone when it returns nothing", async () => {
    const client = fauxClient({ turns: [{ text: "ok" }] });
    let seen: LLMRequest | undefined;

    await run({
      client,
      model: "m",
      messages: [hello],
      hooks: {
        onBeforeRequest: ({ request }) => {
          seen = request;
        },
      },
    });

    expect(client.requests[0]).toBe(seen);
  });

  it("receives the turn number", async () => {
    const client = fauxClient({ turns: [toolCallTurn, { text: "done" }] });
    const turns: number[] = [];

    await run({
      client,
      model: "m",
      messages: [hello],
      tools: [echo],
      hooks: {
        onBeforeRequest: ({ turn }) => {
          turns.push(turn);
        },
      },
    });

    expect(turns).toEqual([1, 2]);
  });

  it("can change the model and sampling parameters", async () => {
    const client = fauxClient({ turns: [{ text: "ok" }] });

    const result = await run({
      client,
      model: "cheap-model",
      messages: [hello],
      hooks: { onBeforeRequest: ({ request }) => ({ ...request, model: "expensive-model" }) },
    });

    expect(client.requests[0]?.model).toBe("expensive-model");
    // The message records the model that actually answered.
    expect(result.messages.at(-1)).toMatchObject({ model: "expensive-model" });
  });

  it("can inject a reminder without losing the transcript", async () => {
    const client = fauxClient({ turns: [{ text: "ok" }] });

    await run({
      client,
      model: "m",
      messages: [hello],
      hooks: {
        onBeforeRequest: ({ request }) => ({
          ...request,
          messages: [
            { role: "system", content: [{ type: "text", text: "Stay in scope." }] },
            ...request.messages,
          ],
        }),
      },
    });

    expect(client.requests[0]?.messages.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("chains: the second hook sees the first one's output", async () => {
    const client = fauxClient({ turns: [{ text: "ok" }] });
    const order: string[] = [];

    await run({
      client,
      model: "m",
      messages: [hello],
      hooks: {
        onBeforeRequest: [
          ({ request }) => {
            order.push("first");
            return { ...request, messages: [...request.messages, ...request.messages] };
          },
          ({ request }) => {
            order.push("second");
            expect(request.messages).toHaveLength(2);
          },
        ],
      },
    });

    expect(order).toEqual(["first", "second"]);
    expect(client.requests[0]?.messages).toHaveLength(2);
  });

  it("supports an async hook", async () => {
    const client = fauxClient({ turns: [{ text: "ok" }] });

    await run({
      client,
      model: "m",
      messages: [hello],
      hooks: {
        onBeforeRequest: async ({ request }) => {
          await Promise.resolve();
          return { ...request, temperature: 0.5 };
        },
      },
    });

    expect(client.requests[0]?.temperature).toBe(0.5);
  });

  it("does not mutate the caller's messages", async () => {
    const client = fauxClient({ turns: [{ text: "ok" }] });
    const messages: Message[] = [hello];

    await run({
      client,
      model: "m",
      messages,
      hooks: {
        onBeforeRequest: ({ request }) => {
          (request.messages as Message[]).push({ role: "user", content: [{ type: "text", text: "sneaky" }] });
        },
      },
    });

    expect(messages).toHaveLength(1);
  });

  it("fails the run when the hook throws", async () => {
    const client = fauxClient({ turns: [{ text: "ok" }] });

    const result = await run({
      client,
      model: "m",
      messages: [hello],
      hooks: {
        onBeforeRequest: () => {
          throw new Error("trimming broke");
        },
      },
    });

    expect(result.stopReason).toBe("error");
    expect(result.error?.kind).toBe("hook");
    expect(result.error?.message).toContain("trimming broke");
    expect(result.error?.retryable).toBe(false);
    // The model was never called.
    expect(client.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// onToolCall
// ---------------------------------------------------------------------------

describe("onToolCall", () => {
  it("denies a call and reports the reason to the model", async () => {
    const client = fauxClient({ turns: [toolCallTurn, { text: "understood" }] });
    let executed = false;
    const guarded = defineTool<{ text: string }>({
      name: "echo",
      description: "Echo text back.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      execute: (args) => {
        executed = true;
        return textResult(`echoed: ${args.text}`);
      },
    });

    const result = await run({
      client,
      model: "m",
      messages: [hello],
      tools: [guarded],
      hooks: { onToolCall: () => ({ deny: "Permission denied: echo is disabled for this run." }) },
    });

    expect(executed).toBe(false);
    expect(result.stopReason).toBe("completed");

    const toolResult = result.messages.find((m) => m.role === "toolResult");
    expect(toolResult).toMatchObject({ isError: true, toolName: "echo" });
    if (toolResult?.role !== "toolResult") throw new Error("expected a tool result");
    expect(toolResult.content[0]).toMatchObject({ text: "Permission denied: echo is disabled for this run." });

    // The model still gets a second turn to react to the refusal.
    expect(client.requests).toHaveLength(2);
  });

  it("does not attach an error to a denial", async () => {
    // A refusal is a decision, not a fault: it should not surface as a failure
    // event that a caller would log as a bug.
    const client = fauxClient({ turns: [toolCallTurn, { text: "ok" }] });
    const errors: AgentEvent[] = [];

    await run({
      client,
      model: "m",
      messages: [hello],
      tools: [echo],
      hooks: { onToolCall: () => ({ deny: "no" }) },
      onEvent: (event) => {
        if (event.type === "error") errors.push(event);
      },
    });

    expect(errors).toEqual([]);
  });

  it("keeps the whole run going after a denial", async () => {
    const client = fauxClient({
      turns: [{ toolCalls: [{ id: "c1", name: "echo", args: { text: "a" } }] }, { text: "I could not do that." }],
    });

    const result = await run({
      client,
      model: "m",
      messages: [hello],
      tools: [echo],
      hooks: { onToolCall: () => ({ deny: "denied" }) },
    });

    expect(result.stopReason).toBe("completed");
    expect(result.turns).toBe(2);
    expect(result.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "I could not do that." }] });
  });

  it("can answer from a cached result instead of running the tool", async () => {
    const client = fauxClient({ turns: [toolCallTurn, { text: "done" }] });
    let executed = false;
    const slow = defineTool<{ text: string }>({
      name: "echo",
      description: "Echo text back.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      execute: () => {
        executed = true;
        return textResult("slow");
      },
    });

    const result = await run({
      client,
      model: "m",
      messages: [hello],
      tools: [slow],
      hooks: { onToolCall: () => ({ result: textResult("from cache", { cached: true }) }) },
    });

    expect(executed).toBe(false);
    const toolResult = result.messages.find((m) => m.role === "toolResult");
    if (toolResult?.role !== "toolResult") throw new Error("expected a tool result");
    expect(toolResult.content[0]).toMatchObject({ text: "from cache" });
    expect(toolResult.isError).toBe(false);
    expect(toolResult.details).toEqual({ cached: true });
  });

  it("sees the parsed arguments and the tool definition", async () => {
    const client = fauxClient({ turns: [toolCallTurn, { text: "done" }] });
    let seenName: string | undefined;
    let seenArgs: unknown;
    let seenDescription: string | undefined;

    await run({
      client,
      model: "m",
      messages: [hello],
      tools: [echo],
      hooks: {
        onToolCall: ({ call, tool }) => {
          seenName = call.name;
          seenArgs = call.args;
          seenDescription = tool?.description;
        },
      },
    });

    expect(seenName).toBe("echo");
    expect(seenArgs).toEqual({ text: "a" });
    expect(seenDescription).toBe("Echo text back.");
  });

  it("passes undefined for a tool the model invented", async () => {
    const client = fauxClient({
      turns: [{ toolCalls: [{ id: "c1", name: "no_such_tool", args: {} }] }, { text: "sorry" }],
    });
    let sawTool: unknown = "not called";

    const result = await run({
      client,
      model: "m",
      messages: [hello],
      tools: [echo],
      hooks: {
        onToolCall: ({ tool }) => {
          sawTool = tool;
        },
      },
    });

    expect(sawTool).toBeUndefined();
    // With no opinion from the hook, the unknown tool still produces an error
    // result the model can read.
    const toolResult = result.messages.find((m) => m.role === "toolResult");
    expect(toolResult).toMatchObject({ isError: true });
  });

  it("first decision wins: a later allow cannot undo a denial", async () => {
    const client = fauxClient({ turns: [toolCallTurn, { text: "ok" }] });
    const calls: string[] = [];

    await run({
      client,
      model: "m",
      messages: [hello],
      tools: [echo],
      hooks: {
        onToolCall: [
          () => {
            calls.push("deny");
            return { deny: "denied by the first hook" };
          },
          () => {
            calls.push("second");
          },
        ],
      },
    });

    expect(calls).toEqual(["deny"]);
  });

  it("later hooks run when earlier ones have no opinion", async () => {
    const client = fauxClient({ turns: [toolCallTurn, { text: "ok" }] });
    const calls: string[] = [];

    await run({
      client,
      model: "m",
      messages: [hello],
      tools: [echo],
      hooks: {
        onToolCall: [
          () => {
            calls.push("first");
          },
          () => {
            calls.push("second");
            return { deny: "denied by the second hook" };
          },
        ],
      },
    });

    expect(calls).toEqual(["first", "second"]);
  });

  it("runs once per call in a parallel batch", async () => {
    const client = fauxClient({
      turns: [
        {
          toolCalls: [
            { id: "c1", name: "echo", args: { text: "a" } },
            { id: "c2", name: "echo", args: { text: "b" } },
          ],
        },
        { text: "done" },
      ],
    });
    const ids: string[] = [];

    await run({
      client,
      model: "m",
      messages: [hello],
      tools: [echo],
      hooks: {
        onToolCall: ({ call }) => {
          ids.push(call.id);
        },
      },
    });

    expect(ids.sort()).toEqual(["c1", "c2"]);
  });

  it("fails the run when the hook throws, rather than allowing the call", async () => {
    const client = fauxClient({ turns: [toolCallTurn, { text: "should not get here" }] });
    let executed = false;
    const guarded = defineTool<{ text: string }>({
      name: "echo",
      description: "Echo text back.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      execute: () => {
        executed = true;
        return textResult("ran");
      },
    });

    const result = await run({
      client,
      model: "m",
      messages: [hello],
      tools: [guarded],
      hooks: {
        onToolCall: () => {
          throw new Error("permission service unreachable");
        },
      },
    });

    expect(executed, "a crashing guard must not let the tool run").toBe(false);
    expect(result.stopReason).toBe("error");
    expect(result.error?.kind).toBe("hook");
    expect(result.error?.message).toContain("permission service unreachable");
  });
});

// ---------------------------------------------------------------------------
// onToolResult
// ---------------------------------------------------------------------------

describe("onToolResult", () => {
  it("can shorten what the model sees", async () => {
    const client = fauxClient({ turns: [toolCallTurn, { text: "done" }] });
    const verbose = defineTool<{ text: string }>({
      name: "echo",
      description: "Echo text back.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      execute: () => textResult("x".repeat(5_000)),
    });

    const result = await run({
      client,
      model: "m",
      messages: [hello],
      tools: [verbose],
      hooks: {
        onToolResult: ({ result: r }) => ({
          content: [{ type: "text", text: "truncated to 10 chars: xxxxxxxxxx" }],
          isError: r.isError ?? false,
        }),
      },
    });

    const toolResult = result.messages.find((m) => m.role === "toolResult");
    if (toolResult?.role !== "toolResult") throw new Error("expected a tool result");
    expect(toolResult.content[0]).toMatchObject({ text: "truncated to 10 chars: xxxxxxxxxx" });
  });

  it("keeps details unless the hook replaces them", async () => {
    const client = fauxClient({ turns: [toolCallTurn, { text: "done" }] });
    const withDetails = defineTool<{ text: string }>({
      name: "echo",
      description: "Echo text back.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      execute: () => textResult("done", { rows: 3 }),
    });

    const result = await run({
      client,
      model: "m",
      messages: [hello],
      tools: [withDetails],
      hooks: { onToolResult: ({ result: r }) => ({ ...r, content: [{ type: "text", text: "rewritten" }] }) },
    });

    const toolResult = result.messages.find((m) => m.role === "toolResult");
    expect(toolResult).toMatchObject({ details: { rows: 3 } });
  });

  it("sees the error for a failed tool", async () => {
    const client = fauxClient({ turns: [toolCallTurn, { text: "done" }] });
    const failing = defineTool<{ text: string }>({
      name: "echo",
      description: "Echo text back.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      execute: () => {
        throw new Error("disk on fire");
      },
    });
    let seenError: string | undefined;
    let seenIsError: boolean | undefined;

    await run({
      client,
      model: "m",
      messages: [hello],
      tools: [failing],
      hooks: {
        onToolResult: ({ error, result }) => {
          seenError = error?.kind;
          seenIsError = result.isError;
        },
      },
    });

    expect(seenError).toBe("toolFailed");
    expect(seenIsError).toBe(true);
  });

  it("also sees arguments-invalid results", async () => {
    const client = fauxClient({
      turns: [{ toolCalls: [{ id: "c1", name: "echo", args: { text: 42 } }] }, { text: "done" }],
    });
    let seenKind: string | undefined;

    await run({
      client,
      model: "m",
      messages: [hello],
      tools: [echo],
      hooks: {
        onToolResult: ({ error }) => {
          seenKind = error?.kind;
        },
      },
    });

    expect(seenKind).toBe("invalidToolCall");
  });

  it("does not run for a denied call's own execution, only for the denial result", async () => {
    const client = fauxClient({ turns: [toolCallTurn, { text: "ok" }] });
    const seen: string[] = [];

    await run({
      client,
      model: "m",
      messages: [hello],
      tools: [echo],
      hooks: {
        onToolCall: () => ({ deny: "no" }),
        onToolResult: ({ result }) => {
          seen.push(result.isError ? "error result" : "ok result");
        },
      },
    });

    expect(seen).toEqual(["error result"]);
  });

  it("chains in order", async () => {
    const client = fauxClient({ turns: [toolCallTurn, { text: "done" }] });
    const steps: string[] = [];

    await run({
      client,
      model: "m",
      messages: [hello],
      tools: [echo],
      hooks: {
        onToolResult: [
          ({ result }) => {
            steps.push("first");
            return { ...result, content: [{ type: "text", text: "first pass" }] };
          },
          ({ result }) => {
            steps.push(`second saw: ${result.content[0]?.type === "text" ? result.content[0].text : "?"}`);
          },
        ],
      },
    });

    expect(steps).toEqual(["first", "second saw: first pass"]);
  });

  it("honours in-place mutation as well as a returned object", async () => {
    const client = fauxClient({ turns: [toolCallTurn, { text: "done" }] });

    const result = await run({
      client,
      model: "m",
      messages: [hello],
      tools: [echo],
      hooks: {
        onToolResult: ({ result: r }) => {
          r.content = [{ type: "text", text: "mutated in place" }];
        },
      },
    });

    const toolResult = result.messages.find((m) => m.role === "toolResult");
    if (toolResult?.role !== "toolResult") throw new Error("expected a tool result");
    expect(toolResult.content[0]).toMatchObject({ text: "mutated in place" });
  });

  it("fails the run when the hook throws", async () => {
    const client = fauxClient({ turns: [toolCallTurn, { text: "done" }] });

    const result = await run({
      client,
      model: "m",
      messages: [hello],
      tools: [echo],
      hooks: {
        onToolResult: () => {
          throw new Error("redaction failed");
        },
      },
    });

    expect(result.stopReason).toBe("error");
    expect(result.error?.kind).toBe("hook");
  });
});

// ---------------------------------------------------------------------------
// The sequential path
// ---------------------------------------------------------------------------

describe("hooks with parallelTools: false", () => {
  it("still applies every hook, in call order", async () => {
    const client = fauxClient({
      turns: [
        {
          toolCalls: [
            { id: "c1", name: "echo", args: { text: "a" } },
            { id: "c2", name: "echo", args: { text: "b" } },
          ],
        },
        { text: "done" },
      ],
    });
    const log: string[] = [];

    const result = await run({
      client,
      model: "m",
      messages: [hello],
      tools: [echo],
      parallelTools: false,
      hooks: {
        onToolCall: ({ call }) => {
          log.push(`call:${call.id}`);
        },
        onToolResult: ({ call }) => {
          log.push(`result:${call.id}`);
        },
      },
    });

    expect(log).toEqual(["call:c1", "result:c1", "call:c2", "result:c2"]);
    expect(result.stopReason).toBe("completed");
  });

  it("denies a call in the sequential path too", async () => {
    const client = fauxClient({ turns: [toolCallTurn, { text: "ok" }] });

    const result = await run({
      client,
      model: "m",
      messages: [hello],
      tools: [echo],
      parallelTools: false,
      hooks: { onToolCall: () => ({ deny: "nope" }) },
    });

    const toolResult = result.messages.find((m) => m.role === "toolResult");
    expect(toolResult).toMatchObject({ isError: true });
  });
});

// ---------------------------------------------------------------------------
// Composition and absence
// ---------------------------------------------------------------------------

describe("hooks in general", () => {
  it("changes nothing when no hooks are given", async () => {
    const withHooks = fauxClient({ turns: [toolCallTurn, { text: "done" }] });
    const withoutHooks = fauxClient({ turns: [toolCallTurn, { text: "done" }] });

    const a = await run({ client: withHooks, model: "m", messages: [hello], tools: [echo], hooks: {} });
    const b = await run({ client: withoutHooks, model: "m", messages: [hello], tools: [echo] });

    expect(a.messages).toEqual(b.messages);
    expect(a.stopReason).toBe(b.stopReason);
    expect(a.turns).toBe(b.turns);
  });

  it("combines all three hooks in one run", async () => {
    const client = fauxClient({ turns: [toolCallTurn, { text: "final" }] });
    const log: string[] = [];

    const result = await run({
      client,
      model: "m",
      messages: [hello],
      tools: [echo],
      hooks: {
        onBeforeRequest: ({ turn }) => {
          log.push(`before:${turn}`);
        },
        onToolCall: ({ call }) => {
          log.push(`call:${call.name}`);
        },
        onToolResult: ({ call }) => {
          log.push(`result:${call.name}`);
        },
      },
    });

    expect(result.stopReason).toBe("completed");
    expect(log).toEqual(["before:1", "call:echo", "result:echo", "before:2"]);
  });

  it("reports whether any hook is configured", () => {
    expect(hasHooks(undefined)).toBe(false);
    expect(hasHooks({})).toBe(false);
    expect(hasHooks({ onToolCall: () => undefined })).toBe(true);
  });

  it("exposes a resolver that can be driven directly", async () => {
    const hooks: RunHooks = { onBeforeRequest: ({ request }) => ({ ...request, temperature: 0.2 }) };
    const resolved = resolveHooks(hooks);
    const base: LLMRequest = { model: "m", messages: [hello], tools: [] };

    const out = await resolved.beforeRequest({ turn: 1, request: base, signal: undefined });

    expect(out.temperature).toBe(0.2);
    expect(out.messages).toEqual([hello]);
  });
});

// ---------------------------------------------------------------------------
// Transcript validation
// ---------------------------------------------------------------------------

describe("transcript validation", () => {
  it("accepts a transcript whose tool calls are all answered", () => {
    const messages: Message[] = [
      hello,
      { role: "assistant", content: [], toolCalls: [{ id: "c1", name: "echo", args: {} }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "c1", toolName: "echo", content: [{ type: "text", text: "ok" }], isError: false },
    ];

    expect(findTranscriptProblems(messages)).toEqual([]);
  });

  it("finds a tool call with no result", () => {
    const messages: Message[] = [
      hello,
      { role: "assistant", content: [], toolCalls: [{ id: "c1", name: "echo", args: {} }], stopReason: "toolUse" },
    ];

    expect(findTranscriptProblems(messages)).toEqual([{ kind: "unanswered", index: 1, callId: "c1" }]);
  });

  it("finds a result whose call was trimmed away", () => {
    const messages: Message[] = [
      hello,
      { role: "toolResult", toolCallId: "gone", toolName: "echo", content: [{ type: "text", text: "ok" }], isError: false },
    ];

    expect(findTranscriptProblems(messages)).toEqual([{ kind: "orphan", index: 1, callId: "gone" }]);
  });

  it("catches a partially answered parallel batch", () => {
    const messages: Message[] = [
      hello,
      {
        role: "assistant",
        content: [],
        toolCalls: [
          { id: "c1", name: "echo", args: {} },
          { id: "c2", name: "echo", args: {} },
        ],
        stopReason: "toolUse",
      },
      { role: "toolResult", toolCallId: "c1", toolName: "echo", content: [{ type: "text", text: "ok" }], isError: false },
    ];

    expect(findTranscriptProblems(messages)).toEqual([{ kind: "unanswered", index: 1, callId: "c2" }]);
  });

  it("describes the problem with message indices", () => {
    const text = describeTranscriptProblems([{ kind: "unanswered", index: 4, callId: "call_abc" }]);
    expect(text).toContain("message 4");
    expect(text).toContain("call_abc");
  });

  it("stops a run whose trimming broke a pairing, before the provider sees it", async () => {
    const client = fauxClient({ turns: [{ text: "never asked" }] });

    const result = await run({
      client,
      model: "m",
      messages: [
        hello,
        { role: "assistant", content: [], toolCalls: [{ id: "c1", name: "echo", args: {} }], stopReason: "toolUse" },
        { role: "toolResult", toolCallId: "c1", toolName: "echo", content: [{ type: "text", text: "ok" }], isError: false },
        { role: "user", content: [{ type: "text", text: "thanks" }] },
      ],
      hooks: {
        // Drops the tool result but keeps the assistant message: the mistake this
        // check exists for.
        onBeforeRequest: ({ request }) => ({ ...request, messages: request.messages.filter((m) => m.role !== "toolResult") }),
      },
    });

    expect(result.stopReason).toBe("error");
    expect(result.error?.kind).toBe("invalidRequest");
    expect(result.error?.message).toContain("no result after it");
    expect(client.requests).toHaveLength(0);
  });
});
