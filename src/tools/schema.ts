import type { JSONSchema, JSONSchemaType } from "../core/schema.js";

/**
 * A JSON Schema subset, and a validator for it.
 *
 * Why a hand-written subset instead of `ajv` or `zod`:
 *
 * The core's zero-dependency promise is only worth having if it holds for the
 * things every embedding agent needs on day one, and tool-argument validation is
 * exactly that. A validator for a tool-call schema does not need JSON Schema's
 * full expressiveness — it needs to answer "does this object have the fields the
 * tool declared, with the right primitive types" and to say so in a way a model
 * can act on.
 *
 * The subset is deliberately small and closed. Anything outside it (`anyOf`,
 * `$ref`, `patternProperties`, `format`) is not silently ignored — `validate`
 * reports it as an unsupported keyword so an author finds out immediately rather
 * than shipping a tool whose constraints are never applied.
 *
 * Schemas are still ordinary JSON Schema, so a caller who prefers `zod` can
 * convert with `z.toJSONSchema()` and hand the result over unchanged.
 */

/** One reason a value did not match its schema, addressed by path. */
export interface SchemaViolation {
  /** Dotted path from the root, e.g. `path` or `edits[0].oldText`. */
  path: string;
  message: string;
}

/**
 * Keywords that exist in JSON Schema but are not supported here.
 *
 * Listed rather than ignored: an ignored constraint is a tool that fails at
 * runtime in a way its author cannot explain.
 */
const UNSUPPORTED_KEYWORDS = new Set([
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "$ref",
  "$defs",
  "definitions",
  "patternProperties",
  "format",
  "multipleOf",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "uniqueItems",
  "contains",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "if",
  "then",
  "else",
]);

const MAX_DEPTH = 64;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate `value` against `schema`.
 *
 * Returns every violation found, not just the first: a model that gets three
 * fields wrong should be told about all three in one round trip rather than
 * discovering them one per turn.
 *
 * An empty array means the value is valid.
 */
export function validate(schema: JSONSchema, value: unknown): SchemaViolation[] {
  const violations: SchemaViolation[] = [];
  validateAt(schema, value, "", violations, 0);
  return violations;
}

/** Thrown when a schema itself is malformed — an authoring bug, not a model bug. */
export class InvalidSchemaError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`Invalid schema at "${path || "(root)"}": ${message}`);
    this.name = "InvalidSchemaError";
  }
}

const VALID_TYPES = new Set<string>([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);

/**
 * Check a schema's own structure, without a value to test it against.
 *
 * `validate` only reaches a nested subschema when the value at that path is
 * present, so an unsupported keyword buried in `properties.foo` would otherwise
 * stay dormant until some model happened to send `foo`. This walks the whole
 * schema up front and is what `defineTool` calls at startup.
 */
export function checkSchema(schema: JSONSchema, path = ""): void {
  checkSchemaAt(schema, path, 0);
}

function checkSchemaAt(schema: JSONSchema, path: string, depth: number): void {
  if (depth > MAX_DEPTH) {
    throw new InvalidSchemaError(`nesting deeper than ${MAX_DEPTH} levels`, path);
  }
  if (schema === null || typeof schema !== "object") {
    throw new InvalidSchemaError("a schema must be an object", path);
  }

  assertSupported(schema, path);

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const type of types) {
      if (!VALID_TYPES.has(type)) {
        throw new InvalidSchemaError(`unknown type "${type}"`, path);
      }
    }
  }

  if (schema.pattern !== undefined) {
    try {
      new RegExp(schema.pattern);
    } catch {
      throw new InvalidSchemaError(`pattern is not a valid regular expression: ${schema.pattern}`, path);
    }
  }

  const properties = schema.properties ?? {};
  if (schema.required !== undefined) {
    for (const name of schema.required) {
      if (!(name in properties)) {
        throw new InvalidSchemaError(
          `required lists "${name}" but properties has no such key`,
          path,
        );
      }
    }
  }

  for (const [key, subschema] of Object.entries(properties)) {
    checkSchemaAt(subschema, joinPath(path, key), depth + 1);
  }

  if (schema.items !== undefined) {
    checkSchemaAt(schema.items, `${path}[]`, depth + 1);
  }
}

function validateAt(
  schema: JSONSchema,
  value: unknown,
  path: string,
  out: SchemaViolation[],
  depth: number,
): void {
  if (depth > MAX_DEPTH) {
    throw new InvalidSchemaError(`nesting deeper than ${MAX_DEPTH} levels`, path);
  }

  assertSupported(schema, path);

  // `enum` and `const` are exact-match constraints on the whole value.
  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    out.push({ path, message: `must be ${describe(schema.const)}` });
    return;
  }

  if (schema.enum !== undefined && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    out.push({ path, message: `must be one of ${schema.enum.map(describe).join(", ")}` });
    return;
  }

  if (schema.type === undefined) return;

  // NaN and Infinity cannot appear in JSON. An adapter that produced one has a
  // bug worth reporting at the boundary rather than passing downstream.
  if (typeof value === "number" && !Number.isFinite(value)) {
    out.push({ path, message: `expected a finite number, received ${String(value)}` });
    return;
  }

  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = jsonTypeOf(value);

  // An integer satisfies `type: "number"`; the reverse is not true.
  const matches = types.includes(actual) || (actual === "integer" && types.includes("number"));

  if (!matches) {
    out.push({
      path,
      message: `expected ${types.join(" or ")}, received ${describe(value)}`,
    });
    return;
  }

  switch (actual) {
    case "object":
      validateObject(schema, value as Record<string, unknown>, path, out, depth);
      return;
    case "array":
      validateArray(schema, value as unknown[], path, out, depth);
      return;
    case "string":
      validateString(schema, value as string, path, out);
      return;
    case "number":
    case "integer":
      validateNumber(schema, value as number, path, out);
      return;
    default:
      return;
  }
}

function validateObject(
  schema: JSONSchema,
  value: Record<string, unknown>,
  path: string,
  out: SchemaViolation[],
  depth: number,
): void {
  for (const key of schema.required ?? []) {
    if (!(key in value) || value[key] === undefined) {
      out.push({ path: joinPath(path, key), message: "is required but missing" });
    }
  }

  const properties = schema.properties ?? {};

  for (const [key, subschema] of Object.entries(properties)) {
    const child = value[key];
    // An absent optional property is valid; only `required` makes it mandatory.
    if (child === undefined) continue;
    validateAt(subschema, child, joinPath(path, key), out, depth + 1);
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) {
        out.push({
          path: joinPath(path, key),
          message: `is not an expected parameter (allowed: ${Object.keys(properties).join(", ") || "none"})`,
        });
      }
    }
  }
}

function validateArray(
  schema: JSONSchema,
  value: unknown[],
  path: string,
  out: SchemaViolation[],
  depth: number,
): void {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    out.push({ path, message: `must contain at least ${schema.minItems} item(s), got ${value.length}` });
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    out.push({ path, message: `must contain at most ${schema.maxItems} item(s), got ${value.length}` });
  }
  if (schema.items !== undefined) {
    value.forEach((item, index) => {
      validateAt(schema.items!, item, `${path}[${index}]`, out, depth + 1);
    });
  }
}

function validateString(
  schema: JSONSchema,
  value: string,
  path: string,
  out: SchemaViolation[],
): void {
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    out.push({ path, message: `must be at least ${schema.minLength} character(s), got ${value.length}` });
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    out.push({ path, message: `must be at most ${schema.maxLength} character(s), got ${value.length}` });
  }
  if (schema.pattern !== undefined) {
    let re: RegExp;
    try {
      re = new RegExp(schema.pattern);
    } catch {
      throw new InvalidSchemaError(`pattern is not a valid regular expression: ${schema.pattern}`, path);
    }
    if (!re.test(value)) {
      out.push({ path, message: `must match ${schema.pattern}` });
    }
  }
}

function validateNumber(
  schema: JSONSchema,
  value: number,
  path: string,
  out: SchemaViolation[],
): void {
  if (schema.minimum !== undefined && value < schema.minimum) {
    out.push({ path, message: `must be >= ${schema.minimum}, got ${value}` });
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    out.push({ path, message: `must be <= ${schema.maximum}, got ${value}` });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertSupported(schema: JSONSchema, path: string): void {
  for (const key of Object.keys(schema)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) {
      throw new InvalidSchemaError(
        `keyword "${key}" is not supported by this subset; rewrite the schema with type/properties/items/enum/const`,
        path,
      );
    }
  }
}

function jsonTypeOf(value: unknown): JSONSchemaType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    case "object":
      return "object";
    default:
      return "null";
  }
}

/**
 * Describe a received value for an error message.
 *
 * Type names rather than `JSON.stringify` output: "received number" is a
 * correction a model can act on, "received 3" invites it to guess.
 */
function describe(value: unknown): string {
  const type = jsonTypeOf(value);
  switch (type) {
    case "string":
      return `string ${truncate(JSON.stringify(value))}`;
    case "number":
    case "integer":
      return `number ${String(value)}`;
    case "boolean":
      return `boolean ${String(value)}`;
    case "null":
      return "null";
    case "array":
      return `array(${(value as unknown[]).length})`;
    case "object": {
      const keys = Object.keys(value as Record<string, unknown>);
      return keys.length === 0 ? "object {}" : `object with keys ${keys.join(", ")}`;
    }
  }
}

function truncate(text: string, max = 60): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function joinPath(base: string, key: string): string {
  return base === "" ? key : `${base}.${key}`;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const aEntries = Object.entries(a as Record<string, unknown>);
    const bObj = b as Record<string, unknown>;
    return (
      aEntries.length === Object.keys(bObj).length &&
      aEntries.every(([k, v]) => k in bObj && deepEqual(v, bObj[k]))
    );
  }
  return false;
}
