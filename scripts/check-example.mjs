#!/usr/bin/env node
/**
 * Run the example in its offline modes and check what it prints.
 *
 * An example that no longer runs is worse than no example, so this keeps it
 * honest without spending a token: three scenarios, each asserting on output that
 * would only appear if the loop, the tools and the hooks actually worked.
 *
 *   npm run check:example
 */

import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "examples/file-agent/index.mjs");
const failures = [];

/** Run the example offline and return its output. */
function runExample(args, overrides = {}) {
  // Copied and unset rather than blanked: the example treats "present" as
  // "asked for", and an empty string is present.
  const env = { ...process.env, OPENAI_API_KEY: "" };
  for (const key of ["EXAMPLE_QUESTION", "EXAMPLE_FOLLOWUP", "EXAMPLE_MAX_EXCHANGES"]) delete env[key];
  Object.assign(env, overrides);

  return execFileSync(process.execPath, [entry, ...args], { cwd: root, encoding: "utf8", env });
}

function scenario(name, args, env, assertions) {
  let output;
  try {
    output = runExample(args, env);
  } catch (error) {
    failures.push(`${name}: the example exited with an error\n${String(error.stdout ?? "")}${String(error.stderr ?? "")}`);
    return;
  }

  for (const [label, check] of assertions) {
    if (!check(output)) failures.push(`${name}: expected ${label}`);
  }
  console.log(`  ${name}: ${failures.length === 0 ? "ok" : "checked"}`);
  for (const line of output.trim().split("\n").slice(-3)) console.log(`    ${line}`);
}

console.log("running the example offline");

// 1. The normal path: list a directory, read a file from the listing, answer.
scenario("reads a directory", ["src"], {}, [
  ["a listing tool call", (out) => out.includes("[tool] list_files")],
  ["a read of a file that exists", (out) => /\[tool\] read_file \{"path":"[^"]+\.ts"\}/.test(out)],
  ["no failed tool", (out) => !out.includes("(refused or failed)")],
  ["a completed run", (out) => out.includes("stop: completed")],
  [
    "the full list/read/answer transcript",
    (out) => out.includes("system > user > assistant > toolResult > assistant > toolResult > assistant"),
  ],
]);

// 2. Path traversal is refused by the tool, and the refusal comes back as data.
scenario("refuses a path outside the root", ["src"], { EXAMPLE_QUESTION: "read ../etc/passwd" }, [
  ["the run to complete despite the refusal", (out) => out.includes("stop: completed")],
  ["the refusal text", (out) => out.includes("is outside")],
  ["no crash", (out) => !out.includes("Unhandled")],
]);

// 3. The hook-level guard: .env is denied before the tool runs.
scenario("denies .env via onToolCall", ["."], { EXAMPLE_QUESTION: "show me the .env file" }, [
  ["the denial", (out) => out.includes("Refused: .env files are off limits")],
  ["the run to complete", (out) => out.includes("stop: completed")],
]);

// 4. Two questions on one transcript, with trimming forced on.
scenario(
  "continues a conversation and trims it",
  ["src"],
  { EXAMPLE_FOLLOWUP: "And what is in there?", EXAMPLE_MAX_EXCHANGES: "1" },
  [
    ["two completed runs", (out) => (out.match(/stop: completed/g) ?? []).length === 2],
    ["the trimming hook to report a cut", (out) => out.includes("[hooks] trimmed")],
    [
      "the second run to start from the first transcript",
      (out) => /system > user > .* > assistant > user > assistant/.test(out),
    ],
  ],
);

// 5. The --live path, against a local server that speaks the OpenAI wire format.
//    Proves the dynamic import and the adapter still fit together, without a key.
{
  let turn = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      turn += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (chunk) => response.write(`data: ${JSON.stringify(chunk)}\n\n`);

      if (turn === 1) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "list_files" } }] } }] });
        send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
      } else {
        send({ choices: [{ delta: { content: "That directory has some files." } }] });
        send({ choices: [{ delta: {}, finish_reason: "stop" }] });
        send({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 } });
      }
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const child = spawn(process.execPath, [entry, "src", "--live"], {
    cwd: root,
    env: {
      ...process.env,
      OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
      OPENAI_API_KEY: "test-key-for-a-local-server",
      OPENAI_MODEL: "local-model",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const code = await new Promise((resolve) => child.on("close", resolve));
  server.close();

  const checks = [
    ["a clean exit", code === 0],
    ["two model calls", turn === 2],
    ["the tool call to come back through the adapter", output.includes("[tool] list_files")],
    ["the streamed answer", output.includes("That directory has some files.")],
    ["a completed run", output.includes("stop: completed")],
  ];
  for (const [label, ok] of checks) {
    if (!ok) failures.push(`--live against a local server: expected ${label}\n${output}`);
  }
  console.log(`  runs via the adapter (--live, local server): ${checks.every(([, ok]) => ok) ? "ok" : "checked"}`);
  for (const line of output.trim().split("\n").slice(-3)) console.log(`    ${line}`);
}

if (failures.length > 0) {
  console.error("\nExample check failed:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("\nExample check passed.");
