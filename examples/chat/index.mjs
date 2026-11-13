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
 *
 * The bot shows the model's reasoning above its answer, because DeepSeek's
 * thinking mode produces a lot of it and watching it is half the point of
 * running a chat demo against a reasoning model. Set `SHOW_THINKING=0` to print
 * only the answers.
 *
 * `REASONING_EFFORT` sets how hard the model thinks. It is a cost knob: on a
 * short factual question the same reply cost 124 tokens at the default effort and
 * 24 with `REASONING_EFFORT=none`. Values: none, minimal, low, medium, high,
 * xhigh, max, ultra — or unset to let the provider decide, which is `high`.
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
// Truthiness, not `!== undefined`: an empty variable is still a set variable, and
// sending `reasoning_effort: ""` is a 422 from DeepSeek.
const reasoningEffort = process.env.REASONING_EFFORT || undefined;
if (reasoningEffort !== undefined) process.stdout.write(`effort: ${reasoningEffort} | model: ${model}\n`);

// Unset means on: an empty string is still a set variable, so this reads the
// value rather than its presence.
const showThinking = (process.env.SHOW_THINKING ?? "1") !== "0";

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

  // Reasoning and answer arrive interleaved on one stream, so some state is
  // needed to know whether the current line is the model thinking or talking.
  // The two get different prefixes: reasoning is often long, and mixing it into
  // the answer makes the answer hard to find.
  let mode = "idle";
  const open = (next) => {
    if (mode !== next) process.stdout.write(mode === "idle" ? "" : "\n");
    if (mode !== next) process.stdout.write(next === "thinking" ? "bot (thinking)> " : "bot> ");
    mode = next;
  };

  // Nothing is mutated for us: the result carries the transcript to send next.
  const result = await run({
    client,
    model,
    messages,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    onEvent: (event) => {
      if (event.type === "thinking_delta") {
        if (!showThinking) return;
        open("thinking");
        process.stdout.write(event.text);
      }
      if (event.type === "text_delta") {
        open("text");
        process.stdout.write(event.text);
      }
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
