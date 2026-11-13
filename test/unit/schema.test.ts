import { describe, expect, it } from "vitest";

import { InvalidSchemaError, checkSchema, validate, type JSONSchema } from "../../src/index.js";

function paths(schema: JSONSchema, value: unknown): string[] {
  return validate(schema, value).map((v) => v.path);
}

describe("type checks", () => {
  it("accepts matching primitives", () => {
    expect(validate({ type: "string" }, "x")).toEqual([]);
    expect(validate({ type: "number" }, 1.5)).toEqual([]);
    expect(validate({ type: "integer" }, 2)).toEqual([]);
    expect(validate({ type: "boolean" }, false)).toEqual([]);
    expect(validate({ type: "null" }, null)).toEqual([]);
  });

  it("rejects mismatches and names both sides", () => {
    const [violation] = validate({ type: "string" }, 42);
    expect(violation?.message).toBe("expected string, received number 42");
  });

  it("treats an integer as a valid number but not the reverse", () => {
    expect(validate({ type: "number" }, 3)).toEqual([]);
    const [violation] = validate({ type: "integer" }, 3.5);
    expect(violation?.message).toBe("expected integer, received number 3.5");
  });

  it("supports nullable types via an array", () => {
    const schema: JSONSchema = { type: ["string", "null"] };
    expect(validate(schema, "x")).toEqual([]);
    expect(validate(schema, null)).toEqual([]);
    expect(paths(schema, 1)).toHaveLength(1);
  });

  it("rejects NaN and Infinity as numbers", () => {
    // JSON cannot represent them, so a adapter that produced one has a bug.
    expect(paths({ type: "number" }, Number.NaN)).toHaveLength(1);
  });

  it("skips type checks when no type is declared", () => {
    expect(validate({ description: "anything" }, { a: 1 })).toEqual([]);
  });
});

describe("objects", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: {
      path: { type: "string" },
      limit: { type: "integer", minimum: 1 },
    },
    required: ["path"],
  };

  it("accepts a valid object", () => {
    expect(validate(schema, { path: "a.ts", limit: 5 })).toEqual([]);
  });

  it("reports a missing required field by name", () => {
    expect(validate(schema, {})).toEqual([{ path: "path", message: "is required but missing" }]);
  });

  it("addresses nested violations by dotted path", () => {
    expect(paths(schema, { path: 7, limit: 0 })).toEqual(["path", "limit"]);
  });

  it("reports every violation, not just the first", () => {
    const violations = validate(schema, { path: 7, limit: 0 });
    expect(violations).toHaveLength(2);
  });

  it("allows unknown keys by default", () => {
    expect(validate(schema, { path: "a.ts", extra: true })).toEqual([]);
  });

  it("rejects unknown keys when additionalProperties is false", () => {
    const strict: JSONSchema = { ...schema, additionalProperties: false };
    const [violation] = validate(strict, { path: "a.ts", extra: true });
    expect(violation?.path).toBe("extra");
    expect(violation?.message).toContain("not an expected parameter");
    expect(violation?.message).toContain("path, limit");
  });

  it("treats a missing optional field as valid", () => {
    expect(validate(schema, { path: "a.ts" })).toEqual([]);
  });

  it("treats an explicitly undefined optional field as valid", () => {
    expect(validate(schema, { path: "a.ts", limit: undefined })).toEqual([]);
  });
});

describe("arrays", () => {
  const schema: JSONSchema = {
    type: "array",
    items: {
      type: "object",
      properties: { oldText: { type: "string" }, newText: { type: "string" } },
      required: ["oldText", "newText"],
    },
    minItems: 1,
    maxItems: 2,
  };

  it("validates each item with a bracket path", () => {
    const violations = validate(schema, [{ oldText: "a", newText: 1 }, { oldText: "b" }]);
    expect(violations.map((v) => v.path)).toEqual(["[0].newText", "[1].newText"]);
  });

  it("enforces minItems and maxItems", () => {
    expect(validate(schema, []).map((v) => v.message)).toEqual([
      "must contain at least 1 item(s), got 0",
    ]);
    const tooMany = validate(schema, [
      { oldText: "a", newText: "b" },
      { oldText: "c", newText: "d" },
      { oldText: "e", newText: "f" },
    ]);
    expect(tooMany.map((v) => v.message)).toEqual(["must contain at most 2 item(s), got 3"]);
  });
});

describe("strings and numbers", () => {
  it("enforces length bounds", () => {
    const schema: JSONSchema = { type: "string", minLength: 2, maxLength: 4 };
    expect(validate(schema, "abc")).toEqual([]);
    expect(validate(schema, "a").map((v) => v.message)).toEqual([
      "must be at least 2 character(s), got 1",
    ]);
    expect(validate(schema, "abcde").map((v) => v.message)).toEqual([
      "must be at most 4 character(s), got 5",
    ]);
  });

  it("enforces patterns", () => {
    const schema: JSONSchema = { type: "string", pattern: "^[a-z]+$" };
    expect(validate(schema, "abc")).toEqual([]);
    expect(validate(schema, "ABC").map((v) => v.message)).toEqual(["must match ^[a-z]+$"]);
  });

  it("enforces numeric bounds", () => {
    const schema: JSONSchema = { type: "number", minimum: 0, maximum: 10 };
    expect(validate(schema, 0)).toEqual([]);
    expect(validate(schema, -1).map((v) => v.message)).toEqual(["must be >= 0, got -1"]);
    expect(validate(schema, 11).map((v) => v.message)).toEqual(["must be <= 10, got 11"]);
  });
});

describe("enum and const", () => {
  it("accepts any listed value", () => {
    const schema: JSONSchema = { type: "string", enum: ["read", "write"] };
    expect(validate(schema, "read")).toEqual([]);
    const [violation] = validate(schema, "append");
    expect(violation?.message).toBe('must be one of string "read", string "write"');
  });

  it("supports non-string enum members", () => {
    const schema: JSONSchema = { enum: [1, "one", null] };
    expect(validate(schema, 1)).toEqual([]);
    expect(validate(schema, "one")).toEqual([]);
    expect(validate(schema, null)).toEqual([]);
    expect(validate(schema, 2)).toHaveLength(1);
  });

  it("compares const by value", () => {
    const schema: JSONSchema = { const: { mode: "fast" } };
    expect(validate(schema, { mode: "fast" })).toEqual([]);
    expect(validate(schema, { mode: "slow" })).toHaveLength(1);
  });

  it("reports an enum failure without also reporting a type failure", () => {
    const schema: JSONSchema = { type: "string", enum: ["a", "b"] };
    expect(validate(schema, 3)).toHaveLength(1);
  });
});

describe("schema authoring errors", () => {
  it("rejects unsupported keywords instead of ignoring them", () => {
    expect(() => checkSchema({ anyOf: [{ type: "string" }] } as JSONSchema)).toThrow(
      InvalidSchemaError,
    );
  });

  it("finds unsupported keywords in nested subschemas", () => {
    // The whole reason checkSchema exists: a value-based check never reaches
    // properties.foo when foo is absent.
    const schema = {
      type: "object",
      properties: { foo: { oneOf: [{ type: "string" }] } },
    } as unknown as JSONSchema;
    expect(() => checkSchema(schema)).toThrow(/foo.*oneOf|oneOf/);
  });

  it("rejects an unknown type name", () => {
    expect(() => checkSchema({ type: "text" } as unknown as JSONSchema)).toThrow(/unknown type "text"/);
  });

  it("rejects a required field that is not declared", () => {
    expect(() =>
      checkSchema({ type: "object", properties: { a: { type: "string" } }, required: ["b"] }),
    ).toThrow(/required lists "b"/);
  });

  it("rejects an uncompilable pattern at authoring time", () => {
    expect(() => checkSchema({ type: "string", pattern: "([" })).toThrow(InvalidSchemaError);
  });

  it("accepts a well-formed nested schema", () => {
    expect(() =>
      checkSchema({
        type: "object",
        properties: {
          edits: { type: "array", items: { type: "object", properties: { oldText: { type: "string" } } } },
        },
        required: ["edits"],
      }),
    ).not.toThrow();
  });
});
