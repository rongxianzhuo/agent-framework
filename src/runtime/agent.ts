import { copyMessages, type ContentBlock, type Message } from "../core/messages.js";
import { run, type RunOptions, type RunResult } from "./run.js";
import { describeTranscriptProblems, findTranscriptProblems } from "./transcript.js";

/** Defaults for one conversation. Input/output and persistence belong to the caller. */
export interface AgentOptions extends Omit<RunOptions, "messages" | "signal"> {
  system?: string;
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
  #messages: Message[];
  #running = false;

  constructor({ system, ...defaults }: AgentOptions) {
    this.#defaults = { ...defaults };
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

  /** Restore a complete transcript, including any system messages. */
  replaceMessages(messages: readonly Message[]): void {
    this.#assertIdle();
    this.#assertComplete(messages);
    this.#messages = copyMessages(messages);
  }

  /** Start over with the constructor's system prompt and configuration. */
  reset(): void {
    this.#assertIdle();
    this.#messages = copyMessages(this.#initialMessages);
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
      const result = await run({ ...this.#defaults, ...options, messages });
      this.#messages = copyMessages(result.messages);
      return result;
    } finally {
      this.#running = false;
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
