import { describe, expect, expectTypeOf, it } from "vitest";

import {
  DEFAULT_RETRYABLE,
  VERSION,
  toNormalizedError,
  type AgentEvent,
  type AssistantMessage,
  type ContentBlock,
  type Message,
  type RunStopReason,
  type StopReason,
  type ToolResultMessage,
  type Usage,
  type UserMessage,
} from "../../src/index.js";

/**
 * Type-level checks are as important as runtime ones here: this file is what
 * fails when a field is renamed, and it fails at `tsc --noEmit` rather than in
 * a consumer six months later.
 */
describe("message model", () => {
  const text: ContentBlock = { type: "text", text: "hello" };
  const image: ContentBlock = { type: "image", mimeType: "image/png", data: "AAAA" };
  const thinking: ContentBlock = { type: "thinking", text: "hmm", signature: "sig" };

  it("exposes the package version", () => {
    expect(VERSION).toBe("0.1.0");
  });

  it("accepts every content block variant", () => {
    expect([text, image, thinking].map((b) => b.type)).toEqual(["text", "image", "thinking"]);
  });

  it("builds each message role", () => {
    const system: Message = { role: "system", content: [text] };
    const user: UserMessage = { role: "user", content: [text, image] };
    const assistant: AssistantMessage = {
      role: "assistant",
      content: [thinking, text],
      toolCalls: [{ id: "call_1", name: "read", args: { path: "a.ts" } }],
      stopReason: "toolUse",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 },
      model: "some-model",
      provider: "some-provider",
    };
    const toolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [text],
      isError: false,
    };
    expect([system, user, assistant, toolResult].map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "toolResult",
    ]);
  });

  it("keeps content and toolCalls on the same assistant message", () => {
    // The whole point of not splitting the assistant message into a union:
    // one response can carry reasoning, visible text and tool calls at once.
    const assistant: AssistantMessage = {
      role: "assistant",
      content: [thinking, text],
      toolCalls: [
        { id: "a", name: "read", args: {} },
        { id: "b", name: "bash", args: {} },
      ],
      stopReason: "toolUse",
    };
    expect(assistant.content).toHaveLength(2);
    expect(assistant.toolCalls).toHaveLength(2);
  });

  it("allows optional fields to be absent rather than undefined", () => {
    const assistant: AssistantMessage = {
      role: "assistant",
      content: [],
      toolCalls: [],
      stopReason: "stop",
    };
    // exactOptionalPropertyTypes: `usage: undefined` would be a type error,
    // so absence is the only representation and JSON drops nothing silently.
    expect("usage" in assistant).toBe(false);
    expect(JSON.stringify(assistant)).toBe(
      '{"role":"assistant","content":[],"toolCalls":[],"stopReason":"stop"}',
    );
  });
});

describe("JSON round trip", () => {
  it("survives stringify/parse with structure and types intact", () => {
    const transcript: Message[] = [
      { role: "system", content: [{ type: "text", text: "you are an agent" }] },
      { role: "user", content: [{ type: "text", text: "list files" }] },
      {
        role: "assistant",
        content: [{ type: "thinking", text: "need ls", signature: "opaque-sig" }],
        toolCalls: [{ id: "call_1", name: "bash", args: { command: "ls" } }],
        stopReason: "toolUse",
        usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 5 },
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{ type: "text", text: "a.ts\nb.ts" }],
        isError: false,
        details: { exitCode: 0, stdout: "a.ts\nb.ts" },
      },
      { role: "assistant", content: [{ type: "text", text: "two files" }], toolCalls: [], stopReason: "stop" },
    ];

    const restored = JSON.parse(JSON.stringify(transcript)) as Message[];

    expect(restored).toEqual(transcript);
    // The discriminated union still narrows after a round trip.
    const last = restored[4];
    if (last?.role !== "assistant") throw new Error("expected assistant message");
    expectTypeOf(last).toEqualTypeOf<AssistantMessage>();
    expect(last.toolCalls).toHaveLength(0);
  });

  it("keeps binary image payloads as plain JSON strings", () => {
    const msg: Message = {
      role: "user",
      content: [{ type: "image", mimeType: "image/jpeg", data: "/9j/4AAQSkZJRg==" }],
    };
    expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
  });
});

describe("stop reasons", () => {
  it("separates per-response and per-run reasons", () => {
    const responseReasons: StopReason[] = ["stop", "length", "toolUse", "contentFilter", "error"];
    const runReasons: RunStopReason[] = ["completed", "maxTurns", "aborted", "error"];
    expect(responseReasons).toHaveLength(5);
    expect(runReasons).toHaveLength(4);
    // They are distinct types: a run reason is not assignable to a response reason.
    // @ts-expect-error "completed" only exists on RunStopReason
    const invalid: StopReason = "completed";
    expect(invalid).toBe("completed");
  });
});

describe("events", () => {
  it("narrows on the type tag", () => {
    const events: AgentEvent[] = [
      { type: "run_start", messageCount: 2 },
      { type: "turn_start", turn: 1 },
      { type: "text_delta", turn: 1, text: "Hel" },
      { type: "thinking_delta", turn: 1, text: "..." },
      { type: "tool_start", turn: 1, toolCallId: "c1", toolName: "read", args: {} },
      { type: "tool_update", toolCallId: "c1", toolName: "read", partial: "line 1" },
      {
        type: "tool_end",
        toolCallId: "c1",
        toolName: "read",
        durationMs: 12,
        result: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [], isError: false },
      },
      { type: "turn_end", turn: 1, toolCallCount: 1 },
      {
        type: "run_end",
        stopReason: "completed",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 },
        messages: [],
      },
      { type: "error", error: { kind: "network", message: "reset", retryable: true }, fatal: true },
    ];

    expect(events).toHaveLength(10);
    const deltas = events.filter((e) => e.type === "text_delta");
    expectTypeOf(deltas[0]).toEqualTypeOf<Extract<AgentEvent, { type: "text_delta" }> | undefined>();
    expect(deltas.map((e) => (e.type === "text_delta" ? e.text : ""))).toEqual(["Hel"]);
  });
});

describe("usage", () => {
  it("keeps cache accounting separate from input tokens", () => {
    const usage: Usage = {
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 8_000,
      cacheWriteTokens: 500,
      totalTokens: 9_700,
    };
    expect(usage.cacheReadTokens).toBeGreaterThan(usage.inputTokens);
    expect(usage.costUsd).toBeUndefined();
  });
});

describe("normalized errors", () => {
  it("fills retryable from the error kind", () => {
    expect(toNormalizedError("rateLimit", "slow down").retryable).toBe(true);
    expect(toNormalizedError("auth", "bad key").retryable).toBe(false);
  });

  it("lets an adapter override the default", () => {
    expect(toNormalizedError("rateLimit", "slow down", { retryable: false }).retryable).toBe(false);
  });

  it("omits absent optional fields instead of setting them to undefined", () => {
    const err = toNormalizedError("network", "reset");
    expect(Object.keys(err).sort()).toEqual(["kind", "message", "retryable"]);
    expect(JSON.stringify(err)).toBe('{"kind":"network","message":"reset","retryable":true}');
  });

  it("carries status and retry-after when present", () => {
    const err = toNormalizedError("overloaded", "529", { status: 529, retryAfterSeconds: 12 });
    expect(err.status).toBe(529);
    expect(err.retryAfterSeconds).toBe(12);
  });

  it("has a default stance for every kind", () => {
    expect(Object.keys(DEFAULT_RETRYABLE)).toHaveLength(12);
    expect(DEFAULT_RETRYABLE.aborted).toBe(false);
    expect(DEFAULT_RETRYABLE.hook).toBe(false);
  });
});
