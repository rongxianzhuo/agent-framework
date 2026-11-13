/**
 * `agent-core/openai` — the OpenAI Chat Completions adapter.
 *
 * A separate entry point so that importing the core does not load an HTTP
 * adapter. `map.ts` and `sse.ts` are exported because an adapter author writing
 * a different gateway often wants the same message mapping and the same framer.
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
  type OpenAIStreamChunk,
  type OpenAITool,
  type OpenAIToolCall,
} from "./providers/openai/map.js";

export { parseSSE, type SSEMessage } from "./providers/sse.js";
