#!/usr/bin/env node
/**
 * A multi-turn chat bot against DeepSeek, in one file.
 *
 *   npm run example
 *
 * Needs `OPENAI_API_KEY` in the environment. The base URL and model default to
 * DeepSeek; both can be overridden with `OPENAI_BASE_URL` and `OPENAI_MODEL`.
 *
 * Everything here is the smallest version of something an embedding agent needs:
 * a system prompt, a loop that reads a line and answers it, and a transcript that
 * survives between turns.
 *
 * That last part is the one thing worth reading the code for. `run()` holds no
 * state: it returns the transcript it produced, and passing that back in on the
 * next call is what makes it a conversation rather than a series of unrelated
 * questions. There is no session object to open, close or clean up.
 *
 * Type at `you>`, or `/exit` to quit.
 */
import { createInterface } from "node:readline";

import { run } from "agent-core";
import { openaiClient } from "agent-core/openai";

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (apiKey === "") {
  console.error(
    [
      "OPENAI_API_KEY is not set.",
      "",
      "  PowerShell:  $env:OPENAI_API_KEY = \"sk-...\"",
      "  bash/zsh:    export OPENAI_API_KEY=sk-...",
      "",
      "Get a key at https://platform.deepseek.com, then run this again.",
    ].join("\n"),
  );
  process.exit(1);
}

const client = openaiClient({
  baseURL: process.env.OPENAI_BASE_URL ?? "https://api.deepseek.com",
  apiKey,
});
const model = process.env.OPENAI_MODEL ?? "deepseek-flash";

// The conversation lives here, not in the library.
let messages = [
  {
    role: "system",
    content: [{ type: "text", text: "You are a helpful assistant. Keep answers short." }],
  },
];

const terminal = process.stdin.isTTY;
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal });
rl.setPrompt("you> ");
if (terminal) rl.prompt();

for await (const line of rl) {
  const text = line.trim();
  if (text === "") {
    if (terminal) rl.prompt();
    continue;
  }
  if (text === "/exit" || text === "/quit") break;

  messages.push({ role: "user", content: [{ type: "text", text }] });
  if (terminal) process.stdout.write("bot> ");

  // Nothing is mutated for us: the result carries the transcript to send next.
  const result = await run({
    client,
    model,
    messages,
    onEvent: (event) => {
      if (event.type === "text_delta") process.stdout.write(event.text);
    },
  });

  console.log("");
  if (result.stopReason === "error") {
    console.error(`[error] ${result.error.kind}: ${result.error.message}`);
  } else if (result.usage !== undefined) {
    console.log(`[${result.usage.totalTokens} tokens]`);
  }
  messages = result.messages;

  if (terminal) rl.prompt();
}

rl.close();
