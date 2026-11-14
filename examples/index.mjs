#!/usr/bin/env node
/**
 * A multi-turn chat bot with local text and image reading tools.
 *
 *   npm run example
 *
 * Needs `OPENAI_API_KEY` in the environment. The base URL and model default to
 * DeepSeek; both can be overridden with `OPENAI_BASE_URL` and `OPENAI_MODEL`.
 *
 * Agent owns the configuration and conversation history. This example owns
 * terminal input and event rendering; file tools come from agent-core/tools.
 *
 * Type at `you>`, or `/exit` to quit.
 * Ask it to read a text file by its absolute path and summarize it.
 * To inspect an image, configure a vision-capable endpoint/model and give its
 * absolute path. read_image supports PNG, JPEG, GIF and WebP.
 *
 * The bot shows the model's reasoning above its answer, because DeepSeek's
 * thinking mode produces a lot of it and watching it is half the point of
 * running a chat demo against a reasoning model. Thinking display and reasoning
 * effort are fixed below; edit the constants to change them.
 */
import { createInterface } from "node:readline";

import { Agent } from "agent-core";
import { createReadFileTool, createReadImageTool } from "agent-core/tools";
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
const reasoningEffort = "high";
const showThinking = true;

const agent = new Agent({
  client,
  model,
  tools: [createReadFileTool(), createReadImageTool()],
  reasoningEffort,
  system: "You are a helpful assistant. Keep answers short. Use read_file for text files and read_image for images; do not guess their contents. Both tools require an absolute path. If the user has not provided one, ask for it rather than guessing a path.",
});

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

  const result = await agent.run(text, {
    onEvent: (event) => {
      if (event.type === "tool_start" || event.type === "tool_end") {
        if (mode !== "idle") process.stdout.write("\n");
        mode = "idle";
        if (event.type === "tool_start") {
          console.log(`tool> ${event.toolName} ${JSON.stringify(event.args)}`);
        } else {
          console.log(`tool> ${event.toolName} ${event.result.isError ? "failed" : "completed"}`);
        }
      }
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

  if (terminal) rl.prompt();
}

rl.close();
