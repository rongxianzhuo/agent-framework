// Smoke test for the built hooks layer, over a real HTTP socket.
//
// A local server stands in for the model, so this needs no key. It exercises the
// combination that only shows up in a real run: two tools in one batch, one
// denied by a permission guard and one allowed, a result redacted before the
// model sees it, and a reminder injected into the request.
//
//   npm run smoke:hooks
import { createServer } from "node:http";
import { openaiClient, run, defineTool, textResult } from "../dist/index.js";

const seen = [];

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const { messages } = JSON.parse(body);
    seen.push(messages);
    res.writeHead(200, { "content-type": "text/event-stream" });

    const send = (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    const toolMessages = messages.filter((message) => message.role === "tool");

    if (toolMessages.length === 0) {
      console.log(`server: turn 1 saw ${messages.length} messages: ${messages.map((m) => m.role).join(",")}`);
      send({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_rm", type: "function", function: { name: "delete_file" } },
                { index: 1, id: "call_ls", type: "function", function: { name: "list_dir" } },
              ],
            },
          },
        ],
      });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"/etc/passwd"}' } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"path":"/tmp"}' } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    } else {
      for (const message of toolMessages) {
        console.log(`server: turn 2, tool result for ${message.tool_call_id}: ${JSON.stringify(message.content)}`);
      }
      send({ choices: [{ delta: { content: "I cannot delete that file." } }] });
      send({ choices: [{ delta: {}, finish_reason: "stop" }] });
      send({ choices: [], usage: { prompt_tokens: 90, completion_tokens: 12, total_tokens: 102 } });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

await new Promise((resolve) => server.listen(0, resolve));
const { port } = server.address();

const ran = [];
const deleteFile = defineTool({
  name: "delete_file",
  description: "Delete a file.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  execute: (args) => {
    ran.push(`delete:${args.path}`);
    return textResult(`deleted ${args.path}`);
  },
});

const listDir = defineTool({
  name: "list_dir",
  description: "List a directory.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  execute: (args) => {
    ran.push(`list:${args.path}`);
    return textResult(`a.txt\nsecret-token-abc123.txt`);
  },
});

const result = await run({
  client: openaiClient({ baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "sk-test" }),
  model: "test-model",
  messages: [
    { role: "system", content: [{ type: "text", text: "You are a careful agent." }] },
    { role: "user", content: [{ type: "text", text: "clean up /etc/passwd" }] },
  ],
  tools: [deleteFile, listDir],
  hooks: {
    onBeforeRequest: ({ request }) => ({
      ...request,
      messages: [...request.messages, { role: "system", content: [{ type: "text", text: "Reminder: stay in /tmp." }] }],
    }),
    onToolCall: ({ call }) => {
      if (call.name === "delete_file" && !String(call.args?.path ?? "").startsWith("/tmp/")) {
        return { deny: `Refused: ${call.args?.path} is outside /tmp. Ask the user for a safe path.` };
      }
    },
    onToolResult: ({ result }) => ({
      ...result,
      content: result.content.map((block) =>
        block.type === "text" ? { ...block, text: block.text.replaceAll("secret-token-abc123", "<redacted>") } : block,
      ),
    }),
  },
});

console.log("---");
console.log("stopReason:", result.stopReason, "| turns:", result.turns, "| usage:", result.usage.totalTokens);
console.log("tools that ran:", JSON.stringify(ran));
console.log("final text:", result.messages.at(-1).content.map((block) => block.text).join(""));

server.close();

// What reached the wire on turn 2, which is the only place hooks can be observed
// from outside.
const wireTurnTwo = seen[1] ?? [];
const wireToolResults = wireTurnTwo.filter((message) => message.role === "tool");
const wireText = JSON.stringify(wireToolResults);

const failures = [];
if (result.stopReason !== "completed") failures.push(`expected "completed", got "${result.stopReason}"`);
if (ran.includes("delete:/etc/passwd")) failures.push("the permission guard let delete_file run");
if (!ran.includes("list:/tmp")) failures.push("the allowed tool did not run");
if (result.turns !== 2) failures.push(`expected 2 turns, got ${result.turns}`);
if (wireTurnTwo.at(-1)?.role !== "system") failures.push("the injected reminder never reached the wire");
if (!wireText.includes("Refused")) failures.push("the denial did not reach the model");
if (wireText.includes("secret-token-abc123")) failures.push("the secret was not redacted before the request");
if (!wireText.includes("<redacted>")) failures.push("the redacted text never reached the wire");
if (result.usage.totalTokens !== 102) failures.push(`expected 102 tokens, got ${result.usage.totalTokens}`);

if (failures.length > 0) {
  console.error("\nsmoke test failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\nsmoke test passed");
