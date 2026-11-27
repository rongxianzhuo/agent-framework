import type { LLMClient, LLMRequest } from "../core/client.js";
import type { ContentBlock, Message } from "../core/messages.js";
import type { ContextCompressionStrategy } from "./compression.js";

/** Configuration for the bundled summarising strategy. */
export interface SummarizingCompressionOptions {
  /**
   * The client used for the summary request. Kept separate from the agent's
   * client on purpose: a cheaper model usually suffices, and reusing the
   * agent's client would report the summary request's own usage as the latest
   * request, hiding how large the real conversation had become.
   */
  client: LLMClient;
  /** Model for the summary request. Required, so the cost is never a surprise. */
  model: string;
  /** Compress when the latest request used at least this many tokens. */
  threshold: number;
  /**
   * Trailing messages left untouched. Defaults to 4, and must be at least 1 so
   * the current user turn never joins the part that gets summarised.
   */
  keepRecentMessages?: number;
}

/** Prefix that marks the summary inside the transcript. */
const SUMMARY_PREFIX = "[Earlier conversation summary]";

const DEFAULT_KEEP_RECENT_MESSAGES = 4;

/** The instruction appended to the messages being summarised. */
const SUMMARY_INSTRUCTION = [
  "Summarize the conversation above so the work can continue without it.",
  "Preserve the user's goal and constraints, the decisions made and their reasons,",
  "the files or resources touched and what changed, the current state of the task,",
  "and what remains to be done.",
  "If the conversation opens with an earlier summary, carry its facts forward.",
  "Reply with the summary only.",
].join(" ");

/**
 * Summarise the oldest part of the conversation once the request grows past a
 * token threshold.
 *
 * The result is an ordinary `ContextCompressionStrategy`, so it travels the same
 * path as a hand-written one: `Agent` runs it before each model request and its
 * output permanently replaces history.
 *
 * The summary enters the transcript as a single `user` message directly after
 * the system prompt, followed by the messages that were kept verbatim. It is an
 * ordinary message rather than part of the system prompt so that it survives
 * `saveHistory()`, which drops system messages, and `replaceMessages()`, which
 * takes the prompt separately. Because it is ordinary, the next compression
 * folds it into the following summary instead of needing separate state.
 *
 * The summary request carries the system prompt, then the dropped messages
 * exactly as they were, then one trailing instruction. The model reads the
 * conversation as it happened under the same instructions the agent ran under.
 *
 * Failures are silent by design: a summary request that fails leaves history
 * untouched and the run continues. Losing a completed turn to a secondary
 * request would be the worse outcome.
 */
export function createSummarizingCompression(
  options: SummarizingCompressionOptions,
): ContextCompressionStrategy {
  const client = requireClient(options.client);
  const threshold = requireThreshold(options.threshold);
  const keepRecent = requireKeepRecent(options.keepRecentMessages);
  const model = requireModel(options.model);

  return {
    shouldCompress(context) {
      const usage = context.lastRequest?.usage;
      if (usage === undefined) return false;
      if (usage.inputTokens + usage.outputTokens < threshold) return false;
      return chooseSplit(context.messages, keepRecent) !== undefined;
    },

    async compress(context) {
      const messages = context.messages;
      const split = chooseSplit(messages, keepRecent);
      if (split === undefined) return messages;
      const system = messages[0]?.role === "system" ? messages[0] : undefined;
      const dropped = messages.slice(system === undefined ? 0 : 1, split);
      const kept = messages.slice(split);

      let summary: string;
      try {
        summary = await requestSummary(client, {
          model,
          system,
          conversation: dropped,
          signal: context.signal,
        });
      } catch {
        return messages;
      }
      if (summary.length === 0) return messages;

      const replacement: Message[] = [];
      if (system !== undefined) replacement.push(system);
      replacement.push({
        role: "user",
        content: [{ type: "text", text: `${SUMMARY_PREFIX}\n${summary}` }],
      });
      replacement.push(...kept);
      return replacement;
    },
  };
}

/**
 * Index of the first message to keep, or `undefined` when nothing can be dropped.
 *
 * The cut follows two rules that the transcript validator would otherwise reject:
 * a kept region never starts with a tool result whose call was dropped, and a
 * dropped region never ends with a tool call whose results were kept. Both are
 * handled by moving the cut back to the owning assistant message.
 */
function chooseSplit(messages: readonly Message[], keepRecent: number): number | undefined {
  const first = messages[0]?.role === "system" ? 1 : 0;
  if (messages.length - first <= keepRecent) return undefined;

  let cut = messages.length - keepRecent;
  while (cut > first && messages[cut]?.role === "toolResult") cut -= 1;
  if (cut <= first) return undefined;
  return cut;
}

interface SummaryRequest {
  model: string;
  system: Message | undefined;
  conversation: readonly Message[];
  signal: AbortSignal | undefined;
}

/**
 * Send the system prompt, the dropped messages and one instruction, and return
 * the reply text.
 *
 * The system message is the agent's own, unchanged: the summariser answers under
 * the same instructions the conversation ran under.
 */
async function requestSummary(client: LLMClient, input: SummaryRequest): Promise<string> {
  input.signal?.throwIfAborted();
  const instruction: Message = { role: "user", content: [{ type: "text", text: SUMMARY_INSTRUCTION }] };
  const request: LLMRequest = {
    model: input.model,
    messages: [
      ...(input.system === undefined ? [] : [input.system]),
      ...input.conversation,
      instruction,
    ],
    tools: [],
  };
  const options = input.signal === undefined ? {} : { signal: input.signal };
  let text = "";
  for await (const event of client.stream(request, options)) {
    if (event.type === "error") throw event.error;
    if (event.type !== "done") continue;
    if (event.message.stopReason === "error") throw new Error("The summary request failed.");
    text = textOf(event.message.content);
  }
  return text.trim();
}

function textOf(content: readonly ContentBlock[]): string {
  return content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function requireClient(client: LLMClient | undefined): LLMClient {
  if (client === undefined || client === null || typeof client.stream !== "function") {
    throw new TypeError("createSummarizingCompression() requires a client with a stream() method.");
  }
  return client;
}

function requireThreshold(threshold: number | undefined): number {
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold <= 0) {
    throw new TypeError("threshold must be a positive finite number of tokens.");
  }
  return threshold;
}

function requireKeepRecent(keepRecentMessages: number | undefined): number {
  if (keepRecentMessages === undefined) return DEFAULT_KEEP_RECENT_MESSAGES;
  if (!Number.isSafeInteger(keepRecentMessages) || keepRecentMessages < 1) {
    throw new TypeError("keepRecentMessages must be a positive safe integer.");
  }
  return keepRecentMessages;
}

function requireModel(model: string | undefined): string {
  if (typeof model !== "string" || model.length === 0) {
    throw new TypeError("model must be a nonempty string.");
  }
  return model;
}