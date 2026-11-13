/**
 * The loop.
 *
 * One function, `run`, which takes a transcript and drives it forward: ask the
 * model, run whatever tools it asked for, feed the results back, repeat until it
 * stops asking. That is the whole job, and this file is deliberately the only
 * place in the project that owns it.
 *
 * Things that are here because they cannot live anywhere else:
 *
 * - Turn accounting and `maxTurns`. A run spans several model calls; somebody
 *   has to count them.
 * - Appending to the transcript in an order the next request can use. Tool
 *   results must be in call order even when the calls ran in parallel.
 * - Cancellation. A signal has to reach both the model call and the tools.
 * - Usage accumulation across turns, since each response only reports its own.
 *
 * Things that are deliberately not here: retries (they belong to the adapter,
 * so two backoff policies never stack), context trimming (belongs to the caller
 * through `onEvent` plus its own transcript handling), rendering, persistence,
 * permissions, and any notion of a sub-agent.
 */

import {
  EMPTY_USAGE,
  addUsage,
  normalizeThrown,
  toToolSpec,
  type LLMClient,
  type LLMRequest,
} from "./client.js";
import { executeTool, type ToolContext, type ToolDefinition } from "./tools.js";
import type {
  AgentEvent,
  AssistantMessage,
  Message,
  NormalizedError,
  RunStopReason,
  Usage,
} from "./types.js";

/** Options for one `run`. */
export interface RunOptions {
  client: LLMClient;
  model: string;

  /**
   * The transcript to continue from, including a leading system message if the
   * agent has one. Not mutated: `run` appends to a copy and returns the result.
   */
  messages: readonly Message[];

  /** Tools offered to the model this run. Omit for a chat-only run. */
  tools?: readonly ToolDefinition<never>[];

  /**
   * Cancels the run. Reaches the in-flight model call and every running tool.
   * A run cancelled this way returns with `stopReason: "aborted"` and does not
   * append results from tools that were interrupted.
   */
  signal?: AbortSignal;

  /**
   * Maximum model calls in this run. Defaults to unlimited: a model that keeps
   * working is not an error, and a fixed ceiling would truncate long tasks. Set
   * a value when a run must finish inside a budget.
   */
  maxTurns?: number;

  /**
   * Run the tools requested in one response concurrently. Defaults to `true`.
   * Turn it off when tools share a resource and ordering matters; the transcript
   * order is unaffected either way.
   */
  parallelTools?: boolean;

  /** Progress callback. Awaited, so an async logger applies backpressure. */
  onEvent?: (event: AgentEvent) => void | Promise<void>;

  maxOutputTokens?: number;
  temperature?: number;
  /** Forwarded to the adapter untouched. */
  providerOptions?: Record<string, unknown>;
}

/** The outcome of one run. */
export interface RunResult {
  /**
   * The full transcript: the input messages followed by everything this run
   * appended. Persist this; pass it back in to continue the conversation.
   */
  messages: Message[];
  /** Cumulative usage over every model call in the run. */
  usage: Usage;
  /** Number of model calls made. */
  turns: number;
  stopReason: RunStopReason;
  /** Present when `stopReason` is `"error"` or `"aborted"`. */
  error?: NormalizedError;
}

/**
 * Drive one run to completion.
 *
 * Never throws for model or tool failures: they come back in the result, with
 * `onEvent` having already reported them. A thrown exception from `run` itself
 * means a programming error — a malformed tool definition, a client that
 * violates the contract by not emitting `done`.
 */
export async function run(options: RunOptions): Promise<RunResult> {
  const {
    client,
    model,
    tools = [],
    signal,
    maxTurns = Number.POSITIVE_INFINITY,
    parallelTools = true,
    onEvent,
    maxOutputTokens,
    temperature,
    providerOptions,
  } = options;

  const emit = async (event: AgentEvent): Promise<void> => {
    await onEvent?.(event);
  };

  // Copy, so the caller's array is untouched. Everything below appends to this.
  const messages: Message[] = [...options.messages];
  const specs = toToolSpec(tools);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  let usage = EMPTY_USAGE;
  let turns = 0;

  await emit({ type: "run_start", messageCount: messages.length });

  const finish = async (
    stopReason: RunStopReason,
    error?: NormalizedError,
  ): Promise<RunResult> => {
    if (error !== undefined) {
      await emit({ type: "error", error, fatal: stopReason === "error" });
    }
    await emit({ type: "run_end", stopReason, usage, messages });
    const result: RunResult = { messages, usage, turns, stopReason };
    if (error !== undefined) result.error = error;
    return result;
  };

  while (turns < maxTurns) {
    if (signal?.aborted) {
      return finish("aborted", abortedError("The run was cancelled before the next turn."));
    }

    turns += 1;
    await emit({ type: "turn_start", turn: turns });

    // A snapshot, not the live array: an adapter may keep the request for
    // logging, and must not see it grow as the run continues.
    const request: LLMRequest = { model, messages: [...messages], tools: specs };
    if (maxOutputTokens !== undefined) request.maxOutputTokens = maxOutputTokens;
    if (temperature !== undefined) request.temperature = temperature;
    if (providerOptions !== undefined) request.providerOptions = providerOptions;

    // --- ask the model -----------------------------------------------------
    let assistant: AssistantMessage | undefined;
    try {
      assistant = await consumeStream(client, request, signal, turns, emit);
    } catch (thrown) {
      const error = normalizeThrown(thrown, client.name);
      // A cancelled run is an outcome, not a failure: report it as such so the
      // caller does not retry something it just stopped.
      return finish(error.kind === "aborted" ? "aborted" : "error", error);
    }

    if (assistant === undefined) {
      return finish(
        "error",
        normalizeThrown(
          new Error(`Client "${client.name}" ended the stream without emitting a done or error event.`),
          client.name,
        ),
      );
    }

    messages.push(assistant);
    usage = addUsage(usage, assistant.usage);
    await emit({ type: "assistant_message", turn: turns, message: assistant });

    if (assistant.stopReason === "error") {
      const error = normalizeThrown(
        new Error(`The model call failed: ${assistant.provider ?? client.name} reported an error.`),
        client.name,
      );
      return finish("error", error);
    }

    // --- stop when the model stops asking for tools ------------------------
    if (assistant.toolCalls.length === 0) {
      await emit({ type: "turn_end", turn: turns, toolCallCount: 0 });
      return finish("completed");
    }

    // --- run the tools -----------------------------------------------------
    const contexts = assistant.toolCalls.map<ToolContext>((call) => {
      const ctx: ToolContext = { callId: call.id, turn: turns };
      if (signal !== undefined) ctx.signal = signal;
      return ctx;
    });

    for (const [index, call] of assistant.toolCalls.entries()) {
      const ctx = contexts[index]!;
      // Progress updates are fire-and-forget: a slow or throwing listener must
      // not stall a tool that is already running.
      ctx.onUpdate = (partial: string) => {
        const pending = onEvent?.({
          type: "tool_update",
          toolCallId: call.id,
          toolName: call.name,
          partial,
        });
        if (pending !== undefined) void pending.catch(() => {});
      };
      await emit({
        type: "tool_start",
        turn: turns,
        toolCallId: call.id,
        toolName: call.name,
        args: call.args,
      });
    }

    const executions = parallelTools
      ? await Promise.all(
          assistant.toolCalls.map((call, index) =>
            executeTool(byName.get(call.name), call, contexts[index]!),
          ),
        )
      : await runSequentially(assistant.toolCalls, byName, contexts);

    if (signal?.aborted) {
      // Results of a cancelled run are dropped rather than fed back: telling the
      // model "your tool was interrupted" invites it to redo work the caller
      // just cancelled.
      return finish("aborted", abortedError("The run was cancelled while tools were executing."));
    }

    // --- assemble the results, in call order -------------------------------
    let toolCallCount = 0;
    for (const [index, execution] of executions.entries()) {
      const call = assistant.toolCalls[index]!;

      if (execution.aborted) {
        return finish("aborted", execution.error);
      }

      // An unknown tool or invalid arguments still produce a result: the model
      // needs to see why its call failed so it can correct course next turn.
      messages.push(execution.message);
      toolCallCount += 1;

      await emit({
        type: "tool_end",
        toolCallId: call.id,
        toolName: call.name,
        result: execution.message,
        durationMs: execution.durationMs,
      });

      if (execution.error !== undefined && execution.error.kind !== "invalidToolCall") {
        // A tool that failed is reported, but does not end the run: the model
        // may retry, switch approach, or explain the failure.
        await emit({ type: "error", error: execution.error, fatal: false });
      }
    }

    await emit({ type: "turn_end", turn: turns, toolCallCount });
  }

  return finish("maxTurns");
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * Drain one model call, forwarding deltas and returning the assembled message.
 *
 * Returns `undefined` when the stream ended without a `done` (a contract
 * violation, reported by the caller) and throws the normalised error when the
 * adapter emitted an `error` event.
 */
async function consumeStream(
  client: LLMClient,
  request: LLMRequest,
  signal: AbortSignal | undefined,
  turn: number,
  emit: (event: AgentEvent) => Promise<void>,
): Promise<AssistantMessage | undefined> {
  const stream = client.stream(request, signal === undefined ? {} : { signal });
  let done: AssistantMessage | undefined;

  for await (const event of stream) {
    if (signal?.aborted) break;

    switch (event.type) {
      case "text_delta":
        await emit({ type: "text_delta", turn, text: event.text });
        break;
      case "thinking_delta":
        await emit({ type: "thinking_delta", turn, text: event.text });
        break;
      case "tool_call_delta":
        // Adapter bookkeeping; the assembled call arrives in `done`.
        break;
      case "done":
        done = event.message;
        break;
      case "error":
        throw event.error;
    }
  }

  if (signal?.aborted) {
    const error = abortedError("The model stream was cancelled.");
    throw error;
  }

  return done;
}

async function runSequentially(
  calls: readonly { id: string; name: string; args: unknown }[],
  byName: Map<string, ToolDefinition<never>>,
  contexts: readonly ToolContext[],
): Promise<Awaited<ReturnType<typeof executeTool>>[]> {
  const results: Awaited<ReturnType<typeof executeTool>>[] = [];
  for (const [index, call] of calls.entries()) {
    results.push(await executeTool(byName.get(call.name), call, contexts[index]!));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function abortedError(message: string): NormalizedError {
  return { kind: "aborted", message, retryable: false };
}
