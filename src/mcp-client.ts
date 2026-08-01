/**
 * mcp-client.ts — Thin JSON-RPC 2.0 client over HTTP for the Sketch MCP Server.
 *
 * Handles connection lifecycle, error classification, and content extraction.
 * Stateless except for the monotonically increasing request ID counter.
 */

// ── Configuration ────────────────────────────────────────────────────────

const DEFAULT_MCP_URL = process.env.SKETCH_MCP_URL || "http://localhost:31126/mcp";
const MCP_PROTOCOL_VERSION = "2024-11-05";
const CLIENT_NAME = "pi-sketch-mcp-bridge";
const CLIENT_VERSION = "2.0.0";

// ── State ────────────────────────────────────────────────────────────────

let requestId = 0;

// ── Types ─────────────────────────────────────────────────────────────────

export interface MCPError {
  code: number;
  message: string;
  data?: unknown;
}

export interface MCPResponse {
  jsonrpc: string;
  id: number;
  result?: Record<string, unknown>;
  error?: MCPError;
}

export interface MCPToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface MCPTextContent {
  type: "text";
  text: string;
}

export interface MCPImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface MCPResourceContent {
  type: "resource";
  resource: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  };
}

export type MCPContentItem = MCPTextContent | MCPImageContent | MCPResourceContent;

export interface ExtractedContent {
  text: string;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
  details: Record<string, unknown>;
}

// ── Helpers ───────────────────────────────────────────────────────────────

export function getMcpUrl(): string {
  return DEFAULT_MCP_URL;
}

/** Reset the request ID counter (used on reconnect). */
export function resetRequestId(): void {
  requestId = 0;
}

// ── JSON-RPC Client ──────────────────────────────────────────────────────

export async function mcpCall(
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

  if (json.error) {
    throw new Error(
      `Sketch MCP error [${method}]: ${json.error.message} (code ${json.error.code})${
        json.error.data ? `\nData: ${JSON.stringify(json.error.data)}` : ""
      }`,
    );
  }

  return json;
}

// ── Session Handshake ────────────────────────────────────────────────────

export async function mcpInitialize(): Promise<{ serverInfo: unknown }> {
  const initResult = await mcpCall("initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: {
      name: CLIENT_NAME,
      version: CLIENT_VERSION,
    },
  });

  // Fire-and-forget the required "initialized" notification per MCP spec §4.1.
  // Sketch MCP over HTTP does not support POST for server→client notifications
  // (it uses SSE), so 501 is expected and benign. Silently ignore.
  mcpCall("notifications/initialized", {}).catch(() => {
  });

  return {
    serverInfo: initResult.result?.serverInfo || "(unknown)",
  };
}

export async function mcpShutdown(): Promise<void> {
  try {
    await mcpCall("shutdown", {}, AbortSignal.timeout(2000));
    console.log("Sketch MCP: session shutdown complete");
  } catch {
    // Server may already be gone; silence
  }
}

// ── Tool Discovery ───────────────────────────────────────────────────────

export async function mcpListTools(): Promise<MCPToolDef[]> {
  const toolsResult = await mcpCall("tools/list");
  return (toolsResult.result?.tools as MCPToolDef[]) || [];
}

// ── Content Extraction ──────────────────────────────────────────────────

export function extractContent(result: Record<string, unknown> | undefined): ExtractedContent {
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
      images.push({
        type: "image",
        data: item.data,
        mimeType: item.mimeType,
      });
    } else if (item.type === "resource") {
      resourceCount++;
      if (item.resource?.text) {
        textParts.push(item.resource.text);
      }
    }
  }

  let text = textParts.join("\n");

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
