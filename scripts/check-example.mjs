#!/usr/bin/env node
/**
 * Run the chat example and check what it prints.
 *
 * An example that no longer runs is worse than no example, so this keeps it
 * honest without spending a token: the bot is driven by piped stdin, and every
 * assertion is something that only appears if the loop really ran.
 *
 *   npm run check:example
 */

import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "examples/chat/index.mjs");
const failures = [];

/**
 * Drive the bot with these lines and return what it printed.
 *
 * `OPENAI_API_KEY` is unset, not blanked: an empty string is still a set
 * variable, and the example treats a set key as "you want a real model".
 */
function converse(lines, overrides = {}) {
  const env = { ...process.env };
  delete env["OPENAI_API_KEY"];
  delete env["OPENAI_BASE_URL"];
  delete env["OPENAI_MODEL"];
  Object.assign(env, overrides);

  return execFileSync(process.execPath, [entry], {
    cwd: root,
    encoding: "utf8",
    env,
    input: lines.join("\n") + "\n",
  });
}

function scenario(name, check) {
  let output;
  try {
    output = check();
  } catch (error) {
    failures.push(`${name}: ${String(error.stdout ?? "")}${String(error.stderr ?? error)}`);
    return;
  }
  console.log(`  ${name}: ok`);
  for (const line of output.trim().split("\n").slice(-3)) console.log(`    ${line}`);
}

function expect(name, output, checks) {
  for (const [label, ok] of checks) {
    if (!ok) failures.push(`${name}: expected ${label}\n--- output ---\n${output}`);
  }
}

console.log("running the example offline");

// 1. The whole point of the example: the second answer sees the first exchange.
scenario("answers twice from one accumulating transcript", () => {
  const output = converse(["hello", "what did I just say?"]);
  expect("answers twice from one accumulating transcript", output, [
    [
      "a first answer to one message and no prior answers",
      output.includes('You have sent me 1 message(s) and I have answered 0 time(s). The last one was "hello".'),
    ],
    [
      // Both counts matter: the second turn must see the earlier question *and*
      // the reply to it. Keeping only the user messages would satisfy a count of
      // two and lose the conversation.
      "a second answer to two messages and one prior answer",
      output.includes('You have sent me 2 message(s) and I have answered 1 time(s). The last one was "what did I just say?".'),
    ],
    ["no error", !output.includes("[error]")],
  ]);
  return output;
});

// 2. A blank line is not a message, and must not reach the model.
scenario("ignores blank lines", () => {
  const output = converse(["", "  ", "only one"]);
  expect("ignores blank lines", output, [
    ["exactly one answer", (output.match(/You have sent me/g) ?? []).length === 1],
    ["that answer to be the message", output.includes('"only one"')],
  ]);
  return output;
});

// 3. `/exit` stops before reading the rest of the input.
scenario("stops on /exit", () => {
  const output = converse(["first", "/exit", "never answered"]);
  expect("stops on /exit", output, [
    ["one answer only", (output.match(/You have sent me/g) ?? []).length === 1],
    ["the trailing line to be ignored", !output.includes("never answered")],
  ]);
  return output;
});

// 4. Closed input is a clean end, not a crash: a bot piped a file must finish.
scenario("exits cleanly at end of input", () => {
  const output = converse([]);
  expect("exits cleanly at end of input", output, [
    ["no output and no crash", output.trim() === ""],
  ]);
  return output || "(no output)";
});

// 5. The --live path, against a local server speaking the OpenAI wire format.
//    This is the only check that looks at the requests, and so the only one that
//    proves the earlier turns are actually sent back to the model.
{
  const bodies = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      bodies.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (chunk) => response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      send({ choices: [{ delta: { content: `reply ${bodies.length}` } }] });
      send({ choices: [{ delta: {}, finish_reason: "stop" }] });
      send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });

  await new Promise((done) => server.listen(0, done));
  const { port } = server.address();

  const child = spawn(process.execPath, [entry, "--live"], {
    cwd: root,
    env: {
      ...process.env,
      OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
      OPENAI_API_KEY: "test-key-for-a-local-server",
      OPENAI_MODEL: "local-model",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  child.stdin.end("first question\nsecond question\n");

  const code = await new Promise((done) => child.on("close", done));
  server.close();

  const second = bodies[1]?.messages ?? [];
  expect("runs via the adapter (--live, local server)", output, [
    ["a clean exit", code === 0],
    ["two model calls", bodies.length === 2],
    ["both replies streamed", output.includes("reply 1") && output.includes("reply 2")],
    [
      "the second request to carry system, user, assistant, user",
      second.map((message) => message.role).join(",") === "system,user,assistant,user",
    ],
    [
      "the second request to repeat the first question",
      JSON.stringify(second).includes("first question"),
    ],
  ]);
  console.log(`  runs via the adapter (--live, local server): ok`);
  for (const line of output.trim().split("\n").slice(-3)) console.log(`    ${line}`);
}

if (failures.length > 0) {
  console.error("\nExample check failed:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("\nExample check passed.");
