# agent-framework

A minimal agent runtime, built to be **embedded** rather than run.

This repository holds `agent-core`: the part of an agent that every agent needs
and nobody should rewrite. It gives you message types, tool definitions and the
loop that drives them. It deliberately contains no UI, no session storage, no
permission prompts, no orchestration and no provider SDKs pinned into the core.

## Why it exists

Building an agent means writing the same three things every time: a provider
call, a tool schema, and a loop that feeds tool results back to the model until
it stops calling tools. That work is boring, easy to get subtly wrong, and has
nothing to do with what makes your agent different.

`agent-core` is that shared bottom layer. Everything above it — system prompt,
context trimming, persistence, approvals, sub-agents — stays with the agent that
imports it.

## Design constraints

These are load-bearing. A change that breaks one of them needs a written
argument.

- **The core has no dependencies.** `import ... from "agent-core"` loads nothing
  outside the Node standard library. One dependency exists in the package — the
  official `openai` SDK — and it is reachable only through `agent-core/openai`.
  `npm install` will put it on disk either way; a core-only agent never loads it,
  and `npm run check:package` fails if that ever changes.
- **No global state.** Several instances can run in the same process. No
  environment variables, no config files, no cwd assumptions, no singletons.
- **No I/O of its own.** The core never touches the filesystem or the network;
  it only calls the tool and client objects you hand it.
- **Data in, data out.** `run` returns the full message list rather than hiding
  state internally, so callers own persistence and replay.
- **Small surface.** Message types, tools, one `run` function, a few hooks.

Provider adapters live under `src/providers/`. `src/` is the only place allowed
to import a package, and only the adapters there do.

## Entry points

Four, so that importing the core does not pull an adapter into your process:

| Import | What you get |
| --- | --- |
| `agent-core` | Loop, messages, tools, schema, hooks. Node built-ins only. |
| `agent-core/openai` | The OpenAI Chat Completions adapter, plus the SSE parser and message mapping. |
| `agent-core/faux` | A scripted `LLMClient` for tests. |
| `agent-core/conformance` | `runConformance`, for anyone writing their own adapter. |

Requires Node 22 or later. TypeScript consumers need `@types/node`; the
declarations use `AbortSignal`, `ReadableStream` and `fetch`, which is why the
package needs no `DOM` lib.

The full guide, including how to write your own adapter and what to watch out
for, is in [docs/integration.md](docs/integration.md).

## Usage

```ts
import { readFile } from "node:fs/promises";
import { run, defineTool, textResult } from "agent-core";
import { openaiClient } from "agent-core/openai";

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

`onToolCall` can also return `{ result }` to answer without running the tool,
which is how caching and test stubs work.

## Testing without a model

```ts
import { run } from "agent-core";
import { fauxClient } from "agent-core/faux";
import { runConformance } from "agent-core/conformance";

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
- **`examples/chat/index.mjs`** — a multi-turn chat bot in about a hundred lines,
  pointed at DeepSeek. It prints the model's reasoning above each answer, which is
  what `thinking_delta` events are for. The part worth reading is how the
  transcript is carried between turns, since the library keeps no state. Needs
  `OPENAI_API_KEY`, then `npm run example`.

## Status

Implemented: message model, JSON Schema subset validation, tools, the loop, the
provider contract, hooks, a scripted provider, a conformance suite, and the
OpenAI adapter.

Not implemented, on purpose: any UI, session storage, permissions *policy* (the
hook is the mechanism; deciding who may delete what is the caller's), retries
above the adapter layer, context compaction, MCP, sub-agents.
