import type { ToolResult } from "../core/messages.js";
import type { ToolSpec } from "../core/client.js";
import type { JSONSchema } from "../core/schema.js";
import { InvalidSchemaError, checkSchema } from "./schema.js";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * What a tool implementation gets at call time.
 *
 * Deliberately tiny. A tool that needs the filesystem, a database or an HTTP
 * client receives it through a closure when the tool is defined, so nothing
 * ambient leaks into the core and two agents in one process cannot accidentally
 * share state through a tool context.
 */
export interface ToolContext {
  /** The call being executed. */
  callId: string;
  /** 1-based turn index within the current run. */
  turn: number;
  /**
   * Aborts when the run is cancelled. Long-running tools should pass this to
   * their I/O and return early rather than finishing work nobody will read.
   */
  signal?: AbortSignal;
  /**
   * Report partial output for a progress UI. Never reaches the model; it only
   * surfaces as `tool_update` events.
   */
  onUpdate?: (partial: string) => void;
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

/**
 * A tool the model can call.
 *
 * `A` is the argument type after validation — the shape the tool's `execute`
 * sees. It is not inferred from the schema (that would need a full type-level
 * JSON Schema interpreter); declare it with `defineTool<MyArgs>({ ... })` and let
 * the validator enforce it at runtime.
 */
export interface ToolDefinition<A = unknown> {
  name: string;
  description: string;
  parameters: JSONSchema;
  /** Runs the tool. May throw; the executor converts failures into results. */
  execute: (args: A, ctx: ToolContext) => ToolResult | Promise<ToolResult>;
  /**
   * Optional per-call deadline in milliseconds.
   *
   * No default on purpose: reading a file and running a test suite have no
   * sensible shared ceiling, and a wrong default produces failures that look
   * like hangs. Omit it and control cancellation through `ctx.signal`.
   */
  timeoutMs?: number;
}

const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Define a tool, validating its shape at startup.
 *
 * Authoring mistakes (an empty description, a malformed name, an unsupported
 * schema keyword) surface here, when the agent starts, rather than on the first
 * call in front of a user.
 */
export function defineTool<A = unknown>(definition: ToolDefinition<A>): ToolDefinition<A> {
  if (!NAME_PATTERN.test(definition.name)) {
    throw new Error(
      `Invalid tool name "${definition.name}": use 1-64 characters of letters, digits, underscore or hyphen.`,
    );
  }
  if (definition.description.trim() === "") {
    throw new Error(`Tool "${definition.name}" needs a description; it is the model's only instruction.`);
  }
  if (definition.timeoutMs !== undefined && !(definition.timeoutMs > 0)) {
    throw new Error(`Tool "${definition.name}" has a non-positive timeoutMs.`);
  }
  // Check the schema's own structure once, here, so an unsupported keyword or a
  // broken pattern surfaces at startup instead of on some model's first call.
  try {
    checkSchema(definition.parameters);
  } catch (error) {
    if (error instanceof InvalidSchemaError) {
      throw new Error(`Tool "${definition.name}": ${error.message}`, { cause: error });
    }
    throw error;
  }
  return definition;
}

/** Convert tool definitions into the wire-facing subset. */
export function toToolSpec(tools: readonly ToolDefinition<never>[]): ToolSpec[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}
