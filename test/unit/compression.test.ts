import { describe, expect, it } from "vitest";
import {
  Agent, defineTool, textResult,
  type CompressionContext, type ContextCompressionStrategy, type LastRequestInfo,
  type LLMClient, type Message, type Usage,
} from "../../src/index.js";
import { fauxClient } from "../../src/faux.js";

const usage = (inputTokens: number, outputTokens = 10): Usage => ({
  inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0,
});
const summary = (): Message[] => [{ role: "user", content: [{ type: "text", text: "compressed history" }] }];

describe("Agent context compression", () => {
  it.each([undefined, null])("does not compress when the strategy is %s", async contextCompression => {
    const client = fauxClient({ turns: [{ text: "one", usage: usage(250_000) }, { text: "two" }] });
    const agent = new Agent({ client, model: "test", ...(contextCompression === null ? { contextCompression } : {}) });
    await agent.run("first");
    await agent.run("second");
    expect(client.requests[1]?.messages).toHaveLength(3);
    expect(agent.messages).toHaveLength(4);
  });

  it("uses the last single request usage inside a tool loop and across Agent runs", async () => {
    const seen: (LastRequestInfo | undefined)[] = [];
    let compressions = 0;
    let toolExecutions = 0;
    const tool = defineTool({
      name: "read", description: "Read.", parameters: { type: "object" },
      execute: () => { toolExecutions++; return textResult("large tool output"); },
    });
    const client = fauxClient({ turns: [
      { toolCalls: [{ id: "c1", name: "read", args: {} }], usage: usage(200_000) },
      { text: "answer", usage: usage(50) },
      { text: "next answer", usage: usage(75) },
    ] });
    const agent = new Agent({
      client, model: "test", tools: [tool],
      contextCompression: {
        shouldCompress: async context => {
          seen.push(context.lastRequest);
          if (seen.length === 2) expect(context.messages.at(-1)).toMatchObject({ role: "toolResult" });
          return (context.lastRequest?.usage?.inputTokens ?? 0) >= 200_000;
        },
        compress: async () => { compressions++; return summary(); },
      },
    });
    const first = await agent.run("read");
    expect(first.usage.inputTokens).toBe(200_050);
    expect(agent.lastRequest?.usage?.inputTokens).toBe(50);
    expect(first.messages[0]).toEqual(summary()[0]);
    await agent.run("followup");
    expect(seen.map(s => s?.usage?.inputTokens)).toEqual([undefined, 200_000, 50]);
    expect(compressions).toBe(1);
    expect(toolExecutions).toBe(1);
    expect(client.requests[1]?.messages).toEqual(summary());
    expect(client.requests[2]?.messages).toHaveLength(3);
  });

  it("supports a class strategy and makes only one compression attempt per request", async () => {
    class AlwaysCompress implements ContextCompressionStrategy {
      checks = 0;
      compressions = 0;
      shouldCompress() { this.checks++; return true; }
      compress() { this.compressions++; return summary(); }
    }
    const strategy = new AlwaysCompress();
    const agent = new Agent({ client: fauxClient({ turns: [{ text: "ok" }] }), model: "test", contextCompression: strategy });
    await agent.run("first");
    expect(strategy.checks).toBe(1);
    expect(strategy.compressions).toBe(1);
  });

  it("runs compression before user hooks, including per-call hooks and temporary edits", async () => {
    const order: string[] = [];
    const client = fauxClient({ turns: [{ text: "one" }, { text: "two" }] });
    const agent = new Agent({
      client, model: "test",
      contextCompression: {
        shouldCompress: () => { order.push("check"); return true; },
        compress: () => { order.push("compress"); return summary(); },
      },
      hooks: { onBeforeRequest: ({ request }) => {
        order.push("default hook");
        expect(request.messages).toEqual(summary());
      } },
    });
    await agent.run("one");
    await agent.run("two", { hooks: { onBeforeRequest: [({ request }) => {
      order.push("override hook");
      return { ...request, messages: [{ role: "user", content: [{ type: "text", text: "wire only" }] }] };
    }] } });
    expect(order).toEqual(["check", "compress", "default hook", "check", "compress", "override hook"]);
    expect(client.requests[1]?.messages[0]?.content).toEqual([{ type: "text", text: "wire only" }]);
    expect(agent.messages[0]).toEqual(summary()[0]);
  });

  it.each(["check", "compress", "invalid", "later hook"])("preserves history on %s failure", async failure => {
    const client = fauxClient({ turns: [{ text: "never" }] });
    const agent = new Agent({
      client, model: "test",
      contextCompression: {
        shouldCompress: () => {
          if (failure === "check") throw new Error("check failed");
          return true;
        },
        compress: () => {
          if (failure === "compress") throw new Error("compress failed");
          if (failure === "invalid") return [{ role: "toolResult", toolCallId: "orphan", toolName: "read", content: [], isError: false }];
          return summary();
        },
      },
    });
    const result = await agent.run("original", failure === "later hook"
      ? { hooks: { onBeforeRequest: () => { throw new Error("later hook failed"); } } } : {});
    expect(result.error?.kind).toBe(failure === "invalid" ? "invalidRequest" : "hook");
    expect(agent.messages).toEqual([{ role: "user", content: [{ type: "text", text: "original" }] }]);
    expect(agent.lastRequest).toBeUndefined();
    expect(client.requests).toHaveLength(0);
  });

  it("forwards cancellation and never commits cancelled compression", async () => {
    const controller = new AbortController();
    const agent = new Agent({
      client: fauxClient({ turns: [] }), model: "test",
      contextCompression: {
        shouldCompress: () => true,
        compress: async ({ signal }) => {
          expect(signal).toBe(controller.signal);
          controller.abort();
          throw new Error("cancelled");
        },
      },
    });
    const result = await agent.run("original", { signal: controller.signal });
    expect(result.stopReason).toBe("aborted");
    expect(agent.messages[0]?.content).toEqual([{ type: "text", text: "original" }]);
    expect(agent.lastRequest).toBeUndefined();
  });

  it("does not change history when a predicate mutates its snapshots and declines compression", async () => {
    const client = fauxClient({ turns: [{ text: "ok", usage: usage(100) }, { text: "next" }] });
    const agent = new Agent({
      client, model: "test",
      contextCompression: {
        shouldCompress: context => {
          context.messages[0]!.content = [];
          if (context.lastRequest?.usage) context.lastRequest.usage.inputTokens = 999;
          return false;
        },
        compress: () => { throw new Error("must not compress"); },
      },
    });
    await agent.run("original");
    const snapshot = agent.lastRequest!;
    snapshot.usage!.inputTokens = 777;
    expect(agent.lastRequest?.usage?.inputTokens).toBe(100);
    await agent.run("next");
    expect(client.requests[1]?.messages[0]?.content).toEqual([{ type: "text", text: "original" }]);
  });

  it("reports unknown usage after a failed request instead of reusing old usage", async () => {
    const seen: (LastRequestInfo | undefined)[] = [];
    const client = fauxClient({ turns: [
      { text: "ok", usage: usage(200) }, { error: { kind: "network", message: "offline" } }, { text: "recovered" },
    ] });
    const agent = new Agent({
      client, model: "test",
      contextCompression: {
        shouldCompress: ({ lastRequest }) => { seen.push(lastRequest); return false; }, compress: () => [],
      },
    });
    await agent.run("first");
    await agent.run("second");
    expect(agent.lastRequest).toEqual({ model: "test", provider: "faux" });
    await agent.run();
    expect(seen.map(r => r?.usage?.inputTokens)).toEqual([undefined, 200, undefined]);
    expect(seen[2]).toEqual({ model: "test", provider: "faux" });
  });

  it("tracks the actual hook-selected model and leaves missing usage undefined", async () => {
    const client: LLMClient = {
      name: "custom",
      async *stream() {
        yield { type: "done", message: { role: "assistant", content: [], toolCalls: [], stopReason: "stop", provider: "gateway" } };
      },
    };
    const agent = new Agent({ client, model: "default", hooks: {
      onBeforeRequest: ({ request }) => ({ ...request, model: "selected" }),
    } });
    await agent.run("hello");
    expect(agent.lastRequest).toEqual({ model: "selected", provider: "gateway" });
  });

  it.each(["throw", "abort"])("clears previous usage when the latest request ends with %s", async mode => {
    let calls = 0;
    const controller = new AbortController();
    const client: LLMClient = {
      name: "custom",
      async *stream() {
        calls++;
        if (calls === 1) {
          yield { type: "done", message: { role: "assistant", content: [], toolCalls: [], stopReason: "stop", usage: usage(999) } };
          return;
        }
        if (mode === "abort") {
          controller.abort();
          throw Object.assign(new Error("request cancelled"), { name: "AbortError" });
        }
        throw new Error("request failed");
      },
    };
    const agent = new Agent({ client, model: "test" });
    await agent.run("one");
    const result = await agent.run("two", { signal: controller.signal });
    expect(result.stopReason).toBe(mode === "abort" ? "aborted" : "error");
    expect(agent.lastRequest).toEqual({ model: "test", provider: "custom" });
  });

  it("clears metadata on reset and history replacement and isolates instances", async () => {
    const seen: CompressionContext[] = [];
    const client = fauxClient({ turns: () => ({ text: "ok", usage: usage(10) }) });
    const agent = new Agent({ client, model: "test", contextCompression: {
      shouldCompress: context => { seen.push(context); return false; }, compress: () => [],
    } });
    const other = new Agent({ client, model: "test" });
    await agent.run("one");
    expect(other.lastRequest).toBeUndefined();
    agent.reset();
    expect(agent.lastRequest).toBeUndefined();
    await agent.run("two");
    agent.replaceMessages(agent.messages);
    expect(agent.lastRequest).toBeUndefined();
    await agent.run("three");
    expect(seen.every(c => c.lastRequest === undefined)).toBe(true);
  });
});
