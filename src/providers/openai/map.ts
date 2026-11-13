/**
 * Message mapping between the core's model and OpenAI's Chat Completions shape.
 *
 * Both directions live here so a change to the wire format has one place to
 * happen. The rules that are not obvious:
 *
 * - The system prompt becomes a `system` message at the front. The core keeps it
 *   in the transcript like any other message; OpenAI wants it inline, so it is
 *   simply serialised in place, which preserves the caller's ordering.
 * - Thinking blocks are **dropped** on the way out. OpenAI does not accept
 *   reasoning content back and rejects unknown fields on some gateways. The
 *   transcript keeps them; only the wire loses them.
 * - Tool results are `role: "tool"` messages keyed by `tool_call_id`, and OpenAI
 *   requires every `tool_call` to be answered. The loop guarantees that, so the
 *   mapping does not need to invent placeholders.
 * - `args` is serialised back to a JSON string. If it is `undefined` (arguments
 *   that never parsed), an empty object is sent so the call still has a
 *   counterpart; the model then sees the tool's error result and retries.
 */

import type { Message, TextBlock } from "../../types.js";
import type { ToolSpec } from "../../client.js";

// ---------------------------------------------------------------------------
// Outbound: core messages -> OpenAI request
// ---------------------------------------------------------------------------

export type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | OpenAIContentPart[] }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAITool {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

export function toOpenAIMessages(messages: readonly Message[]): OpenAIMessage[] {
  return messages.map(toOpenAIMessage);
}

function toOpenAIMessage(message: Message): OpenAIMessage {
  switch (message.role) {
    case "system":
      return { role: "system", content: textOf(message.content) };

    case "user": {
      const images = message.content.filter((block) => block.type === "image");
      if (images.length === 0) return { role: "user", content: textOf(message.content) };

      // Mixed content needs the part array; plain text stays a string, which is
      // the form every compatible gateway understands.
      const parts: OpenAIContentPart[] = [];
      for (const block of message.content) {
        if (block.type === "text") parts.push({ type: "text", text: block.text });
        else if (block.type === "image") {
          parts.push({
            type: "image_url",
            image_url: { url: `data:${block.mimeType};base64,${block.data}` },
          });
        }
      }
      return { role: "user", content: parts };
    }

    case "assistant": {
      const toolCalls = message.toolCalls.map<OpenAIToolCall>((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.args ?? {}),
        },
      }));

      // `content: null` with tool calls is what OpenAI itself emits; an empty
      // string is rejected by some gateways when tool_calls is present.
      const text = textOf(message.content);
      const assistant: OpenAIMessage = {
        role: "assistant",
        content: text === "" ? null : text,
      };
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
      return assistant;
    }

    case "toolResult":
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: textOf(message.content),
      };
  }
}

/**
 * Concatenate the text blocks of a message.
 *
 * Thinking blocks are ignored rather than dropped silently from the caller's
 * data: they stay in the transcript, they just have no wire representation.
 */
function textOf(content: readonly { type: string }[]): string {
  return content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function toOpenAITools(tools: readonly ToolSpec[]): OpenAITool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      // The core's schema subset is valid JSON Schema; OpenAI accepts it as is.
      parameters: tool.parameters,
    },
  }));
}

// ---------------------------------------------------------------------------
// Inbound: OpenAI stream chunk -> values
// ---------------------------------------------------------------------------

export interface OpenAIStreamChunk {
  id?: string;
  model?: string;
  choices?: {
    index?: number;
    delta?: {
      content?: string | null;
      /** Reasoning text from gateways that expose it (DeepSeek, others). */
      reasoning_content?: string | null;
      /** Some gateways use this spelling. */
      reasoning?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
  error?: { message?: string; type?: string; code?: string };
}

/** The finish reasons that mean something to the core. */
export function mapFinishReason(reason: string | null | undefined): "stop" | "length" | "toolUse" | "contentFilter" | "error" {
  switch (reason) {
    case "stop":
    case null:
    case undefined:
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "toolUse";
    case "content_filter":
      return "contentFilter";
    default:
      return "stop";
  }
}
