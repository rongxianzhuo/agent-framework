import { describe, expect, it, vi } from "vitest";

import {
  ToolRegistry,
  defineTool,
  executeTool,
  jsonResult,
  textResult,
  type ToolContext,
} from "../../src/index.js";

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { callId: "call_1", turn: 1, ...overrides };
}

const readTool = defineTool<{ path: string; limit?: number }>({
  name: "read",
  description: "Read a file.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, limit: { type: "integer", minimum: 1 } },
    required: ["path"],
    additionalProperties: false,
  },
  execute: (args) => textResult(`contents of ${args.path}`),
});

describe("defineTool", () => {
  it("returns the definition unchanged", () => {
    expect(readTool.name).toBe("read");
    expect(readTool.parameters.type).toBe("object");
  });

  it("rejects a malformed name", () => {
    expect(() => defineTool({ ...readTool, name: "has space" })).toThrow(/Invalid tool name/);
    expect(() => defineTool({ ...readTool, name: "" })).toThrow(/Invalid tool name/);
  });

  it("rejects a blank description", () => {
    expect(() => defineTool({ ...readTool, description: "   " })).toThrow(/needs a description/);
  });

  it("rejects a non-positive timeout", () => {
    expect(() => defineTool({ ...readTool, timeoutMs: 0 })).toThrow(/non-positive timeoutMs/);
  });

  it("rejects an unsupported schema keyword at definition time, not at call time", () => {
    expect(() =>
      defineTool({
        name: "bad",
        description: "x",
        parameters: { anyOf: [{ type: "string" }] } as never,
        execute: () => textResult(""),
      }),
    ).toThrow(/not supported by this subset/);
  });
});

describe("ToolRegistry", () => {
  const bash = defineTool({
    name: "bash",
    description: "Run a command.",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    execute: () => textResult("ok"),
  });

  it("indexes tools by name and preserves order", () => {
    const registry = new ToolRegistry([readTool, bash]);
    expect(registry.size).toBe(2);
    expect(registry.list().map((t) => t.name)).toEqual(["read", "bash"]);
    expect(registry.has("bash")).toBe(true);
    expect(registry.get("bash")?.name).toBe("bash");
    expect(registry.get("nope")).toBeUndefined();
  });

  it("rejects duplicate names", () => {
    expect(() => new ToolRegistry([readTool, readTool])).toThrow(/Duplicate tool name "read"/);
  });

  it("picks an allowlist in the order given", () => {
    const registry = new ToolRegistry([readTool, bash]);
    expect(registry.pick(["bash", "read"]).map((t) => t.name)).toEqual(["bash", "read"]);
  });

  it("fails loudly on an unknown name in an allowlist", () => {
    const registry = new ToolRegistry([readTool]);
    expect(() => registry.pick(["reed"])).toThrow(/Unknown tool "reed"\. Available: read/);
  });

  it("keeps instances independent", () => {
    const a = new ToolRegistry([readTool]);
    const b = new ToolRegistry([bash]);
    expect(a.has("bash")).toBe(false);
    expect(b.has("read")).toBe(false);
  });
});

describe("executeTool", () => {
  it("runs the tool with validated arguments", async () => {
    const execute = vi.fn(() => textResult("done"));
    const tool = defineTool<{ path: string }>({
      name: "ping",
      description: "x",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute,
    });

    const outcome = await executeTool(tool, { id: "c1", name: "ping", args: { path: "a" } }, ctx());

    expect(execute).toHaveBeenCalledWith({ path: "a" }, expect.objectContaining({ callId: "call_1" }));
    expect(outcome.error).toBeUndefined();
    expect(outcome.aborted).toBe(false);
    expect(outcome.message).toEqual({
      role: "toolResult",
      toolCallId: "c1",
      toolName: "ping",
      content: [{ type: "text", text: "done" }],
      isError: false,
    });
  });

  it("returns a result rather than throwing when the tool does not exist", async () => {
    const outcome = await executeTool(undefined, { id: "c1", name: "ghost", args: {} }, ctx());

    expect(outcome.message.isError).toBe(true);
    expect(outcome.message.content).toEqual([{ type: "text", text: 'There is no tool named "ghost".' }]);
    expect(outcome.error?.kind).toBe("invalidToolCall");
    expect(outcome.error?.retryable).toBe(false);
  });

  it("tells the model exactly which argument is wrong", async () => {
    const outcome = await executeTool(readTool, { id: "c1", name: "read", args: { path: 7 } }, ctx());

    expect(outcome.message.isError).toBe(true);
    expect(outcome.error?.kind).toBe("invalidToolCall");
    const text = (outcome.message.content[0] as { text: string }).text;
    expect(text).toContain("The arguments for tool \"read\" are invalid.");
    expect(text).toContain("- path: expected string, received number 7");
    expect(text).toContain("Fix the arguments and call the tool again.");
  });

  it("lists several argument problems in one result", async () => {
    const tool = defineTool<Record<string, unknown>>({
      name: "multi",
      description: "x",
      parameters: {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "integer" } },
        required: ["a", "b"],
      },
      execute: () => textResult(""),
    });

    const outcome = await executeTool(tool, { id: "c1", name: "multi", args: {} }, ctx());
    const text = (outcome.message.content[0] as { text: string }).text;

    expect(text).toContain("- a: is required but missing");
    expect(text).toContain("- b: is required but missing");
  });

  it("does not execute when arguments fail validation", async () => {
    const execute = vi.fn(() => textResult("ran"));
    const tool = defineTool({
      name: "guarded",
      description: "x",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute,
    });

    expect(execute).not.toHaveBeenCalled();
    await executeTool(tool, { id: "c1", name: "guarded", args: {} }, ctx());
    expect(execute).not.toHaveBeenCalled();
  });

  it("converts a thrown error into a readable result and keeps the cause", async () => {
    const boom = new Error("ENOENT: no such file");
    const tool = defineTool({
      name: "explode",
      description: "x",
      parameters: { type: "object", properties: {} },
      execute: () => {
        throw boom;
      },
    });

    const outcome = await executeTool(tool, { id: "c1", name: "explode", args: {} }, ctx());

    expect(outcome.message.isError).toBe(true);
    expect((outcome.message.content[0] as { text: string }).text).toBe(
      'Tool "explode" failed: ENOENT: no such file',
    );
    expect(outcome.error?.kind).toBe("toolFailed");
    expect(outcome.error?.cause).toBe(boom);
  });

  it("handles a thrown non-Error value", async () => {
    const tool = defineTool({
      name: "weird",
      description: "x",
      parameters: { type: "object", properties: {} },
      execute: () => {
        throw "just a string";
      },
    });

    const outcome = await executeTool(tool, { id: "c1", name: "weird", args: {} }, ctx());
    expect((outcome.message.content[0] as { text: string }).text).toBe(
      'Tool "weird" failed: just a string',
    );
  });

  it("truncates a very long error message", async () => {
    const tool = defineTool({
      name: "verbose",
      description: "x",
      parameters: { type: "object", properties: {} },
      execute: () => {
        throw new Error("x".repeat(5_000));
      },
    });

    const outcome = await executeTool(tool, { id: "c1", name: "verbose", args: {} }, ctx());
    const text = (outcome.message.content[0] as { text: string }).text;
    expect(text.length).toBeLessThan(2_100);
    expect(text.endsWith("…")).toBe(true);
  });

  it("propagates isError and details from the tool result", async () => {
    const tool = defineTool({
      name: "soft-fail",
      description: "x",
      parameters: { type: "object", properties: {} },
      execute: () => ({ content: [{ type: "text", text: "no matches" }], isError: true, details: { code: 1 } }),
    });

    const outcome = await executeTool(tool, { id: "c1", name: "soft-fail", args: {} }, ctx());

    expect(outcome.message.isError).toBe(true);
    expect(outcome.message.details).toEqual({ code: 1 });
    expect(outcome.error?.kind).toBe("toolFailed");
  });

  it("omits details when the tool does not provide any", async () => {
    const outcome = await executeTool(readTool, { id: "c1", name: "read", args: { path: "a" } }, ctx());
    expect("details" in outcome.message).toBe(false);
  });

  describe("cancellation", () => {
    it("does not start a tool once the signal has fired", async () => {
      const execute = vi.fn(() => textResult("ran"));
      const tool = defineTool({
        name: "late",
        description: "x",
        parameters: { type: "object", properties: {} },
        execute,
      });
      const controller = new AbortController();
      controller.abort();

      const outcome = await executeTool(tool, { id: "c1", name: "late", args: {} }, ctx({ signal: controller.signal }));

      expect(execute).not.toHaveBeenCalled();
      expect(outcome.aborted).toBe(true);
      expect(outcome.error?.kind).toBe("aborted");
    });

    it("reports an abort that happens mid-flight", async () => {
      const controller = new AbortController();
      const tool = defineTool({
        name: "slow",
        description: "x",
        parameters: { type: "object", properties: {} },
        execute: () => {
          controller.abort();
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        },
      });

      const outcome = await executeTool(tool, { id: "c1", name: "slow", args: {} }, ctx({ signal: controller.signal }));

      expect(outcome.aborted).toBe(true);
      expect(outcome.message.isError).toBe(true);
    });
  });

  describe("timeouts", () => {
    it("applies the tool's own timeout", async () => {
      const tool = defineTool({
        name: "hang",
        description: "x",
        parameters: { type: "object", properties: {} },
        timeoutMs: 10,
        execute: () => new Promise(() => {}),
      });

      const outcome = await executeTool(tool, { id: "c1", name: "hang", args: {} }, ctx());

      expect(outcome.message.isError).toBe(true);
      expect((outcome.message.content[0] as { text: string }).text).toContain(
        'Tool "hang" exceeded its 10ms timeout',
      );
    });

    it("does not time out a tool that finishes first", async () => {
      const tool = defineTool({
        name: "quick",
        description: "x",
        parameters: { type: "object", properties: {} },
        timeoutMs: 1_000,
        execute: async () => textResult("fast"),
      });

      const outcome = await executeTool(tool, { id: "c1", name: "quick", args: {} }, ctx());
      expect(outcome.message.isError).toBe(false);
    });

    it("has no timeout when the tool declares none", async () => {
      const tool = defineTool({
        name: "patient",
        description: "x",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return textResult("done");
        },
      });

      const outcome = await executeTool(tool, { id: "c1", name: "patient", args: {} }, ctx());
      expect(outcome.message.isError).toBe(false);
    });
  });

  it("passes onUpdate through to the tool", async () => {
    const partials: string[] = [];
    const streaming = defineTool({
      name: "stream",
      description: "x",
      parameters: { type: "object", properties: {} },
      execute: (_args, context) => {
        context.onUpdate?.("50%");
        return textResult("done");
      },
    });

    await executeTool(streaming, { id: "c1", name: "stream", args: {} }, ctx({ onUpdate: (p) => partials.push(p) }));
    expect(partials).toEqual(["50%"]);
  });
});

describe("result helpers", () => {
  it("wraps text", () => {
    expect(textResult("hi")).toEqual({ content: [{ type: "text", text: "hi" }] });
  });

  it("keeps details out of the model-visible content", () => {
    const result = textResult("hi", { raw: true });
    expect(result.content).toEqual([{ type: "text", text: "hi" }]);
    expect(result.details).toEqual({ raw: true });
  });

  it("pretty-prints structured JSON", () => {
    expect(jsonResult({ a: 1 }).content).toEqual([{ type: "text", text: '{\n  "a": 1\n}' }]);
    expect(jsonResult({ a: 1 }).details).toEqual({ a: 1 });
  });
});
