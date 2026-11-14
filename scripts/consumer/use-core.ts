// Consumer fixture: the published type declarations under a strict consumer.
//
// Compiled by scripts/check-package.mjs with `skipLibCheck: false`, so a broken
// or sloppy declaration fails here rather than in somebody else's editor. The
// `@ts-expect-error` lines are assertions: if the error stops happening, this
// file stops compiling.
import { Agent, run, defineTool, textResult, type AgentInput, type AgentOptions, type AgentRunOptions, type CompressionContext, type ContextCompressionStrategy, type LastRequestInfo, type Message, type RunHooks, type RunResult } from "agent-framework";
import * as core from "agent-framework";
import { fauxClient } from "agent-framework/faux";
import { runConformance, type ConformanceResult } from "agent-framework/conformance";
import type { Base64ImageBlock, ImageBlock, LLMClient, UrlImageBlock } from "agent-framework";
import { createEditFileTool, createReadFileTool, createReadImageTool, createWriteFileTool, type EditFileArgs, type EditFileToolOptions, type ReadFileArgs, type ReadFileToolOptions, type ReadPathArgs, type ReadToolOptions, type WriteFileArgs, type WriteFileToolOptions } from "agent-framework/tools";

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

export async function inspectImages(client: LLMClient, model: string, base64: string): Promise<RunResult> {
  const inline: Base64ImageBlock = { type: "image", mimeType: "image/png", data: base64 };
  const remote: UrlImageBlock = { type: "image", url: "https://images.example.test/photo.jpg" };
  const images: ImageBlock[] = [inline, remote];
  // @ts-expect-error a URL image cannot also carry Base64 data
  const invalid: ImageBlock = { ...inline, url: remote.url };
  void invalid;
  return new Agent({ client, model }).run([{ type: "text", text: "Compare." }, ...images]);
}

// The core entry point must not carry an adapter.
// @ts-expect-error openaiClient belongs to agent-framework/openai
core.openaiClient;

// Built-ins belong to the optional tools entry point.
// @ts-expect-error core-only consumers do not load built-in file tools
core.createReadFileTool;
// @ts-expect-error writers also belong to the optional tools entry point
core.createWriteFileTool;
// @ts-expect-error editors belong to the optional tools entry point
core.createEditFileTool;

export function builtinEditor() {
  const options: EditFileToolOptions = { name: "replace_text", timeoutMs: 1000 };
  const editor = createEditFileTool(options);
  const args: EditFileArgs = { file_path: "/absolute/file.txt", old_string: "old", new_string: "new", replease_all: true };
  const execute = () => editor.execute(args, { callId: "edit", turn: 1 });
  // @ts-expect-error file_path is required; path is not an alias
  const invalid = () => editor.execute({ path: args.file_path, old_string: "old", new_string: "new" }, { callId: "edit", turn: 1 });
  return { editor, execute, invalid };
}

export function builtinWriter() {
  const options: WriteFileToolOptions = { name: "save_text", timeoutMs: 1000 };
  const writer = createWriteFileTool(options);
  const args: WriteFileArgs = { path: "/absolute/file.txt", content: "text" };
  const execute = () => writer.execute(args, { callId: "write", turn: 1 });
  // @ts-expect-error writing requires text content as well as a path
  const invalid = () => writer.execute({ path: args.path }, { callId: "write", turn: 1 });
  return { writer, execute, invalid };
}

export function builtinReaders() {
  const common: ReadToolOptions = { name: "open_text", timeoutMs: 1000 };
  const options: ReadFileToolOptions = { ...common, maxBytes: 1024 * 1024 };
  const text = createReadFileTool(options);
  const image = createReadImageTool();
  const args: ReadPathArgs = { path: "/absolute/file.txt" };
  const execute = () => text.execute(args, { callId: "test", turn: 1 });
  const range: ReadFileArgs = { ...args, offset: 1, limit: 20 };
  const executeRange = () => text.execute(range, { callId: "range", turn: 1 });
  // @ts-expect-error offset and limit must be supplied together
  const invalidRange = () => text.execute({ path: args.path, offset: 1 }, { callId: "range", turn: 1 });
  // @ts-expect-error built-in tools retain their typed path argument
  const invalid = () => image.execute({ path: 123 }, { callId: "test", turn: 1 });
  // @ts-expect-error maxBytes is currently a text-reader option only
  const invalidImage = () => createReadImageTool({ maxBytes: 1000 });
  return { text, image, execute, executeRange, invalidRange, invalid, invalidImage };
}

// A tool's arguments are typed by the definition, not by `unknown`.
// @ts-expect-error wrong argument shape
tool.execute({ nope: 1 }, { callId: "c", turn: 1 });
