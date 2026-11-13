// The API surface docs/integration.md tells readers to use, compiled against the
// published declarations.
//
// Not a test of behaviour — `use-core.mjs` covers that. This exists so the guide
// cannot drift: every name, option and shape it shows has to resolve here, under
// the same strict settings a consumer would use. When an option is renamed,
// check:package fails instead of shipping a guide that no longer compiles.
import { readFile } from "node:fs/promises";

import {
  run,
  defineTool,
  textResult,
  jsonResult,
  MessageAccumulator,
  type Message,
  type RunHooks,
  type LLMClient,
  type LLMRequest,
  type LLMEvent,
  type ToolCall,
  type Usage,
} from "agent-core";
import { openaiClient } from "agent-core/openai";
import { fauxClient } from "agent-core/faux";
import { runConformance, formatResults, allPassed } from "agent-core/conformance";

// --- Tools ----------------------------------------------------------------

const read = defineTool<{ path: string }>({
  name: "read_file",
  description: "Read a text file.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Path to read." } },
    required: ["path"],
    additionalProperties: false,
  },
  execute: async (args, ctx) => {
    ctx.onUpdate?.(`reading ${args.path}`);
    return textResult(await readFile(args.path, { encoding: "utf8", signal: ctx.signal }));
  },
  timeoutMs: 10_000,
});

const search = defineTool<{ query: string; limit?: number }>({
  name: "search",
  description: "Search the notes.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 50 } },
    required: ["query"],
    additionalProperties: false,
  },
  execute: (args) => jsonResult({ query: args.query, limit: args.limit ?? 10 }),
});

// --- Hooks ----------------------------------------------------------------

/** The guide's answer to "args is unknown": narrow it where the shape is known. */
const argsOf = <T>(call: ToolCall): Partial<T> => (call.args ?? {}) as Partial<T>;

function trimHistory(messages: readonly Message[]): Message[] {
  const starts = messages.flatMap((message, index) => (message.role === "user" ? [index] : []));
  if (starts.length <= 6) return [...messages];

  const cut = starts.at(-6)!;
  const system = messages[0]?.role === "system" ? [messages[0]] : [];
  return [...system, ...messages.slice(cut)];
}

const hooks: RunHooks = {
  onBeforeRequest: ({ request }) => ({ ...request, messages: trimHistory(request.messages) }),

  onToolCall: async ({ call }) => {
    if (call.name === "read_file") {
      const { path } = argsOf<{ path: string }>(call);
      if (path !== undefined && !path.startsWith("/tmp")) {
        return { deny: "Refused: that path is outside the workspace." };
      }
    }
    if (call.name === "search") {
      const { query } = argsOf<{ query: string }>(call);
      const cache = new Map<string, string>([["a", "cached: a"]]);
      const hit = query === undefined ? undefined : cache.get(query);
      if (hit !== undefined) return { result: textResult(hit) };
    }
  },

  onToolResult: ({ result }) => {
    const text = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (text.length <= 2_000) return;
    return {
      content: [{ type: "text", text: `${text.slice(0, 2_000)}\n… truncated.` }],
      details: { truncated: true, fullLength: text.length },
      isError: result.isError ?? false,
    };
  },
};

// --- The loop -------------------------------------------------------------

export async function runOnce(): Promise<Usage> {
  // Options the guide names, spelled the way the guide spells them.
  const client = openaiClient({
    baseURL: "https://api.openai.com/v1",
    maxRetries: 0,
    reasoningEcho: "always",
  });

  const result = await run({
    client,
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: [{ type: "text", text: "You are a coding agent." }] },
      { role: "user", content: [{ type: "text", text: "What is in src/index.ts?" }] },
    ],
    tools: [read, search],
    maxTurns: 12,
    parallelTools: true,
    maxOutputTokens: 512,
    temperature: 0.2,
    reasoningEffort: "low",
    hooks,
    providerOptions: {},
    onEvent: (event) => {
      if (event.type === "text_delta") process.stdout.write(event.text);
      if (event.type === "error") console.error(event.error.kind, event.fatal);
    },
  });

  // Reading the result the way the guide describes.
  const assistant = result.messages.find((message) => message.role === "assistant");
  assistant?.content;
  assistant?.toolCalls;

  const stopReason: "completed" | "maxTurns" | "aborted" | "error" = result.stopReason;
  console.log(stopReason, result.turns, result.usage.totalTokens, result.error?.retryable);

  // Continuing a conversation: pass the transcript back in.
  const next = await run({ client, model: "gpt-4o-mini", messages: result.messages });
  return next.usage;
}

// --- Writing an adapter ---------------------------------------------------

export const myClient: LLMClient = {
  name: "my-gateway",
  async *stream(request: LLMRequest, options?: { signal?: AbortSignal }): AsyncIterable<LLMEvent> {
    const accumulator = new MessageAccumulator();
    if (!options?.signal?.aborted) {
      const event: LLMEvent = { type: "text_delta", text: "hello" };
      accumulator.push(event);
      yield event;
    }

    yield {
      type: "done",
      message: accumulator.build({
        stopReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 },
        model: request.model,
        provider: "my-gateway",
      }),
    };
  },
};

export async function checkAdapter(): Promise<boolean> {
  const results = await runConformance(myClient, { model: "my-model", only: ["text"], skip: ["abort"] });
  console.log(formatResults(results));
  return allPassed(results);
}

// --- Testing without a model ----------------------------------------------

export async function withoutAModel(): Promise<void> {
  const client = fauxClient({
    turns: [
      { text: "Let me look.", toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.txt" } }] },
      { text: "It contains hello.", delayMs: 1 },
    ],
    chunkSize: 4,
    onExhausted: "error",
  });

  const result = await run({
    client,
    model: "test",
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    tools: [read],
  });

  // A scripted model that reacts to what it was sent.
  const scripted = fauxClient({
    turns: (_request, index) => (index === 0 ? { text: "first" } : { text: "second" }),
    name: "scripted",
  });
  await run({
    client: scripted,
    model: "test",
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
  });
  console.log(client.requests.length, result.stopReason);
}
