#!/usr/bin/env node
/**
 * A multi-turn chat bot, in one file.
 *
 *   npm run example              # offline, a scripted model, costs nothing
 *   npm run example -- --live    # a real model; reads OPENAI_API_KEY
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
 * Type at `you>`, or `/exit` to quit. Ctrl-D does the same.
 */
import { createInterface } from "node:readline";

import { run } from "agent-core";
import { fauxClient } from "agent-core/faux";

const live = process.argv.includes("--live");

const client = live
  ? // Imported only when asked for, so the offline path never loads the adapter.
    await import("agent-core/openai").then(({ openaiClient }) =>
      openaiClient({ baseURL: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1" }),
    )
  : fauxClient({
      // A scripted stand-in for a model. It answers from the transcript it was
      // handed, so its replies show the conversation actually accumulating.
      turns: (request) => {
        const textOf = (message) => message.content.map((block) => block.text ?? "").join("");
        const users = request.messages.filter((message) => message.role === "user").map(textOf);
        const answers = request.messages.filter((message) => message.role === "assistant").length;
        return {
          text: `You have sent me ${users.length} message(s) and I have answered ${answers} time(s). The last one was "${users.at(-1) ?? ""}".`,
        };
      },
    });

const model = live ? (process.env.OPENAI_MODEL ?? "gpt-4o-mini") : "faux";

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
  }
  messages = result.messages;

  if (terminal) rl.prompt();
}

rl.close();
