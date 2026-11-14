import { describe, expect, it } from "vitest";
import {
  Agent, defineTool, run, textResult,
  type BeforeRequestHook, type BeforeRequestUpdate, type Message,
} from "../../src/index.js";
import { fauxClient } from "../../src/faux.js";

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const history = (): Message[] => [
  user("old question"),
  { role: "assistant", content: [{ type: "text", text: "old answer" }], toolCalls: [], stopReason: "stop" },
  user("new question"),
];
const tool = defineTool({
  name: "read", description: "Read.", parameters: { type: "object" },
  execute: () => textResult("contents"),
});
const toolTurn = { toolCalls: [{ id: "c1", name: "read", args: {} }] };

describe("request history replacement", () => {
  it.each(["plain", "explicit", "in-place"])("keeps %s replacement temporary", async mode => {
    const client = fauxClient({ turns: [toolTurn, { text: "done" }] });
    const input = history();
    const result = await run({
      client, model: "test", messages: input, tools: [tool],
      hooks: { onBeforeRequest: ({ request, turn }) => {
        if (turn !== 1) return;
        if (mode === "in-place") {
          request.messages[0]!.content = [{ type: "text", text: "temporary" }];
          return;
        }
        const next = { ...request, messages: [user("temporary")] };
        return mode === "plain" ? next : { request: next, replaceHistory: false };
      } },
    });
    expect(client.requests[0]?.messages[0]?.content).toEqual([{ type: "text", text: "temporary" }]);
    expect(client.requests[1]?.messages.slice(0, 3)).toEqual(input);
    expect(result.messages.slice(0, 3)).toEqual(input);
    expect(input).toEqual(history());
    expect(result.stopReason).toBe("completed");
  });

  it("persists replacement through tool turns, returned results and Agent conversations", async () => {
    const client = fauxClient({ turns: [toolTurn, { text: "done" }, { text: "followup" }] });
    const agent = new Agent({ client, model: "original-model", tools: [tool] });
    agent.replaceMessages(history());
    const result = await agent.run(undefined, { hooks: { onBeforeRequest: async ({ request, turn }) => {
      if (turn !== 1) return;
      return {
        request: { ...request, model: "temporary-model", messages: [user("summary")] },
        replaceHistory: true,
      };
    } } });
    expect(result.messages.map(m => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(result.messages[0]?.content).toEqual([{ type: "text", text: "summary" }]);
    expect(client.requests[1]?.messages[0]).toEqual(user("summary"));
    expect(client.requests[1]?.model).toBe("original-model");
    await agent.run("next");
    expect(client.requests[2]?.messages.slice(0, -1)).toEqual(result.messages);
    expect(agent.messages.some(m => m.content.some(b => b.type === "text" && b.text === "old question"))).toBe(false);
  });

  it("captures persistent messages before later temporary in-place edits", async () => {
    const client = fauxClient({ turns: [{ text: "done" }] });
    const result = await run({
      client, model: "test", messages: history(),
      hooks: { onBeforeRequest: [
        ({ request }) => ({ request: { ...request, messages: [user("permanent")] }, replaceHistory: true }),
        ({ request }) => { request.messages[0]!.content = [{ type: "text", text: "wire only" }]; },
      ] },
    });
    expect(client.requests[0]?.messages).toEqual([user("wire only")]);
    expect(result.messages[0]).toEqual(user("permanent"));
  });

  it("compresses after a tool result within the same run without replaying the tool", async () => {
    let executions = 0;
    const counted = defineTool({ ...tool, execute: () => { executions++; return textResult("large output"); } });
    const client = fauxClient({ turns: [toolTurn, { text: "summary accepted" }] });
    const result = await run({
      client, model: "test", messages: history(), tools: [counted],
      hooks: { onBeforeRequest: ({ request, turn }) => {
        if (turn !== 2) return;
        expect(request.messages.at(-1)).toMatchObject({ role: "toolResult" });
        return { request: { ...request, messages: [user("summary of history and large output")] }, replaceHistory: true };
      } },
    });
    expect(result.stopReason).toBe("completed");
    expect(executions).toBe(1);
    expect(client.requests[1]?.messages).toEqual([user("summary of history and large output")]);
    expect(result.messages).toHaveLength(2);
  });

  it("uses the last persistent snapshot in a hook chain", async () => {
    const client = fauxClient({ turns: [{ text: "done" }] });
    const result = await run({
      client, model: "test", messages: history(),
      hooks: { onBeforeRequest: [
        ({ request }) => ({ request: { ...request, messages: [user("first")] }, replaceHistory: true }),
        ({ request }) => ({ ...request, messages: [user("temporary")] }),
        ({ request }) => ({ request: { ...request, messages: [...request.messages, user("last")] }, replaceHistory: true }),
      ] },
    });
    expect(result.messages.slice(0, 2)).toEqual([user("temporary"), user("last")]);
  });

  it.each(["persistent", "temporary"])("does not commit if the %s transcript is invalid", async invalid => {
    const client = fauxClient({ turns: [{ text: "never called" }] });
    const broken: Message[] = [{
      role: "assistant", content: [], toolCalls: [{ id: "missing", name: "read", args: {} }], stopReason: "toolUse",
    }];
    const original = history();
    const result = await run({
      client, model: "test", messages: original,
      hooks: { onBeforeRequest: [
        ({ request }) => ({ request: { ...request, messages: invalid === "persistent" ? broken : [user("summary")] }, replaceHistory: true }),
        ({ request }) => ({ ...request, messages: invalid === "temporary" ? broken : [user("valid wire")] }),
      ] },
    });
    expect(result.error?.kind).toBe("invalidRequest");
    expect(result.messages).toEqual(original);
    expect(client.requests).toHaveLength(0);
  });

  it("does not commit if a later hook fails", async () => {
    const client = fauxClient({ turns: [] });
    const original = history();
    const result = await run({
      client, model: "test", messages: original,
      hooks: { onBeforeRequest: [
        ({ request }) => ({ request: { ...request, messages: [user("summary")] }, replaceHistory: true }),
        () => { throw new Error("compression failed"); },
      ] },
    });
    expect(result.error?.kind).toBe("hook");
    expect(result.messages).toEqual(original);
    expect(client.requests).toHaveLength(0);
  });

  it.each([false, true])("does not commit on cancellation (hook throws: %s)", async throws => {
    const controller = new AbortController();
    const client = fauxClient({ turns: [] });
    const original = history();
    const result = await run({
      client, model: "test", messages: original, signal: controller.signal,
      hooks: { onBeforeRequest: ({ request }) => {
        controller.abort();
        if (throws) throw new Error("compression cancelled");
        return { request: { ...request, messages: [user("summary")] }, replaceHistory: true };
      } },
    });
    expect(result.stopReason).toBe("aborted");
    expect(result.messages).toEqual(original);
    expect(client.requests).toHaveLength(0);
  });

  it("keeps a committed replacement even if the subsequent model call fails", async () => {
    const client = fauxClient({ turns: [{ error: { kind: "network", message: "offline" } }] });
    const agent = new Agent({ client, model: "test" });
    const result = await agent.run("old", { hooks: { onBeforeRequest: ({ request }) => ({
      request: { ...request, messages: [user("summary")] }, replaceHistory: true,
    }) } });
    expect(result.error?.kind).toBe("network");
    expect(agent.messages).toEqual([user("summary")]);
  });

  it("detaches persistent history from retained hook objects", async () => {
    let update!: BeforeRequestUpdate;
    const hook: BeforeRequestHook = ({ request }) => {
      update = { request: { ...request, messages: [user("summary")] }, replaceHistory: true };
      return update;
    };
    const result = await run({
      client: fauxClient({ turns: [{ text: "ok" }] }), model: "test", messages: history(),
      hooks: { onBeforeRequest: hook },
    });
    update.request.messages[0]!.content = [];
    expect(result.messages[0]).toEqual(user("summary"));
  });
});
