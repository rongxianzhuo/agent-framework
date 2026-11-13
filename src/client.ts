/**
 * The provider contract.
 *
 * This file is the entire surface a model adapter has to satisfy, and it lives
 * in the core rather than under `providers/` because the loop depends on it. The
 * direction of the dependency matters: adapters implement this contract, the
 * core never reaches into an adapter.
 *
 * The contract is one method and one event union:
 *
 *   client.stream(request) -> async iterable of LLMEvent, ending in exactly one
 *                             `done` (with the assembled message) or `error`
 *
 * Everything provider-specific — wire format, SSE framing, how tool arguments
 * arrive in pieces, where usage lives — stops at the adapter boundary. What
 * crosses the boundary is a normalised event stream and one assembled
 * `AssistantMessage`.
 */

import { toNormalizedError } from "./errors.js";
import type { JSONSchema } from "./schema.js";
import type { ToolDefinition } from "./tools.js";
import type {
  AssistantMessage,
  ContentBlock,
  Message,
  NormalizedError,
  StopReason,
  ToolCall,
  Usage,
} from "./types.js";

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * A tool as the model sees it: no `execute`, no `timeoutMs`.
 *
 * Stripping the implementation is not cosmetic. It makes it impossible for an
 * adapter to accidentally run a tool while building a request payload, and it
 * keeps request objects safe to log.
 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: JSONSchema;
}

/** Convert tool definitions into the wire-facing subset. */
export function toToolSpec(tools: readonly ToolDefinition<never>[]): ToolSpec[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

/**
 * One model call.
 *
 * `messages` is the whole transcript, including a leading system message if the
 * caller supplied one. The loop does not extract or reformat it; an adapter that
 * needs the system prompt elsewhere (Anthropic wants it as a top-level field)
 * does that at its own boundary. One representation, one place to look.
 */
export interface LLMRequest {
  model: string;
  messages: readonly Message[];
  tools: readonly ToolSpec[];
  maxOutputTokens?: number;
  temperature?: number;
  /**
   * Escape hatch for provider-specific parameters. The core never reads this;
   * it exists so an adapter can expose, say, a reasoning effort setting without
   * every other adapter having to grow a field it ignores.
   */
  providerOptions?: Record<string, unknown>;
}

export interface LLMStreamOptions {
  signal?: AbortSignal;
}

/** A model adapter. */
export interface LLMClient {
  /** Short provider name, used in errors and on assistant messages. */
  readonly name: string;
  stream(request: LLMRequest, options?: LLMStreamOptions): AsyncIterable<LLMEvent>;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * What an adapter emits while a response streams.
 *
 * Deltas are optional for the consumer: the loop forwards them as `AgentEvent`s
 * for progress display and then reads everything it needs from `done`. An
 * adapter that cannot stream may emit only `done`; one that cannot assemble may
 * not, because `done` is mandatory.
 */
export type LLMEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  /**
   * A piece of a tool call. `index` is the model's call position within the
   * response; `id` and `name` typically arrive on the first piece for that
   * index, `argsDelta` accumulates as a JSON string.
   *
   * The loop ignores these — they exist for adapters to feed
   * `MessageAccumulator`, because assembling partial tool JSON is provider
   * dialect and does not belong in the core loop.
   */
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; argsDelta?: string }
  | { type: "done"; message: AssistantMessage }
  | { type: "error"; error: NormalizedError };

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Builds one `AssistantMessage` from a delta stream.
 *
 * Provided for adapter authors: every provider streams tool arguments as
 * fragments, and getting the bookkeeping right (interleaved thinking and text,
 * out-of-order indexes, JSON that never closes) is the same work each time.
 *
 * Content blocks keep arrival order, so a response that thinks, speaks, then
 * thinks again produces three blocks rather than two merged ones.
 */
export class MessageAccumulator {
  #blocks: ContentBlock[] = [];
  #calls = new Map<number, { id: string; name: string; argsJson: string }>();

  push(event: LLMEvent): void {
    switch (event.type) {
      case "text_delta":
        this.#appendText("text", event.text);
        return;
      case "thinking_delta":
        this.#appendText("thinking", event.text);
        return;
      case "tool_call_delta": {
        const existing = this.#calls.get(event.index) ?? { id: "", name: "", argsJson: "" };
        if (event.id !== undefined) existing.id = event.id;
        if (event.name !== undefined) existing.name = event.name;
        if (event.argsDelta !== undefined) existing.argsJson += event.argsDelta;
        this.#calls.set(event.index, existing);
        return;
      }
      default:
        return;
    }
  }

  #appendText(kind: "text" | "thinking", delta: string): void {
    if (delta === "") return;
    const last = this.#blocks.at(-1);
    if (last && last.type === kind) {
      last.text += delta;
      return;
    }
    this.#blocks.push({ type: kind, text: delta });
  }

  /** The assembled message. Call once; the accumulator is not reusable. */
  build(input: {
    stopReason: StopReason;
    usage?: Usage;
    model?: string;
    provider?: string;
  }): AssistantMessage {
    const message: AssistantMessage = {
      role: "assistant",
      content: this.#blocks,
      toolCalls: this.#assembledCalls(),
      stopReason: input.stopReason,
    };
    if (input.usage !== undefined) message.usage = input.usage;
    if (input.model !== undefined) message.model = input.model;
    if (input.provider !== undefined) message.provider = input.provider;
    return message;
  }

  /**
   * Tool calls in index order, not arrival order.
   *
   * A provider may interleave fragments from several calls; the model's intent
   * is the order of the indexes, and tool results must come back in that order
   * or Anthropic rejects the next request.
   */
  #assembledCalls(): ToolCall[] {
    return [...this.#calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, raw]) => {
        const call: ToolCall = {
          id: raw.id,
          name: raw.name,
          // A truncated or malformed JSON fragment leaves `args` undefined; the
          // tool layer turns that into a readable error result rather than
          // executing with garbage.
          args: parseToolArguments(raw.argsJson),
        };
        return call;
      });
  }
}

function parseToolArguments(json: string): unknown {
  if (json.trim() === "") return {};
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export const EMPTY_USAGE: Usage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
});

/** Sum two usage records. `costUsd` is summed only when both sides have one. */
export function addUsage(a: Usage, b: Usage | undefined): Usage {
  if (b === undefined) return a;
  const total: Usage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
  if (a.costUsd !== undefined && b.costUsd !== undefined) total.costUsd = a.costUsd + b.costUsd;
  else if (a.costUsd !== undefined) total.costUsd = a.costUsd;
  else if (b.costUsd !== undefined) total.costUsd = b.costUsd;
  return total;
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/**
 * Recognise something that is already in the normalised shape.
 *
 * Adapters throw these directly; the loop needs to tell them apart from an
 * unexpected JavaScript error so it does not bury a `rateLimit` under `unknown`.
 */
export function isNormalizedError(value: unknown): value is NormalizedError {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "message" in value &&
    "retryable" in value &&
    typeof (value as { message: unknown }).message === "string"
  );
}

/** Convert anything thrown by a client into a `NormalizedError`. */
export function normalizeThrown(thrown: unknown, provider?: string): NormalizedError {
  if (isNormalizedError(thrown)) {
    return thrown.provider !== undefined || provider === undefined
      ? thrown
      : { ...thrown, provider };
  }
  if (thrown instanceof Error && (thrown.name === "AbortError" || thrown.name === "TimeoutError")) {
    return toNormalizedError("aborted", thrown.message || "The request was aborted.", {
      cause: thrown,
      ...(provider === undefined ? {} : { provider }),
    });
  }
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  return toNormalizedError("unknown", message || "Unknown provider failure.", {
    cause: thrown,
    ...(provider === undefined ? {} : { provider }),
  });
}
