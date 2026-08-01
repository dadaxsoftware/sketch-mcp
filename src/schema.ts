/**
 * schema.ts — JSON Schema → TypeBox TSchema converter.
 *
 * Recursively converts MCP inputSchema definitions to TypeBox schemas.
 * Enhanced to handle Sketch MCP specific patterns:
 * - Enum values → Literal unions
 * - One-off string params with known value sets → StringEnum
 * - Nested object/array structures
 */

import { Type, type TSchema } from "typebox";

// ── Known value sets for Sketch MCP parameters ──────────────────────────

const KNOWN_VALUE_SETS: Record<string, string[]> = {
  kind: ["symbol", "textStyle", "layerStyle", "swatch", "frameTemplate", "graphicTemplate"],
  overrideKind: ["text", "color", "image", "all"],
  topic: ["mcp", "troubleshooting", "use", "layout", "styling", "symbols", "assets", "prototyping"],
};

/**
 * Attempt to infer known value sets for a parameter based on the tool name and
 * parameter name. This enriches the type information beyond what the raw JSON
 * Schema provides.
 */
function inferValueSet(toolName: string, paramName: string): string[] | undefined {
  if (paramName === "kind") {
    // get_design_assets uses one set of kinds
    if (toolName === "get_symbol_overrides") {
      return KNOWN_VALUE_SETS.overrideKind;
    }
    return KNOWN_VALUE_SETS.kind;
  }
  if (paramName === "topic" && toolName === "get_guide") {
    return KNOWN_VALUE_SETS.topic;
  }
  return undefined;
}

// ── Core Converter ──────────────────────────────────────────────────────

export function jsonSchemaToTypeBox(
  schema: Record<string, unknown> | undefined,
  toolName?: string,
  paramName?: string,
): TSchema {
  if (!schema || typeof schema !== "object") {
    return Type.Object({});
  }

  const description = schema.description as string | undefined;
  const opts = description ? { description } : {};

  // ── Enum handling ──────────────────────────────────────────────
  if (schema.enum !== undefined) {
    const values = schema.enum as unknown[];
    if (values.length === 1) {
      return Type.Literal(values[0]);
    }
    const literals = values.map((v) => Type.Literal(v));
    if (literals.length > 0) {
      return Type.Union(literals, opts);
    }
  }

  // ── Const handling ─────────────────────────────────────────────
  if (schema.const !== undefined) {
    return Type.Literal(schema.const);
  }

  const schemaType = schema.type as string | undefined;

  // ── Object type with properties ────────────────────────────────
  if (schemaType === "object" && schema.properties) {
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const required = new Set<string>((schema.required as string[]) || []);
    const props: Record<string, TSchema> = {};

    for (const [key, propSchema] of Object.entries(properties)) {
      let field: TSchema = jsonSchemaToTypeBox(propSchema, toolName, key);

      // Enrich with known value sets (string params only)
      if (propSchema.type === "string" && !propSchema.enum) {
        const inferred = inferValueSet(toolName, key);
        if (inferred) {
          const enrichedDesc = propSchema.description
            ? `${propSchema.description} One of: ${inferred.join(", ")}.`
            : `One of: ${inferred.join(", ")}.`;
          field = Type.String({ description: enrichedDesc });
        }
      }

      // Wrap Optional if not required
      if (!required.has(key)) {
        field = Type.Optional(field);
      }

      props[key] = field;
    }

    if (Object.keys(props).length === 0) {
      return Type.Object({}, opts);
    }
    return Type.Object(props, opts);
  }

  // ── Array type ─────────────────────────────────────────────────
  if (schemaType === "array") {
    const items = schema.items as Record<string, unknown> | undefined;
    const itemSchema = items
      ? jsonSchemaToTypeBox(items, toolName, `${paramName || "item"}[]`)
      : Type.String();
    return Type.Array(itemSchema, opts);
  }

  // ── Primitive types ────────────────────────────────────────────
  switch (schemaType) {
    case "string":
      // Check for known value set enrichment
      if (toolName && paramName) {
        const inferred = inferValueSet(toolName, paramName);
        if (inferred && !description) {
          return Type.String({
            description: `One of: ${inferred.join(", ")}.`,
          });
        }
      }
      return Type.String(opts as any);
    case "number":
    case "integer":
      return Type.Number(opts as any);
    case "boolean":
      return Type.Boolean(opts as any);
    default:
      return Type.String({
        description: description || `Value (type: ${schemaType || "unknown"})`,
      });
  }
}
