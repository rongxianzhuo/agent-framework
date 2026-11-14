// Consumer fixture: an adapter written from scratch, checked with the published
// conformance suite. This is the path an adapter author outside the project takes.
import { MessageAccumulator } from "agent-framework";
import { runConformance, formatResults, allPassed } from "agent-framework/conformance";

/**
 * A client that answers by matching the prompt. Stands in for a real provider so
 * the check needs no network, while still exercising the suite as a third party
 * would: implement `stream`, run `runConformance`, read the failures.
 */
function echoClient() {
  return {
    name: "hand-rolled",
    async *stream(request) {
      const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
      const prompt = (lastUser?.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");

      const accumulator = new MessageAccumulator();
      const emit = function* (event) {
        accumulator.push(event);
        yield event;
      };

      let stopReason = "stop";
      if (prompt.includes("Call the tool")) {
        yield* emit({ type: "tool_call_delta", index: 0, id: "ext_1", name: "conformance_probe" });
        yield* emit({ type: "tool_call_delta", index: 0, argsDelta: '{"value":"conformance"}' });
        stopReason = "toolUse";
      } else if (prompt.includes("Count slowly")) {
        // Slow enough that the abort lands mid-stream.
        for (const piece of ["1", "2", "3", "4", "5", "6", "7", "8"]) {
          await new Promise((resolve) => setTimeout(resolve, 70));
          yield* emit({ type: "text_delta", text: piece });
        }
      } else {
        yield* emit({ type: "text_delta", text: "ok" });
      }

      yield {
        type: "done",
        message: accumulator.build({
          stopReason,
          usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 25 },
          model: request.model,
          provider: "hand-rolled",
        }),
      };
    },
  };
}

const results = await runConformance(echoClient(), { model: "anything" });
for (const line of formatResults(results).split("\n")) console.log(`  ${line}`);

if (!allPassed(results)) {
  console.error("  FAIL the conformance suite did not pass for a hand-written adapter");
  process.exit(1);
}
console.log("  third-party adapter: passed");
