// Smoke test for the built OpenAI adapter, over a real HTTP socket.
//
// Uses a local server instead of api.openai.com, so it needs no key and makes no
// external calls. What it proves that the unit tests cannot: the fetch wiring,
// headers, request body and SSE reading all work over an actual socket, and a
// full two-turn agent run completes through the built `dist/` output.
//
//   npm run smoke:openai
import { createServer } from "node:http";
import { openaiClient, run, defineTool, textResult } from "../dist/index.js";

let turn = 0;

const chunks = {
  first: [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.ts"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ],
  second: [
    { choices: [{ delta: { content: "a.ts is a " } }] },
    { choices: [{ delta: { content: "test file." }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } },
  ],
};

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    turn += 1;
    const parsed = JSON.parse(body);
    console.log(`server: ${req.method} ${req.url} | auth=${req.headers.authorization} | model=${parsed.model} | roles=${parsed.messages.map((m) => m.role).join(",")}`);
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of turn === 1 ? chunks.first : chunks.second) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

await new Promise((resolve) => server.listen(0, resolve));
const { port } = server.address();

const read = defineTool({
  name: "read",
  description: "Read a file.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  execute: (args) => textResult(`contents of ${args.path}`),
});

const client = openaiClient({ baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "sk-test" });
const result = await run({
  client,
  model: "test-model",
  messages: [
    { role: "system", content: [{ type: "text", text: "You are a coding agent." }] },
    { role: "user", content: [{ type: "text", text: "what is in a.ts?" }] },
  ],
  tools: [read],
});

console.log("---");
console.log("stopReason:", result.stopReason, "| turns:", result.turns, "| usage:", result.usage.totalTokens);
console.log("transcript:", result.messages.map((m) => m.role).join(" > "));
console.log("toolResult:", result.messages.find((m) => m.role === "toolResult")?.content[0]?.text);
console.log("final text:", result.messages.at(-1).content.map((b) => b.text).join(""));

server.close();

const failures = [];
if (result.stopReason !== "completed") failures.push(`expected stopReason "completed", got "${result.stopReason}"`);
if (result.turns !== 2) failures.push(`expected 2 turns, got ${result.turns}`);
if (result.messages.map((m) => m.role).join(",") !== "system,user,assistant,toolResult,assistant") {
  failures.push("unexpected transcript shape");
}
if (result.usage.totalTokens !== 60) failures.push(`expected 60 tokens of usage, got ${result.usage.totalTokens}`);

if (failures.length > 0) {
  console.error("\nsmoke test failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\nsmoke test passed");
