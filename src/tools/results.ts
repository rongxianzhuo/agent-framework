import type { ContentBlock, ToolCall, ToolResult, ToolResultMessage } from "../core/messages.js";

/**
 * Wrap a `ToolResult` in the transcript message it becomes.
 *
 * Exported because hooks produce results too — a denial or a cached answer is an
 * ordinary tool result with an unusual origin, and it must be wrapped
 * identically or the provider will not accept the transcript.
 */
export function toResultMessage(call: ToolCall, result: ToolResult): ToolResultMessage {
  const message: ToolResultMessage = {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: result.content,
    isError: result.isError ?? false,
  };
  if (result.details !== undefined) message.details = result.details;
  return message;
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

/** Wrap a string as a successful tool result. */
export function textResult(text: string, details?: unknown): ToolResult {
  const content: ContentBlock[] = [{ type: "text", text }];
  return details === undefined ? { content } : { content, details };
}

/** Wrap a structured value as pretty-printed JSON, with the value kept for the UI. */
export function jsonResult(value: unknown, indent = 2): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, indent) }], details: value };
}
