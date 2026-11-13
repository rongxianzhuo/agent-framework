/**
 * The OpenAI Chat Completions adapter, built on the official `openai` package.
 *
 * One implementation of `LLMClient` speaking `POST /chat/completions`. Because
 * that endpoint is the de-facto interface for a dozen other services, the same
 * adapter works against any gateway that accepts the same body — the only thing
 * that varies is `baseURL`.
 *
 * Choices worth knowing about:
 *
 * - **The SDK owns the wire.** Request bodies, SSE framing, status handling and
 *   backoff all come from `openai` instead of from code here. That is a real
 *   runtime dependency, taken deliberately: it is the vendor's own library,
 *   maintained on the vendor's release cadence, and it turns protocol drift into
 *   a compile error instead of a runtime surprise.
 * - **Retries are the SDK's, and default to zero.** The SDK defaults to two
 *   retries; this adapter passes zero unless the caller asks, because a library
 *   must not silently repeat a request that costs money. The SDK also refuses to
 *   retry once a response body has started streaming, which is the rule this
 *   adapter used to enforce itself.
 * - **`fetch` is still injectable**, so adapter behaviour is testable offline
 *   against recorded chunks without a key or a network.
 * - **No default `baseURL` or `model`.** Guessing a default here produces the
 *   worst kind of bug: everything works, against the wrong service.
 */

import OpenAI from "openai";
import {
  APIError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
} from "openai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";

import { MessageAccumulator } from "../../client.js";
import { toNormalizedError } from "../../errors.js";
import type { LLMClient, LLMEvent, LLMRequest } from "../../client.js";
import type { NormalizedError, StopReason, Usage } from "../../types.js";
import { mapFinishReason, toOpenAIMessages, toOpenAITools } from "./map.js";

export interface OpenAIAdapterOptions {
  /**
   * API key. Defaults to the SDK's own resolution, which is
   * `process.env.OPENAI_API_KEY`.
   *
   * Read from the environment rather than hard-coded so a key never lands in a
   * repository or a log; pass it explicitly when several keys are in play.
   */
  apiKey?: string;
  /** Base URL up to and including the version segment, e.g. `https://api.openai.com/v1`. */
  baseURL: string;
  /**
   * Extra headers, for gateways that want their own auth or attribution header.
   * `Authorization` is set from `apiKey` unless overridden here.
   */
  headers?: Record<string, string>;
  /** Injected for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Retries for retryable failures (rate limit, overload, connection).
   *
   * Defaults to 0, unlike the SDK's own default of 2: a library must not silently
   * repeat a request that costs money. Set it in an agent that has a budget
   * policy. A failed attempt that already streamed output is never retried.
   */
  maxRetries?: number;
  /**
   * Per-request timeout in milliseconds, passed to the SDK.
   *
   * Unset by default, matching the SDK: a long tool-driven turn can legitimately
   * take minutes, and the caller's `AbortSignal` is the right way to bound it.
   */
  timeoutMs?: number;
  /**
   * Request `stream_options.include_usage`.
   *
   * On by default: without it OpenAI omits usage from streamed responses and
   * cost accounting silently reads zero. A gateway that rejects the field can
   * turn it off.
   */
  includeUsage?: boolean;
  /** Name reported on messages and errors. */
  name?: string;
  /**
   * Send `max_completion_tokens` instead of `max_tokens`.
   *
   * Newer OpenAI models require the former; older gateways only understand the
   * latter. Default is `max_tokens`.
   */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** Extra top-level body fields, merged last. */
  bodyDefaults?: Record<string, unknown>;
}

export interface OpenAIAdapter extends LLMClient {
  /** Streaming calls made. Retries inside the SDK are not counted separately. */
  readonly callCount: number;
}

export function openaiClient(options: OpenAIAdapterOptions): OpenAIAdapter {
  const baseURL = options.baseURL.trim().replace(/\/+$/, "");
  if (baseURL === "") {
    throw new Error("openaiClient requires a baseURL, e.g. https://api.openai.com/v1");
  }
  const name = options.name ?? "openai";
  const includeUsage = options.includeUsage ?? true;
  const maxTokensField = options.maxTokensField ?? "max_tokens";

  const sdk = new OpenAI({
    apiKey: options.apiKey ?? process.env["OPENAI_API_KEY"] ?? "",
    baseURL,
    // The SDK has its own default of 2. Passing 0 explicitly is the whole point.
    maxRetries: options.maxRetries ?? 0,
    ...(options.headers !== undefined ? { defaultHeaders: options.headers } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
  });

  let callCount = 0;

  const adapter: OpenAIAdapter = {
    name,
    get callCount() {
      return callCount;
    },
    async *stream(request: LLMRequest, streamOptions?: { signal?: AbortSignal }): AsyncGenerator<LLMEvent> {
      callCount += 1;

      const body: Record<string, unknown> = {
        model: request.model,
        messages: toOpenAIMessages(request.messages),
        stream: true,
      };
      if (request.tools.length > 0) body["tools"] = toOpenAITools(request.tools);
      if (request.maxOutputTokens !== undefined) body[maxTokensField] = request.maxOutputTokens;
      if (request.temperature !== undefined) body["temperature"] = request.temperature;
      if (includeUsage) body["stream_options"] = { include_usage: true };
      if (options.bodyDefaults !== undefined) Object.assign(body, options.bodyDefaults);
      // Per-request options win over adapter defaults: a caller overriding one
      // parameter for one call should not have to rebuild the client.
      if (request.providerOptions !== undefined) Object.assign(body, request.providerOptions);

      const accumulator = new MessageAccumulator();
      let stopReason: StopReason = "stop";
      let usage: Usage | undefined;

      try {
        // The cast is the seam: adapter-level extras (`providerOptions`,
        // `bodyDefaults`) are validated at runtime by the gateway, not by the
        // SDK's request type. Everything the adapter itself sets is typed.
        const stream = await sdk.chat.completions.create(
          body as unknown as Parameters<typeof sdk.chat.completions.create>[0],
          streamOptions?.signal !== undefined ? { signal: streamOptions.signal } : {},
        );

        for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
          if (chunk.usage !== null && chunk.usage !== undefined) {
            usage = toUsage(chunk.usage);
          }

          const choice = chunk.choices[0];
          if (choice === undefined) continue;

          const delta = choice.delta;
          if (delta !== undefined) {
            for (const event of deltaEvents(delta)) {
              accumulator.push(event);
              yield event;
            }
          }

          if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
            stopReason = mapFinishReason(choice.finish_reason);
          }
        }
      } catch (thrown) {
        yield { type: "error", error: classifyError(thrown, name) };
        return;
      }

      yield {
        type: "done",
        message: accumulator.build({
          stopReason,
          ...(usage !== undefined ? { usage } : {}),
          model: request.model,
          provider: name,
        }),
      };
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Stream deltas
// ---------------------------------------------------------------------------

/**
 * Reasoning text from gateways that expose it. The OpenAI API does not send
 * these, so they are not in the SDK's type; DeepSeek and others put reasoning in
 * `reasoning_content`, and a few use `reasoning`.
 */
type ReasoningDelta = {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: readonly {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
};

function* deltaEvents(delta: unknown): Generator<LLMEvent> {
  const d = delta as ReasoningDelta;

  const reasoning = d.reasoning_content ?? d.reasoning;
  if (typeof reasoning === "string" && reasoning !== "") {
    yield { type: "thinking_delta", text: reasoning };
  }
  if (typeof d.content === "string" && d.content !== "") {
    yield { type: "text_delta", text: d.content };
  }
  for (const [position, call] of (d.tool_calls ?? []).entries()) {
    const event: LLMEvent = {
      type: "tool_call_delta",
      // A gateway may omit `index`; fall back to position in the array.
      index: call.index ?? position,
    };
    if (call.id !== undefined) event.id = call.id;
    if (call.function?.name !== undefined) event.name = call.function.name;
    if (call.function?.arguments !== undefined) event.argsDelta = call.function.arguments;
    yield event;
  }
}

function toUsage(raw: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}): Usage {
  const inputTokens = raw.prompt_tokens ?? 0;
  const outputTokens = raw.completion_tokens ?? 0;
  const cacheReadTokens = raw.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    // OpenAI does not report cache writes separately; the field exists because
    // other providers do and the accounting shape must not change per provider.
    cacheWriteTokens: 0,
    totalTokens: raw.total_tokens ?? inputTokens + outputTokens,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Map anything thrown by the SDK onto the core's taxonomy.
 *
 * The SDK's error classes carry more information than an HTTP status; using them
 * is the reason to depend on it, so classification goes through them rather than
 * re-deriving the meaning of a number.
 */
function classifyError(thrown: unknown, provider: string): NormalizedError {
  if (thrown instanceof APIUserAbortError) {
    return toNormalizedError("aborted", `${provider}: the request was aborted.`, { provider, cause: thrown });
  }

  if (thrown instanceof APIConnectionTimeoutError) {
    return toNormalizedError("network", `${provider}: the request timed out.`, { provider, cause: thrown });
  }

  if (thrown instanceof APIConnectionError) {
    // DNS failure, refused connection, TLS problem, socket reset. All worth
    // retrying, all indistinguishable from here.
    return toNormalizedError("network", `${provider}: ${thrown.message}`, { provider, cause: thrown });
  }

  if (thrown instanceof APIError) {
    const status = typeof thrown.status === "number" ? thrown.status : undefined;
    const error = toNormalizedError(httpStatusKind(status), describe(thrown, provider), {
      ...(status !== undefined ? { status } : {}),
      provider,
      cause: thrown,
    });
    const retryAfter = parseRetryAfter(thrown.headers);
    if (retryAfter !== undefined) error.retryAfterSeconds = retryAfter;
    return error;
  }

  if (isAbortLike(thrown)) {
    return toNormalizedError("aborted", `${provider}: the request was aborted.`, { provider, cause: thrown });
  }

  const message = thrown instanceof Error ? thrown.message : String(thrown);
  return toNormalizedError("provider", `${provider}: ${message || "unknown failure"}`, {
    cause: thrown,
    provider,
  });
}

/** Use the server's own message when it sent one; it says more than our guess. */
function describe(error: APIError, provider: string): string {
  const detail = error.error !== undefined && error.error !== null && "message" in error.error
    ? String((error.error as { message?: unknown }).message ?? "")
    : "";
  if (detail !== "") return `${provider} returned ${String(error.status)}: ${detail}`;
  return `${provider} returned ${String(error.status)}: ${error.message}`;
}

function httpStatusKind(status: number | undefined): NormalizedError["kind"] {
  if (status === undefined) return "provider";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "invalidRequest";
  if (status === 408) return "network";
  if (status === 409) return "invalidRequest";
  if (status === 413) return "contextOverflow";
  if (status === 422) return "invalidRequest";
  if (status === 429) return "rateLimit";
  if (status >= 500) return "overloaded";
  if (status >= 400) return "invalidRequest";
  return "provider";
}

/**
 * `retry-after` is either seconds or an HTTP date, and the SDK surfaces it as a
 * `Headers` object. Never trust a gateway to send a number.
 */
function parseRetryAfter(headers: Headers | undefined): number | undefined {
  const header = headers?.get("retry-after");
  if (header === undefined || header === null) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;

  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.round((date - Date.now()) / 1000));
}

/** A DOMException named AbortError, from a signal that fired outside the SDK. */
function isAbortLike(value: unknown): boolean {
  return (
    value instanceof Error && (value.name === "AbortError" || value.name === "TimeoutError")
  );
}
