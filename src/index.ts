/**
 * Public entry point for `agent-framework`.
 *
 * Every export is listed explicitly. `export *` is banned (enforced by
 * `scripts/check-invariants.mjs`) so that the public surface can only grow by
 * a deliberate edit to this file, and so a new internal helper never becomes
 * public by accident.
 *
 * The surface is intentionally small: message types, tool definitions, one
 * `run` function, a conversation-owning `Agent` and a handful of hooks. UI, persistence,
 * permissions, orchestration, provider SDKs — belongs to the embedding agent.
 */

// Data model
export type {
  AgentEvent,
  AssistantMessageEvent,
  ErrorEvent,
  RunEndEvent,
  RunStartEvent,
  RunStopReason,
  TextDeltaEvent,
  ThinkingDeltaEvent,
  ToolEndEvent,
  ToolStartEvent,
  ToolUpdateEvent,
  TurnEndEvent,
  TurnStartEvent,
} from "./runtime/events.js";
export type {
  AssistantMessage,
  Base64ImageBlock,
  ContentBlock,
  ImageBlock,
  Message,
  MessageRole,
  ReasoningEffort,
  StopReason,
  SystemMessage,
  TextBlock,
  ThinkingBlock,
  ToolCall,
  ToolResult,
  ToolResultMessage,
  UserMessage,
  UrlImageBlock,
} from "./core/messages.js";
export type { ErrorKind, NormalizedError } from "./core/errors.js";
export type { Usage } from "./core/usage.js";

// Errors
export { DEFAULT_RETRYABLE, toNormalizedError } from "./core/errors.js";

// Schema subset
export { InvalidSchemaError, checkSchema, validate, type SchemaViolation } from "./tools/schema.js";
export { type JSONSchema, type JSONSchemaType } from "./core/schema.js";

// Tools
export { ToolRegistry } from "./tools/registry.js";
export { defineTool, type ToolContext, type ToolDefinition } from "./tools/definition.js";
export { executeTool, type ToolExecution } from "./tools/execute.js";
export { jsonResult, textResult } from "./tools/results.js";

// Provider contract
export { EMPTY_USAGE, addUsage } from "./core/usage.js";
export { MessageAccumulator } from "./providers/shared/accumulator.js";
export { isNormalizedError, normalizeThrown } from "./core/errors.js";
export { toToolSpec } from "./tools/definition.js";
export {
  type LLMClient,
  type LLMEvent,
  type LLMRequest,
  type LLMStreamOptions,
  type ToolSpec,
} from "./core/client.js";

// Loop
export { run, type RunOptions, type RunResult } from "./runtime/run.js";
export { Agent, type AgentInput, type AgentOptions, type AgentRunOptions } from "./runtime/agent.js";
export type { CompressionContext, ContextCompressionStrategy, LastRequestInfo } from "./runtime/compression.js";

// Hooks: the caller's interception points in a run
export {
  HookError,
  hasHooks,
  resolveHooks,
  type BeforeRequestContext,
  type BeforeRequestHook,
  type BeforeRequestResult,
  type BeforeRequestUpdate,
  type RunHooks,
  type ToolCallContext,
  type ToolCallDecision,
  type ToolCallHook,
  type ToolResultContext,
  type ToolResultHook,
} from "./runtime/hooks.js";
export {
  describeTranscriptProblems,
  findTranscriptProblems,
  type TranscriptProblem,
} from "./runtime/transcript.js";

// Providers, the scripted client and the conformance suite are separate entry
// points (`agent-framework/openai`, `agent-framework/faux`, `agent-framework/conformance`).
// Deliberately absent here: an embedding agent that only wants the loop should
// not pull an HTTP adapter into its process because it imported `run`.

export const VERSION = "0.1.0";
