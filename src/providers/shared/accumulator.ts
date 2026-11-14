import type { LLMEvent } from "../../core/client.js";
import type { AssistantMessage, ContentBlock, StopReason, ToolCall } from "../../core/messages.js";
import type { Usage } from "../../core/usage.js";

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
