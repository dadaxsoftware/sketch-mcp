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

const DEFAULT_MCP_URL = process.env.SKETCH_MCP_URL || "http://localhost:31126/mcp";
const MCP_PROTOCOL_VERSION = "2024-11-05";
const CLIENT_NAME = "pi-sketch-mcp-bridge";
const CLIENT_VERSION = "1.1.0";

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

/**
 * Make a JSON-RPC call to the Sketch MCP server.
 * Handles network errors (connection refused, timeout, DNS) gracefully.
 */
async function mcpCall(
  method: string,
  params?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<MCPResponse> {
  const id = ++requestId;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params: params || {},
  });

  let res: Response;
  try {
    res = await fetch(DEFAULT_MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
      signal: signal ?? AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Classify common connection errors for better diagnostics
    if (message.includes("ECONNREFUSED") || message.includes("Connection refused")) {
      throw new Error(
        `Sketch MCP server not reachable at ${DEFAULT_MCP_URL}. ` +
          `Make sure Sketch is running and MCP Server is started (⌘K → "Start MCP Server").`,
      );
    }
    if (message.includes("ENOTFOUND") || message.includes("resolve")) {
      throw new Error(
        `Cannot resolve MCP server host. Check SKETCH_MCP_URL environment variable.`,
      );
    }
    if (message.includes("aborted") || message.includes("timeout") || message.includes("Timeout")) {
      throw new Error(
        `Sketch MCP request timed out (${method}). The server may be unresponsive.`,
      );
    }
    throw new Error(`Sketch MCP request failed: ${message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Sketch MCP HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
    );
  }

  const json = (await res.json()) as MCPResponse;

  // Surface JSON-RPC errors as thrown exceptions
  if (json.error) {
    throw new Error(
      `Sketch MCP error [${method}]: ${json.error.message} (code ${json.error.code})${
        json.error.data ? `\nData: ${JSON.stringify(json.error.data)}` : ""
      }`,
    );
  }

  return json;
}

// ── JSON Schema → TypeBox Converter ────────────────────────────────────

/**
 * Recursively converts a JSON Schema (MCP inputSchema) to a TypeBox TSchema.
 * Handles: string, number, integer, boolean, object, array, enum, const.
 * Unknown/unsupported types fall back to Type.String().
 */
function jsonSchemaToTypeBox(schema: Record<string, unknown> | undefined): TSchema {
  if (!schema || typeof schema !== "object") {
    return Type.Object({});
  }

  const description = schema.description as string | undefined;
  const opts = description ? { description } : {};

  // Handle enum (single-value or multi-value)
  if (schema.enum !== undefined) {
    const values = schema.enum as unknown[];
    if (values.length === 1) {
      // Single enum → constant
      return Type.Literal(values[0]);
    }
    // Multi-value enum → union of literals
    const literals = values.map((v) => Type.Literal(v));
    if (literals.length > 0) {
      return Type.Union(literals as any, opts);
    }
  }

  // Handle const
  if (schema.const !== undefined) {
    return Type.Literal(schema.const);
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

    if (Object.keys(props).length === 0) {
      return Type.Object({}, opts);
    }
    return Type.Object(props, opts);
  }

  // Handle array type
  if (schemaType === "array") {
    const items = schema.items as Record<string, unknown> | undefined;
    const itemSchema = items ? jsonSchemaToTypeBox(items) : Type.String();
    return Type.Array(itemSchema, opts);
  }

  // Handle primitive types
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
      return Type.String({
        description: description || `Value (type: ${schemaType || "unknown"})`,
      });
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

/**
 * Extract and normalize content from an MCP tools/call result.
 *
 * Text content is accumulated into a single readable string.
 * Image content (e.g. screenshots) is passed through as proper ImageContent
 * blocks so the LLM can actually see them.
 * Resource content is summarized since Pi doesn't have a resource concept.
 */
function extractContent(result: Record<string, unknown> | undefined): {
  text: string;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
  details: Record<string, unknown>;
} {
  const content = result?.content as MCPContentItem[] | undefined;

  if (!content || !Array.isArray(content)) {
    return {
      text: result ? JSON.stringify(result, null, 2) : "(no result)",
      images: [],
      details: { raw_result: result || null },
    };
  }

  const textParts: string[] = [];
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  let resourceCount = 0;

  for (const item of content) {
    if (item.type === "text") {
      textParts.push(item.text);
    } else if (item.type === "image") {
      // Pass through images (e.g. screenshots) so the LLM can see them
      images.push({
        type: "image",
        data: item.data,
        mimeType: item.mimeType,
      });
    } else if (item.type === "resource") {
      resourceCount++;
      // If the resource has inline text, include it
      if (item.resource?.text) {
        textParts.push(item.resource.text);
      }
    }
  }

  let text = textParts.join("\n");

  // Append summary of non-text content only if there's no inline rendering
  const extras: string[] = [];
  if (images.length > 0) extras.push(`${images.length} image(s) attached`);
  if (resourceCount > 0) extras.push(`${resourceCount} resource(s)`);

  if (extras.length > 0) {
    text = text ? `${text}\n\n[${extras.join(", ")}]` : `[${extras.join(", ")}]`;
  }

  if (!text && images.length === 0) {
    text = JSON.stringify(result, null, 2);
  }

  return {
    text,
    images,
    details: {
      content_items: content.length,
      image_count: images.length,
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
  // Step 1: Initialize MCP session
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

  console.log(
    `Sketch MCP: initialized session with server ${initResult.result?.serverInfo ? JSON.stringify(initResult.result.serverInfo) : "(unknown)"}`,
  );

  // Step 2: Send the required "initialized" notification (MCP protocol §4.1)
  // This is a notification, not a request — we don't await the response.
  // Fire-and-forget; if it fails, tools may still work.
  mcpCall("notifications/initialized", {}).catch((err) => {
    console.warn(`Sketch MCP: initialized notification failed: ${err instanceof Error ? err.message : err}`);
  });

  // Step 3: Discover available tools
  const toolsResult = await mcpCall("tools/list");
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

      // Build a one-line snippet for the system prompt's "Available tools" section
      const promptSnippet = tool.description
        ? `sketch_${tool.name} – ${tool.description.split(".")[0].trim()}`
        : `sketch_${tool.name} – Sketch design tool`;

      pi.registerTool({
        name: toolName,
        label: `Sketch: ${tool.name}`,
        description:
          tool.description ||
          `Sketch MCP tool: ${tool.name}. Operates on the currently open Sketch document.`,
        promptSnippet,
        parameters: params as TObject,
        async execute(_toolCallId, toolParams, signal, _onUpdate, _ctx) {
          // Use AbortSignal from pi tool execution context for cancellation support
          const result = await mcpCall("tools/call", {
            name: tool.name,
            arguments: toolParams || {},
          }, signal);

          const { text, images, details } = extractContent(
            result.result as Record<string, unknown> | undefined,
          );

          // Build content array: text + any image blocks
          const content: Array<
            { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
          > = [];

          if (text) {
            content.push({ type: "text" as const, text });
          }
          for (const img of images) {
            content.push(img);
          }

          return {
            content,
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
      console.error(
        `Sketch MCP: Failed to register tool "${tool.name}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log(`Sketch MCP: registered ${registered} tools`);
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
      console.error(`Sketch MCP: ${message}`);
      // Only show warning in TUI mode to avoid noise in print/RPC modes
      ctx.ui.notify(
        `Sketch MCP unavailable — ${message.slice(0, 80)}`,
        "warning",
      );
    }
  });

  // ── Session shutdown: clean up MCP session ───────────────────────
  pi.on("session_shutdown", async (_event) => {
    if (mcpConnected) {
      try {
        // Attempt graceful shutdown notification (fire-and-forget)
        await mcpCall("shutdown", {}, AbortSignal.timeout(2000));
        console.log("Sketch MCP: session shutdown complete");
      } catch {
        // Server may already be gone; silence the error
      }
      mcpConnected = false;
    }
  });

  // ── /sketch-reconnect – force reconnection ───────────────────────
  pi.registerCommand("sketch-reconnect", {
    description: "Reconnect to Sketch MCP server and refresh tools",
    handler: async (_args, ctx) => {
      mcpConnected = false;
      requestId = 0;

      // Note: Pi does not currently support unregistering tools.
      // Clearing the set ensures we re-register under the same names,
      // which will overwrite the previous registrations.
      const previousCount = registeredToolNames.size;
      registeredToolNames = new Set();

      ctx.ui.notify("Reconnecting to Sketch MCP server...", "info");

      try {
        const count = await discoverAndRegisterTools(pi);
        mcpConnected = true;
        ctx.ui.notify(
          `Sketch MCP reconnected – ${count} tools available (was ${previousCount})`,
          "info",
        );
      } catch (err) {
        mcpConnected = false;
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Sketch MCP reconnection failed: ${message}`, "error");
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
          `Sketch MCP: not connected.\n\n` +
            `Server URL: ${DEFAULT_MCP_URL}\n` +
            `To connect: Start Sketch, then press ⌘K → "Start MCP Server", then run /sketch-reconnect`,
          "warning",
        );
      }
    },
  });
}
