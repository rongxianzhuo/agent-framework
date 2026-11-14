// Consumer fixture: the core entry point, plain ESM JavaScript, no build step.
//
// Run by scripts/check-package.mjs inside a throwaway project that installed the
// packed tarball by name. It exercises what an embedding agent actually does:
// define a tool, run a multi-turn loop, intercept with hooks, handle a tool that
// throws.
import { Agent, run, defineTool, textResult } from "agent-core";
import { fauxClient } from "agent-core/faux";

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
agent.replaceMessages(saved);
if (agent.messages.length !== 5) failures.push("Agent did not restore the conversation");

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
  client: compressionClient, model: "demo",
  contextCompression: {
    shouldCompress: ({ lastRequest }) => (lastRequest?.usage?.inputTokens ?? 0) >= 200_000,
    compress: () => {
      compressions++;
      return [{ role: "user", content: [{ type: "text", text: "strategy summary" }] }];
    },
  },
});
await compressedAgent.run("first");
await compressedAgent.run("second");
if (compressions !== 1 || compressionClient.requests[1]?.messages.length !== 1) failures.push("Compression strategy did not replace history");
if (compressedAgent.lastRequest?.usage?.inputTokens !== 20) failures.push("Latest request usage was not updated");

export const problems = failures;
if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}
console.log("  core consumer: passed");
