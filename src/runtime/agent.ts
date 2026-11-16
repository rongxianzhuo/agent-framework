import { copyMessages, type ContentBlock, type Message } from "../core/messages.js";
import type { LLMClient, LLMEvent, LLMRequest, LLMStreamOptions } from "../core/client.js";
import { run, type RunOptions, type RunResult } from "./run.js";
import { describeTranscriptProblems, findTranscriptProblems } from "./transcript.js";
import type { CompressionContext, ContextCompressionStrategy, LastRequestInfo } from "./compression.js";
import type { BeforeRequestHook, RunHooks } from "./hooks.js";
import { loadHistory, saveHistory } from "./history.js";
import { resolve } from "node:path";

/** Defaults for one conversation, with optional JSON history persistence. */
export interface AgentOptions extends Omit<RunOptions, "messages" | "signal"> {
  system?: string;
  /** Omit or set null to disable automatic context compression. */
  contextCompression?: ContextCompressionStrategy | null;
  /** Load history and save the full non-system transcript after each completed run. */
  historyFile?: string;
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
  /** Mutable: replaceMessages() can install a different prompt or drop it. */
  #system: string | undefined;
  readonly #compression: ContextCompressionStrategy | null | undefined;
  readonly #historyFile: string | undefined;
  #messages: Message[];
  #lastRequest: LastRequestInfo | undefined;
  #running = false;

  constructor({ system, contextCompression, historyFile, ...defaults }: AgentOptions) {
    const client = defaults.client;
    this.#defaults = {
      ...defaults,
      client: { name: client.name, stream: (request, options) => this.#stream(client, request, options) },
    };
    this.#compression = contextCompression;
    if (defaults.tools !== undefined) this.#defaults.tools = [...defaults.tools];
    this.#system = system;
    this.#historyFile = historyFile === undefined ? undefined : resolve(historyFile);
    this.#messages = this.#historyFile === undefined ? [] : loadHistory(this.#historyFile);
    if (system !== undefined) this.#messages.unshift({ role: "system", content: [{ type: "text", text: system }] });
    this.#assertComplete(this.#messages);
  }

  /** A message snapshot for inspection or persistence; opaque details stay by reference. */
  get messages(): Message[] {
    return copyMessages(this.#messages);
  }

  /**
   * The current system prompt, without the message wrapper.
   *
   * `messages` includes it as a leading system message, so this is the other half
   * of what `replaceMessages()` takes apart. Undefined when there is none.
   */
  get system(): string | undefined {
    return this.#system;
  }

  /** Latest request snapshot, retained across runs; usage may be unknown. */
  get lastRequest(): LastRequestInfo | undefined {
    return this.#lastRequest === undefined ? undefined : structuredClone(this.#lastRequest);
  }

  /**
   * Restore a conversation: its system prompt and its messages, separately.
   *
   * The prompt is required and must not be blank. A conversation always has one,
   * so there is no "no prompt" state to express here; an empty or whitespace-only
   * string is rejected rather than silently becoming a prompt that says nothing.
   *
   * `messages` must not contain system messages — the prompt is `systemPrompt`
   * and nothing else, so a transcript carrying its own would be ambiguous.
   *
   * Every check runs before any field is written, so a rejected call leaves the
   * agent exactly as it was. Tool-call/result pairing is checked the same way.
   */
  replaceMessages(systemPrompt: string, messages: readonly Message[]): void {
    this.#assertIdle();

    if (typeof systemPrompt !== "string") {
      throw new TypeError(
        `replaceMessages() requires a system prompt string; received ${describeValue(systemPrompt)}.`,
      );
    }
    if (systemPrompt.trim() === "") {
      throw new Error("replaceMessages() requires a non-empty system prompt; the string was blank.");
    }

    const withSystem = messages.filter((message) => message.role === "system");
    if (withSystem.length > 0) {
      throw new Error(
        "replaceMessages() takes the system prompt as its first argument; " +
          `the messages array must not contain system messages (found ${withSystem.length}).`,
      );
    }

    const next: Message[] = [
      { role: "system", content: [{ type: "text", text: systemPrompt }] },
      ...copyMessages(messages),
    ];
    this.#assertComplete(next);

    this.#system = systemPrompt;
    this.#messages = next;
    this.#lastRequest = undefined;
  }

  /**
   * Start over with the current system prompt and configuration.
   *
   * The prompt is configuration, not conversation: a `replaceMessages()` call
   * that installed a different one stays in effect here. An agent constructed
   * without a `system` option is the only way to have no prompt at all, and
   * `replaceMessages()` cannot create that state — it requires one.
   */
  reset(): void {
    this.#assertIdle();
    this.#messages = this.#system === undefined
      ? []
      : [{ role: "system", content: [{ type: "text", text: this.#system }] }];
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
      if (this.#historyFile !== undefined && result.stopReason === "completed") {
        await saveHistory(this.#historyFile, result.messages);
      }
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

/** Name a rejected argument's type for an error message, without echoing its value. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return typeof value;
}

