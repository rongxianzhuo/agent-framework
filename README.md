# agent-framework

A minimal agent runtime, built to be **embedded** rather than run.

This repository holds `agent-framework`: the part of an agent that every agent needs
and nobody should rewrite. It gives you message types, tool definitions and the
loop that drives them. It deliberately contains no UI, no session storage, no
permission prompts, no orchestration and no provider SDKs pinned into the core.

## Why it exists

Building an agent means writing the same three things every time: a provider
call, a tool schema, and a loop that feeds tool results back to the model until
it stops calling tools. That work is boring, easy to get subtly wrong, and has
nothing to do with what makes your agent different.

`agent-framework` is that shared bottom layer. Everything above it — system prompt,
context trimming, persistence, approvals, sub-agents — stays with the agent that
imports it.

## Design constraints

These are load-bearing. A change that breaks one of them needs a written
argument.

- **The core has no dependencies.** `import ... from "agent-framework"` loads nothing
  outside the Node standard library. One dependency exists in the package — the
  official `openai` SDK — and it is reachable only through `agent-framework/openai`.
  `npm install` will put it on disk either way; a core-only agent never loads it,
  and `npm run check:package` fails if that ever changes.
- **No global state.** Several instances can run in the same process. The core
  reads no environment variables, no config files, no working directory, and holds
  no singletons. (The OpenAI adapter does fall back to `OPENAI_API_KEY` when no key
  is passed to it, which is the one deliberate exception and is documented on that
  option.)
- **No I/O of its own.** The core never touches the filesystem or the network;
  it only calls the tool and client objects you hand it. Optional built-in file
  tools perform I/O only when explicitly registered and executed.
- **Data in, data out.** `run` returns the full message list rather than hiding
  state internally. Hooks can explicitly replace that history. The optional
  `Agent` class retains the resulting list per instance;
  callers still own persistence and replay.
- **Small surface.** Message types, tools, `run`, an `Agent` class, a few hooks.

Provider adapters live under `src/providers/`. `src/` is the only place allowed
to import a package, and only the adapters there do.

## Entry points

Five, so importing the core does not pull an adapter or built-in file tool into
your process:

| Import | What you get |
| --- | --- |
| `agent-framework` | Agent, loop, messages, tools, schema, hooks. Node built-ins only. |
| `agent-framework/openai` | The OpenAI Chat Completions adapter, plus the message mapping. Loads the `openai` SDK. |
| `agent-framework/faux` | A scripted `LLMClient` for tests. |
| `agent-framework/conformance` | `runConformance`, for anyone writing their own adapter. |
| `agent-framework/tools` | Optional text/image reader, text writer and editor factories. |

Requires Node 22 or later. TypeScript consumers need `@types/node`; the
declarations use `AbortSignal`, `ReadableStream` and `fetch`, which is why the
package needs no `DOM` lib.

The full guide, including how to write your own adapter and what to watch out
for, is in [docs/integration.md](docs/integration.md).

## Usage

For a conversation, create one `Agent` and send it each user input:

```ts
import { Agent } from "agent-framework";
import { openaiClient } from "agent-framework/openai";

const agent = new Agent({
  client: openaiClient({ baseURL: "https://api.openai.com/v1" }),
  model: "gpt-4o-mini",
  system: "You are a helpful assistant.",
});

await agent.run("My name is Alex.");
const result = await agent.run("What is my name?");
// agent.messages is a snapshot; save it wherever you like.
```

`Agent` accepts tools, hooks and generation defaults. Each call can supply
`onEvent`, `signal` and other execution overrides. It has no terminal or rendering
logic. For explicit transcript ownership, use the stateless `run` function:

```ts
import { readFile } from "node:fs/promises";
import { run, defineTool, textResult } from "agent-framework";
import { openaiClient } from "agent-framework/openai";

const read = defineTool<{ path: string }>({
  name: "read",
  description: "Read a file and return its contents.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
  execute: async (args) => textResult(await readFile(args.path, "utf8")),
});

const client = openaiClient({ baseURL: "https://api.openai.com/v1" });

const result = await run({
  client,
  model: "gpt-4o-mini",
  messages: [
    { role: "system", content: [{ type: "text", text: "You are a coding agent." }] },
    { role: "user", content: [{ type: "text", text: "What is in src/index.ts?" }] },
  ],
  tools: [read],
  onEvent: (event) => {
    if (event.type === "text_delta") process.stdout.write(event.text);
  },
});

// Persist this wherever you like; pass it back in to continue.
await save(result.messages);
```

`run` returns `{ messages, usage, turns, stopReason, error? }`. It does not throw
for model or tool failures — those come back in the result.

## Built-in file tools

```ts
import { createEditFileTool, createReadFileTool, createReadImageTool, createWriteFileTool } from "agent-framework/tools";

const agent = new Agent({
  client,
  model,
  tools: [
    createReadFileTool({ maxBytes: 1024 * 1024 }), // 1 MiB
    createReadImageTool({ timeoutMs: 10_000 }),
    createWriteFileTool(),
    createEditFileTool(),
  ],
});
```

All file tools require absolute paths. `read_file` returns UTF-8 text; `read_image`
returns a Base64 image block for PNG, JPEG, GIF or WebP, identified by file
signature. Each factory accepts optional `name` and `timeoutMs` settings and
returns an ordinary `ToolDefinition`. Registration is explicit; permissions still
use your existing `onToolCall` hook. Importing `agent-framework` alone loads none of these tools.

`write_file` accepts `{ path, content }` and creates or overwrites a UTF-8 text
file. Empty content clears the file. Parent directories must already exist, and
success returns a text confirmation with the number of bytes written.

`edit_file` accepts `{ file_path, old_string, new_string, replace_all? }` to
replace exact literal text in an existing UTF-8 file. `replace_all` defaults to
false: no match or multiple matching positions return an error without writing.
Set it to true to replace all non-overlapping matches. `old_string` must be
nonempty; an empty `new_string` deletes the matched text.

`read_file` rejects obvious binary content and invalid UTF-8 rather than sending
garbled text to the model. Detection uses contents, not filename extensions;
other text encodings must be converted to UTF-8 first.

`read_file` also accepts `maxBytes`: a non-negative safe integer specifying the
maximum file size in bytes. Omit it for no limit; zero allows only empty files.
Files exactly at the limit are accepted. Larger files fail without returning
partial text. Reads are bounded even if a file grows after its size is checked.

The model may pass `offset` and `limit` together to read a line range:

```json
{ "path": "/absolute/file.txt", "offset": 10, "limit": 20 }
```

This skips 10 lines and returns at most 20 lines (lines 11–30). `offset` is a
non-negative integer, `limit` is a positive integer, and both must be supplied or
both omitted. Omitting both reads the whole file. Original line endings are
preserved; an offset beyond EOF returns empty text. `maxBytes` still limits the
entire file, even when a line range is requested.

## Image inputs

Use a vision-capable model and pass text and images as user content blocks:

```ts
await agent.run([
  { type: "text", text: "Compare these images." },
  { type: "image", url: "https://example.com/photo.jpg" },
  { type: "image", mimeType: "image/png", data: imageBase64 },
]);
```

Base64 data has no `data:` prefix and requires a MIME type. URL images use a
fully qualified HTTP(S) URL accessible to the model provider. Each image has one
source. The OpenAI-compatible adapter sends URLs unchanged and wraps Base64 as
a data URL. The framework does not download URL images. Images remain in history
for followup questions and can be removed by your context compression policy.

## Context compression

`Agent` optionally accepts an application-defined strategy:

```ts
const agent = new Agent({
  client,
  model: "gpt-4o-mini",
  contextCompression: {
    shouldCompress: ({ lastRequest }) => {
      const usage = lastRequest?.usage;
      return usage !== undefined && usage.inputTokens + usage.outputTokens > 200_000;
    },
    compress: ({ messages, signal }) => summarizeHistory(messages, signal),
  },
});
```

`summarizeHistory` is your function returning a replacement `Message[]`. Checks
run before every model request, including turns after tools; valid compression
permanently replaces history. Omit the strategy or set it to `null` to disable it.
`agent.lastRequest` exposes the latest individual request's model, provider and
optional usage across runs. It is not the cumulative `RunResult.usage`, nor an
exact estimate of the next request. See the guide for failure and hook semantics.

## Hooks: the caller's three decisions

The core has no opinions about how much context fits, which tools are allowed, or
what a caller's UI should display. Those belong to the embedding agent, and each
one happens at a specific point in the loop.

```ts
const result = await run({
  client,
  model: "gpt-4o-mini",
  messages,
  tools: [deleteFile, listDir],
  hooks: {
    // Trim or inject just before the request is sent.
    onBeforeRequest: ({ request }) => ({ ...request, messages: trim(request.messages) }),

    // Permission check. Returning a denial does not stop the run: the model is
    // told "no" as a tool result and gets to try something else.
    onToolCall: ({ call }) => {
      if (call.name === "delete_file" && !isInsideTmp(call.args)) {
        return { deny: "Refused: that path is outside /tmp." };
      }
    },

    // Rewrite what the model sees. The raw value can stay in `details`.
    onToolResult: ({ result }) => ({
      ...result,
      content: result.content.map((block) =>
        block.type === "text" ? { ...block, text: redact(block.text) } : block,
      ),
    }),
  },
});
```

Every hook is optional. `onBeforeRequest` and `onToolResult` chain, so a list of
them composes; `onToolCall` short-circuits, because a guard that says no must not
be overridden by a later hook that means to allow. A hook that throws ends the run
with `kind: "hook"` — a guard that crashes is not a guard.

`onBeforeRequest` returns a plain request for temporary changes. To permanently
replace history, return `{ request: updatedRequest, replaceHistory: true }`.
Only messages persist; model and generation settings remain per-request. The
framework validates the replacement before committing it, and `Agent` retains
the resulting history. Compression timing and strategy belong to the caller.

`onToolCall` can also return `{ result }` to answer without running the tool,
which is how caching and test stubs work.

## Testing without a model

```ts
import { run } from "agent-framework";
import { fauxClient } from "agent-framework/faux";
import { runConformance } from "agent-framework/conformance";

const client = fauxClient({
  turns: [
    { toolCalls: [{ id: "c1", name: "read", args: { path: "a.ts" } }] },
    { text: "a.ts is a test file." },
  ],
});
```

`fauxClient` scripts an `LLMClient` and streams it exactly as a real adapter
does. `runConformance(client, { model })` runs six checks against any adapter —
including one you write yourself — and returns pass/fail data.

## Where to look next

- **`docs/integration.md`** — the guide: tools, hooks, errors, writing an adapter,
  and the things that surprise people.
- **`examples/index.mjs`** — a multi-turn chat bot with `read_file`, `read_image`,
  `write_file` and `edit_file` tools. Give an absolute path to a text file or a PNG/JPEG/GIF/WebP
  image. Configure a vision-capable endpoint/model for image understanding;
  the default endpoint is DeepSeek. Relative paths are rejected. It prints tool
  activity and the model's reasoning above each answer, which is
  what `thinking_delta` events are for. `Agent` carries the transcript between
  turns; terminal input and rendering stay in the example. Needs
  `OPENAI_API_KEY`, then `npm run example`.

## Source layout

- `src/core/` — messages, model client contracts, schema types, errors and usage.
- `src/runtime/` — Agent, the run loop, events, hooks and transcript validation.
- `src/tools/` — tool definitions, registry, execution, results and schema validation.
- `src/builtins/` — optional filesystem tool implementations and shared path checks.
- `src/providers/` — concrete adapters and dependency-free shared stream assembly.
- `src/testing/` — the adapter conformance suite.

Root entry files (`index.ts`, `openai.ts`, `faux.ts`, `conformance.ts`, `tools.ts`) define the
public exports. Internal modules import their dependencies directly. Core modules
depend only on core; tools depend on core; runtime depends on core and tools.
Adapters depend on core and shared provider helpers; built-ins depend on core and
tool mechanisms. `npm run invariants` checks these boundaries and prevents the
core entry point from loading adapters, SDKs or built-in file tools.

## Status

Implemented: message model, JSON Schema subset validation, tools, Agent, the loop, the
provider contract, hooks, context compression strategies, built-in file readers, writer and editor,
a scripted provider, a conformance suite, and the OpenAI adapter.

Not implemented, on purpose: any UI, session storage, permissions *policy* (the
hook is the mechanism; deciding who may delete what is the caller's), retries
above the adapter layer, built-in context summarization, MCP, sub-agents.
