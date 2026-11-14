import type { LLMRequest } from "../core/client.js";
import type { Message } from "../core/messages.js";
import type { Usage } from "../core/usage.js";

/** The latest model request, not cumulative usage for an entire Agent run. */
export interface LastRequestInfo {
  model: string;
  provider?: string;
  /** Absent if the request failed or its provider did not report usage. */
  usage?: Usage;
}

/** Snapshots provided before each model request, including turns after tools. */
export interface CompressionContext {
  messages: readonly Message[];
  request: LLMRequest;
  signal: AbortSignal | undefined;
  lastRequest: LastRequestInfo | undefined;
}

/** Application-owned trigger and compression algorithm. No default policy. */
export interface ContextCompressionStrategy {
  shouldCompress(context: CompressionContext): boolean | Promise<boolean>;
  compress(context: CompressionContext): readonly Message[] | Promise<readonly Message[]>;
}
