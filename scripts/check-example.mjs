#!/usr/bin/env node
/**
 * Run the chat example and check what it does.
 *
 * The example talks to a real model, and this must not: so every scenario points
 * it at a local server that speaks the OpenAI wire format. No key, no network, no
 * cost — and because the runs are local, the assertions can look at the requests
 * the bot sent, which is where multi-turn behaviour actually lives.
 *
 *   npm run check:example
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "examples/chat/index.mjs");
const failures = [];

/** Requests the local server received, cleared between scenarios. */
let received = [];

/**
 * Whether the server should stream `reasoning_content` before the answer.
 *
 * DeepSeek sends reasoning as `delta.reasoning_content`, which the adapter turns
 * into `thinking_delta` events. Without this the demo's thinking path would never
 * be exercised here.
 */
let sendReasoning = false;

const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    received.push(JSON.parse(body));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (chunk) => response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    if (sendReasoning) {
      send({ choices: [{ delta: { reasoning_content: "Let me think. " } }] });
      send({ choices: [{ delta: { reasoning_content: "The answer is trivial." } }] });
    }
    // Echo the turn number, so the output shows which call produced it.
    send({ choices: [{ delta: { content: `answer ${received.length}` } }] });
    send({ choices: [{ delta: {}, finish_reason: "stop" }] });
    send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
    response.write("data: [DONE]\n\n");
    response.end();
  });
});

await new Promise((done) => server.listen(0, "127.0.0.1", done));
const { port } = server.address();

/**
 * Drive the bot with these lines and return what it printed.
 *
 * The key is a dummy: the local server does not check it, and using one keeps the
 * example's "no key" guard from firing, so the guard itself stays untested here
 * and is covered by the last scenario instead.
 */
async function converse(lines, env = {}) {
  received = [];
  sendReasoning = env["SHOW_THINKING"] !== undefined;
  // Async on purpose: `execFileSync` would block this process's event loop, so
  // the local server could never answer the child's request.
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: {
      ...process.env,
      OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
      OPENAI_API_KEY: "dummy-key-for-the-local-server",
      OPENAI_MODEL: "local-model",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  child.stdin.end(lines.map((line) => line + "\n").join(""));

  const code = await new Promise((done) => child.on("close", done));
  return { output, code };
}

async function scenario(name, run, checks) {
  let output;
  try {
    ({ output } = await run());
  } catch (error) {
    failures.push(`${name}: ${String(error)}`);
    return;
  }
  for (const [label, ok] of checks(output)) {
    if (!ok) failures.push(`${name}: expected ${label}\n--- output ---\n${output}`);
  }
  console.log(`  ${name}: ok`);
  for (const line of output.trim().split("\n").slice(-3)) console.log(`    ${line}`);
}

console.log("running the example against a local server");

// 1. The point of the example: the second request carries the first exchange.
await scenario(
  "answers twice from one accumulating transcript",
  () => converse(["hello", "what did I just say?"]),
  (output) => [
    ["both answers", output.includes("answer 1") && output.includes("answer 2")],
    ["two requests", received.length === 2],
    [
      "the second request to carry system, user, assistant, user",
      (received[1]?.messages ?? []).map((message) => message.role).join(",") === "system,user,assistant,user",
    ],
    [
      "the second request to still contain the first question",
      JSON.stringify(received[1] ?? {}).includes("hello"),
    ],
    ["usage to be reported", output.includes("[12 tokens]")],
  ],
);

// 2. A blank line is not a message and must not reach the model.
await scenario(
  "ignores blank lines",
  () => converse(["", "  ", "only one"]),
  (output) => [
    ["one request", received.length === 1],
    ["that request to carry the one real message", JSON.stringify(received[0] ?? {}).includes("only one")],
    ["no empty message to reach the model", !JSON.stringify(received[0] ?? {}).includes('"content":""')],
  ],
);

// 3. `/exit` stops before reading the rest of the piped input.
await scenario(
  "stops on /exit",
  () => converse(["first", "/exit", "never sent"]),
  () => [
    ["one request", received.length === 1],
    ["the trailing line to be ignored", !JSON.stringify(received[0] ?? {}).includes("never sent")],
  ],
);

// 4. Closed input is a clean end, not a crash.
await scenario(
  "exits cleanly at end of input",
  () => converse([]),
  (output) => [
    ["no requests", received.length === 0],
    ["no output and no crash", output.trim() === ""],
  ],
);

// 5. Reasoning is shown above the answer, on its own prefix, and can be turned off.
await scenario(
  "shows reasoning above the answer",
  () => converse(["hello"], { SHOW_THINKING: "1" }),
  (output) => [
    ["the reasoning to be printed", output.includes("Let me think. The answer is trivial.")],
    ["a marker distinguishing it", output.includes("bot (thinking)>")],
    ["the answer to follow on its own line", /bot \(thinking\)> .*\nbot> answer 1/.test(output)],
  ],
);

await scenario(
  "hides reasoning when asked to",
  () => converse(["hello"], { SHOW_THINKING: "0" }),
  (output) => [
    ["no reasoning", !output.includes("Let me think.")],
    ["no marker", !output.includes("(thinking)")],
    ["the answer to still be there", output.includes("answer 1")],
  ],
);

// 6. Without a key it says so, instead of trying and failing with a 401.
{
  const { output, code } = await converse(["hello"], { OPENAI_API_KEY: "" });
  const checks = [
    ["a non-zero exit", code !== 0],
    ["a message naming the variable", output.includes("OPENAI_API_KEY is not set")],
    ["no request to be made", received.length === 0],
  ];
  for (const [label, ok] of checks) {
    if (!ok) failures.push(`refuses to start without a key: expected ${label}\n--- output ---\n${output}`);
  }
  console.log(`  refuses to start without a key: ok`);
  for (const line of output.trim().split("\n").slice(0, 1)) console.log(`    ${line}`);
}

server.close();

if (failures.length > 0) {
  console.error("\nExample check failed:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("\nExample check passed.");
