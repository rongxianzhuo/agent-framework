// Consumer fixture: the OpenAI subpath, against a local server that speaks SSE.
//
// Proves `agent-core/openai` resolves and works after a real `npm install`, with
// no API key and no network egress.
import { createServer } from "node:http";
import { run, defineTool } from "agent-core";
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
  execute: (args) => ({ content: [
    { type: "text", text: `got ${args.n}` },
    { type: "image", mimeType: "image/png", data: "AAAA" },
  ] }),
});

const client = openaiClient({ baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "test-key-from-consumer" });
const result = await run({
  client,
  model: "consumer-model",
  messages: [{ role: "user", content: [
    { type: "text", text: "Describe these images." },
    { type: "image", url: "https://images.example.test/photo.jpg" },
    { type: "image", mimeType: "image/png", data: "AAAA" },
  ] }],
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
const imageParts = lastBody?.messages?.[0]?.content;
if (imageParts?.[1]?.image_url?.url !== "https://images.example.test/photo.jpg") failures.push("URL image was not preserved");
if (imageParts?.[2]?.image_url?.url !== "data:image/png;base64,AAAA") failures.push("Base64 image was not encoded");
// The complete tool batch must precede the supplementary image message.
if (lastBody?.messages?.at(-2)?.role !== "tool") {
  failures.push(`the tool result was not sent back as role "tool": ${lastBody?.messages?.map((m) => m.role).join(",")}`);
}
const toolImageParts = lastBody?.messages?.at(-1)?.content;
if (lastBody?.messages?.at(-1)?.role !== "user" || toolImageParts?.[2]?.image_url?.url !== "data:image/png;base64,AAAA") {
  failures.push("tool image was not attached after the tool result");
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}
console.log("  openai consumer: passed");
