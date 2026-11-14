# Integrating agent-core

Everything you need to put an agent inside your own program. Written for someone
who has a project and wants a model loop in it, not for someone who wants to
understand this repository.

If you would rather read code than prose, `examples/index.mjs` is a
multi-turn chat bot with a local `read_file` tool in one file, and its loop is the
shape every embedding agent starts from. It targets DeepSeek's endpoint and needs
`OPENAI_API_KEY`. Run `npm run example`, then ask it to read a text file by its
absolute path. The tool rejects relative paths, and the system prompt does not
include the current working directory.

## What you are getting

A function called `run`. Give it a transcript and a client that can talk to a
model; it calls the model, executes whatever tools the model asks for, feeds the
results back, and repeats until the model stops asking. It returns the new
transcript. The `Agent` class wraps this function with per-instance conversation
history and reusable configuration. Both are available from `agent-core`.

Everything else stays yours: the system prompt, what tools exist and what they
do, how much history fits, which calls need approval, where the transcript is
stored, what the user sees. The library has no UI, no session storage, no
configuration files and no global state.

It has one dependency: the official `openai` SDK, used by `agent-core/openai` and
nowhere else. Importing `agent-core` alone does not load it, so an agent that only
wants the loop pays nothing at runtime — though `npm install` puts the SDK on disk
regardless, because npm has no per-entry-point dependencies. If that matters to
you, it is the price of not maintaining an SSE framer and a protocol mapping by
hand.

## Install and run

```sh
npm install agent-core
```

```ts
import { readFile } from "node:fs/promises";
import { run, defineTool, textResult } from "agent-core";
import { openaiClient } from "agent-core/openai";

const read = defineTool<{ path: string }>({
  name: "read_file",
  description: "Read a text file.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Path to read." } },
    required: ["path"],
    additionalProperties: false,
  },
  execute: async (args) => textResult(await readFile(args.path, "utf8")),
});

const client = openaiClient({ baseURL: "https://api.openai.com/v1" }); // reads OPENAI_API_KEY

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

await save(result.messages); // anywhere you like
```

Node 22 or later. TypeScript projects need `@types/node` — the public types use
`AbortSignal`, `ReadableStream` and `fetch`, and no `DOM` lib is required.

## Stateful conversations with Agent

```ts
import { Agent } from "agent-core";

const agent = new Agent({
  client,
  model: "gpt-4o-mini",
  system: "You are a coding agent.",
  tools: [read],
});

await agent.run("Read a.ts", { onEvent });
await agent.run("Summarize the file", { onEvent }); // automatically includes history

const saved = agent.messages;
agent.reset();                  // restores the constructor's system prompt
agent.replaceMessages(saved);   // restores the full transcript, including system messages
```

Pass a string or an array of content blocks to `agent.run(input, options)`.
Constructor options supply defaults; per-call execution options such as `signal`,
`maxTurns`, `onEvent`, `hooks` and sampling settings override those defaults for
that call only. A per-call listener or hooks object replaces the default one.
The return value is the same `RunResult` as `run()`; usage and turns cover only
that execution, while messages contain the entire conversation.

Call `agent.run()` without input to continue after a turn limit or retry a failed
model request without adding the same user message again. Model errors and
cancellations retain the returned transcript. If cancellation or a hook failure
left unanswered tool calls, the next run throws before contacting the model.
Inspect `agent.messages`, supply the actual tool outcomes with
`replaceMessages()`, or explicitly `reset()` to start a new conversation. Agent
does not automatically replay tools, since they may already have had side effects.

Snapshots and returned results cannot mutate Agent's stored message data. Opaque
tool-result `details` are kept by reference so application objects remain usable;
their ownership and serialization stay with the caller. `replaceMessages()` checks
tool-call/result pairing before accepting history. Concurrent runs or history
edits during a run are rejected; use separate instances for separate conversations.
Input, rendering, storage and retry policy remain application responsibilities.

## Four entry points

| Import | Contents |
| --- | --- |
| `agent-core` | Agent, loop, messages, tools, schema validation, hooks |
| `agent-core/openai` | OpenAI adapter (on the official SDK), wire mapping |
| `agent-core/faux` | A scripted client for tests |
| `agent-core/conformance` | `runConformance`, for people writing adapters |

The split exists so that importing the loop does not load an HTTP adapter. Import
the subpath you actually use.

## The message model

A transcript is an array of messages with one of four roles:

| Role | Meaning | Notable fields |
| --- | --- | --- |
| `system` | Instructions the caller set once | `content` |
| `user` | What the human said | `content` |
| `assistant` | What the model said | `content`, `toolCalls`, `stopReason`, `usage` |
| `toolResult` | What a tool returned | `toolCallId`, `toolName`, `content`, `isError`, `details` |

`content` is an array of blocks: `{ type: "text", text }`, `{ type: "thinking", text, signature? }`,
or `{ type: "image", ... }`.

Two design choices you will notice immediately:

**An assistant message carries text and tool calls as sibling fields**, not as a
union of "a text message" and "a tool call message". Models routinely emit both in
one response, and a union would force you to narrow and re-assemble before you
could look at a turn.

```ts
const assistant = result.messages.find((m) => m.role === "assistant");
assistant?.content;    // what it said
assistant?.toolCalls;  // what it wants run — often both are non-empty
```

**Tool results carry `content` for the model and `details` for you.** The model
sees a string; your UI sees structured data.

```ts
return jsonResult({ rows: 12, took: "40ms" }); // content: pretty JSON, details: the object
```

## Tools

A tool is a name, a description, JSON Schema parameters, and a function.

```ts
const search = defineTool<{ query: string; limit?: number }>({
  name: "search",
  description: "Search the notes. Returns matching lines.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words to look for." },
      limit: { type: "number", minimum: 1, maximum: 50 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  execute: async (args, ctx) => {
    // ctx.signal aborts when the run is cancelled; pass it to your I/O.
    // ctx.onUpdate("progress text") streams a partial result to the caller.
    const lines = await searchNotes(args.query, args.limit ?? 10, ctx.signal);
    return lines.length === 0 ? textResult("No matches.") : textResult(lines.join("\n"));
  },
  timeoutMs: 10_000, // optional; there is no default
});
```

The schema is a deliberate subset of JSON Schema:

- Supported: `type` (including `["string", "null"]` for nullable), `properties`,
  `required`, `additionalProperties`, `items`, `minItems`, `maxItems`,
  `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `enum`, `const`,
  `default`, `description`.
- Rejected at definition time: `anyOf`, `oneOf`, `allOf`, `not`, `$ref`, `$defs`,
  `format`, `multipleOf`, `exclusiveMinimum`, `exclusiveMaximum`, `uniqueItems`,
  `contains`, `if`/`then`/`else`, and the rest. An unsupported keyword throws
  rather than being silently ignored, because ignoring a constraint produces a
  tool that fails at runtime for reasons its author cannot see.

### Failures are data, not exceptions

This is the rule that makes a run self-correcting. A tool that throws, times out,
returns `isError`, receives bad arguments, or does not exist at all produces a
`toolResult` with `isError: true` whose text the model reads on the next turn. The
run continues; `run()` does not throw.

```ts
execute: async (args) => {
  if (!exists(args.path)) throw new Error(`${args.path} does not exist`);
  return textResult(await read(args.path));
}
```

The model sees `read_file failed: /tmp/x does not exist` and can try another path.
You see the failure as an `error` event with `fatal: false` on `onEvent`, if you
want to log it. Bad arguments do not raise that event — the reason is already in
the tool result the model is reading, and a model guessing at a schema is not an
incident worth logging as one.

Four things count as failures: unknown tool name, arguments that fail the schema,
a thrown error, and a returned `isError`. All four are distinguishable in the text
the model receives, so it can tell "that tool does not exist" from "that path is
wrong".

## The loop

```ts
const result = await run({
  client,                        // an LLMClient
  model: "gpt-4o-mini",
  messages,                      // the transcript so far; not mutated
  tools,                         // omitted means chat-only
  signal,                        // AbortSignal, optional
  maxTurns: 12,                  // default: unlimited
  parallelTools: true,           // default: true
  maxOutputTokens: 512,
  temperature: 0.2,
  reasoningEffort: "low",        // for models that think before answering
  hooks,                         // see below
  onEvent: (event) => {},        // progress; awaited
  providerOptions: {},           // handed to the adapter untouched
});
```

The result:

```ts
interface RunResult {
  messages: Message[];           // input + everything this run appended
  usage: Usage;                  // summed over every model call
  turns: number;                 // model calls made
  stopReason: "completed" | "maxTurns" | "aborted" | "error";
  error?: NormalizedError;
}
```

### Reasoning effort

Models with a reasoning mode spend output tokens thinking before they write
anything. `reasoningEffort` is both a quality and a cost knob, and it is the one
setting whose effect is large enough to be surprising: on DeepSeek, "9.11 and 9.8,
which is greater?" cost 124 tokens at the default effort and 24 with reasoning
off — a saving of about 80%, on a question the model then got wrong.

```ts
await run({ client, model, messages, reasoningEffort: "low" });
```

Accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` and
`ultra`. Unset means the provider's default, which for DeepSeek is `high`. The
value is not validated locally: a typo comes back from the provider as an
invalid-request error that lists what it accepts, which is more useful than a
whitelist of ours would be, and a new effort level works without a release here.

`reasoningEffort` applies to every model call in a run, including the ones that
follow a tool result. With a reasoning model and tools, reasoning is often the
largest line item in the bill, so a long tool-using run is where setting it pays.

`run` never throws for a model failure or a tool failure; both arrive as
`stopReason: "error"` with `error` set. An exception escaping `run` means a bug —
a malformed tool definition, or a client that ended its stream without saying
`done`.

`maxTurns` defaults to unlimited on purpose: a model that keeps working is not an
error, and a fixed ceiling silently truncates long tasks. Pass a number when a run
has a budget.

**Continuing a conversation** is just passing the transcript back:

```ts
const first = await run({ client, model, messages: [system, userTurn1] });
const second = await run({ client, model, messages: first.messages, /* + new user turn */ });
```

Nothing is stored between runs. That is what makes persistence, replay and
branching the caller's problem to solve in whatever way suits it.

**Running tools in parallel** happens by default because it is what you want for
independent reads. Turn it off with `parallelTools: false` when tools share a
resource. Either way the transcript gets results in call order.

**Cancellation**: pass a `signal`. It reaches the in-flight model call and every
running tool. A cancelled run returns `stopReason: "aborted"` and drops the
results of interrupted tools rather than feeding them back — telling a model "your
tool was interrupted" invites it to redo work you just cancelled.

## Hooks

Three places where the core hands control back to you. All optional.

### `onBeforeRequest` — rewrite the request

Runs immediately before each model call. Return a whole `LLMRequest`, or nothing
to leave it alone.

```ts
hooks: {
  onBeforeRequest: ({ request, turn }) => ({
    ...request,
    messages: trimHistory(request.messages),
  }),
}
```

This is where context management lives: dropping old turns, injecting a reminder,
swapping the model for a cheap one on later turns, or adding a
`providerOptions` field. The core will not outsource its own judgment about how
much history fits, because that differs per model and per caller.

**Trim by whole exchanges.** An exchange begins at a user message:

```ts
function trimHistory(messages: readonly Message[]): Message[] {
  const starts = messages.flatMap((m, i) => (m.role === "user" ? [i] : []));
  if (starts.length <= 6) return [...messages];

  const cut = starts.at(-6)!;
  const system = messages[0]?.role === "system" ? [messages[0]] : [];
  return [...system, ...messages.slice(cut)];
}
```

Cutting anywhere else can separate an assistant's tool call from the result that
answers it. If you do break the pairing, `run` stops with `kind: "invalidRequest"`
and names the message index and call id, before the provider can reject it with a
much less useful message.

### `onToolCall` — allow, deny, or answer

Runs before each tool call, after arguments have been parsed but before the tool
runs.

```ts
// `call.args` is `unknown`: the arguments belong to a tool the model picked at
// runtime, so the type only exists where you defined that tool. Narrow once.
const argsOf = <T>(call: ToolCall): Partial<T> => (call.args ?? {}) as Partial<T>;

hooks: {
  onToolCall: async ({ call }) => {
    if (call.name === "delete_file") {
      const { path } = argsOf<{ path: string }>(call);
      if (path !== undefined && !insideWorkspace(path)) {
        return { deny: "Refused: that path is outside the workspace." };
      }
    }
    if (call.name === "search") {
      const { query } = argsOf<{ query: string }>(call);
      const hit = query === undefined ? undefined : cache.get(query);
      if (hit !== undefined) return { result: textResult(hit) };
    }
    // Return nothing to let the tool run.
  },
}
```

- Return `{ deny: reason }` to refuse. The model receives `isError: true` with your
  reason and gets to try something else. **Denying does not end the run** — that is
  the point. No `error` event is emitted, because a refusal is a decision, not a
  fault.
- Return `{ result }` to answer without running the tool: caching, stubs, tools
  whose answer is already known.
- Return nothing to proceed.

`tool` is `undefined` when the model named a tool that was never offered, which is
worth handling — models do invent tool names.

An async hook can await a human:

```ts
onToolCall: async ({ call }) => {
  const ok = await askTheUser(`Run ${call.name} with ${JSON.stringify(call.args)}?`);
  if (!ok) return { deny: "The user declined." };
};
```

This is the mechanism for permissions. The *policy* — who may delete what, which
paths are in bounds — is yours, which is why it is a hook and not a setting.

### `onToolResult` — rewrite what the model sees

```ts
hooks: {
  onToolResult: ({ result }) => {
    const text = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (text.length <= 2_000) return;
    return {
      content: [{ type: "text", text: `${text.slice(0, 2_000)}\n… truncated.` }],
      details: { truncated: true, fullLength: text.length },
      isError: result.isError ?? false,
    };
  },
}
```

Truncation, redaction, reformatting for a UI. It rewrites the message that goes
into the transcript, not just the wire format, so if you need the raw value
downstream put it in `details` yourself or keep your own copy.

Note what this hook *cannot* do: it sees tool output only. The user's own message
and the model's tool-call arguments pass through untouched, so a redaction policy
that must cover those belongs in `onBeforeRequest` instead.

### Composition

- `onBeforeRequest` and `onToolResult` **chain**: give an array and each sees the
  previous one's output.
- `onToolCall` **short-circuits**: the first hook that returns a decision wins. A
  guard that says no must not be overridable by a later hook that wants to allow.
- A hook that throws ends the run with `kind: "hook"`. It does not fall through to
  "allowed": a guard that crashes is not a guard.

## Errors

Failures are `NormalizedError` values — `{ kind, message, retryable, status?, provider?, retryAfterSeconds? }`:

| `kind` | Meaning | Retryable |
| --- | --- | --- |
| `auth` | Bad or missing credential | no |
| `rateLimit` | Provider throttled you | yes |
| `overloaded` | Provider 5xx or overloaded | yes |
| `invalidRequest` | Malformed request, or a broken transcript | no |
| `contextOverflow` | Prompt plus history exceeds the window | no — trim |
| `network` | DNS, reset, timeout | yes |
| `aborted` | Your signal fired | no |
| `invalidToolCall` | Arguments failed the schema | no — the model retries |
| `toolFailed` | A tool threw or returned `isError` | no |
| `hook` | A hook threw | no |
| `provider` | Unclassified provider failure | no |
| `unknown` | Anything else | no |

**Retries live in the adapter, not the loop.** An adapter may retry a failure that
has not yet streamed anything; once output has reached the caller, retrying would
replay text the user already saw.

The OpenAI adapter's `maxRetries` defaults to `0`, **not** the SDK's own default of
`2`: a library should not silently spend your money. Set it in the agent that owns
a budget. The retry loop itself is the SDK's, so `agent-core` passes the number
through and then gets out of the way; the SDK already refuses to replay a request
whose response body has begun streaming.

The loop's own reaction to `rateLimit` and friends is to stop and tell you. Decide
there whether to retry the whole run, with the transcript it returned.

## Writing your own adapter

An adapter is one method. Implement this and you have a provider:

```ts
interface LLMClient {
  readonly name: string;
  stream(request: LLMRequest, options?: { signal?: AbortSignal }): AsyncIterable<LLMEvent>;
}
```

The events:

```ts
{ type: "text_delta"; text: string }
{ type: "thinking_delta"; text: string }
{ type: "tool_call_delta"; index: number; id?: string; name?: string; argsDelta?: string }
{ type: "done"; message: AssistantMessage }
{ type: "error"; error: NormalizedError }
```

Assembling partial tool-call JSON is provider dialect, so the core does not do it
for you; `MessageAccumulator` does, and you feed it every event you emit:

```ts
import { MessageAccumulator } from "agent-core";

async *stream(request, options) {
  const accumulator = new MessageAccumulator();

  for await (const chunk of readYourProvider(request, options?.signal)) {
    const event = translate(chunk);          // your dialect → LLMEvent
    accumulator.push(event);
    yield event;
  }

  yield {
    type: "done",
    message: accumulator.build({
      stopReason: "stop",                    // "stop" | "length" | "toolUse" | "contentFilter" | "error"
      usage,
      model: request.model,
      provider: "my-gateway",
    }),
  };
}
```

Rules that matter more than they look:

- **Always end with exactly one `done` or one `error`.** A stream that just stops
  is a contract violation and the loop reports it as such.
- **Look at `options.signal`.** Abort should take effect mid-stream, not after the
  response finishes. This is the one thing the conformance suite cannot fake.
- **Report `usage` when the provider does.** Without it, cost accounting silently
  reads zero.
- **Map `finish_reason` to `stopReason`.** `toolUse` tells the loop there are calls
  to run; getting this wrong leaves tool calls unexecuted.

Then check it:

```ts
import { runConformance, formatResults, allPassed } from "agent-core/conformance";

const results = await runConformance(myClient, { model: "my-model" });
console.log(formatResults(results)); // six checks: text, system, tool-call, tool-result, abort, usage
if (!allPassed(results)) process.exit(1);
```

`runConformance` returns plain data, not test-framework objects, so it works in
Vitest, in Jest, in node:test, or in a script. Options: `only`, `skip`,
`timeoutMs`, `abortGraceMs`, `toolName`, `providerOptions`.

`maxOutputTokens` is the one option worth setting deliberately. It is unset by
default, so the suite sends no output cap and the cost of a run is whatever the
model decides to generate. A cap used to be the default and made checks fail for
budget reasons — a reasoning model spends the budget thinking before it writes,
which truncated tool-call JSON mid-object — so if you run this against an
expensive model, set a cap and accept that a failure may mean "ran out of room"
rather than "wrong".

## Testing without a model

`fauxClient` scripts responses and streams them exactly as a real adapter does:

```ts
import { fauxClient } from "agent-core/faux";

const client = fauxClient({
  turns: [
    { text: "Let me look.", toolCalls: [{ id: "c1", name: "read", args: { path: "a.txt" } }] },
    { text: "It contains hello." },
  ],
  chunkSize: 4,        // stream in small pieces, to exercise accumulation
});

const result = await run({ client, model: "test", messages, tools });
expect(client.requests).toHaveLength(2);        // what was actually sent
expect(result.stopReason).toBe("completed");
```

`turns` can be a function of the request, which is how you script a model that
responds to what it was given:

```ts
const client = fauxClient({
  turns: (request, index) => (index === 0
    ? { toolCalls: [{ id: "c1", name: "read", args: { path: "a.txt" } }] }
    : { text: "done" }),
});
```

Other knobs: `delayMs` and `chunkDelayMs` per turn (to test timeouts and aborts),
`error` (to script a provider failure), `onExhausted: "error" | "repeatLast"`,
`reset()`.

## Things that surprise people

- **`content` on an assistant message can be empty.** A turn that only calls a
  tool has `content: []` and non-empty `toolCalls`. Check `stopReason === "toolUse"`,
  not "did it say anything".
- **Thinking blocks are echoed back only when the request carries tools.** With
  no tools, the OpenAI adapter drops them: the API does not accept its own
  reasoning content as input. With tools, it sends them as `reasoning_content`,
  because DeepSeek's thinking mode requires exactly that — a request containing
  `tools` must echo the reasoning of every prior assistant turn, or the API
  answers 400. Thinking blocks stay in your transcript either way, for your UI.

  Two things to know about that echo. `reasoningEcho` defaults to
  `"when-present"`, which leaves the field off when a message has no thinking —
  that is what keeps a transcript written by a provider without thinking blocks
  unchanged on the wire. Set `reasoningEcho: "always"` on DeepSeek when you build
  an assistant tool turn yourself instead of taking one from a model response: it
  sends an empty `reasoning_content` for that turn, which DeepSeek accepts where
  it rejects a missing field (measured on `deepseek-flash` and `deepseek-v4-pro`).
  `reasoningEcho: "never"` turns the field off for a gateway that refuses it.
- **`temperature` does nothing while reasoning is on.** DeepSeek ignores
  `temperature`, `presence_penalty` and `frequency_penalty` in thinking mode, and
  says so, but it does not reject them — the request succeeds and the parameter is
  silently dropped. If you tuned a temperature and the output did not change, this
  is why. `top_p` is model-dependent: on `deepseek-flash` it only applies in
  thinking mode and is clamped to 0.95–1.0.
- **`extra_body` is a Python concept.** DeepSeek's docs show provider-specific
  parameters inside `extra_body={"thinking": ...}`, which is how the Python SDK
  takes unknown fields. The JavaScript SDK has no such wrapper — unknown top-level
  fields pass straight through — so in TypeScript the same parameter goes at the
  top level, or through `providerOptions`.
- **A thinking model spends `max_tokens` on reasoning first.** Reasoning and the
  answer share one budget, so a cap that looks generous for prose can truncate
  the tool-call JSON before the model writes any. Size caps for thinking models
  with that in mind, or leave the cap off.
- **`baseURL` includes the version segment if the provider uses one.**
  `https://api.openai.com/v1` works; so does `https://api.deepseek.com` without
  `/v1`. There is no default — guessing one produces confusing 404s.
- **`model` is required.** No default model, no default base URL. A library that
  guesses which model you meant is a library that bills you for the wrong one.
- **Newer OpenAI models want `max_completion_tokens` instead of `max_tokens`.**
  Set `maxTokensField: "max_completion_tokens"` on the adapter if your model
  rejects the latter.
- **The loop never mutates your array.** Every run appends to a copy. Persist what
  it returns, not what you passed in.
- **A tool result with `isError: true` still ends the turn normally.** It is
  appended to the transcript and the model gets another turn. Only `stopReason`
  tells you the run as a whole failed.
- **`call.args` in a hook is `unknown`, deliberately.** A hook runs before
  anything knows which tool's schema applies to this call, and the value came from
  a model. Narrow it next to the tool definition that owns the shape.
- **`details` is not sent to the model.** It is for you. Nothing in it reaches the
  provider, so it is a safe place for structured data, but it is also not a place
  the model can read.
- **The SDK is installed even if you never touch it.** `npm install agent-core`
  puts `openai` (~35 MB) in `node_modules`. Nothing loads it unless you import
  `agent-core/openai`, but the disk cost is real. If you are embedding only the
  loop and care about install size, that is the trade to weigh.
- **`maxTurns` off by default cuts both ways.** A loop that never terminates will
  not terminate. Watch `turns` in logs and set a ceiling where a run can be long.

## Deliberately not included

Any UI. Session storage. A permission policy (the hook is the mechanism, the
decision is yours). Retries above the adapter. Context compaction heuristics. MCP.
Sub-agents. Orchestration. Every one of these has a place in a real agent, and none
of them belongs in a library that several different agents import — they would
each need to be configurable, and each configuration would leak into every
consumer.

If you find yourself wanting one, the hook is usually where it goes, in your
repository rather than this one.
