import { describe, expect, it } from "vitest";

import { type LLMClient, type LLMRequest } from "../../src/index.js";
import { fauxClient, type FauxTurn } from "../../src/faux.js";
import {
  allPassed,
  formatResults,
  runConformance,
  type ConformanceResult,
} from "../../src/conformance.js";

/** Last user text in a request, which is how the suite's prompts are recognised. */
function lastUserText(request: LLMRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const message = request.messages[i];
    if (message?.role !== "user") continue;
    return message.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
  }
  return "";
}

/**
 * A faux client that answers the conformance prompts. Used both to prove the
 * suite passes a correct adapter and to show how a function script replaces a
 * fixture per prompt.
 */
function wellBehavedFaux(): LLMClient {
  return fauxClient({
    name: "conformance-faux",
    turns: (request): FauxTurn => {
      const prompt = lastUserText(request);

      if (prompt.includes("Call the tool")) {
        return { toolCalls: [{ id: "call_ok_1", name: "conformance_probe", args: { value: "conformance" } }] };
      }
      if (prompt.includes("What did")) return { text: "conformance" };
      if (prompt.includes("Count slowly")) {
        // Streams for well over a second, honouring the signal between pieces
        // the way an adapter reading from a socket would.
        return { text: "1\n2\n3\n4\n5\n6\n7\n8\n9\n10", chunkSize: 2, chunkDelayMs: 60 };
      }
      if (prompt.includes("ready")) return { text: "ready" };
      if (prompt.includes("ok")) return { text: "ok" };
      return { text: "metered" };
    },
  });
}

function byCheck(results: readonly ConformanceResult[], check: string): ConformanceResult | undefined {
  return results.find((result) => result.check === check);
}

describe("runConformance", () => {
  it("passes an adapter that behaves", async () => {
    const results = await runConformance(wellBehavedFaux(), { model: "faux-1" });

    expect(formatResults(results)).toContain("PASS");
    for (const result of results) {
      expect(result.ok, `${result.check}: ${result.detail}`).toBe(true);
    }
    expect(allPassed(results)).toBe(true);
    expect(results.map((r) => r.check)).toEqual(["text", "system", "tool-call", "tool-result", "abort", "usage"]);
  });

  it("reports timings for every check", async () => {
    const results = await runConformance(wellBehavedFaux(), { model: "faux-1", only: ["text"] });
    expect(results[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("fails an adapter that returns no text", async () => {
    const mute: LLMClient = {
      name: "mute",
      async *stream() {
        yield {
          type: "done" as const,
          message: { role: "assistant" as const, content: [], toolCalls: [], stopReason: "stop" as const },
        };
      },
    };

    const results = await runConformance(mute, { model: "m", only: ["text"] });

    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.detail).toContain("no text block");
  });

  it("fails an adapter that forgets usage", async () => {
    const noUsage = fauxClient({
      name: "no-usage",
      turns: () => ({
        text: "hello",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
      }),
    });

    const results = await runConformance(noUsage, { model: "m", only: ["usage"] });

    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.detail).toContain("totalTokens is 0");
  });

  it("fails an adapter whose tool arguments never parse", async () => {
    const brokenToolCall: LLMClient = {
      name: "broken-tools",
      async *stream() {
        yield {
          type: "done" as const,
          message: {
            role: "assistant" as const,
            content: [],
            toolCalls: [{ id: "x", name: "conformance_probe", args: '{"value": "conformance"}' }],
            stopReason: "toolUse" as const,
          },
        };
      },
    };

    const results = await runConformance(brokenToolCall, { model: "m", only: ["tool-call"] });

    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.detail).toContain("not parsed into an object");
  });

  it("fails an adapter that ignores the abort signal", async () => {
    const deaf: LLMClient = {
      name: "deaf",
      async *stream() {
        await new Promise((resolve) => setTimeout(resolve, 500));
        yield {
          type: "done" as const,
          message: { role: "assistant" as const, content: [], toolCalls: [], stopReason: "stop" as const },
        };
      },
    };

    const results = await runConformance(deaf, { model: "m", only: ["abort"], abortGraceMs: 100 });

    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.detail).toContain("ignoring the signal");
  });

  it("reports an abort that arrived promptly", async () => {
    const results = await runConformance(wellBehavedFaux(), { model: "m", only: ["abort"] });

    expect(results[0]?.ok, results[0]?.detail).toBe(true);
    expect(results[0]?.detail).toMatch(/^aborted \d+ms after the signal$/);
  });

  it("honours only and skip", async () => {
    const onlyResults = await runConformance(wellBehavedFaux(), { model: "m", only: ["text", "usage"] });
    expect(onlyResults.map((r) => r.check)).toEqual(["text", "usage"]);

    const skipped = await runConformance(wellBehavedFaux(), { model: "m", skip: ["abort", "tool-call"] });
    expect(skipped.map((r) => r.check)).toEqual(["text", "system", "tool-result", "usage"]);
    expect(byCheck(skipped, "abort")).toBeUndefined();
  });

  it("enforces a per-check deadline", async () => {
    const stuck: LLMClient = {
      name: "stuck",
      // Never yields and never returns: the check has to time out on its own.
      async *stream() {
        await new Promise(() => {});
        // Unreachable, but a generator needs a yield to be one.
        yield { type: "error" as const, error: { kind: "unknown" as const, message: "", retryable: false } };
      },
    };

    const results = await runConformance(stuck, { model: "m", only: ["text"], timeoutMs: 30 });

    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.detail).toContain('did not finish within 30ms');
  });

  it("requires a model id", async () => {
    await expect(runConformance(wellBehavedFaux(), { model: " " })).rejects.toThrow(/model id/);
  });

  it("uses a custom probe tool name", async () => {
    const client = fauxClient({
      name: "custom-name",
      turns: (request) =>
        lastUserText(request).includes("Call the tool")
          ? { toolCalls: [{ id: "c", name: "my_probe", args: { value: "conformance" } }] }
          : { text: "ok" },
    });

    const results = await runConformance(client, { model: "m", only: ["tool-call"], toolName: "my_probe" });
    expect(results[0]?.ok, results[0]?.detail).toBe(true);
  });

  it("formats a readable summary", async () => {
    const results = await runConformance(wellBehavedFaux(), { model: "m", only: ["text"] });
    const summary = formatResults(results);

    expect(summary).toMatch(/^PASS {2}text \(\d+ms\): /);
  });
});
