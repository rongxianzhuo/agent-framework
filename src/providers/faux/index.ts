/**
 * A scripted provider for tests, examples, and conformance runs.
 *
 * The loop and the tool layer are about control flow, so their tests should not
 * depend on a model's mood. A faux client answers from a script: each turn says
 * what the "model" replies with, and the client streams it exactly as a real
 * adapter would — text in chunks, tool arguments in fragments — so anything
 * built on top is exercised against a realistic event stream.
 *
 * It is an ordinary `LLMClient`, so it plugs into `run` with no special casing.
 * Embedding agents are expected to use it for their own tests.
 */

import { toNormalizedError } from "../../core/errors.js";
import { MessageAccumulator } from "../shared/accumulator.js";
import type { LLMClient, LLMEvent, LLMRequest } from "../../core/client.js";
import type { StopReason, ToolCall } from "../../core/messages.js";
import type { Usage } from "../../core/usage.js";

/** What the faux model does on one turn. */
export interface FauxTurn {
  /** Visible reply text. */
  text?: string;
  /** Reasoning text, emitted as a thinking block ahead of the reply. */
  thinking?: string;
  /** Tool calls to request. Arguments are streamed as JSON fragments. */
  toolCalls?: ToolCall[];
  /** Defaults to `toolUse` when there are tool calls, `stop` otherwise. */
  stopReason?: StopReason;
  /** Reported usage. Estimated from the text when omitted. */
  usage?: Usage;
  /** Emit this error instead of a reply. */
  error?: { kind: Parameters<typeof toNormalizedError>[0]; message: string };
  /** Milliseconds to wait before producing anything. */
  delayMs?: number;
  /** Split text and arguments into pieces of this many characters. */
  chunkSize?: number;
  /**
   * Milliseconds to wait between pieces. Streaming slowly is what makes a faux
   * turn cancellable mid-flight, which is how the abort path gets exercised.
   */
  chunkDelayMs?: number;
}

export interface FauxOptions {
  /**
   * The script. Either a fixed list, or a function of the request — the latter
   * lets one faux client answer a whole conformance run without a fixture per
   * prompt.
   */
  turns: readonly FauxTurn[] | ((request: LLMRequest, index: number) => FauxTurn | Promise<FauxTurn>);
  /** Provider name reported on messages and errors. */
  name?: string;
  /** What to do when a list script runs out of turns. */
  onExhausted?: "error" | "repeatLast";
  /** Default chunk size for turns that do not set one. 0 disables chunking. */
  chunkSize?: number;
  /** Model name stamped on every assistant message. */
  model?: string;
}

export interface FauxClient extends LLMClient {
  /** Every request the client received, in order. Useful for assertions. */
  readonly requests: LLMRequest[];
  /** Rewind the script to the first turn and clear the request log. */
  reset(): void;
}

/**
 * Build a scripted client.
 *
 * Token counts are estimated at four characters per token when a turn does not
 * report usage. That is a rough approximation and is documented as such: the
 * point is to exercise accumulation and reporting, not to model billing.
 */
export function fauxClient(options: FauxOptions): FauxClient {
  const name = options.name ?? "faux";
  const requests: LLMRequest[] = [];
  let index = 0;
  let lastTurn: FauxTurn | undefined;

  const client: FauxClient = {
    name,
    requests,
    reset() {
      index = 0;
      lastTurn = undefined;
      requests.length = 0;
    },
    async *stream(request: LLMRequest, streamOptions?: { signal?: AbortSignal }): AsyncGenerator<LLMEvent> {
      requests.push(request);
      const position = index;
      index += 1;

      const turn = await resolveTurn(options, request, position, lastTurn);
      if (turn === undefined) {
        yield {
          type: "error",
          error: toNormalizedError(
            "provider",
            `${name}: no scripted response for turn ${position + 1}. Add a turn or use a function script.`,
          ),
        };
        return;
      }
      lastTurn = turn;

      if (turn.delayMs !== undefined && turn.delayMs > 0) {
        await sleep(turn.delayMs);
      }
      if (streamOptions?.signal?.aborted) {
        yield { type: "error", error: toNormalizedError("aborted", `${name}: aborted before responding.`) };
        return;
      }

      if (turn.error !== undefined) {
        yield { type: "error", error: toNormalizedError(turn.error.kind, turn.error.message) };
        return;
      }

      const size = turn.chunkSize ?? options.chunkSize ?? 0;
      const accumulator = new MessageAccumulator();

      const emit = function* (event: LLMEvent): Generator<LLMEvent> {
        accumulator.push(event);
        yield event;
      };

      // Between pieces, honour cancellation the way a real adapter's socket read
      // does: stop mid-stream rather than finishing work nobody will read.
      const pause = async (): Promise<boolean> => {
        if (turn.chunkDelayMs === undefined || turn.chunkDelayMs <= 0) return true;
        await sleep(turn.chunkDelayMs);
        return streamOptions?.signal?.aborted !== true;
      };

      if (turn.thinking !== undefined && turn.thinking !== "") {
        for (const piece of pieces(turn.thinking, size)) {
          if (!(await pause())) return;
          yield* emit({ type: "thinking_delta", text: piece });
        }
      }

      if (turn.text !== undefined && turn.text !== "") {
        for (const piece of pieces(turn.text, size)) {
          if (!(await pause())) return;
          yield* emit({ type: "text_delta", text: piece });
        }
      }

      for (const [callIndex, call] of (turn.toolCalls ?? []).entries()) {
        yield* emit({ type: "tool_call_delta", index: callIndex, id: call.id, name: call.name });
        // Stream the arguments as JSON fragments, the way real providers do, so
        // the accumulator and the loop see realistic input.
        for (const piece of pieces(JSON.stringify(call.args ?? {}), size)) {
          yield* emit({ type: "tool_call_delta", index: callIndex, argsDelta: piece });
        }
      }

      const stopReason =
        turn.stopReason ?? ((turn.toolCalls?.length ?? 0) > 0 ? "toolUse" : "stop");
      const usage = turn.usage ?? estimateUsage(request, turn);

      yield {
        type: "done",
        message: accumulator.build({
          stopReason,
          usage,
          model: options.model ?? request.model,
          provider: name,
        }),
      };
    },
  };

  return client;
}

async function resolveTurn(
  options: FauxOptions,
  request: LLMRequest,
  index: number,
  lastTurn: FauxTurn | undefined,
): Promise<FauxTurn | undefined> {
  if (typeof options.turns === "function") {
    return options.turns(request, index);
  }
  const turn = options.turns[index];
  if (turn !== undefined) return turn;
  if (options.onExhausted === "repeatLast") return lastTurn;
  return undefined;
}

/** Split into pieces of at most `size` characters; a size of 0 means one piece. */
function* pieces(text: string, size: number): Generator<string> {
  if (text === "") return;
  if (size <= 0) {
    yield text;
    return;
  }
  // Array.from so a surrogate pair is never cut in half.
  const characters = Array.from(text);
  for (let i = 0; i < characters.length; i += size) {
    yield characters.slice(i, i + size).join("");
  }
}

function estimateUsage(request: LLMRequest, turn: FauxTurn): Usage {
  const inputChars = request.messages.reduce((sum, message) => sum + messageLength(message), 0);
  const outputChars = (turn.text?.length ?? 0) + (turn.thinking?.length ?? 0);
  const inputTokens = Math.ceil(inputChars / 4);
  const outputTokens = Math.ceil(outputChars / 4);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: inputTokens + outputTokens,
  };
}

function messageLength(message: LLMRequest["messages"][number]): number {
  let length = 0;
  for (const block of message.content) {
    if (block.type === "text" || block.type === "thinking") length += block.text.length;
    else if (block.type === "image") length += block.data.length;
  }
  if (message.role === "assistant") {
    for (const call of message.toolCalls) length += JSON.stringify(call.args ?? {}).length;
  }
  if (message.role === "toolResult") length += message.toolName.length;
  return length;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
