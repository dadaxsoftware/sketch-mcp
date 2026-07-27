/**
 * Sketch MCP Bridge Extension
 *
 * Bridges pi to the Sketch MCP Server (HTTP JSON-RPC), dynamically discovering
 * and registering all Sketch MCP tools as native pi tools.
 *
 * Prerequisites:
 *   1. Sketch 2025.2.4+ (macOS, NOT Mac App Store version)
 *   2. MCP Server started in Sketch (⌘K → "Start MCP Server")
 *
 * Tools exposed (auto-discovered):
 *   - sketch_get_document_info    – Structured overview of the open document
 *   - sketch_get_layer_tree_summary – Layer hierarchy as readable text
 *   - sketch_get_design_assets    – Symbols, styles, swatches, templates
 *   - sketch_get_screenshot       – Screenshot of a layer or canvas
 *   - sketch_get_libraries        – Linked library info
 *   - sketch_get_symbol_overrides – Override properties for a symbol instance
 *   - sketch_get_guide            – Sketch built-in reference guides
 *   - sketch_run_code             – Execute arbitrary SketchAPI JavaScript
 *
 * Commands:
 *   /sketch-reconnect  – Force reconnection & tool re-discovery
 *   /sketch-status     – Show connection status
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema, type TObject } from "typebox";

// ── Configuration ──────────────────────────────────────────────────────

const DEFAULT_MCP_URL = "http://localhost:31126/mcp";
const MCP_PROTOCOL_VERSION = "2024-11-05";
const CLIENT_NAME = "pi-sketch-mcp-bridge";
const CLIENT_VERSION = "1.0.0";

// ── State ──────────────────────────────────────────────────────────────

let mcpConnected = false;
let requestId = 0;
let registeredToolNames = new Set<string>();

// ── MCP JSON-RPC Client ────────────────────────────────────────────────

interface MCPError {
  code: number;
  message: string;
  data?: unknown;
}

interface MCPResponse {
  jsonrpc: string;
  id: number;
  result?: Record<string, unknown>;
  error?: MCPError;
}

async function mcpCall(method: string, params?: Record<string, unknown>): Promise<MCPResponse> {
  const id = ++requestId;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params: params || {},
  });

  const res = await fetch(DEFAULT_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body,
    // MCP server is local, short timeouts are appropriate
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  return (await res.json()) as MCPResponse;
}

// ── JSON Schema → TypeBox Converter ────────────────────────────────────

/**
 * Recursively converts a JSON Schema (MCP inputSchema) to a TypeBox TSchema.
 * Handles: string, number, integer, boolean, object, array.
 * Unknown/unsupported types fall back to Type.String().
 */
function jsonSchemaToTypeBox(schema: Record<string, unknown> | undefined): TSchema {
  if (!schema || typeof schema !== "object") {
    return Type.Object({});
  }

  const schemaType = schema.type as string | undefined;

  // Handle object type with properties
  if (schemaType === "object" && schema.properties) {
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const required = new Set<string>((schema.required as string[]) || []);
    const props: Record<string, TSchema> = {};

    for (const [key, propSchema] of Object.entries(properties)) {
      let field: TSchema = jsonSchemaToTypeBox(propSchema);

      // Wrap with Optional if not required
      if (!required.has(key)) {
        field = Type.Optional(field);
      }

      props[key] = field;
    }

    const description = schema.description as string | undefined;
    if (Object.keys(props).length === 0) {
      return Type.Object({}, description ? { description } : {});
    }
    return Type.Object(props, description ? { description } : {});
  }

  // Handle array type
  if (schemaType === "array") {
    const items = schema.items as Record<string, unknown> | undefined;
    const itemSchema = items ? jsonSchemaToTypeBox(items) : Type.String();
    const description = schema.description as string | undefined;
    return Type.Array(itemSchema, description ? { description } : {});
  }

  // Handle primitive types
  const description = schema.description as string | undefined;
  const opts = description ? { description } : {};

  switch (schemaType) {
    case "string":
      return Type.String(opts);
    case "number":
    case "integer":
      return Type.Number(opts);
    case "boolean":
      return Type.Boolean(opts);
    default:
      // Fallback: treat as string (most flexible for LLM)
      return Type.String({ description: description || `Value (type: ${schemaType || "unknown"})` });
  }
}

// ── MCP Content Extraction ─────────────────────────────────────────────

interface MCPTextContent {
  type: "text";
  text: string;
}

interface MCPImageContent {
  type: "image";
  data: string; // base64
  mimeType: string;
}

interface MCPResourceContent {
  type: "resource";
  resource: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string; // base64
  };
}

type MCPContentItem = MCPTextContent | MCPImageContent | MCPResourceContent;

function extractContent(result: Record<string, unknown> | undefined): {
  text: string;
  details: Record<string, unknown>;
} {
  const content = result?.content as MCPContentItem[] | undefined;

  if (!content || !Array.isArray(content)) {
    // No content array – return the raw result as JSON
    return {
      text: result ? JSON.stringify(result, null, 2) : "(no result)",
      details: { raw_result: result || null },
    };
  }

  const textParts: string[] = [];
  const imageCount = content.filter((c) => c.type === "image").length;
  const resourceCount = content.filter((c) => c.type === "resource").length;

  for (const item of content) {
    if (item.type === "text") {
      textParts.push(item.text);
    }
  }

  let text = textParts.join("\n");

  // Append summary of non-text content
  const extras: string[] = [];
  if (imageCount > 0) extras.push(`${imageCount} image(s)`);
  if (resourceCount > 0) extras.push(`${resourceCount} resource(s)`);

  if (extras.length > 0) {
    text = text ? `${text}\n\n[Contains: ${extras.join(", ")}]` : `[Contains: ${extras.join(", ")}]`;
  }

  if (!text) {
    text = JSON.stringify(result, null, 2);
  }

  return {
    text,
    details: {
      content_items: content.length,
      image_count: imageCount,
      resource_count: resourceCount,
      raw_result: result,
    },
  };
}

// ── Tool Discovery & Registration ──────────────────────────────────────

interface MCPToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

async function discoverAndRegisterTools(pi: ExtensionAPI): Promise<number> {
  // Initialize MCP session
  const initResult = await mcpCall("initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {
      // We don't need to advertise any special capabilities
    },
    clientInfo: {
      name: CLIENT_NAME,
      version: CLIENT_VERSION,
    },
  });

  if (initResult.error) {
    throw new Error(
      `MCP initialize failed: ${initResult.error.message} (code ${initResult.error.code})`,
    );
  }

  // Discover available tools
  const toolsResult = await mcpCall("tools/list");
  if (toolsResult.error) {
    throw new Error(
      `MCP tools/list failed: ${toolsResult.error.message} (code ${toolsResult.error.code})`,
    );
  }

  const tools: MCPToolDef[] = (toolsResult.result?.tools as MCPToolDef[]) || [];
  let registered = 0;

  for (const tool of tools) {
    const toolName = `sketch_${tool.name}`;

    // Skip if already registered (prevents duplicates on reconnection)
    if (registeredToolNames.has(toolName)) {
      registered++;
      continue;
    }

    try {
      // Convert JSON Schema to TypeBox parameters
      const params = jsonSchemaToTypeBox(tool.inputSchema);

      pi.registerTool({
        name: toolName,
        label: `Sketch: ${tool.name}`,
        description:
          tool.description ||
          `Sketch MCP tool: ${tool.name}. Operates on the currently open Sketch document.`,
        parameters: params as TObject,
        async execute(_toolCallId, toolParams, _signal, _onUpdate, _ctx) {
          const result = await mcpCall("tools/call", {
            name: tool.name,
            arguments: toolParams || {},
          });

          if (result.error) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Sketch MCP Error [${tool.name}]: ${result.error.message}${
                    result.error.data ? `\nData: ${JSON.stringify(result.error.data)}` : ""
                  }`,
                },
              ],
              details: {
                tool: tool.name,
                error: result.error,
              },
            };
          }

          const { text, details } = extractContent(result.result as Record<string, unknown> | undefined);

          return {
            content: [{ type: "text" as const, text }],
            details: {
              tool: tool.name,
              ...details,
            },
          };
        },
      });

      registeredToolNames.add(toolName);
      registered++;
    } catch (err) {
      console.error(`Sketch MCP: Failed to register tool "${tool.name}":`, err);
    }
  }

  return registered;
}

// ── Extension Entry Point ──────────────────────────────────────────────

export default async function sketchMcpExtension(pi: ExtensionAPI) {
  // ── Session start: discover & register Sketch MCP tools ──────────
  pi.on("session_start", async (_event, ctx) => {
    try {
      const count = await discoverAndRegisterTools(pi);
      mcpConnected = true;
      ctx.ui.notify(
        `Sketch MCP connected – ${count} tools available`,
        "info",
      );
    } catch (err) {
      mcpConnected = false;
      const message = err instanceof Error ? err.message : String(err);
      // Don't spam the user if Sketch isn't running; log quietly
      console.error(`Sketch MCP: ${message}`);
      ctx.ui.notify(
        `Sketch MCP unavailable (${message.slice(0, 80)})`,
        "warning",
      );
    }
  });

  // ── /sketch-reconnect – force reconnection ───────────────────────
  pi.registerCommand("sketch-reconnect", {
    description: "Reconnect to Sketch MCP server and refresh tools",
    handler: async (_args, ctx) => {
      mcpConnected = false;
      requestId = 0;
      registeredToolNames = new Set();

      ctx.ui.notify("Reconnecting to Sketch MCP server...", "info");

      try {
        const count = await discoverAndRegisterTools(pi);
        mcpConnected = true;
        ctx.ui.notify(
          `Sketch MCP reconnected – ${count} tools available`,
          "info",
        );
      } catch (err) {
        mcpConnected = false;
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Sketch MCP failed: ${message}`, "error");
      }
    },
  });

  // ── /sketch-status – show connection state ──────────────────────
  pi.registerCommand("sketch-status", {
    description: "Show Sketch MCP connection status",
    handler: async (_args, ctx) => {
      if (mcpConnected) {
        ctx.ui.notify(
          `Sketch MCP: connected (${registeredToolNames.size} tools) → ${DEFAULT_MCP_URL}`,
          "info",
        );
      } else {
        ctx.ui.notify(
          `Sketch MCP: not connected. Start MCP Server in Sketch (⌘K → "Start MCP Server"), then run /sketch-reconnect`,
          "warning",
        );
      }
    },
  });
}
