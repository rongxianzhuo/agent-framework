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

Provider adapters live under `src/providers/` and are optional subpath imports.
They may depend on a vendor SDK; the core may not.

## Status

Skeleton only. The message model, tool validation, loop and adapters land in the
steps that follow; see the commits for the current state.
