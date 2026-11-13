/**
 * The data model shared by every part of `agent-core`.
 *
 * Everything here is plain JSON-serializable data: no classes, no functions, no
 * dates, no `undefined` inside arrays. A message list can be written to disk,
 * read back elsewhere and replayed byte-for-byte, which is what lets the
 * embedding agent own persistence without the core knowing about storage.
 *
 * Field names follow the two rules that make cross-provider work bearable:
 *
 * - Say what the content *is*, not which provider produced it. `thinking` is a
 *   normalised block, not an Anthropic `thinking_delta`.
 * - Keep provider-specific opaque data in a signed field on the block that
 *   owns it (`signature`), so it can be replayed to the provider that issued it
 *   and ignored by every other provider.
 */

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/** A block of content inside a message. */
export type ContentBlock = TextBlock | ImageBlock | ThinkingBlock;

export interface TextBlock {
  type: "text";
  text: string;
}

/**
 * Base64-encoded image, no data-URL prefix.
 *
 * `data` is kept as base64 rather than bytes so a whole conversation stays
 * valid JSON on disk and over the wire.
 */
export interface ImageBlock {
  type: "image";
  /** e.g. `image/png`, `image/jpeg`. */
  mimeType: string;
  /** Base64 payload, without a `data:` prefix. */
  data: string;
}

/**
 * Reasoning output from a thinking-capable model.
 *
 * `signature` is opaque provider data (Anthropic's signed thinking blob, for
 * example). It must be sent back unchanged to the provider that produced it and
 * dropped by any other provider. Treating it as an opaque string keeps the core
 * from having to understand any one provider's attestation scheme.
 */
export interface ThinkingBlock {
  type: "thinking";
  text: string;
  signature?: string;
}

// ---------------------------------------------------------------------------
// Tool calls and results
// ---------------------------------------------------------------------------

/**
 * A model's request to run a tool.
 *
 * `args` is already parsed by the provider adapter; the core never sees
 * partial JSON. It is typed `unknown` on purpose — it only becomes meaningful
 * after the tool layer validates it against the tool's schema. A call whose
 * arguments fail to parse keeps `args: undefined` and is turned into an error
 * tool result instead of being executed.
 */
export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

/**
 * What a tool implementation returns.
 *
 * `content` goes to the model. `details` is for the embedding agent's UI and is
 * never sent to the model — it is where a file diff, a DOM snapshot or a raw
 * response body belongs, so it does not burn context on every subsequent turn.
 */
export interface ToolResult {
  content: ContentBlock[];
  details?: unknown;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type MessageRole = "system" | "user" | "assistant" | "toolResult";

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export interface SystemMessage {
  role: "system";
  content: ContentBlock[];
}

export interface UserMessage {
  role: "user";
  content: ContentBlock[];
}

/**
 * Model output.
 *
 * `content` and `toolCalls` are deliberately two parallel fields rather than a
 * discriminated union of "text message" and "tool call message". Models
 * routinely emit reasoning and one or more tool calls in the same response, and
 * a union would force every consumer to narrow and re-assemble before it can
 * look at a turn.
 */
export interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
  /** Empty when the model answered without calling a tool. */
  toolCalls: ToolCall[];
  stopReason: StopReason;
  /** Reported by the provider for this single response. */
  usage?: Usage;
  /** Model that produced the message; may differ from the run's model after a switch. */
  model?: string;
  /** Provider that produced the message, for debugging and cost attribution. */
  provider?: string;
}

/**
 * The outcome of one tool call, fed back to the model.
 *
 * `toolCallId` links this message to its `ToolCall`. `content` is what the
 * model sees; a failed tool sets `isError` and returns the failure text as
 * content so the model can correct itself within the same run.
 */
export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: ContentBlock[];
  isError: boolean;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Stop reasons
// ---------------------------------------------------------------------------

/**
 * Why a single model response ended. Mirrors what providers report, normalised
 * across them.
 */
export type StopReason =
  /** The model finished its turn. */
  | "stop"
  /** Output token limit reached. */
  | "length"
  /** The response contains tool calls to execute. */
  | "toolUse"
  /** Provider-side safety filter stopped generation. */
  | "contentFilter"
  /** The request failed; see the accompanying error. */
  | "error";

/**
 * Why a whole `run()` ended.
 *
 * Kept separate from `StopReason` because a run spans several responses: "the
 * model is done" and "we hit the turn limit" are different facts, and callers
 * need to tell them apart to decide whether to continue.
 */
export type RunStopReason =
  /** The model produced a response with no tool calls. */
  | "completed"
  /** `maxTurns` was reached while the model still wanted to run tools. */
  | "maxTurns"
  /** The caller's `AbortSignal` fired. */
  | "aborted"
  /** An unrecoverable error ended the run. */
  | "error";

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * Token accounting for one response or one run.
 *
 * Cache fields are separate rather than folded into `inputTokens` so an
 * embedding agent can report real cost: cached input is typically an order of
 * magnitude cheaper. `totalTokens` is stored rather than computed because
 * providers disagree on whether it includes cache reads.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Estimated spend in USD, when the adapter knows the model's price. */
  costUsd?: number;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Progress emitted by `run()` through `onEvent`.
 *
 * Events are the only streaming surface. The core does not render anything and
 * does not interpret payloads beyond tagging them, so an embedding agent can
 * log them, forward them to a UI, or ignore them entirely.
 *
 * Deltas arrive before the matching `assistant_message`; the assembled message
 * is always emitted, even when the consumer dropped every delta.
 */
export type AgentEvent =
  | RunStartEvent
  | TurnStartEvent
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | AssistantMessageEvent
  | ToolStartEvent
  | ToolUpdateEvent
  | ToolEndEvent
  | TurnEndEvent
  | RunEndEvent
  | ErrorEvent;

export interface RunStartEvent {
  type: "run_start";
  /** Number of messages in the transcript the run started from. */
  messageCount: number;
}

export interface TurnStartEvent {
  type: "turn_start";
  /** 1-based index of the turn within this run. */
  turn: number;
}

export interface TextDeltaEvent {
  type: "text_delta";
  turn: number;
  text: string;
}

export interface ThinkingDeltaEvent {
  type: "thinking_delta";
  turn: number;
  text: string;
}

export interface AssistantMessageEvent {
  type: "assistant_message";
  turn: number;
  message: AssistantMessage;
}

export interface ToolStartEvent {
  type: "tool_start";
  turn: number;
  toolCallId: string;
  toolName: string;
  /** Validated arguments. */
  args: unknown;
}

export interface ToolUpdateEvent {
  type: "tool_update";
  toolCallId: string;
  toolName: string;
  /** Partial output, for a UI that shows progress. */
  partial: string;
}

export interface ToolEndEvent {
  type: "tool_end";
  toolCallId: string;
  toolName: string;
  result: ToolResultMessage;
  durationMs: number;
}

export interface TurnEndEvent {
  type: "turn_end";
  turn: number;
  toolCallCount: number;
}

export interface RunEndEvent {
  type: "run_end";
  stopReason: RunStopReason;
  /** Cumulative usage across every response in the run. */
  usage: Usage;
  /** Full transcript, including the messages this run appended. */
  messages: Message[];
}

export interface ErrorEvent {
  type: "error";
  error: NormalizedError;
  /** Set when the error ended the run. */
  fatal: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * How an error should be handled, independent of who threw it.
 *
 * Providers express the same failures with wildly different shapes (HTTP
 * status, error codes, English message text). Adapters map them into this
 * taxonomy once, and everything above can make decisions without parsing
 * strings.
 */
export type ErrorKind =
  /** Bad or missing credentials. Not retryable. */
  | "auth"
  /** Provider rate limit. Retryable after a delay. */
  | "rateLimit"
  /** Provider is overloaded or returned 5xx. Retryable. */
  | "overloaded"
  /** The request itself was malformed. Not retryable. */
  | "invalidRequest"
  /** Prompt plus history exceeds the model's context window. Needs trimming. */
  | "contextOverflow"
  /** Connection failure, DNS error, reset. Retryable. */
  | "network"
  /** The caller's `AbortSignal` fired. Not an error in the usual sense. */
  | "aborted"
  /** Tool arguments did not match the tool's schema. Fed back to the model. */
  | "invalidToolCall"
  /** A tool threw or returned a failure. Fed back to the model. */
  | "toolFailed"
  /** Unclassified provider failure. */
  | "provider"
  /** Anything else. */
  | "unknown";

/** A provider or tool failure, normalised so callers can act on it. */
export interface NormalizedError {
  kind: ErrorKind;
  /** Human-readable message, safe to show in a log or feed back to the model. */
  message: string;
  /**
   * Whether retrying the same request could succeed. Derived from `kind`, but
   * stored explicitly because adapters occasionally know better (a specific
   * 429 with a long `retry-after`, for instance).
   */
  retryable: boolean;
  /** HTTP status when one applies. */
  status?: number;
  /** Provider name, when known. */
  provider?: string;
  /** Seconds the provider asked us to wait, from `retry-after` or equivalent. */
  retryAfterSeconds?: number;
  /** Original error, kept for logging. Never sent to the model. */
  cause?: unknown;
}
