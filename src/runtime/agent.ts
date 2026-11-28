import { copyMessages, type ContentBlock, type Message } from "../core/messages.js";
import type { LLMClient, LLMEvent, LLMRequest, LLMStreamOptions } from "../core/client.js";
import { run, type RunOptions, type RunResult } from "./run.js";
import { describeTranscriptProblems, findTranscriptProblems } from "./transcript.js";
import type { CompressionContext, ContextCompressionStrategy, LastRequestInfo } from "./compression.js";
import type { TurnEndHook, RunHooks } from "./hooks.js";
import { loadHistory, saveHistory } from "./history.js";
import { resolve } from "node:path";

/** Defaults for one conversation, with optional JSON history persistence. */
export interface AgentOptions extends Omit<RunOptions, "messages" | "signal"> {
  system: string;
  /** Omit or set null to disable automatic context compression. */
  contextCompression?: ContextCompressionStrategy | null;
  /** Load history and save the full non-system transcript after each completed run. */
  historyFile?: string;
}

/** Overrides for one execution; omitted fields keep the agent's defaults. */
export type AgentRunOptions = Omit<RunOptions, "client" | "model" | "messages" | "tools">;

/**
 * Overrides for `complete()`.
 *
 * The shape matches `AgentRunOptions`, but the defaults differ: the agent's own
 * `hooks` and `onEvent` are not inherited, so a stateless completion never runs
 * the conversation's interception points or reports into its event stream.
 */
export type AgentCompleteOptions = AgentRunOptions;

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
  readonly #client: LLMClient;
  #system: string;
  readonly #compression: ContextCompressionStrategy | null | undefined;
  readonly #historyFile: string | undefined;
  #messages: Message[];
  #lastRequest: LastRequestInfo | undefined;
  #running = false;

  constructor({ system, contextCompression, historyFile, ...defaults }: AgentOptions) {
    const prompt = requireSystemString(system, "new Agent()");
    const client = defaults.client;
    this.#client = client;
    this.#defaults = {
      ...defaults,
      client: { name: client.name, stream: (request, options) => this.#stream(client, request, options) },
    };
    this.#compression = contextCompression;
    if (defaults.tools !== undefined) this.#defaults.tools = [...defaults.tools];
    this.#system = prompt;
    this.#historyFile = historyFile === undefined ? undefined : resolve(historyFile);
    this.#messages = this.#historyFile === undefined ? [] : loadHistory(this.#historyFile);
    this.#messages.unshift({ role: "system", content: [{ type: "text", text: prompt }] });
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
   * of what `replaceMessages()` takes apart.
   */
  get system(): string {
    return this.#system;
  }

  /** Latest request snapshot, retained across runs; usage may be unknown. */
  get lastRequest(): LastRequestInfo | undefined {
    return this.#lastRequest === undefined ? undefined : structuredClone(this.#lastRequest);
  }

  /**
   * Restore a conversation: its system prompt and its messages, separately.
   *
   * The prompt is required and must be a string, but it may be empty: an empty
   * prompt is a conversation that says nothing up front, not a mistake.
   *
   * `messages` must not contain system messages — the prompt is `systemPrompt`
   * and nothing else, so a transcript carrying its own would be ambiguous.
   *
   * Every check runs before any field is written, so a rejected call leaves the
   * agent exactly as it was. Tool-call/result pairing is checked the same way.
   */
  replaceMessages(systemPrompt: string, messages: readonly Message[]): void {
    this.#assertIdle();
    const prompt = requireSystemString(systemPrompt, "replaceMessages()");

    const withSystem = messages.filter((message) => message.role === "system");
    if (withSystem.length > 0) {
      throw new Error(
        "replaceMessages() takes the system prompt as its first argument; " +
          `the messages array must not contain system messages (found ${withSystem.length}).`,
      );
    }

    const next: Message[] = [
      { role: "system", content: [{ type: "text", text: prompt }] },
      ...copyMessages(messages),
    ];
    this.#assertComplete(next);

    this.#system = prompt;
    this.#messages = next;
    this.#lastRequest = undefined;
  }

  /**
   * Start over with the current system prompt and configuration.
   *
   * The prompt is configuration, not conversation: a `replaceMessages()` call
   * that installed a different one stays in effect here.
   */
  reset(): void {
    this.#assertIdle();
    this.#messages = [{ role: "system", content: [{ type: "text", text: this.#system }] }];
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

  /**
   * Run one conversation from a transcript the caller supplies, without touching
   * this agent's own conversation.
   *
   * A stateless `run()` that reuses the agent's client, model, tools and sampling
   * settings. The whole loop applies, so a response that asks for tools gets them
   * executed and fed back until the model stops asking. What does not apply is
   * anything tied to this instance's state: `messages` and `lastRequest` are
   * untouched, compression is off, and the agent's default `hooks` and `onEvent`
   * are not inherited. Pass them per call if this completion needs them.
   *
   * `messages` is used as given, system prompt included: the agent's own `system`
   * is not prepended and no system message is added when the transcript has none.
   * The same idle check as `run()` does not apply, so this may be called while the
   * agent is running.
   */
  async complete(messages: readonly Message[], options: AgentCompleteOptions = {}): Promise<RunResult> {
    const { hooks: _defaultHooks, onEvent: _defaultOnEvent, ...defaults } = this.#defaults;
    return run({
      ...defaults,
      ...options,
      client: this.#client,
      messages: copyMessages(messages),
    });
  }

  #compressionHooks(hooks: RunHooks | undefined, strategy: ContextCompressionStrategy): RunHooks {
    const compress: TurnEndHook = async ({ messages, message, turn, signal }) => {
      const snapshot = copyMessages([...messages]);
      const context: CompressionContext = { messages: snapshot, usage: message.usage, turn, signal };
      if (!await strategy.shouldCompress(context) || signal?.aborted) return;
      const compressed = copyMessages([...(await strategy.compress(context))]);
      return compressed;
    };
    const ended = hooks?.onTurnEnd;
    return {
      ...hooks,
      onTurnEnd: [compress, ...(ended === undefined ? [] : Array.isArray(ended) ? ended : [ended])],
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

function requireSystemString(value: unknown, caller: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${caller} requires a system prompt string; received ${describeValue(value)}.`);
  }
  return value;
}

