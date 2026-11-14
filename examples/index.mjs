#!/usr/bin/env node
/**
 * A multi-turn chat bot with a local file-reading tool, against DeepSeek.
 *
 *   npm run example
 *
 * Needs `OPENAI_API_KEY` in the environment. The base URL and model default to
 * DeepSeek; both can be overridden with `OPENAI_BASE_URL` and `OPENAI_MODEL`.
 *
 * Everything here is the smallest version of something an embedding agent needs:
 * a system prompt, a tool, a loop that reads a line and answers it, and a
 * transcript that survives between turns.
 *
 * That last part is the one thing worth reading the code for. `run()` holds no
 * state: it returns the transcript it produced, and passing that back in on the
 * next call is what makes it a conversation rather than a series of unrelated
 * questions. There is no session object to open, close or clean up.
 *
 * Type at `you>`, or `/exit` to quit.
 * Ask it to read a text file by its absolute path and summarize it.
 *
 * The bot shows the model's reasoning above its answer, because DeepSeek's
 * thinking mode produces a lot of it and watching it is half the point of
 * running a chat demo against a reasoning model. Thinking display and reasoning
 * effort are fixed below; edit the constants to change them.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, parse } from "node:path";
import { createInterface } from "node:readline";

import { defineTool, run, textResult } from "agent-core";
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

const readFileTool = defineTool({
  name: "read_file",
  description: "Read a local UTF-8 text file using an absolute path. Relative paths are not accepted.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", minLength: 1, description: "Absolute path of the text file to read." } },
    required: ["path"],
    additionalProperties: false,
  },
  execute: async ({ path }, ctx) => {
    // On Windows, a root-only path such as \file still depends on the current drive.
    if (!isAbsolute(path) || (process.platform === "win32" && parse(path).root.length === 1)) {
      throw new Error("An absolute file path is required. Ask the user for the full path.");
    }
    return textResult(await readFile(path, { encoding: "utf8", signal: ctx.signal }));
  },
});

// The conversation lives here, not in the library.
let messages = [
  {
    role: "system",
    content: [{
      type: "text",
      text: "You are a helpful assistant. Keep answers short. Use read_file when you need to inspect a local file; do not guess its contents. The tool requires an absolute path. If the user has not provided one, ask for it rather than guessing a path.",
    }],
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
    tools: [readFileTool],
    reasoningEffort,
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
  messages = result.messages;

  if (terminal) rl.prompt();
}

rl.close();
