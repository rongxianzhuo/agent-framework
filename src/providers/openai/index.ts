/**
 * The OpenAI Chat Completions adapter.
 *
 * One implementation of `LLMClient` speaking `POST /chat/completions`. Because
 * that endpoint is the de-facto interface for a dozen other services, the same
 * adapter works against any gateway that accepts the same body — the only thing
 * that varies is `baseURL`.
 *
 * Choices worth knowing about:
 *
 * - **No SDK.** `fetch` is built into Node 22, and an SDK would put a vendor
 *   dependency in the tree of every embedding agent. The cost is writing the SSE
 *   loop ourselves, which is thirty lines and now covered by tests.
 * - **`fetch` is injectable.** Adapter behaviour is testable offline against
 *   recorded chunks; without this, every test would need a key and a network.
 * - **No default `baseURL` or `model`.** Guessing a default here produces the
 *   worst kind of bug: everything works, against the wrong service.
 * - **Retries live here**, not in the loop: only for retryable kinds, honouring
 *   `retry-after`. Two layers of backoff would stack into an unpredictable delay.
 */

import { MessageAccumulator } from "../../client.js";
import { toNormalizedError } from "../../errors.js";
import type { LLMClient, LLMEvent, LLMRequest } from "../../client.js";
import type { NormalizedError, StopReason, Usage } from "../../types.js";
import { parseSSE } from "../sse.js";
import {
  mapFinishReason,
  toOpenAIMessages,
  toOpenAITools,
  type OpenAIStreamChunk,
} from "./map.js";

export interface OpenAIAdapterOptions {
  /**
   * API key. Defaults to `process.env.OPENAI_API_KEY`.
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
   * Retries for retryable failures (rate limit, overload, network). Defaults to
   * 0: a library must not silently repeat a request that costs money. Set it in
   * an agent that has a budget policy.
   */
  maxRetries?: number;
  /** Base delay for exponential backoff when the server sends no `retry-after`. */
  retryBaseMs?: number;
  /** Cap on backoff, so a long `retry-after` does not stall a run for minutes. */
  maxRetryDelayMs?: number;
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
  /** Requests attempted, including retries. Useful in tests and for logging. */
  readonly callCount: number;
}

export function openaiClient(options: OpenAIAdapterOptions): OpenAIAdapter {
  const baseURL = options.baseURL.trim().replace(/\/+$/, "");
  if (baseURL === "") {
    throw new Error("openaiClient requires a baseURL, e.g. https://api.openai.com/v1");
  }
  const name = options.name ?? "openai";
  const doFetch = options.fetch ?? globalThis.fetch;
  const maxRetries = options.maxRetries ?? 0;
  const retryBaseMs = options.retryBaseMs ?? 500;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 20_000;
  const includeUsage = options.includeUsage ?? true;
  const maxTokensField = options.maxTokensField ?? "max_tokens";

  let callCount = 0;

  const adapter: OpenAIAdapter = {
    name,
    get callCount() {
      return callCount;
    },
    async *stream(request: LLMRequest, streamOptions?: { signal?: AbortSignal }): AsyncGenerator<LLMEvent> {
      let attempt = 0;

      while (true) {
        callCount += 1;
        // Track whether this attempt already put events on the wire. A failure
        // after the first delta cannot be retried: replaying the attempt would
        // duplicate text the consumer has already displayed and counted.
        let emitted = false;

        try {
          for await (const event of attemptStream({
            baseURL,
            name,
            doFetch,
            apiKey: options.apiKey ?? readEnv("OPENAI_API_KEY"),
            headers: options.headers,
            includeUsage,
            maxTokensField,
            bodyDefaults: options.bodyDefaults,
            request,
            signal: streamOptions?.signal,
          })) {
            emitted = true;
            yield event;
          }
          return;
        } catch (thrown) {
          const error = classifyError(thrown, name);

          const retryable = error.retryable && error.kind !== "aborted" && !emitted;
          if (!retryable || attempt >= maxRetries) {
            yield { type: "error", error };
            return;
          }

          const delay = Math.min(
            maxRetryDelayMs,
            error.retryAfterSeconds !== undefined
              ? error.retryAfterSeconds * 1000
              : retryBaseMs * 2 ** attempt,
          );
          attempt += 1;

          // An aborted signal during backoff must end the run, not sleep on.
          if (streamOptions?.signal?.aborted) {
            yield { type: "error", error: toNormalizedError("aborted", `${name}: aborted during retry backoff.`) };
            return;
          }
          await sleep(delay);
        }
      }
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// One attempt
// ---------------------------------------------------------------------------

interface AttemptInput {
  baseURL: string;
  name: string;
  doFetch: typeof fetch;
  apiKey: string | undefined;
  headers: Record<string, string> | undefined;
  includeUsage: boolean;
  maxTokensField: "max_tokens" | "max_completion_tokens";
  bodyDefaults: Record<string, unknown> | undefined;
  request: LLMRequest;
  signal: AbortSignal | undefined;
}

async function* attemptStream(input: AttemptInput): AsyncGenerator<LLMEvent> {
  const { request, name } = input;

  const body: Record<string, unknown> = {
    model: request.model,
    messages: toOpenAIMessages(request.messages),
    stream: true,
  };
  if (request.tools.length > 0) body["tools"] = toOpenAITools(request.tools);
  if (request.maxOutputTokens !== undefined) body[input.maxTokensField] = request.maxOutputTokens;
  if (request.temperature !== undefined) body["temperature"] = request.temperature;
  if (input.includeUsage) body["stream_options"] = { include_usage: true };
  if (input.bodyDefaults !== undefined) Object.assign(body, input.bodyDefaults);
  // Per-request options win over adapter defaults: a caller overriding one
  // parameter for one call should not have to rebuild the client.
  if (request.providerOptions !== undefined) Object.assign(body, request.providerOptions);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
  };
  if (input.apiKey !== undefined && input.apiKey !== "") {
    headers["authorization"] = `Bearer ${input.apiKey}`;
  }
  if (input.headers !== undefined) Object.assign(headers, input.headers);

  const response = await input.doFetch(`${input.baseURL}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  if (!response.ok) {
    throw await responseError(response, name);
  }
  if (response.body === null) {
    throw toNormalizedError("provider", `${name}: the response had no body.`, { provider: name });
  }

  const accumulator = new MessageAccumulator();
  let stopReason: StopReason = "stop";
  let usage: Usage | undefined;

  for await (const message of parseSSE(response.body)) {
    const data = message.data.trim();
    if (data === "") continue;
    // `[DONE]` ends the stream. Gateways that never send it simply close the
    // socket, which is equally fine: what matters is that a message was
    // assembled and the stop reason is known.
    if (data === "[DONE]") break;

    let chunk: OpenAIStreamChunk;
    try {
      chunk = JSON.parse(data) as OpenAIStreamChunk;
    } catch {
      throw toNormalizedError("provider", `${name}: could not parse a stream chunk as JSON.`, {
        provider: name,
        cause: data,
      });
    }

    // Some gateways deliver errors inside a 200 stream.
    if (chunk.error !== undefined) {
      throw toNormalizedError("provider", `${name}: ${chunk.error.message ?? "unspecified stream error"}`, {
        provider: name,
        cause: chunk.error,
      });
    }

    if (chunk.usage !== null && chunk.usage !== undefined) {
      usage = toUsage(chunk.usage);
    }

    const choice = chunk.choices?.[0];
    if (choice === undefined) continue;

    const delta = choice.delta;
    if (delta !== undefined) {
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string" && reasoning !== "") {
        const event: LLMEvent = { type: "thinking_delta", text: reasoning };
        accumulator.push(event);
        yield event;
      }
      if (typeof delta.content === "string" && delta.content !== "") {
        const event: LLMEvent = { type: "text_delta", text: delta.content };
        accumulator.push(event);
        yield event;
      }
      for (const [position, call] of (delta.tool_calls ?? []).entries()) {
        const event: LLMEvent = {
          type: "tool_call_delta",
          // A gateway may omit `index`; fall back to position in the array.
          index: call.index ?? position,
        };
        if (call.id !== undefined) event.id = call.id;
        if (call.function?.name !== undefined) event.name = call.function.name;
        if (call.function?.arguments !== undefined) event.argsDelta = call.function.arguments;
        accumulator.push(event);
        yield event;
      }
    }

    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      stopReason = mapFinishReason(choice.finish_reason);
    }
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
}

function toUsage(raw: NonNullable<OpenAIStreamChunk["usage"]>): Usage {
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

/** An HTTP failure, carrying what the retry logic needs. */
class HTTPError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds: number | undefined,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "HTTPError";
  }
}

async function responseError(response: Response, provider: string): Promise<HTTPError> {
  let body: unknown;
  let detail = "";
  try {
    const text = await response.text();
    body = text;
    const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } };
    detail = parsed.error?.message ?? "";
  } catch {
    // Non-JSON error bodies happen with proxies and gateways.
  }

  const status = response.status;
  const message = detail !== "" ? `${provider} returned ${status}: ${detail}` : `${provider} returned ${status}`;
  return new HTTPError(message, status, parseRetryAfter(response.headers.get("retry-after")), body);
}

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  // `retry-after` is either seconds or an HTTP date; both appear in the wild.
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.round((date - Date.now()) / 1000));
}

/** Map anything thrown during an attempt onto the error taxonomy. */
function classifyError(thrown: unknown, provider: string): NormalizedError {
  if (thrown instanceof HTTPError) {
    const kind = httpStatusKind(thrown.status);
    const error = toNormalizedError(kind, thrown.message, { status: thrown.status, provider });
    if (thrown.retryAfterSeconds !== undefined) error.retryAfterSeconds = thrown.retryAfterSeconds;
    error.cause = thrown.body;
    return error;
  }

  if (thrown instanceof Error && (thrown.name === "AbortError" || thrown.name === "TimeoutError")) {
    return toNormalizedError("aborted", `${provider}: the request was aborted.`, { cause: thrown, provider });
  }

  if (thrown instanceof TypeError) {
    // fetch throws TypeError for DNS failures, refused connections and TLS
    // problems. All worth retrying, all indistinguishable from here.
    return toNormalizedError("network", `${provider}: ${thrown.message}`, { cause: thrown, provider });
  }

  if (isNormalized(thrown)) return thrown;

  const message = thrown instanceof Error ? thrown.message : String(thrown);
  return toNormalizedError("provider", `${provider}: ${message || "unknown failure"}`, {
    cause: thrown,
    provider,
  });
}

function httpStatusKind(status: number): NormalizedError["kind"] {
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

function isNormalized(value: unknown): value is NormalizedError {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "message" in value &&
    "retryable" in value
  );
}

function readEnv(key: string): string | undefined {
  const value = process.env[key];
  return value === undefined || value === "" ? undefined : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
