import type { Usage } from "./usage.js";

/**
 * The data model shared by every part of `agent-framework`.
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

/** An image supplied as inline Base64 or a remotely accessible URL. */
export type ImageBlock = Base64ImageBlock | UrlImageBlock;

/** Base64-encoded image, no data-URL prefix; stays JSON-serializable. */
export interface Base64ImageBlock {
  type: "image";
  /** e.g. `image/png`, `image/jpeg`. */
  mimeType: string;
  /** Base64 payload, without a `data:` prefix. */
  data: string;
  url?: never;
}

/** The provider fetches this URL; the core does not download the image. */
export interface UrlImageBlock {
  type: "image";
  /** A fully qualified HTTP(S) URL accessible to the model provider. */
  url: string;
  data?: never;
  mimeType?: never;
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
 * How hard the model should think before answering.
 *
 * Models that reason spend output tokens on reasoning before writing anything,
 * so this is a cost knob as much as a quality one: on DeepSeek a short factual
 * question cost 124 tokens at the default effort and 24 with reasoning off.
 *
 * `"none"` is not in DeepSeek's documented list, but it is not an invention
 * either: it turns reasoning off, which the documentation offers through
 * `thinking: { type: "disabled" }`. The adapter translates it to that form, so
 * the wire stays on the documented path while callers get one vocabulary.
 *
 * The remaining values are passed through unvalidated. A typo reaches the
 * provider and comes back as an invalid-request error naming the allowed values,
 * which is a better error message than a local whitelist could produce, and it
 * keeps new effort levels working without a release here.
 */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/** Internal message snapshot; opaque application details retain their ownership. */
export function copyMessages(messages: readonly Message[]): Message[] {
  return messages.map(message => {
    if (message.role !== "toolResult") return structuredClone(message);
    const { details, ...data } = message;
    const copy: ToolResultMessage = structuredClone(data);
    if ("details" in message) copy.details = details;
    return copy;
  });
}
