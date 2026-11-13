/**
 * Server-sent events, parsed from a fetch response body.
 *
 * Shared by adapters rather than inlined in one of them: the framing rules are
 * the same everywhere (lines, `data:` prefixes, a blank line between events), and
 * getting them subtly wrong is the usual source of "the stream stops halfway"
 * bugs. What differs per provider — the JSON inside the payload — stays where it
 * belongs.
 */

/** One `data:` payload from the stream, with the prefix stripped. */
export interface SSEMessage {
  /** The payload. Multi-line data fields are joined with newlines. */
  data: string;
  /** The `event:` field, when the provider sets one. */
  event?: string;
}

/**
 * Parse an SSE body into messages.
 *
 * Yields as soon as a complete event has arrived, so a caller can forward deltas
 * without waiting for the response to finish. Comment lines (`:keep-alive`) are
 * skipped; they exist to keep proxies from closing the connection and carry no
 * data.
 *
 * A stream that ends without a trailing blank line still yields its last event:
 * providers close the socket at `[DONE]` and some never send the final newline.
 */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let dataLines: string[] = [];
  let eventName: string | undefined;

  const flush = (): SSEMessage | undefined => {
    if (dataLines.length === 0 && eventName === undefined) return undefined;
    const message: SSEMessage = { data: dataLines.join("\n") };
    if (eventName !== undefined) message.event = eventName;
    dataLines = [];
    eventName = undefined;
    return message;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newlineAt: number;
      while ((newlineAt = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, newlineAt);
        buffer = buffer.slice(newlineAt + 1);
        // Tolerate CRLF: some proxies rewrite line endings.
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

        if (line === "") {
          const message = flush();
          if (message !== undefined) yield message;
          continue;
        }
        if (line.startsWith(":")) continue;

        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let fieldValue = colon === -1 ? "" : line.slice(colon + 1);
        if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);

        if (field === "data") dataLines.push(fieldValue);
        else if (field === "event") eventName = fieldValue;
      }
    }

    // Whatever is left in the buffer when the socket closes.
    buffer += decoder.decode();
    for (const rawLine of buffer.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line === "" || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let fieldValue = colon === -1 ? "" : line.slice(colon + 1);
      if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
      if (field === "data") dataLines.push(fieldValue);
      else if (field === "event") eventName = fieldValue;
    }

    const last = flush();
    if (last !== undefined) yield last;
  } finally {
    // Release the socket on early exit (abort, consumer break, parse failure).
    reader.releaseLock();
  }
}
