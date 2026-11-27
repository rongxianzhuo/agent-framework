import { describe, expect, it } from "vitest";
import { run, defineTool, textResult, type Message, type Usage } from "../../src/index.js";
import { fauxClient } from "../../src/faux.js";

const usage = (inputTokens: number, outputTokens = 10): Usage => ({
  inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: inputTokens + outputTokens,
});

const system: Message = { role: "system", content: [{ type: "text", text: "system prompt" }] };

function user(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

describe("onTurnEnd", () => {
  it("sees the response and the usage that produced it", async () => {
    const seen: { turn: number; last: string; inputTokens: number | undefined }[] = [];
    const result = await run({
      client: fauxClient({ turns: [{ text: "answer", usage: usage(1_234, 56) }] }),
      model: "test",
      messages: [system, user("hello")],
      hooks: {
        onTurnEnd: ({ messages, message, turn }) => {
          seen.push({
            turn,
            last: messages.at(-1)?.role ?? "none",
            inputTokens: message.usage?.inputTokens,
          });
        },
      },
    });

    expect(result.stopReason).toBe("completed");
    expect(seen).toEqual([{ turn: 1, last: "assistant", inputTokens: 1_234 }]);
  });

  it("runs after the tool results of a turn are in the transcript", async () => {
    const roles: string[][] = [];
    const tool = defineTool({
      name: "read", description: "Read.", parameters: { type: "object" },
      execute: () => textResult("file contents"),
    });
    await run({
      client: fauxClient({ turns: [
        { toolCalls: [{ id: "c1", name: "read", args: {} }] },
        { text: "done" },
      ] }),
      model: "test",
      messages: [system, user("read it")],
      tools: [tool],
      hooks: { onTurnEnd: ({ messages }) => { roles.push(messages.map(message => message.role)); } },
    });

    expect(roles).toEqual([
      ["system", "user", "assistant", "toolResult"],
      ["system", "user", "assistant", "toolResult", "assistant"],
    ]);
  });

  it("replaces the transcript the run continues from", async () => {
    const client = fauxClient({ turns: [{ text: "one" }, { text: "two" }] });
    const result = await run({
      client,
      model: "test",
      messages: [system, user("first")],
      hooks: {
        onTurnEnd: ({ messages }) => [messages[0]!, user("replaced history")],
      },
    });

    expect(result.stopReason).toBe("completed");
    expect(result.messages).toEqual([system, user("replaced history")]);
  });

  it("chains, each hook seeing the previous output", async () => {
    const seen: string[] = [];
    await run({
      client: fauxClient({ turns: [{ text: "answer" }] }),
      model: "test",
      messages: [system, user("hello")],
      hooks: {
        onTurnEnd: [
          ({ messages }) => { seen.push(`first:${messages.length}`); return [messages[0]!, user("from first")]; },
          ({ messages }) => { seen.push(`second:${messages.length}`); return messages; },
        ],
      },
    });

    expect(seen).toEqual(["first:3", "second:2"]);
  });

  it("runs for every turn of a run, including the last", async () => {
    let calls = 0;
    await run({
      client: fauxClient({ turns: [
        { toolCalls: [{ id: "c1", name: "read", args: {} }] },
        { text: "done" },
      ] }),
      model: "test",
      messages: [system, user("read")],
      tools: [defineTool({
        name: "read", description: "Read.", parameters: { type: "object" },
        execute: () => textResult("ok"),
      })],
      hooks: { onTurnEnd: () => { calls += 1; } },
    });

    expect(calls).toBe(2);
  });

  it("fails the run when the hook throws", async () => {
    const result = await run({
      client: fauxClient({ turns: [{ text: "answer" }] }),
      model: "test",
      messages: [system, user("hello")],
      hooks: { onTurnEnd: () => { throw new Error("hook exploded"); } },
    });

    expect(result.stopReason).toBe("error");
    expect(result.error?.kind).toBe("hook");
    expect(result.messages.map(message => message.role)).toEqual(["system", "user", "assistant"]);
  });

  it("rejects a transcript with an unanswered tool call", async () => {
    const result = await run({
      client: fauxClient({ turns: [{ text: "answer" }] }),
      model: "test",
      messages: [system, user("hello")],
      hooks: {
        onTurnEnd: () => [
          system,
          { role: "assistant", content: [], toolCalls: [{ id: "c1", name: "read", args: {} }], stopReason: "toolUse" },
        ],
      },
    });

    expect(result.stopReason).toBe("error");
    expect(result.error?.kind).toBe("invalidRequest");
  });

  it("leaves the transcript alone when the hook returns nothing", async () => {
    const result = await run({
      client: fauxClient({ turns: [{ text: "answer" }] }),
      model: "test",
      messages: [system, user("hello")],
      hooks: { onTurnEnd: () => undefined },
    });

    expect(result.messages.map(message => message.role)).toEqual(["system", "user", "assistant"]);
  });
});
