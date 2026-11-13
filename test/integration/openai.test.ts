/**
 * Live checks against a real API. **These cost money.**
 *
 * Skipped unless `OPENAI_API_KEY` is set, and when skipped it says so, because a
 * green test run must not be readable as "verified against the API".
 *
 * Deliberately one test and two model calls. A tool round trip is the cheapest
 * single run that still proves the things a fixture cannot: that the endpoint
 * accepts our message shape, our tool schema, and the transcript we send back
 * with a tool result. Everything else worth checking is against recorded chunks
 * in `test/unit/openai.test.ts`, which is free.
 *
 * Not run here, on purpose: the full `runConformance` suite (six calls, and its
 * abort check needs a long generation). Set `OPENAI_LIVE_CONFORMANCE=1` to run it
 * deliberately.
 *
 *   set -a; . /root/.env; set +a; npm test
 */

import { describe, expect, it } from "vitest";

import { defineTool, run, textResult } from "../../src/index.js";
import { openaiClient } from "../../src/openai.js";
import { formatResults, runConformance } from "../../src/conformance.js";

const apiKey = process.env["OPENAI_API_KEY"] ?? "";
const baseURL = process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1";
const model = process.env["OPENAI_MODEL"] ?? "gpt-4o-mini";
const runConformanceToo = process.env["OPENAI_LIVE_CONFORMANCE"] === "1";

const enabled = apiKey !== "";

if (!enabled) {
  console.log("[live api] skipped: OPENAI_API_KEY is not set");
}

describe.skipIf(!enabled)("the adapter against the live API", () => {
  // No retries: a retried request is a second bill.
  const client = () => openaiClient({ baseURL, apiKey, maxRetries: 0 });

  it(
    "runs a tool round trip against the real endpoint",
    async () => {
      const tool = defineTool<{ city: string }>({
        name: "get_weather",
        description: "Return the current weather for a city.",
        parameters: {
          type: "object",
          properties: { city: { type: "string", description: "City name." } },
          required: ["city"],
          additionalProperties: false,
        },
        execute: (args) => textResult(`21C and clear in ${args.city}`),
      });

      const result = await run({
        client: client(),
        model,
        messages: [
          { role: "system", content: [{ type: "text", text: "Be brief. Use tools when asked." }] },
          { role: "user", content: [{ type: "text", text: "Weather in Lisbon? Use the tool, then answer in five words." }] },
        ],
        tools: [tool],
        maxTurns: 3,
        maxOutputTokens: 64,
      });

      // A failure here is the interesting case, so surface the provider's own
      // words before asserting anything else.
      expect(result.error?.message ?? "no error", `stopReason=${result.stopReason}`).toBe("no error");

      const roles = result.messages.map((message) => message.role);
      expect(roles, "the model answered without calling the tool").toContain("toolResult");
      expect(result.turns).toBeGreaterThanOrEqual(2);
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);

      console.log(
        `[live api] ${model}: ${result.turns} turns, ${result.usage.inputTokens} in / ${result.usage.outputTokens} out / ${result.usage.totalTokens} total`,
      );
      console.log(
        `[live api] transcript: ${result.messages
          .map((message) =>
            message.role === "assistant"
              ? `assistant[${message.content.map((block) => block.type).join("+") || "none"}${message.toolCalls.length > 0 ? `, ${message.toolCalls.map((call) => `${call.name}(${JSON.stringify(call.args)})`).join(" ")}` : ""}]`
              : message.role,
          )
          .join(" > ")}`,
      );
      const finalText = result.messages
        .at(-1)
        ?.content.filter((block) => block.type === "text")
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      console.log(`[live api] final answer: ${JSON.stringify(finalText)}`);
    },
    120_000,
  );
});

describe.skipIf(!enabled || !runConformanceToo)("the full conformance suite on the live API", () => {
  it(
    "passes",
    async () => {
      // No output cap and no skipped checks: the point is to exercise all six
      // against the real endpoint, including abort. `reasoningEcho: "always"` is
      // what DeepSeek's thinking mode needs: the tool-result check replays an
      // assistant tool turn that no model produced, and DeepSeek rejects such a
      // turn unless `reasoning_content` is present.
      const results = await runConformance(
        openaiClient({ baseURL, apiKey, maxRetries: 0, reasoningEcho: "always" }),
        { model },
      );
      const summary = formatResults(results);
      for (const result of results) expect(result.ok, `\n${summary}`).toBe(true);
    },
    240_000,
  );
});
