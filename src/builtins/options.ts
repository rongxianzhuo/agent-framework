/** Options shared by the built-in file-reading tools. */
export interface ReadToolOptions {
  /** Override the tool's default name. */
  name?: string;
  /** Optional per-call timeout; cancellation uses the existing tool executor. */
  timeoutMs?: number;
}

/** Text-reader configuration, controlled by the developer rather than the model. */
export interface ReadFileToolOptions extends ReadToolOptions {
  /** Maximum file size in bytes. Omit for no limit; zero allows only empty files. */
  maxBytes?: number;
}

/** Both readers require a fully qualified absolute file path. */
export interface ReadPathArgs {
  path: string;
}
