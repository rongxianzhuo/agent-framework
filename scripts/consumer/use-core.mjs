// Consumer fixture: the core entry point, plain ESM JavaScript, no build step.
//
// Run by scripts/check-package.mjs inside a throwaway project that installed the
// packed tarball by name. It exercises what an embedding agent actually does:
// define a tool, run a multi-turn loop, intercept with hooks, handle a tool that
// throws.
import { run, defineTool, textResult } from "agent-core";
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

export const problems = failures;
if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}
console.log("  core consumer: passed");
