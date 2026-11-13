import { describe, expect, it } from "vitest";

import {
  run,
  textResult,
  defineTool,
  toNormalizedError,
  type AgentEvent,
  type AssistantMessage,
  type LLMClient,
  type LLMRequest,
  type Message,
  type NormalizedError,
  type StopReason,
  type ToolCall,
  type Usage,
} from "../../src/index.js";

// ---------------------------------------------------------------------------
// A scripted client: the loop is about control flow, so the model is a fixture.
// ---------------------------------------------------------------------------

interface ScriptedTurn {
  text?: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  stopReason?: StopReason;
  usage?: Usage;
  error?: NormalizedError;
  /** Abort the run's signal after this delta, to test mid-stream cancellation. */
  abortAfterChunk?: AbortController;
  /** Milliseconds to wait before producing the response. */
  delayMs?: number;
}

function scripted(turns: ScriptedTurn[]): { client: LLMClient; requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  let index = 0;

  const client: LLMClient = {
    name: "scripted",
    async *stream(request: LLMRequest) {
      requests.push(request);
      const turn = turns[index];
      index += 1;
      if (turn === undefined) throw new Error(`scripted client exhausted after ${requests.length} request(s)`);

      if (turn.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, turn.delayMs));
      }

      if (turn.error !== undefined) {
        yield { type: "error" as const, error: turn.error };
        return;
      }

      if (turn.thinking !== undefined) {
        yield { type: "thinking_delta" as const, text: turn.thinking };
      }

      if (turn.text !== undefined) {
        const chunks = turn.text.match(/.{1,5}/gs) ?? [];
        for (const chunk of chunks) {
          yield { type: "text_delta" as const, text: chunk };
        }
      }

      if (turn.abortAfterChunk !== undefined) turn.abortAfterChunk.abort();

      const message: AssistantMessage = {
        role: "assistant",
        content: turn.thinking === undefined ? [] : [{ type: "thinking", text: turn.thinking }],
        toolCalls: turn.toolCalls ?? [],
        stopReason: turn.stopReason ?? ((turn.toolCalls?.length ?? 0) > 0 ? "toolUse" : "stop"),
      };
      if (turn.text !== undefined) message.content.push({ type: "text", text: turn.text });
      if (turn.usage !== undefined) message.usage = turn.usage;
      message.provider = "scripted";

      yield { type: "done" as const, message };
    },
  };

  return { client, requests };
}

function usage(input: number, output: number): Usage {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: input + output,
  };
}

const sys: Message = { role: "system", content: [{ type: "text", text: "You are a test agent." }] };
const hello: Message = { role: "user", content: [{ type: "text", text: "hi" }] };

const echo = defineTool<{ text: string }>({
  name: "echo",
  description: "Echo text back.",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  execute: (args) => textResult(`echoed: ${args.text}`),
});

/** The text of the first tool result in a transcript, for assertions. */
function toolResultText(messages: readonly Message[]): string {
  const message = messages.find((m) => m.role === "toolResult");
  if (message?.role !== "toolResult") throw new Error("expected a toolResult message");
  const block = message.content[0];
  return block?.type === "text" ? block.text : "";
}

// ---------------------------------------------------------------------------
// Basic flow
// ---------------------------------------------------------------------------

describe("a run without tools", () => {
  it("completes in one turn and returns the extended transcript", async () => {
    const { client, requests } = scripted([{ text: "hello there", usage: usage(10, 3) }]);

    const result = await run({ client, model: "test-model", messages: [sys, hello] });

    expect(result.stopReason).toBe("completed");
    expect(result.turns).toBe(1);
    expect(result.messages).toHaveLength(3);
    expect(result.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "hello there" }],
      toolCalls: [],
      stopReason: "stop",
    });
    expect(result.usage.inputTokens).toBe(10);
    expect(requests[0]?.model).toBe("test-model");
    expect(requests[0]?.tools).toEqual([]);
  });

  it("does not mutate the caller's message array", async () => {
    const { client } = scripted([{ text: "ok" }]);
    const input: Message[] = [sys, hello];
    const snapshot = [...input];

    const result = await run({ client, model: "m", messages: input });

    expect(input).toEqual(snapshot);
    expect(input).toHaveLength(2);
    expect(result.messages).not.toBe(input);
  });

  it("passes the system message through untouched and first", async () => {
    const { client, requests } = scripted([{ text: "ok" }]);

    await run({ client, model: "m", messages: [sys, hello] });

    expect(requests[0]?.messages[0]).toEqual(sys);
    expect(requests[0]?.messages).toHaveLength(2);
  });

  it("forwards maxOutputTokens, temperature and providerOptions", async () => {
    const { client, requests } = scripted([{ text: "ok" }]);

    await run({
      client,
      model: "m",
      messages: [hello],
      maxOutputTokens: 512,
      temperature: 0.2,
      providerOptions: { reasoningEffort: "low" },
    });

    expect(requests[0]?.maxOutputTokens).toBe(512);
    expect(requests[0]?.temperature).toBe(0.2);
    expect(requests[0]?.providerOptions).toEqual({ reasoningEffort: "low" });
  });

  it("omits unset request fields rather than sending undefined", async () => {
    const { client, requests } = scripted([{ text: "ok" }]);

    await run({ client, model: "m", messages: [hello] });

    expect("maxOutputTokens" in (requests[0] ?? {})).toBe(false);
    expect("temperature" in (requests[0] ?? {})).toBe(false);
    expect("providerOptions" in (requests[0] ?? {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

describe("a run with tools", () => {
  it("executes the call, feeds the result back and continues", async () => {
    const { client, requests } = scripted([
      { toolCalls: [{ id: "c1", name: "echo", args: { text: "ping" } }] },
      { text: "all done" },
    ]);

    const result = await run({ client, model: "m", messages: [hello], tools: [echo] });

    expect(result.turns).toBe(2);
    expect(result.stopReason).toBe("completed");
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(result.messages[2]).toEqual({
      role: "toolResult",
      toolCallId: "c1",
      toolName: "echo",
      content: [{ type: "text", text: "echoed: ping" }],
      isError: false,
    });
    // The second request sees the tool result.
    expect(requests[1]?.messages).toHaveLength(3);
    // Only the tool spec crosses the boundary, never the implementation.
    expect(requests[0]?.tools).toEqual([
      { name: "echo", description: "Echo text back.", parameters: echo.parameters },
    ]);
  });

  it("keeps tool results in call order even when they finish out of order", async () => {
    const slow = defineTool<{ text: string }>({
      name: "slow",
      description: "Takes 30ms.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      execute: async (args) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return textResult(`slow:${args.text}`);
      },
    });
    const fast = defineTool<{ text: string }>({
      name: "fast",
      description: "Returns immediately.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      execute: (args) => textResult(`fast:${args.text}`),
    });

    const { client } = scripted([
      {
        toolCalls: [
          { id: "c1", name: "slow", args: { text: "a" } },
          { id: "c2", name: "fast", args: { text: "b" } },
        ],
      },
      { text: "done" },
    ]);

    const result = await run({ client, model: "m", messages: [hello], tools: [slow, fast] });
    const results = result.messages.filter((m) => m.role === "toolResult");

    expect(results.map((m) => m.toolCallId)).toEqual(["c1", "c2"]);
  });

  it("runs tools concurrently by default", async () => {
    let running = 0;
    let peak = 0;
    const tool = defineTool<{ n: number }>({
      name: "wait",
      description: "Holds for 20ms and records concurrency.",
      parameters: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
      execute: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running -= 1;
        return textResult("ok");
      },
    });

    const { client } = scripted([
      {
        toolCalls: [
          { id: "c1", name: "wait", args: { n: 1 } },
          { id: "c2", name: "wait", args: { n: 2 } },
        ],
      },
      { text: "done" },
    ]);

    await run({ client, model: "m", messages: [hello], tools: [tool] });

    expect(peak).toBe(2);
  });

  it("never overlaps tools when parallelTools is false", async () => {
    let running = 0;
    let peak = 0;
    const tool = defineTool<{ n: number }>({
      name: "wait",
      description: "Holds for 10ms and records concurrency.",
      parameters: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
      execute: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 10));
        running -= 1;
        return textResult("ok");
      },
    });

    const { client } = scripted([
      {
        toolCalls: [
          { id: "c1", name: "wait", args: { n: 1 } },
          { id: "c2", name: "wait", args: { n: 2 } },
        ],
      },
      { text: "done" },
    ]);

    await run({ client, model: "m", messages: [hello], tools: [tool], parallelTools: false });

    expect(peak).toBe(1);
  });

  it("runs tools one at a time when parallelTools is false", async () => {
    const order: string[] = [];
    const tool = defineTool<{ tag: string }>({
      name: "step",
      description: "Records its tag after a delay.",
      parameters: { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] },
      execute: async (args) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push(args.tag);
        return textResult(args.tag);
      },
    });

    const { client } = scripted([
      {
        toolCalls: [
          { id: "c1", name: "step", args: { tag: "first" } },
          { id: "c2", name: "step", args: { tag: "second" } },
        ],
      },
      { text: "done" },
    ]);

    await run({ client, model: "m", messages: [hello], tools: [tool], parallelTools: false });

    expect(order).toEqual(["first", "second"]);
  });

  it("feeds an unknown tool back as an error the model can react to", async () => {
    const { client } = scripted([
      { toolCalls: [{ id: "c1", name: "ghost", args: {} }] },
      { text: "I will use echo instead" },
    ]);

    const result = await run({ client, model: "m", messages: [hello], tools: [echo] });

    expect(result.stopReason).toBe("completed");
    const toolResult = result.messages.find((m) => m.role === "toolResult");
    expect(toolResult).toMatchObject({ isError: true, toolName: "ghost" });
  });

  it("feeds invalid arguments back as an error naming the field", async () => {
    const { client } = scripted([
      { toolCalls: [{ id: "c1", name: "echo", args: { text: 42 } }] },
      { text: "fixed" },
    ]);

    const result = await run({ client, model: "m", messages: [hello], tools: [echo] });
    const toolResult = result.messages.find((m) => m.role === "toolResult");

    expect(toolResult?.isError).toBe(true);
    expect(toolResultText(result.messages)).toContain("expected string, received number 42");
  });

  it("reports a tool that throws and lets the model continue", async () => {
    const broken = defineTool({
      name: "broken",
      description: "Always throws.",
      parameters: { type: "object", properties: {} },
      execute: () => {
        throw new Error("disk on fire");
      },
    });

    const { client } = scripted([
      { toolCalls: [{ id: "c1", name: "broken", args: {} }] },
      { text: "the disk is on fire" },
    ]);

    const events: AgentEvent[] = [];
    const result = await run({
      client,
      model: "m",
      messages: [hello],
      tools: [broken],
      onEvent: (e) => {
        events.push(e);
      },
    });

    expect(result.stopReason).toBe("completed");
    const nonFatal = events.filter((e) => e.type === "error");
    expect(nonFatal).toHaveLength(1);
    expect(nonFatal[0]).toMatchObject({ fatal: false, error: { kind: "toolFailed" } });
  });

  it("reports a tool timeout as a tool failure", async () => {
    const hang = defineTool({
      name: "hang",
      description: "Never returns.",
      parameters: { type: "object", properties: {} },
      timeoutMs: 10,
      execute: () => new Promise(() => {}),
    });

    const { client } = scripted([
      { toolCalls: [{ id: "c1", name: "hang", args: {} }] },
      { text: "gave up" },
    ]);

    const result = await run({ client, model: "m", messages: [hello], tools: [hang] });
    const toolResult = result.messages.find((m) => m.role === "toolResult");

    expect(toolResult?.isError).toBe(true);
    expect(toolResultText(result.messages)).toContain("exceeded its 10ms timeout");
  });
});

// ---------------------------------------------------------------------------
// Usage and turn limits
// ---------------------------------------------------------------------------

describe("accounting", () => {
  it("sums usage across turns", async () => {
    const { client } = scripted([
      { toolCalls: [{ id: "c1", name: "echo", args: { text: "x" } }], usage: usage(10, 2) },
      { text: "done", usage: usage(20, 4) },
    ]);

    const result = await run({ client, model: "m", messages: [hello], tools: [echo] });

    expect(result.usage).toEqual({
      inputTokens: 30,
      outputTokens: 6,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 36,
    });
  });

  it("uses the frozen empty usage as a base without mutating it", async () => {
    const { client } = scripted([{ text: "ok" }]);
    const result = await run({ client, model: "m", messages: [hello] });
    expect(result.usage.totalTokens).toBe(0);
    expect(Number.isInteger(result.usage.inputTokens)).toBe(true);
  });

  it("stops at maxTurns and keeps the work done so far", async () => {
    const { client } = scripted([
      { toolCalls: [{ id: "c1", name: "echo", args: { text: "a" } }] },
      { toolCalls: [{ id: "c2", name: "echo", args: { text: "b" } }] },
      { text: "never reached" },
    ]);

    const result = await run({ client, model: "m", messages: [hello], tools: [echo], maxTurns: 2 });

    expect(result.stopReason).toBe("maxTurns");
    expect(result.turns).toBe(2);
    expect(result.messages.filter((m) => m.role === "toolResult")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Failure and cancellation
// ---------------------------------------------------------------------------

describe("failures", () => {
  it("returns an error result when the adapter emits an error event", async () => {
    const { client } = scripted([{ error: toNormalizedError("rateLimit", "slow down", { retryAfterSeconds: 3 }) }]);

    const result = await run({ client, model: "m", messages: [hello] });

    expect(result.stopReason).toBe("error");
    expect(result.error?.kind).toBe("rateLimit");
    expect(result.error?.retryAfterSeconds).toBe(3);
    expect(result.messages).toHaveLength(1);
  });

  it("returns an error result when the adapter throws", async () => {
    const client: LLMClient = {
      name: "throwing",
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error("socket closed");
      },
    };

    const result = await run({ client, model: "m", messages: [hello] });

    expect(result.stopReason).toBe("error");
    expect(result.error?.message).toBe("socket closed");
  });

  it("treats a stream that ends without done as a contract violation", async () => {
    const client: LLMClient = {
      name: "silent",
      async *stream() {
        yield { type: "text_delta" as const, text: "half a thought" };
      },
    };

    const result = await run({ client, model: "m", messages: [hello] });

    expect(result.stopReason).toBe("error");
    expect(result.error?.message).toContain("without emitting a done or error event");
  });

  it("ends the run when the model reports stopReason error", async () => {
    const { client } = scripted([{ text: "", stopReason: "error" }]);

    const result = await run({ client, model: "m", messages: [hello] });

    expect(result.stopReason).toBe("error");
  });

  it("marks the error event fatal only when the run ended", async () => {
    const { client } = scripted([{ error: toNormalizedError("auth", "bad key") }]);
    const events: AgentEvent[] = [];

    await run({
      client,
      model: "m",
      messages: [hello],
      onEvent: (e) => {
        events.push(e);
      },
    });

    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ fatal: true });
  });
});

describe("cancellation", () => {
  it("does not call the model when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, requests } = scripted([{ text: "never" }]);

    const result = await run({ client, model: "m", messages: [hello], signal: controller.signal });

    expect(result.stopReason).toBe("aborted");
    expect(result.turns).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it("stops mid-stream and reports aborted, not failed", async () => {
    const controller = new AbortController();
    const { client } = scripted([{ text: "streaming a long answer here", abortAfterChunk: controller }]);

    const result = await run({ client, model: "m", messages: [hello], signal: controller.signal });

    expect(result.stopReason).toBe("aborted");
    expect(result.error?.kind).toBe("aborted");
    // The partial turn produced no assistant message, so the transcript is intact.
    expect(result.messages).toHaveLength(1);
  });

  it("discards tool results when the run is cancelled during execution", async () => {
    const controller = new AbortController();
    const cancelling = defineTool({
      name: "cancel-me",
      description: "Aborts the run while running.",
      parameters: { type: "object", properties: {} },
      execute: () => {
        controller.abort();
        return textResult("finished anyway");
      },
    });

    const { client } = scripted([{ toolCalls: [{ id: "c1", name: "cancel-me", args: {} }] }]);

    const result = await run({
      client,
      model: "m",
      messages: [hello],
      tools: [cancelling],
      signal: controller.signal,
    });

    expect(result.stopReason).toBe("aborted");
    expect(result.messages.some((m) => m.role === "toolResult")).toBe(false);
  });

  it("passes the signal to the client", async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const client: LLMClient = {
      name: "spy",
      async *stream(_request, options) {
        seen.push(options?.signal);
        yield {
          type: "done" as const,
          message: { role: "assistant" as const, content: [], toolCalls: [], stopReason: "stop" as const },
        };
      },
    };

    await run({ client, model: "m", messages: [hello], signal: controller.signal });
    expect(seen[0]).toBe(controller.signal);
  });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

describe("events", () => {
  it("emits a start, the turns, and a single end in order", async () => {
    const { client } = scripted([
      { toolCalls: [{ id: "c1", name: "echo", args: { text: "x" } }] },
      { text: "finished" },
    ]);
    const events: AgentEvent[] = [];

    await run({
      client,
      model: "m",
      messages: [hello],
      tools: [echo],
      onEvent: (e) => {
        events.push(e);
      },
    });

    expect(events[0]?.type).toBe("run_start");
    expect(events.at(-1)?.type).toBe("run_end");
    expect(events.filter((e) => e.type === "run_start")).toHaveLength(1);
    expect(events.filter((e) => e.type === "run_end")).toHaveLength(1);
    expect(events.filter((e) => e.type === "turn_start")).toHaveLength(2);
    expect(events.filter((e) => e.type === "turn_end")).toHaveLength(2);
  });

  it("forwards text deltas before the assembled message", async () => {
    const { client } = scripted([{ text: "abcdefghij" }]);
    const events: AgentEvent[] = [];

    await run({
      client,
      model: "m",
      messages: [hello],
      onEvent: (e) => {
        events.push(e);
      },
    });

    const deltaIndex = events.findIndex((e) => e.type === "text_delta");
    const messageIndex = events.findIndex((e) => e.type === "assistant_message");
    expect(deltaIndex).toBeGreaterThan(-1);
    expect(deltaIndex).toBeLessThan(messageIndex);

    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.text : ""))
      .join("");
    expect(text).toBe("abcdefghij");
  });

  it("emits tool_start and tool_end with a duration", async () => {
    const { client } = scripted([
      { toolCalls: [{ id: "c1", name: "echo", args: { text: "x" } }] },
      { text: "done" },
    ]);
    const events: AgentEvent[] = [];

    await run({
      client,
      model: "m",
      messages: [hello],
      tools: [echo],
      onEvent: (e) => {
        events.push(e);
      },
    });

    const start = events.find((e) => e.type === "tool_start");
    const end = events.find((e) => e.type === "tool_end");
    expect(start).toMatchObject({ toolName: "echo", args: { text: "x" } });
    expect(end).toMatchObject({ toolName: "echo", durationMs: expect.any(Number) });
  });

  it("awaits an async listener, so ordering survives a slow logger", async () => {
    const seen: string[] = [];
    const { client } = scripted([{ text: "ok" }]);

    await run({
      client,
      model: "m",
      messages: [hello],
      onEvent: async (e) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        seen.push(e.type);
      },
    });

    expect(seen[0]).toBe("run_start");
    expect(seen.at(-1)).toBe("run_end");
  });

  it("reports the final transcript in run_end", async () => {
    const { client } = scripted([{ text: "ok" }]);
    const events: AgentEvent[] = [];

    await run({
      client,
      model: "m",
      messages: [hello],
      onEvent: (e) => {
        events.push(e);
      },
    });

    const end = events.at(-1);
    if (end?.type !== "run_end") throw new Error("expected run_end");
    expect(end.stopReason).toBe("completed");
    expect(end.messages).toHaveLength(2);
  });

  it("tolerates a listener that throws on progress updates", async () => {
    const { client } = scripted([
      { toolCalls: [{ id: "c1", name: "noisy", args: {} }] },
      { text: "done" },
    ]);
    const noisy = defineTool({
      name: "noisy",
      description: "Emits progress then returns.",
      parameters: { type: "object", properties: {} },
      execute: (_args, ctx) => {
        ctx.onUpdate?.("halfway");
        return textResult("ok");
      },
    });

    const result = await run({
      client,
      model: "m",
      messages: [hello],
      tools: [noisy],
      onEvent: (event) => {
        if (event.type === "tool_update") throw new Error("listener bug");
      },
    });

    expect(result.stopReason).toBe("completed");
  });
});
