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

export const VERSION = "0.1.0";
