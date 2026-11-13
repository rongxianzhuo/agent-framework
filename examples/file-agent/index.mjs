#!/usr/bin/env node
/**
 * A small but complete agent: it answers questions about files in a directory.
 *
 * Run it from the repository root:
 *
 *   npm run example                                  # offline, scripted model
 *   node examples/file-agent/index.mjs src --live     # real model, needs a key
 *
 * This is the example the integration guide walks through. It shows the four
 * things an embedded agent always ends up doing:
 *
 *   1. define tools with JSON Schema parameters
 *   2. confine those tools to a directory, via `onToolCall`
 *   3. keep what the model sees within a budget, via `onBeforeRequest`
 *      and `onToolResult`
 *   4. stream progress to a human, via `onEvent`
 *
 * By default it uses the scripted client, so it runs offline and costs nothing.
 * `--live` swaps in the OpenAI adapter; the key comes from the environment and is
 * never read by this file.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";

import { run, defineTool, textResult } from "agent-core";
import { fauxClient } from "agent-core/faux";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const live = args.includes("--live");
const rootArg = args.find((arg) => !arg.startsWith("--")) ?? ".";
const root = resolve(rootArg);
const question = process.env.EXAMPLE_QUESTION ?? `What does this project do? Look at ${rootArg}.`;

// ---------------------------------------------------------------------------
// Tools
//
// Each tool resolves the path it was given against `root` and refuses anything
// that escapes, so a model cannot read `../../etc/passwd` by asking nicely.
// ---------------------------------------------------------------------------

/** Resolve `path` inside `root`, or throw with a message the model can read. */
function inside(path) {
  const full = resolve(root, path ?? ".");
  const rel = relative(root, full);
  if (rel.startsWith("..") || (rel !== "" && rel.split(sep)[0] === "..") || rel.startsWith("/")) {
    throw new Error(`${path} is outside ${root}. The tools only work inside it.`);
  }
  return full;
}

const listFiles = defineTool({
  name: "list_files",
  description: "List files and directories at a path inside the project.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory, relative to the project root. Defaults to root." },
    },
    additionalProperties: false,
  },
  execute: async (toolArgs) => {
    const dir = inside(toolArgs.path);
    const entries = await readdir(dir, { withFileTypes: true });
    const lines = entries
      .filter((entry) => entry.name !== "node_modules" && entry.name !== ".git")
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`);
    return textResult(lines.join("\n") || "(empty)");
  },
  timeoutMs: 5_000,
});

const readText = defineTool({
  name: "read_file",
  description: "Read a text file inside the project.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the project root." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  execute: async (toolArgs) => {
    const file = inside(toolArgs.path);
    const info = await stat(file);
    if (info.size > 200_000) {
      return { content: [{ type: "text", text: `${toolArgs.path} is ${info.size} bytes, too large to read.` }],
        isError: true };
    }
    return textResult(await readFile(file, "utf8"));
  },
  timeoutMs: 5_000,
});

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

const MAX_TOOL_CHARS = 2_000;
const MAX_EXCHANGES = Number(process.env.EXAMPLE_MAX_EXCHANGES ?? 6);

/**
 * Keep the system message and the last few exchanges.
 *
 * An exchange starts at a user message, and that is the only place a cut is safe:
 * cutting between an assistant's tool call and the tool result that answers it
 * produces a transcript providers reject. Keeping whole exchanges means the
 * pairing can never break, whatever the model did in between.
 */
function trim(messages) {
  const starts = messages.flatMap((message, index) => (message.role === "user" ? [index] : []));
  if (starts.length <= MAX_EXCHANGES) return messages;

  const cut = starts[starts.length - MAX_EXCHANGES];
  const system = messages[0]?.role === "system" ? [messages[0]] : [];
  return [...system, ...messages.slice(cut)];
}

const hooks = {
  onBeforeRequest: ({ request }) => {
    const messages = trim(request.messages);
    if (messages !== request.messages) {
      console.log(`\n[hooks] trimmed ${request.messages.length} messages to ${messages.length}`);
    }
    return { ...request, messages };
  },

  onToolCall: ({ call }) => {
    // A second guard, independent of what the tools do themselves. This is where
    // a UI would ask a human instead.
    if (call.name === "read_file" && String(call.args?.path ?? "").includes(".env")) {
      return { deny: "Refused: .env files are off limits." };
    }
  },

  onToolResult: ({ result }) => {
    const text = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (text.length <= MAX_TOOL_CHARS) return;

    return {
      content: [
        { type: "text", text: `${text.slice(0, MAX_TOOL_CHARS)}\n… truncated ${text.length - MAX_TOOL_CHARS} chars.` },
      ],
      // The untruncated text stays available to the caller's own code.
      details: { truncated: true, full_length: text.length },
      isError: result.isError ?? false,
    };
  },
};

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const client = live
  ? // Imported only when needed, so the offline path never loads the adapter.
    await import("agent-core/openai").then(({ openaiClient }) =>
      openaiClient({ baseURL: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1" }),
    )
  : fauxClient({
      // A scripted model that follows the same loop as a real one: list, then read
      // one file from the listing, then answer. Written as a function of the
      // request so it works for whatever directory you point it at. It also takes
      // the question literally, which is how the offline self-check exercises the
      // two refusals.
      turns: (request) => {
        const last = request.messages.at(-1);

        if (last.role === "user") {
          if (question.includes("..")) {
            return { text: "Reading above the root.\n", toolCalls: [{ id: "c1", name: "read_file", args: { path: "../etc/passwd" } }] };
          }
          if (question.includes(".env")) {
            return { text: "Reading the env file.\n", toolCalls: [{ id: "c1", name: "read_file", args: { path: ".env" } }] };
          }
          return { text: "Let me look at what is here.\n", toolCalls: [{ id: "c1", name: "list_files", args: {} }] };
        }

        if (last.role === "toolResult" && last.toolName === "list_files") {
          const listing = last.content.map((block) => block.text).join("");
          const firstFile = listing
            .split("\n")
            .filter((line) => line.startsWith("file "))
            .map((line) => line.slice(5))
            .at(0);

          if (firstFile !== undefined) {
            return { toolCalls: [{ id: "c2", name: "read_file", args: { path: firstFile } }] };
          }
          return { text: "There are no files here." };
        }

        const sample = last.content.map((block) => block.text).join("").slice(0, 160).replaceAll("\n", " ");
        return {
          text: `${rootArg}: ${sample}…\n(Scripted answer — rerun with --live for a real one.)`,
        };
      },
    });

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

const system = {
  role: "system",
  content: [
    {
      type: "text",
      text: "You answer questions about a project by listing and reading its files. List before you read. Be brief.",
    },
  ],
};

const onEvent = (event) => {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.text);
      break;
    case "tool_start":
      console.log(`\n[tool] ${event.toolName} ${JSON.stringify(event.args ?? {})}`);
      break;
    case "tool_end":
      console.log(`[tool] ${event.toolName} ${event.durationMs}ms${event.result.isError ? " (refused or failed)" : ""}`);
      break;
    case "error":
      console.log(`\n[error] ${event.error.kind}: ${event.error.message}`);
      break;
    default:
      break;
  }
};

/** One run. Passing the previous transcript back in is how a conversation continues. */
async function ask(messages, text) {
  console.log(`\nquestion: ${text}`);

  const result = await run({
    client,
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    messages: [...messages, { role: "user", content: [{ type: "text", text }] }],
    tools: [listFiles, readText],
    hooks,
    maxTurns: 12,
    maxOutputTokens: 512,
    onEvent,
  });

  console.log(`\n${"-".repeat(60)}`);
  console.log(`stop: ${result.stopReason} | turns: ${result.turns} | tokens: ${result.usage.totalTokens}`);
  console.log(`transcript: ${result.messages.map((message) => message.role).join(" > ")}`);

  if (result.error !== undefined) {
    console.log(`error: ${result.error.kind} — ${result.error.message}`);
    process.exitCode = 1;
  }

  return result.messages;
}

let transcript = [system];
transcript = await ask(transcript, question);

if (process.env.EXAMPLE_FOLLOWUP) {
  // The same transcript, one more turn. Nothing was stored anywhere: the caller
  // owns the history, which is the whole reason `run` returns it.
  transcript = await ask(transcript, process.env.EXAMPLE_FOLLOWUP);
}
