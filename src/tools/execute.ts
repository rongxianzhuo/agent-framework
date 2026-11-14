import { toNormalizedError, type NormalizedError } from "../core/errors.js";
import type { ToolCall, ToolResult, ToolResultMessage } from "../core/messages.js";
import type { ToolContext, ToolDefinition } from "./definition.js";
import { validate } from "./schema.js";
import { toResultMessage } from "./results.js";

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** The outcome of one tool call. Never a thrown error. */
export interface ToolExecution {
  /** Always present: the message to append to the transcript. */
  message: ToolResultMessage;
  /** Present when the tool did not succeed. */
  error?: NormalizedError;
  /**
   * True when the run was cancelled. The loop discards the message rather than
   * feeding it to the model — telling a model "you were interrupted" invites it
   * to retry work the caller just cancelled.
   */
  aborted: boolean;
  /** Wall-clock duration of the call, for progress display and slow-tool hunting. */
  durationMs: number;
}

/** Cap on how much of a thrown error's text is fed back to the model. */
const MAX_ERROR_CHARS = 2_000;

/**
 * Run one tool call.
 *
 * Order of checks matters and is fixed: abort, then existence, then argument
 * validation, then execution. A model that hallucinates a tool name gets a
 * different message than one that hallucinates an argument.
 */
export async function executeTool(
  tool: ToolDefinition<never> | undefined,
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolExecution> {
  const startedAt = performance.now();
  const elapsed = (): number => Math.round(performance.now() - startedAt);

  if (ctx.signal?.aborted) {
    return abortedExecution(call, "The run was cancelled before this call started.", elapsed());
  }

  if (!tool) {
    return failedExecution(
      call,
      toNormalizedError("invalidToolCall", `There is no tool named "${call.name}".`),
      elapsed(),
    );
  }

  // A tool call whose arguments never parsed arrives as `undefined`. Say so
  // plainly instead of letting the schema report "expected object".
  if (call.args === undefined) {
    return failedExecution(
      call,
      toNormalizedError(
        "invalidToolCall",
        `The arguments for tool "${tool.name}" were not valid JSON, so the call could not be executed. Call the tool again with well-formed arguments.`,
      ),
      elapsed(),
    );
  }

  const violations = validate(tool.parameters, call.args);
  if (violations.length > 0) {
    return failedExecution(
      call,
      toNormalizedError("invalidToolCall", invalidArgumentsMessage(tool.name, violations)),
      elapsed(),
    );
  }

  try {
    const result = await runWithTimeout(tool, call, ctx);
    const message = toResultMessage(call, result);

    if (message.isError) {
      return {
        aborted: false,
        message,
        error: toNormalizedError(
          "toolFailed",
          `Tool "${tool.name}" reported a failure after ${elapsed()}ms.`,
        ),
        durationMs: elapsed(),
      };
    }
    return { aborted: false, message, durationMs: elapsed() };
  } catch (thrown) {
    if (isAbortError(thrown) || ctx.signal?.aborted) {
      return abortedExecution(call, `Tool "${tool.name}" was cancelled.`, elapsed());
    }

    const error = classifyThrown(tool.name, thrown);
    const message: ToolResultMessage = {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: error.message }],
      isError: true,
    };
    return { aborted: false, message, error, durationMs: elapsed() };
  }
}

async function runWithTimeout(
  tool: ToolDefinition<never>,
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  const execution = Promise.resolve().then(() =>
    (tool.execute as (args: unknown, ctx: ToolContext) => ToolResult | Promise<ToolResult>)(call.args, ctx),
  );

  if (tool.timeoutMs === undefined) return execution;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ToolTimeoutError(tool.name, tool.timeoutMs!));
    }, tool.timeoutMs);
  });

  try {
    return await Promise.race([execution, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class ToolTimeoutError extends Error {
  constructor(
    readonly toolName: string,
    readonly timeoutMs: number,
  ) {
    super(`Tool "${toolName}" exceeded its ${timeoutMs}ms timeout.`);
    this.name = "ToolTimeoutError";
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/**
 * Map anything a tool throws onto the error taxonomy.
 *
 * The model sees a short, sanitised sentence. The original is kept in `cause`
 * for the caller's logs — a stack trace in the transcript is noise the model
 * cannot use and which costs tokens on every subsequent turn.
 */
function classifyThrown(toolName: string, thrown: unknown): NormalizedError {
  if (thrown instanceof ToolTimeoutError) {
    return toNormalizedError("toolFailed", thrown.message, { cause: thrown });
  }

  const raw = thrown instanceof Error ? thrown.message : String(thrown);
  const text = raw.length > MAX_ERROR_CHARS ? `${raw.slice(0, MAX_ERROR_CHARS)}…` : raw;

  return toNormalizedError("toolFailed", `Tool "${toolName}" failed: ${text || "no error message"}`, {
    cause: thrown,
  });
}

function invalidArgumentsMessage(
  toolName: string,
  violations: readonly { path: string; message: string }[],
): string {
  const lines = violations.map((v) => `- ${v.path || "(arguments)"}: ${v.message}`);
  return [
    `The arguments for tool "${toolName}" are invalid.`,
    ...lines,
    "Fix the arguments and call the tool again.",
  ].join("\n");
}

function failedExecution(call: ToolCall, error: NormalizedError, durationMs: number): ToolExecution {
  return {
    aborted: false,
    error,
    message: errorResult(call, error.message),
    durationMs,
  };
}

function abortedExecution(call: ToolCall, text: string, durationMs: number): ToolExecution {
  return {
    aborted: true,
    error: toNormalizedError("aborted", text),
    message: errorResult(call, text),
    durationMs,
  };
}

function errorResult(call: ToolCall, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text }],
    isError: true,
  };
}
