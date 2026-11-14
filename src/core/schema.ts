/** JSON Schema shapes shared by model contracts and tool definitions. */

export type JSONSchemaType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null";

/**
 * The supported subset of JSON Schema.
 *
 * `type` accepts an array to express nullability (`["string", "null"]`), which
 * is how optional parameters are written without a second `anyOf` construct.
 */
export interface JSONSchema {
  type?: JSONSchemaType | JSONSchemaType[];
  description?: string;

  // Object
  properties?: Record<string, JSONSchema>;
  required?: string[];
  additionalProperties?: boolean;

  // Array
  items?: JSONSchema;
  minItems?: number;
  maxItems?: number;

  // String
  minLength?: number;
  maxLength?: number;
  pattern?: string;

  // Number
  minimum?: number;
  maximum?: number;

  // Any
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
}
