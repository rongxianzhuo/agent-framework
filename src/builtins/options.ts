/** Name and timeout options shared by built-in filesystem tools. */
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

/** Writer factories accept the same optional name and timeout settings. */
export type WriteFileToolOptions = ReadToolOptions;

/** Editor factories accept the same optional name and timeout settings. */
export type EditFileToolOptions = ReadToolOptions;

/** Literal text replacement in an existing UTF-8 file. */
export interface EditFileArgs {
  file_path: string;
  old_string: string;
  new_string: string;
  /** Replace all non-overlapping occurrences; defaults to false. */
  replace_all?: boolean;
}

/** UTF-8 text to create or overwrite at an absolute path. */
export interface WriteFileArgs {
  path: string;
  content: string;
}

/** Both readers require a fully qualified absolute file path. */
export interface ReadPathArgs {
  path: string;
}

/** Read all text, or skip zero-based lines and return at most limit lines. */
export type ReadFileArgs = ReadPathArgs & (
  | { offset?: never; limit?: never }
  | { offset: number; limit: number }
);
