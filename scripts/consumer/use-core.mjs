// Consumer fixture: the core entry point, plain ESM JavaScript, no build step.
//
// Run by scripts/check-package.mjs inside a throwaway project that installed the
// packed tarball by name. It exercises what an embedding agent actually does:
// define a tool, run a multi-turn loop, intercept with hooks, handle a tool that
// throws.
import { Agent, run, createSummarizingCompression, defineTool, textResult } from "agent-framework";
import { fauxClient } from "agent-framework/faux";

const readFile = defineTool({
  name: "read",
  description: "Read a file.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
  execute: async (args) => {
    if (args.path === "missing.txt") throw new Error("ENOENT: no such file");
    return textResult(`contents of ${args.path}`);
  },
});

const client = fauxClient({
  turns: [
    { text: "Let me look.", toolCalls: [{ id: "c1", name: "read", args: { path: "a.txt" } }] },
    { toolCalls: [{ id: "c2", name: "read", args: { path: "missing.txt" } }] },
    { text: "That file does not exist." },
  ],
  chunkSize: 4,
});

const seen = [];
const result = await run({
  client,
  model: "demo",
  messages: [
    { role: "system", content: [{ type: "text", text: "You are a reader." }] },
    { role: "user", content: [{ type: "text", text: "read a.txt then missing.txt" }] },
  ],
  tools: [readFile],
  hooks: {
    onToolCall: ({ call }) => {
      if (call.name === "read" && String(call.args?.path).includes("..")) {
        return { deny: "Refused: path traversal." };
      }
    },
    onToolResult: ({ result }) => ({
      ...result,
      content: result.content.map((block) =>
        block.type === "text" ? { ...block, text: block.text.toUpperCase() } : block,
      ),
    }),
  },
  onEvent: (event) => seen.push(event.type),
});

console.log("  stopReason:", result.stopReason, "| turns:", result.turns);
console.log("  roles:", result.messages.map((message) => message.role).join(" > "));

const failures = [];
if (result.stopReason !== "completed") failures.push(`stopReason was ${result.stopReason}`);
if (result.turns !== 3) failures.push(`expected 3 turns, got ${result.turns}`);
if (!seen.includes("tool_start") || !seen.includes("tool_end")) failures.push("tool events were not emitted");

// The tool that threw must have come back as data, not as an exception.
const failed = result.messages.filter((message) => message.role === "toolResult" && message.isError);
if (failed.length !== 1) failures.push(`expected exactly 1 failed tool result, got ${failed.length}`);

// onToolResult ran, and its output is what the transcript holds.
const upper = result.messages.some(
  (message) =>
    message.role === "toolResult" &&
    message.content.some((block) => block.type === "text" && block.text === "CONTENTS OF A.TXT"),
);
if (!upper) failures.push("onToolResult did not rewrite the tool result");

const conversationClient = fauxClient({ turns: [
  { text: "Hello Alex." }, { text: "Alex." }, { text: "Compressed." }, { text: "Continued." },
] });
const agent = new Agent({ client: conversationClient, model: "demo", system: "Be brief." });
await agent.run("My name is Alex.");
await agent.run("What is my name?");
if (conversationClient.requests[1]?.messages.length !== 4) failures.push("Agent did not preserve the first exchange");
const saved = agent.messages;
agent.reset();
agent.replaceMessages(agent.system, saved.slice(1));
if (agent.messages.length !== 5) failures.push("Agent did not restore the conversation");
if (agent.system !== "Be brief.") failures.push("Agent did not restore the system prompt");

await agent.run("compress", { hooks: { onBeforeRequest: ({ request }) => ({
  request: { ...request, messages: [{ role: "user", content: [{ type: "text", text: "summary" }] }] },
  replaceHistory: true,
}) } });
await agent.run("continue");
if (conversationClient.requests[3]?.messages.length !== 3) failures.push("Agent did not retain compressed history");
if (agent.messages[0]?.content[0]?.text !== "summary") failures.push("Permanent replacement was not saved");

let compressions = 0;
const compressionClient = fauxClient({ turns: [
  { text: "large context", usage: { inputTokens: 200_000, outputTokens: 10, totalTokens: 200_010, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  { text: "small context", usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 } },
] });
const compressedAgent = new Agent({
  client: compressionClient, model: "demo", system: "Be brief.",
  contextCompression: {
    shouldCompress: ({ usage }) => (usage?.inputTokens ?? 0) >= 200_000,
    compress: ({ messages }) => {
      compressions++;
      return [messages[0], { role: "user", content: [{ type: "text", text: "strategy summary" }] }];
    },
  },
});
await compressedAgent.run("first");
if (compressions !== 1) failures.push("Compression did not run at the end of the turn");
if (compressedAgent.messages.length !== 2) failures.push(`Compressed history was not stored, got ${compressedAgent.messages.length} messages`);
await compressedAgent.run("second");
if (compressionClient.requests[1]?.messages.length !== 3) failures.push("Compression strategy did not replace history");

const summarizeClient = fauxClient({ turns: [{ text: "The user introduced themselves as Alex." }] });
const bundledClient = fauxClient({ turns: [
  { text: "Hello Alex.", usage: { inputTokens: 200_000, outputTokens: 10, totalTokens: 200_010, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  { text: "Still Alex.", usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 } },
] });
const bundledAgent = new Agent({
  client: bundledClient, model: "demo", system: "Be brief.",
  contextCompression: createSummarizingCompression({
    client: summarizeClient, model: "cheap", threshold: 100_000, keepRecentMessages: 1,
  }),
});
await bundledAgent.run("My name is Alex.");
await bundledAgent.run("What is my name?");
const bundledMessages = bundledClient.requests[1]?.messages ?? [];
if (summarizeClient.requests.length !== 1) failures.push("Bundled strategy did not issue exactly one summary request");
if (summarizeClient.requests[0]?.model !== "cheap") failures.push("Bundled strategy ignored the configured summary model");
if (bundledMessages[0]?.role !== "system") failures.push("Bundled strategy dropped the system prompt");
if (!String(bundledMessages[1]?.content[0]?.text).includes("The user introduced themselves")) {
  failures.push("Bundled strategy did not put the summary after the system prompt");
}
if (bundledMessages.length !== 4) failures.push(`Bundled strategy did not shorten the transcript, got ${bundledMessages.length} messages`);
if (bundledAgent.lastRequest?.usage?.inputTokens !== 30) failures.push("Bundled strategy leaked its own usage into lastRequest");

export const problems = failures;
if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}
console.log("  core consumer: passed");
