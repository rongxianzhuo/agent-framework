import { copyMessages, type ContentBlock, type Message } from "../core/messages.js";
import type { LLMClient, LLMEvent, LLMRequest, LLMStreamOptions } from "../core/client.js";
import { run, type RunOptions, type RunResult } from "./run.js";
import { describeTranscriptProblems, findTranscriptProblems } from "./transcript.js";
import type { CompressionContext, ContextCompressionStrategy, LastRequestInfo } from "./compression.js";
import type { BeforeRequestHook, RunHooks } from "./hooks.js";

/** Defaults for one conversation. Input/output and persistence belong to the caller. */
export interface AgentOptions extends Omit<RunOptions, "messages" | "signal"> {
  system?: string;
  /** Omit or set null to disable automatic context compression. */
  contextCompression?: ContextCompressionStrategy | null;
}

/** Overrides for one execution; omitted fields keep the agent's defaults. */
export type AgentRunOptions = Omit<RunOptions, "client" | "model" | "messages" | "tools">;

/** A text input or structured user content, including images. */
export type AgentInput = string | readonly ContentBlock[];

/**
 * One conversation, driven by the same stateless run() loop.
 *
 * Message data is copied; opaque tool-result details remain caller-owned and
 * are kept by reference. No conversation state is shared across instances.
 */
export class Agent {
  readonly #defaults: Omit<RunOptions, "messages" | "signal">;
  readonly #initialMessages: Message[];
  readonly #compression: ContextCompressionStrategy | null | undefined;
  #messages: Message[];
  #lastRequest: LastRequestInfo | undefined;
  #running = false;

  constructor({ system, contextCompression, ...defaults }: AgentOptions) {
    const client = defaults.client;
    this.#defaults = {
      ...defaults,
      client: { name: client.name, stream: (request, options) => this.#stream(client, request, options) },
    };
    this.#compression = contextCompression;
    if (defaults.tools !== undefined) this.#defaults.tools = [...defaults.tools];
    this.#initialMessages = system === undefined
      ? []
      : [{ role: "system", content: [{ type: "text", text: system }] }];
    this.#messages = copyMessages(this.#initialMessages);
  }

  /** A message snapshot for inspection or persistence; opaque details stay by reference. */
  get messages(): Message[] {
    return copyMessages(this.#messages);
  }

  /** Latest request snapshot, retained across runs; usage may be unknown. */
  get lastRequest(): LastRequestInfo | undefined {
    return this.#lastRequest === undefined ? undefined : structuredClone(this.#lastRequest);
  }

  /** Restore a complete transcript, including any system messages. */
  replaceMessages(messages: readonly Message[]): void {
    this.#assertIdle();
    this.#assertComplete(messages);
    this.#messages = copyMessages(messages);
    this.#lastRequest = undefined;
  }

  /** Start over with the constructor's system prompt and configuration. */
  reset(): void {
    this.#assertIdle();
    this.#messages = copyMessages(this.#initialMessages);
    this.#lastRequest = undefined;
  }

  /**
   * Append user input and execute, or omit input to continue existing history.
   * Returned errors/aborts retain their transcript. An unanswered tool call
   * blocks the next run until the caller supplies results via replaceMessages()
   * or resets the conversation; tools are never automatically replayed.
   */
  async run(input?: AgentInput, options: AgentRunOptions = {}): Promise<RunResult> {
    this.#assertIdle();
    this.#assertComplete(this.#messages);
    this.#running = true;
    try {
      const messages = this.messages;
      if (input !== undefined) {
        const content = typeof input === "string" ? [{ type: "text" as const, text: input }] : [...input];
        messages.push({ role: "user", content: structuredClone(content) });
      }
      const settings = { ...this.#defaults, ...options, messages };
      if (this.#compression != null) settings.hooks = this.#compressionHooks(settings.hooks, this.#compression);
      const result = await run(settings);
      this.#messages = copyMessages(result.messages);
      return result;
    } finally {
      this.#running = false;
    }
  }

  #compressionHooks(hooks: RunHooks | undefined, strategy: ContextCompressionStrategy): RunHooks {
    const compress: BeforeRequestHook = async ({ request, signal }) => {
      const messages = copyMessages(request.messages);
      const context: CompressionContext = {
        messages,
        request: { ...request, messages, tools: structuredClone(request.tools) },
        signal,
        lastRequest: this.lastRequest,
      };
      if (request.providerOptions !== undefined) {
        context.request.providerOptions = structuredClone(request.providerOptions);
      }
      if (!await strategy.shouldCompress(context) || signal?.aborted) return;
      return {
        request: { ...request, messages: await strategy.compress(context) },
        replaceHistory: true,
      };
    };
    const before = hooks?.onBeforeRequest;
    return {
      ...hooks,
      onBeforeRequest: [compress, ...(before === undefined ? [] : Array.isArray(before) ? before : [before])],
    };
  }

  async *#stream(client: LLMClient, request: LLMRequest, options?: LLMStreamOptions): AsyncGenerator<LLMEvent> {
    const info: LastRequestInfo = { model: request.model, provider: client.name };
    this.#lastRequest = info;
    try {
      for await (const event of client.stream(request, options)) {
        if (event.type === "done") {
          this.#lastRequest = { ...info, provider: event.message.provider ?? client.name };
          if (event.message.usage !== undefined && event.message.stopReason !== "error") {
            this.#lastRequest.usage = structuredClone(event.message.usage);
          }
        } else if (event.type === "error") {
          this.#lastRequest = info;
        }
        yield event;
      }
    } catch (error) {
      this.#lastRequest = info;
      throw error;
    }
  }

  #assertIdle(): void {
    if (this.#running) throw new Error("This Agent is already running. Wait for it to finish or use another instance.");
  }

  #assertComplete(messages: readonly Message[]): void {
    const problems = findTranscriptProblems(messages);
    if (problems.length > 0) {
      throw new Error(`${describeTranscriptProblems(problems)} Supply the missing results with replaceMessages() or reset() before continuing.`);
    }
  }
}
