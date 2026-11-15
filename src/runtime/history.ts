import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import type { Message } from "../core/messages.js";

/** Read a framework transcript; a missing file starts an empty conversation. */
export function loadHistory(path: string): Message[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const messages: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!Array.isArray(messages) || !messages.every(message =>
    typeof message === "object" && message !== null && Array.isArray(message.content) &&
    (message.role === "user" || (message.role === "toolResult" &&
      typeof message.toolCallId === "string" && typeof message.toolName === "string") ||
      (message.role === "assistant" && Array.isArray(message.toolCalls))))) {
    throw new Error("History must be a JSON array of non-system framework messages.");
  }
  return (messages as Message[]).map(message => {
    const { role, content } = message;
    if (role === "assistant") return { role, content, toolCalls: message.toolCalls,
      stopReason: message.toolCalls.length > 0 ? "toolUse" : "stop" };
    if (role === "toolResult") return { role, content, toolCallId: message.toolCallId,
      toolName: message.toolName, isError: false };
    return { role: "user", content };
  });
}

/** Save the completed run's entire current context, excluding system prompts. */
export async function saveHistory(path: string, messages: readonly Message[]): Promise<void> {
  const history = messages.filter(message => message.role !== "system").map(message => {
    const { role, content } = message;
    if (role === "assistant") return { role, content, toolCalls: message.toolCalls };
    if (role === "toolResult") return { role, content, toolCallId: message.toolCallId, toolName: message.toolName };
    return { role, content };
  });
  const text = JSON.stringify(history, null, 2) + "\n";
  await writeFile(path, text, "utf8");
}
