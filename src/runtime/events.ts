import type { AssistantMessage, Message, ToolResultMessage } from "../core/messages.js";
import type { Usage } from "../core/usage.js";
import type { NormalizedError } from "../core/errors.js";

/**
 * Why a whole `run()` ended.
 *
 * Kept separate from `StopReason` because a run spans several responses: "the
 * model is done" and "we hit the turn limit" are different facts, and callers
 * need to tell them apart to decide whether to continue.
 */
export type RunStopReason =
  /** The model produced a response with no tool calls. */
  | "completed"
  /** `maxTurns` was reached while the model still wanted to run tools. */
  | "maxTurns"
  /** The caller's `AbortSignal` fired. */
  | "aborted"
  /** An unrecoverable error ended the run. */
  | "error";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Progress emitted by `run()` through `onEvent`.
 *
 * Events are the only streaming surface. The core does not render anything and
 * does not interpret payloads beyond tagging them, so an embedding agent can
 * log them, forward them to a UI, or ignore them entirely.
 *
 * Deltas arrive before the matching `assistant_message`; the assembled message
 * is always emitted, even when the consumer dropped every delta.
 */
export type AgentEvent =
  | RunStartEvent
  | TurnStartEvent
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | AssistantMessageEvent
  | ToolStartEvent
  | ToolUpdateEvent
  | ToolEndEvent
  | TurnEndEvent
  | RunEndEvent
  | ErrorEvent;

export interface RunStartEvent {
  type: "run_start";
  /** Number of messages in the transcript the run started from. */
  messageCount: number;
}

export interface TurnStartEvent {
  type: "turn_start";
  /** 1-based index of the turn within this run. */
  turn: number;
}

export interface TextDeltaEvent {
  type: "text_delta";
  turn: number;
  text: string;
}

export interface ThinkingDeltaEvent {
  type: "thinking_delta";
  turn: number;
  text: string;
}

export interface AssistantMessageEvent {
  type: "assistant_message";
  turn: number;
  message: AssistantMessage;
}

export interface ToolStartEvent {
  type: "tool_start";
  turn: number;
  toolCallId: string;
  toolName: string;
  /** Validated arguments. */
  args: unknown;
}

export interface ToolUpdateEvent {
  type: "tool_update";
  toolCallId: string;
  toolName: string;
  /** Partial output, for a UI that shows progress. */
  partial: string;
}

export interface ToolEndEvent {
  type: "tool_end";
  toolCallId: string;
  toolName: string;
  result: ToolResultMessage;
  durationMs: number;
}

export interface TurnEndEvent {
  type: "turn_end";
  turn: number;
  toolCallCount: number;
}

export interface RunEndEvent {
  type: "run_end";
  stopReason: RunStopReason;
  /** Cumulative usage across every response in the run. */
  usage: Usage;
  /** Full transcript, including the messages this run appended. */
  messages: Message[];
}

export interface ErrorEvent {
  type: "error";
  error: NormalizedError;
  /** Set when the error ended the run. */
  fatal: boolean;
}
