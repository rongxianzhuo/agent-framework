// Consumer fixture: the published type declarations under a strict consumer.
//
// Compiled by scripts/check-package.mjs with `skipLibCheck: false`, so a broken
// or sloppy declaration fails here rather than in somebody else's editor. The
// `@ts-expect-error` lines are assertions: if the error stops happening, this
// file stops compiling.
import { Agent, run, defineTool, textResult, type AgentInput, type AgentOptions, type AgentRunOptions, type CompressionContext, type ContextCompressionStrategy, type LastRequestInfo, type Message, type RunHooks, type RunResult } from "agent-core";
import * as core from "agent-core";
import { fauxClient } from "agent-core/faux";
import { runConformance, type ConformanceResult } from "agent-core/conformance";

const tool = defineTool<{ path: string }>({
  name: "read",
  description: "Read a file.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  execute: (args) => textResult(`read ${args.path}`),
});

const hooks: RunHooks = {
  onBeforeRequest: ({ request }) => ({ ...request, temperature: 0.2 }),
  onToolCall: ({ call }) => (call.name === "read" ? undefined : { deny: "no" }),
  onToolResult: ({ result }) => result,
};

const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];

export async function go(): Promise<string> {
  const result: RunResult = await run({
    client: fauxClient({ turns: [{ text: "ok" }] }),
    model: "m",
    messages,
    tools: [tool],
    hooks,
  });

  const checks: ConformanceResult[] = await runConformance(fauxClient({ turns: () => ({ text: "ok" }) }), {
    model: "m",
    only: ["text"],
  });

  return `${result.stopReason} ${checks.length} ${core.VERSION}`;
}

export async function converse(input: AgentInput): Promise<RunResult> {
  const strategy: ContextCompressionStrategy = {
    shouldCompress: ({ lastRequest }: CompressionContext) => (lastRequest?.usage?.inputTokens ?? 0) > 200_000,
    compress: ({ messages }) => [...messages],
  };
  const options: AgentOptions = {
    client: fauxClient({ turns: () => ({ text: "ok" }) }),
    model: "m", system: "Be brief.", tools: [tool], hooks, contextCompression: strategy,
  };
  const agent = new Agent(options);
  const execution: AgentRunOptions = { maxTurns: 2, signal: new AbortController().signal };
  await agent.run(input, execution);
  const latest: LastRequestInfo | undefined = agent.lastRequest;
  if (latest?.usage !== undefined) latest.usage.inputTokens.toFixed();
  const saved: Message[] = agent.messages;
  agent.reset();
  agent.replaceMessages(saved);
  return agent.run();
}

// The core entry point must not carry an adapter.
// @ts-expect-error openaiClient belongs to agent-core/openai
core.openaiClient;

// A tool's arguments are typed by the definition, not by `unknown`.
// @ts-expect-error wrong argument shape
tool.execute({ nope: 1 }, { callId: "c", turn: 1 });
