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

- **Zero runtime dependencies.** The core imports nothing outside the standard
  library, so embedding it never drags a provider SDK or a schema library into
  your tree.
- **No global state.** Several instances can run in the same process. No
  environment variables, no config files, no cwd assumptions, no singletons.
- **No I/O of its own.** The core never touches the filesystem or the network;
  it only calls the tool and client objects you hand it.
- **Data in, data out.** `run` returns the full message list rather than hiding
  state internally, so callers own persistence and replay.
- **Small surface.** Message types, tools, one `run` function, a few hooks.

Provider adapters live under `src/providers/`. The OpenAI adapter uses `fetch`
directly, so even the provider layer adds no runtime dependency.

## Usage

```ts
import { readFile } from "node:fs/promises";
import { openaiClient, run, defineTool, textResult } from "agent-core";

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

## Testing without a model

```ts
import { fauxClient, run, runConformance } from "agent-core";

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

## Status

Implemented: message model, JSON Schema subset validation, tools, the loop, the
provider contract, a scripted provider, a conformance suite, and the OpenAI
adapter.

Not implemented, on purpose: any UI, session storage, permissions, retries above
the adapter layer, context compaction, MCP, sub-agents.
