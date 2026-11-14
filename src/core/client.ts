import type { JSONSchema } from "./schema.js";
import type { AssistantMessage, Message, ReasoningEffort } from "./messages.js";
import type { NormalizedError } from "./errors.js";

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
   * How hard to think before answering, for models that reason.
   *
   * Adapters for models without a reasoning mode ignore it, as an adapter is
   * always free to ignore a request field it has no wire representation for.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Escape hatch for provider-specific parameters. The core never reads this;
   * it exists so an adapter can take a parameter that has no place in the
   * portable request shape.
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
