/**
 * Live checks against the real OpenAI endpoint.
 *
 * Skipped unless `OPENAI_API_KEY` is set, and skipped loudly: the file records
 * why, so a green test run cannot be mistaken for "verified against the API".
 *
 * Keep this list short and cheap. Everything that can be checked against recorded
 * chunks belongs in `test/unit/openai.test.ts`; what lives here is only the part
 * that a fixture cannot prove — that the wire format is still accepted.
 *
 *   OPENAI_API_KEY=sk-... npm test
 *   OPENAI_BASE_URL=https://api.deepseek.com/v1 OPENAI_MODEL=deepseek-chat \
 *     OPENAI_API_KEY=... npm test
 */

import { describe, expect, it } from "vitest";

import { openaiClient, run, runConformance, defineTool, textResult, formatResults } from "../../src/index.js";

const apiKey = process.env["OPENAI_API_KEY"] ?? "";
const baseURL = process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1";
const model = process.env["OPENAI_MODEL"] ?? "gpt-4o-mini";

const enabled = apiKey !== "";

if (!enabled) {
  // Not a silent skip: this line is the evidence that live checks did not run.
  console.log("[openai integration] skipped: OPENAI_API_KEY is not set");
}

describe.skipIf(!enabled)("openai adapter against the live API", () => {
  const client = () =>
    openaiClient({ baseURL, apiKey, maxRetries: 1, retryBaseMs: 2_000 });

  it("answers a plain prompt", async () => {
    const result = await run({
      client: client(),
      model,
      messages: [{ role: "user", content: [{ type: "text", text: "Reply with the single word: ready" }] }],
      maxOutputTokens: 32,
    });

    expect(result.stopReason, result.error?.message).toBe("completed");
    const assistant = result.messages.at(-1);
    if (assistant?.role !== "assistant") throw new Error("no assistant message");
    expect(assistant.content.some((block) => block.type === "text")).toBe(true);
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  }, 60_000);

  it("calls a tool and uses its result", async () => {
    const tool = defineTool<{ city: string }>({
      name: "get_weather",
      description: "Return the current weather for a city. Always call this when asked about weather.",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "City name." } },
        required: ["city"],
        additionalProperties: false,
      },
      execute: (args) => textResult(`It is 21C and clear in ${args.city}.`),
    });

    const result = await run({
      client: client(),
      model,
      messages: [{ role: "user", content: [{ type: "text", text: "What is the weather in Lisbon? Use the tool." }] }],
      tools: [tool],
      maxTurns: 3,
    });

    expect(result.stopReason, result.error?.message).toBe("completed");
    const toolResult = result.messages.find((m) => m.role === "toolResult");
    expect(toolResult, "the model never called the tool").toBeDefined();
    expect(toolResult).toMatchObject({ toolName: "get_weather", isError: false });
  }, 120_000);

  it("passes the shared conformance suite", async () => {
    const results = await runConformance(client(), { model, maxOutputTokens: 128 });
    const summary = formatResults(results);

    // Report every line before asserting, so a failure names the broken check.
    for (const result of results) {
      expect(result.ok, summary).toBe(true);
    }
  }, 180_000);
});
