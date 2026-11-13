/**
 * `agent-core/conformance` — the adapter test suite.
 *
 * Exported for people writing their own `LLMClient`, including outside this
 * repository. Kept out of the core entry point because it imports `run` and
 * `defineTool`, and a runtime that only embeds the loop should not ship it.
 */

export {
  allPassed,
  formatResults,
  runConformance,
  type ConformanceCheck,
  type ConformanceOptions,
  type ConformanceResult,
} from "./testing/conformance.js";
