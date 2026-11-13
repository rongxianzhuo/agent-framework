/**
 * Public entry point for `agent-core`.
 *
 * Every export is listed explicitly. `export *` is banned (enforced by
 * `scripts/check-invariants.mjs`) so that the public surface can only grow by
 * a deliberate edit to this file, and so a new internal helper never becomes
 * public by accident.
 *
 * The surface is intentionally small: message types, tool definitions, one
 * `run` function and a handful of hooks. Everything else — UI, persistence,
 * permissions, orchestration, provider SDKs — belongs to the embedding agent.
 */

// Data model
export type {
  AgentEvent,
  AssistantMessage,
  AssistantMessageEvent,
  ContentBlock,
  ErrorEvent,
  ErrorKind,
  ImageBlock,
  Message,
  MessageRole,
  NormalizedError,
  RunEndEvent,
  RunStartEvent,
  RunStopReason,
  StopReason,
  SystemMessage,
  TextBlock,
  TextDeltaEvent,
  ThinkingBlock,
  ThinkingDeltaEvent,
  ToolCall,
  ToolEndEvent,
  ToolResult,
  ToolResultMessage,
  ToolStartEvent,
  ToolUpdateEvent,
  TurnEndEvent,
  TurnStartEvent,
  Usage,
  UserMessage,
} from "./types.js";

// Errors
export { DEFAULT_RETRYABLE, toNormalizedError } from "./errors.js";

// Schema subset
export {
  InvalidSchemaError,
  checkSchema,
  validate,
  type JSONSchema,
  type JSONSchemaType,
  type SchemaViolation,
} from "./schema.js";

// Tools
export {
  ToolRegistry,
  defineTool,
  executeTool,
  jsonResult,
  textResult,
  type ToolContext,
  type ToolDefinition,
  type ToolExecution,
} from "./tools.js";

// Provider contract
export {
  EMPTY_USAGE,
  MessageAccumulator,
  addUsage,
  isNormalizedError,
  normalizeThrown,
  toToolSpec,
  type LLMClient,
  type LLMEvent,
  type LLMRequest,
  type LLMStreamOptions,
  type ToolSpec,
} from "./client.js";

// Loop
export { run, type RunOptions, type RunResult } from "./loop.js";

// Hooks: the caller's interception points in a run
export {
  HookError,
  describeTranscriptProblems,
  findTranscriptProblems,
  hasHooks,
  resolveHooks,
  type BeforeRequestContext,
  type BeforeRequestHook,
  type RunHooks,
  type ToolCallContext,
  type ToolCallDecision,
  type ToolCallHook,
  type ToolResultContext,
  type ToolResultHook,
  type TranscriptProblem,
} from "./hooks.js";

// Providers (subpath imports keep these out of a core-only module graph)
export {
  openaiClient,
  type OpenAIAdapter,
  type OpenAIAdapterOptions,
} from "./providers/openai/index.js";
export { toOpenAIMessages, toOpenAITools } from "./providers/openai/map.js";
export { parseSSE, type SSEMessage } from "./providers/sse.js";

// Testing: a scripted provider and a conformance suite for adapter authors
export { fauxClient, type FauxClient, type FauxOptions, type FauxTurn } from "./providers/faux/index.js";
export {
  allPassed,
  formatResults,
  runConformance,
  type ConformanceCheck,
  type ConformanceOptions,
  type ConformanceResult,
} from "./testing/conformance.js";

export const VERSION = "0.1.0";
