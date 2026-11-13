// Consumer fixture: the OpenAI subpath, against a local server that speaks SSE.
//
// Proves `agent-core/openai` resolves and works after a real `npm install`, with
// no API key and no network egress.
import { createServer } from "node:http";
import { run, defineTool, textResult } from "agent-core";
import { openaiClient } from "agent-core/openai";

let lastBody;
let requests = 0;

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    requests += 1;
    lastBody = JSON.parse(body);

    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);

    if (requests === 1) {
      // A tool call whose arguments arrive in fragments, as real gateways send.
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "noop" } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"n":1}' } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    } else {
      send({ choices: [{ delta: { content: "done" } }] });
      send({ choices: [{ delta: {}, finish_reason: "stop" }] });
      send({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

await new Promise((resolve) => server.listen(0, resolve));
const { port } = server.address();

const noop = defineTool({
  name: "noop",
  description: "Does nothing.",
  parameters: { type: "object", properties: { n: { type: "number" } } },
  execute: (args) => textResult(`got ${args.n}`),
});

const client = openaiClient({ baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "test-key-from-consumer" });
const result = await run({
  client,
  model: "consumer-model",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [noop],
});

server.close();

console.log("  stopReason:", result.stopReason, "| turns:", result.turns, "| usage:", result.usage.totalTokens);

const failures = [];
if (result.stopReason !== "completed") failures.push(`stopReason was ${result.stopReason}`);
if (result.turns !== 2) failures.push(`expected 2 turns, got ${result.turns}`);
if (result.usage.totalTokens !== 14) failures.push(`expected 14 tokens, got ${result.usage.totalTokens}`);
if (lastBody?.model !== "consumer-model") failures.push("model was not forwarded");
if (lastBody?.stream !== true) failures.push("stream was not requested");
if (lastBody?.tools?.[0]?.function?.name !== "noop") failures.push("tools were not serialised");
// Turn 2 must carry the assistant's tool call followed by the result as `tool`.
if (lastBody?.messages?.at(-1)?.role !== "tool") {
  failures.push(`the tool result was not sent back as role "tool": ${lastBody?.messages?.map((m) => m.role).join(",")}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}
console.log("  openai consumer: passed");
