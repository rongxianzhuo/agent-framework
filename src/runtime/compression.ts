import type { Message } from "../core/messages.js";
import type { Usage } from "../core/usage.js";

/** The latest model request, not cumulative usage for an entire Agent run. */
export interface LastRequestInfo {
  model: string;
  provider?: string;
  /** Absent if the request failed or its provider did not report usage. */
  usage?: Usage;
}

/**
 * What a strategy sees at the end of a turn.
 *
 * This is the moment the response has arrived and any tool results are already in
 * the transcript, so `usage` is the exact cost of the request that just finished
 * and `messages` is exactly what the next request would send. Measuring here
 * avoids the lag of reading a previous request's usage before sending the next.
 */
export interface CompressionContext {
  /** The transcript after this turn: the response, plus any tool results. */
  messages: readonly Message[];
  /** Usage the provider reported for the response that ended this turn. */
  usage: Usage | undefined;
  /** 1-based turn index within the run. */
  turn: number;
  signal: AbortSignal | undefined;
}

/**
 * Application-owned trigger and compression algorithm. No default policy beyond
 * `createSummarizingCompression()`.
 *
 * `compress` returns the whole transcript to continue from, including the leading
 * system message when there is one. Returning the messages unchanged declines to
 * compress this turn.
 */
export interface ContextCompressionStrategy {
  shouldCompress(context: CompressionContext): boolean | Promise<boolean>;
  compress(context: CompressionContext): readonly Message[] | Promise<readonly Message[]>;
}
