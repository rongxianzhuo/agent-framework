/**
 * `agent-core/openai` — the OpenAI Chat Completions adapter, on the official SDK.
 *
 * A separate entry point because importing it loads the `openai` package. The
 * core entry point does not, so an embedding agent that only wants the loop never
 * pulls the SDK into its process.
 *
 * `map.ts` is exported as well: someone writing an adapter for a different
 * vendor that speaks the same wire format can reuse the message translation
 * instead of writing it again.
 */

export {
  openaiClient,
  type OpenAIAdapter,
  type OpenAIAdapterOptions,
} from "./providers/openai/index.js";

export {
  mapFinishReason,
  toOpenAIMessages,
  toOpenAITools,
  type OpenAIContentPart,
  type OpenAIMessage,
  type OpenAITool,
  type OpenAIToolCall,
} from "./providers/openai/map.js";
