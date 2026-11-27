import { describe, expect, it } from "vitest";
import {
  Agent, defineTool, textResult,
  type CompressionContext, type ContextCompressionStrategy, type LLMClient, type Message, type Usage,
} from "../../src/index.js";
import { fauxClient } from "../../src/faux.js";

const usage = (inputTokens: number, outputTokens = 10): Usage => ({
  inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0,
});
const summary = (): Message[] => [{ role: "user", content: [{ type: "text", text: "compressed history" }] }];

describe("Agent context compression", () => {
  it.each([undefined, null])("does not compress when the strategy is %s", async contextCompression => {
    const client = fauxClient({ turns: [{ text: "one", usage: usage(250_000) }, { text: "two" }] });
    const agent = new Agent({ system: "test prompt", client, model: "test", ...(contextCompression === null ? { contextCompression } : {}) });
    await agent.run("first");
    await agent.run("second");
    expect(client.requests[1]?.messages).toHaveLength(4);
    expect(agent.messages).toHaveLength(5);
  });

  it("measures the turn that just finished, not the previous request", async () => {
    const seen: (Usage | undefined)[] = [];
    const client = fauxClient({ turns: [{ text: "one", usage: usage(250_000) }, { text: "two", usage: usage(20) }] });
    const agent = new Agent({ system: "test prompt", client, model: "test", contextCompression: {
      shouldCompress: ({ usage: current }) => { seen.push(current); return false; },
      compress: () => { throw new Error("must not compress"); },
    } });
    await agent.run("first");
    await agent.run("second");
    expect(seen.map(value => value?.inputTokens)).toEqual([250_000, 20]);
  });

  it("compresses at the end of the turn, before the next request is built", async () => {
    const order: string[] = [];
    const client = fauxClient({ turns: [{ text: "one", usage: usage(250_000) }, { text: "two" }] });
    const agent = new Agent({ system: "test prompt", client, model: "test", contextCompression: {
      shouldCompress: () => { order.push("check"); return true; },
      compress: ({ messages }) => { order.push("compress"); return [messages[0]!, ...summary()]; },
    } });
    await agent.run("first");
    expect(order).toEqual(["check", "compress"]);
    expect(agent.messages).toEqual([{ role: "system", content: [{ type: "text", text: "test prompt" }] }, ...summary()]);
    await agent.run("second");
    expect(client.requests[1]?.messages).toEqual([
      { role: "system", content: [{ type: "text", text: "test prompt" }] },
      ...summary(),
      { role: "user", content: [{ type: "text", text: "second" }] },
    ]);
  });

  it("runs inside a tool loop, once per turn that ends", async () => {
    const seen: number[] = [];
    let toolExecutions = 0;
    const tool = defineTool({
      name: "read", description: "Read.", parameters: { type: "object" },
      execute: () => { toolExecutions++; return textResult("large tool output"); },
    });
    const client = fauxClient({ turns: [
      { toolCalls: [{ id: "c1", name: "read", args: {} }], usage: usage(200_000) },
      { text: "answer", usage: usage(50) },
    ] });
    const agent = new Agent({ system: "test prompt", client, model: "test", tools: [tool], contextCompression: {
      shouldCompress: ({ usage: current, turn, messages }) => {
        seen.push(current?.inputTokens ?? -1);
        if (turn === 1) expect(messages.at(-1)).toMatchObject({ role: "toolResult" });
        return (current?.inputTokens ?? 0) >= 200_000;
      },
      compress: ({ messages }) => [messages[0]!, ...summary()],
    } });
    const result = await agent.run("read");
    expect(seen).toEqual([200_000, 50]);
    expect(toolExecutions).toBe(1);
    expect(result.messages[0]).toMatchObject({ role: "system" });
    expect(result.messages.some(message => message.role === "toolResult")).toBe(false);
    expect(result.messages.at(-1)).toMatchObject({ role: "assistant" });
    expect(agent.messages).toHaveLength(3);
  });

  it("reaches historyFile in the same run", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "agent-framework-compress-"));
    try {
      const file = join(directory, "history.json");
      const client = fauxClient({ turns: [{ text: "one", usage: usage(250_000) }] });
      const agent = new Agent({ system: "test prompt", client, model: "test", historyFile: file, contextCompression: {
        shouldCompress: () => true,
        compress: ({ messages }) => [messages[0]!, ...summary()],
      } });
      await agent.run("first");
      const saved = JSON.parse(await readFile(file, "utf8")) as Message[];
      expect(saved).toEqual(summary());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("supports a class strategy and checks once per turn", async () => {
    class AlwaysCompress implements ContextCompressionStrategy {
      checks = 0;
      compressions = 0;
      shouldCompress() { this.checks++; return true; }
      compress() { this.compressions++; return summary(); }
    }
    const strategy = new AlwaysCompress();
    const agent = new Agent({ system: "test prompt", client: fauxClient({ turns: [{ text: "ok" }] }), model: "test", contextCompression: strategy });
    await agent.run("first");
    expect(strategy.checks).toBe(1);
    expect(strategy.compressions).toBe(1);
  });

  it("accepts a replacement that keeps the system prompt", async () => {
    const client = fauxClient({ turns: [{ text: "one", usage: usage(250_000) }, { text: "two" }] });
    const agent = new Agent({ system: "test prompt", client, model: "test", contextCompression: {
      shouldCompress: () => true,
      compress: ({ messages }) => [messages[0]!, ...summary()],
    } });
    await agent.run("first");
    await agent.run("second");
    expect(client.requests[1]?.messages[0]).toMatchObject({ role: "system" });
  });

  it("reports a broken transcript as an invalid request without committing it", async () => {
    const client = fauxClient({ turns: [{ text: "ok", usage: usage(250_000) }] });
    const agent = new Agent({ system: "test prompt", client, model: "test", contextCompression: {
      shouldCompress: () => true,
      compress: () => [{ role: "toolResult", toolCallId: "orphan", toolName: "read", content: [], isError: false }],
    } });
    const result = await agent.run("original");
    expect(result.stopReason).toBe("error");
    expect(result.error?.kind).toBe("invalidRequest");
    expect(agent.messages).toEqual([
      { role: "system", content: [{ type: "text", text: "test prompt" }] },
      { role: "user", content: [{ type: "text", text: "original" }] },
      expect.objectContaining({
        role: "assistant", content: [{ type: "text", text: "ok" }], toolCalls: [], stopReason: "stop",
      }),
    ]);
  });

  it.each(["check", "compress"])("reports a %s failure as a hook error without changing history", async failure => {
    const client = fauxClient({ turns: [{ text: "ok", usage: usage(250_000) }] });
    const agent = new Agent({ system: "test prompt", client, model: "test", contextCompression: {
      shouldCompress: () => {
        if (failure === "check") throw new Error("check failed");
        return true;
      },
      compress: () => {
        if (failure === "compress") throw new Error("compress failed");
        return summary();
      },
    } });
    const result = await agent.run("original");
    expect(result.stopReason).toBe("error");
    expect(result.error?.kind).toBe("hook");
    expect(agent.messages[1]).toMatchObject({ role: "user" });
  });

  it("does not compress a cancelled run", async () => {
    const controller = new AbortController();
    const client = fauxClient({ turns: [{ text: "ok", usage: usage(250_000), chunkSize: 1, chunkDelayMs: 20 }] });
    const agent = new Agent({ system: "test prompt", client, model: "test", contextCompression: {
      shouldCompress: () => { throw new Error("must not run after an abort"); },
      compress: () => summary(),
    } });
    setTimeout(() => controller.abort(), 10);
    const result = await agent.run("original", { signal: controller.signal });
    expect(result.stopReason).toBe("aborted");
  });

  it("composes with a user onTurnEnd hook, running the strategy first", async () => {
    const order: string[] = [];
    const client = fauxClient({ turns: [{ text: "one", usage: usage(250_000) }, { text: "two" }] });
    const agent = new Agent({ system: "test prompt", client, model: "test", contextCompression: {
      shouldCompress: () => { order.push("check"); return true; },
      compress: () => { order.push("compress"); return summary(); },
    }, hooks: { onTurnEnd: [({ messages }) => { order.push("user"); return messages; }] } });
    await agent.run("first");
    expect(order).toEqual(["check", "compress", "user"]);
  });

  it("leaves lastRequest describing the conversation, not the summary", async () => {
    const client = fauxClient({ turns: [{ text: "one", usage: usage(250_000) }, { text: "two" }] });
    const agent = new Agent({ system: "test prompt", client, model: "test", contextCompression: {
      shouldCompress: () => true,
      compress: () => summary(),
    } });
    await agent.run("first");
    expect(agent.lastRequest?.usage?.inputTokens).toBe(250_000);
  });

  it("does not call compress when the predicate declines", async () => {
    const seen: CompressionContext[] = [];
    const agent = new Agent({ system: "test prompt", client: fauxClient({ turns: [{ text: "ok", usage: usage(10) }] }), model: "test", contextCompression: {
      shouldCompress: context => { seen.push(context); return false; },
      compress: () => { throw new Error("must not compress"); },
    } });
    await agent.run("original");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.usage?.inputTokens).toBe(10);
  });

  it("does not treat a missing usage as a reason to compress", async () => {
    const client: LLMClient = {
      name: "custom",
      async *stream() {
        yield { type: "done", message: { role: "assistant", content: [], toolCalls: [], stopReason: "stop" } };
      },
    };
    const seen: (Usage | undefined)[] = [];
    const agent = new Agent({ system: "test prompt", client, model: "test", contextCompression: {
      shouldCompress: ({ usage: current }) => { seen.push(current); return false; },
      compress: () => summary(),
    } });
    await agent.run("original");
    expect(seen).toEqual([undefined]);
  });

  it("isolates instances and clears nothing on reset", async () => {
    const client = fauxClient({ turns: () => ({ text: "ok", usage: usage(250_000) }) });
    const strategy: ContextCompressionStrategy = {
      shouldCompress: () => true,
      compress: ({ messages }) => [messages[0]!, ...summary()],
    };
    const agent = new Agent({ system: "test prompt", client, model: "test", contextCompression: strategy });
    const other = new Agent({ system: "test prompt", client, model: "test" });
    await agent.run("one");
    expect(other.messages).toHaveLength(1);
    agent.reset();
    expect(agent.messages).toEqual([{ role: "system", content: [{ type: "text", text: "test prompt" }] }]);
    await agent.run("two");
    expect(agent.messages).toHaveLength(2);
    expect(agent.messages[1]).toMatchObject({ role: "user" });
  });
});
