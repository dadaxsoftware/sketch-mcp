/**
 * sketch-mcp/index.ts — Pi extension bridging AI agents to Sketch MCP Server.
 *
 * v2.0.0 — Guide-aware prompting, smart run_code pre-flight, connection health,
 *          enriched tool descriptions, and multi-file architecture.
 *
 * Prerequisites:
 *   1. Sketch 2025.2.4+ (macOS direct download, NOT Mac App Store version)
 *   2. MCP Server started in Sketch (⌘K → "Start MCP Server")
 *
 * Tools auto-registered (prefixed sketch_):
 *   get_document_info, get_layer_tree_summary, get_design_assets,
 *   get_screenshot, get_libraries, get_symbol_overrides, get_guide,
 *   run_code
 *
 * Commands:
 *   /sketch-reconnect  — Force reconnection & tool re-discovery
 *   /sketch-status     — Show connection status
 *   /sketch-guide      — Fetch a specific guide topic on demand
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema, type TObject } from "typebox";

import {
  mcpCall,
  mcpInitialize,
  mcpShutdown,
  mcpListTools,
  extractContent,
  getMcpUrl,
  resetRequestId,
  type MCPToolDef,
} from "./mcp-client";
import { jsonSchemaToTypeBox } from "./schema";
import {
  preloadEssentialGuides,
  clearGuideCache,
  buildSketchMcpPromptSnippet,
  fetchGuide,
} from "./guides";

// ── State ────────────────────────────────────────────────────────────────

let mcpConnected = false;
let registeredToolNames = new Set<string>();

// ── Tool Descriptions Enhancement ────────────────────────────────────────

/**
 * Enriched descriptions for Sketch MCP tools.
 * These add parameter hints, prerequisite warnings, and output notes
 * beyond the raw MCP descriptions.
 */
const ENRICHED_TOOL_META: Record<string, { description: string; promptSnippet: string }> = {
  get_guide: {
    description:
      "Returns Markdown guidance for using Sketch MCP tools. " +
      "LOAD THIS FIRST before any other Sketch tool. " +
      "Topics: mcp (general), troubleshooting, use (content work), " +
      "layout, styling, symbols, assets, prototyping.",
    promptSnippet:
      "sketch_get_guide – Get Sketch MCP usage guides (PREREQUISITE: load topic 'mcp' before other tools)",
  },
  get_document_info: {
    description:
      "Returns basic information about an open Sketch document: " +
      "file name, page names, layer counts, and top-level frames with position and dimensions. " +
      "Call this first to understand the document structure. " +
      "Load get_guide topic 'mcp' before using.",
    promptSnippet:
      "sketch_get_document_info – Get open Sketch document structure (pages, frames, layer counts)",
  },
  get_layer_tree_summary: {
    description:
      "Returns a compact indented text summary of a layer's subtree hierarchy. " +
      "Each line shows layer type, name, ID, position, and dimensions. " +
      "Text layers include string content. Frame layers with stack layout include direction, gap, and padding. " +
      "Parameters: layerID (optional root), depth (1-10, default 3), targetDocumentID (optional). " +
      "Use this over run_code to explore layer hierarchy before diving into specific layers.",
    promptSnippet:
      "sketch_get_layer_tree_summary – Layer tree with type/name/ID/position/dims/text (depth 1-10)",
  },
  get_design_assets: {
    description:
      "Returns a list of design assets grouped by source library. " +
      "kind must be one of: symbol, textStyle, layerStyle, swatch, frameTemplate, graphicTemplate. " +
      "Use sourceLibraryID to filter by library. " +
      "Load get_guide topic 'mcp' before using.",
    promptSnippet:
      "sketch_get_design_assets – List symbols, styles, swatches, templates (kind: symbol|textStyle|...)",
  },
  get_screenshot: {
    description:
      "Generates a PNG screenshot of a Sketch layer. " +
      "If no layerID is provided, screenshots the currently selected layer. " +
      "The image is passed to the AI for visual analysis. " +
      "Use this to verify changes or visually inspect designs. " +
      "Load get_guide topic 'mcp' before using.",
    promptSnippet:
      "sketch_get_screenshot – Capture PNG screenshot of a layer or selection (AI can see it)",
  },
  get_libraries: {
    description:
      "Returns a list of libraries available for the target Sketch document. " +
      "Use together with get_design_assets when working with library components. " +
      "Load get_guide topic 'mcp' before using.",
    promptSnippet:
      "sketch_get_libraries – List linked Sketch libraries for the current document",
  },
  get_symbol_overrides: {
    description:
      "Returns available Overrides on a SymbolInstance. " +
      "kind: 'text', 'color', 'image', or 'all'. " +
      "Use symbolInstanceID from layer tree to target a specific instance. " +
      "Load get_guide topic 'mcp' and 'symbols' before using for modification.",
    promptSnippet:
      "sketch_get_symbol_overrides – Get editable properties on a symbol instance (text|color|image|all)",
  },
  run_code: {
    description:
      "Executes ECMAScript 2020 Sketch plugin scripts via the SketchAPI. " +
      "CRITICAL RULES: Start every script with 'const sketch = require(\"sketch\")'. " +
      "Use only the public Sketch API. Keep scripts small and flat. " +
      "Do NOT include comments. Report results with console.log(JSON.stringify(...)). " +
      "Load get_guide topic 'use' before mutating content. " +
      "Load 'troubleshooting' on failure before retrying. " +
      "Use get_screenshot to verify visual changes, not run_code.",
    promptSnippet:
      "sketch_run_code – Execute SketchAPI JavaScript (load 'use' guide first; no comments; require('sketch'))",
  },
};

function enrichMeta(
  tool: MCPToolDef,
): { description: string; promptSnippet: string } {
  const enriched = ENRICHED_TOOL_META[tool.name];
  if (enriched) return enriched;

  // Fallback: use raw MCP description with a note about guides
  const desc = tool.description || `Sketch MCP tool: ${tool.name}`;
  return {
    description: desc + " Load get_guide topic 'mcp' before using.",
    promptSnippet: `sketch_${tool.name} – ${desc.split(".")[0].trim()}`,
  };
}

// ── Tool Registration ────────────────────────────────────────────────────

async function discoverAndRegisterTools(pi: ExtensionAPI): Promise<number> {
  // Step 1: Initialize MCP session
  const { serverInfo } = await mcpInitialize();
  console.log(`Sketch MCP: initialized session with server ${JSON.stringify(serverInfo)}`);

  // Step 2: Discover available tools
  const tools = await mcpListTools();

  // Step 3: Register each tool as a native pi tool
  let registered = 0;

  for (const tool of tools) {
    const toolName = `sketch_${tool.name}`;

    // Skip if already registered
    if (registeredToolNames.has(toolName)) {
      registered++;
      continue;
    }

    try {
      const params = jsonSchemaToTypeBox(tool.inputSchema, tool.name);
      const meta = enrichMeta(tool);

      pi.registerTool({
        name: toolName,
        label: `Sketch: ${tool.name}`,
        description: meta.description,
        promptSnippet: meta.promptSnippet,
        parameters: params as TObject,
        async execute(_toolCallId, toolParams, signal, _onUpdate, _ctx) {
          const result = await mcpCall("tools/call", {
            name: tool.name,
            arguments: toolParams || {},
          }, signal);

          const { text, images, details } = extractContent(
            result.result as Record<string, unknown> | undefined,
          );

          // Build content: text + any image blocks
          const content: Array<
            { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
          > = [];

          // For run_code failures, append a hint to load troubleshooting guide
          let finalText = text;
          if (tool.name === "run_code" && details.raw_result) {
            const raw = details.raw_result as Record<string, unknown>;
            if (raw.isError) {
              finalText = text + "\n\n⚠️ run_code failed. " +
                "Consider calling sketch_get_guide with topic 'troubleshooting' before retrying.";
            }
          }

          if (finalText) {
            content.push({ type: "text", text: finalText });
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

// ── Extension Entry Point ────────────────────────────────────────────────

export default async function sketchMcpExtension(pi: ExtensionAPI) {
  // ── session_start: connect & register tools ─────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    try {
      const count = await discoverAndRegisterTools(pi);
      mcpConnected = true;

      // Preload essential guides in background (non-blocking)
      preloadEssentialGuides().catch((err) => {
        console.warn(`Sketch MCP: guide preload warning: ${err instanceof Error ? err.message : err}`);
      });

      ctx.ui.notify(
        `Sketch MCP connected — ${count} tools available`,
        "info",
      );
    } catch (err) {
      mcpConnected = false;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Sketch MCP: ${message}`);
      ctx.ui.notify(
        `Sketch MCP unavailable — ${message.slice(0, 80)}`,
        "warning",
      );
    }
  });

  // ── before_agent_start: inject Sketch MCP best practices ────────────
  pi.on("before_agent_start", async (event, _ctx) => {
    // Only inject if we're connected and Sketch tools are available
    if (!mcpConnected) return;

    // Check if any sketch_* tools are registered
    // If they were registered but later the server went down, we still inject
    if (registeredToolNames.size === 0) return;

    const snippet = buildSketchMcpPromptSnippet();

    // Append the snippet to the chained system prompt
    return {
      systemPrompt: (event.systemPrompt || "") + snippet,
    };
  });

  // ── session_shutdown: clean up ─────────────────────────────────────
  pi.on("session_shutdown", async (_event) => {
    if (mcpConnected) {
      await mcpShutdown();
      mcpConnected = false;
    }
  });

  // ── /sketch-reconnect ──────────────────────────────────────────────
  pi.registerCommand("sketch-reconnect", {
    description: "Reconnect to Sketch MCP server and refresh tools",
    handler: async (_args, ctx) => {
      mcpConnected = false;
      resetRequestId();
      clearGuideCache();

      const previousCount = registeredToolNames.size;
      registeredToolNames = new Set();

      ctx.ui.notify("Reconnecting to Sketch MCP server...", "info");

      try {
        const count = await discoverAndRegisterTools(pi);
        mcpConnected = true;

        // Re-preload guides
        preloadEssentialGuides().catch(() => {});

        ctx.ui.notify(
          `Sketch MCP reconnected — ${count} tools available (was ${previousCount})`,
          "info",
        );
      } catch (err) {
        mcpConnected = false;
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Sketch MCP reconnection failed: ${message}`, "error");
      }
    },
  });

  // ── /sketch-status ─────────────────────────────────────────────────
  pi.registerCommand("sketch-status", {
    description: "Show Sketch MCP connection status",
    handler: async (_args, ctx) => {
      if (mcpConnected) {
        ctx.ui.notify(
          `Sketch MCP: connected (${registeredToolNames.size} tools) → ${getMcpUrl()}`,
          "info",
        );
      } else {
        ctx.ui.notify(
          `Sketch MCP: not connected.\n\n` +
            `Server URL: ${getMcpUrl()}\n` +
            `To connect: Start Sketch, then press ⌘K → "Start MCP Server", then run /sketch-reconnect`,
          "warning",
        );
      }
    },
  });

  // ── /sketch-guide — fetch a guide topic on demand ──────────────────
  const guideTopics = [
    "mcp", "troubleshooting", "use", "layout",
    "styling", "symbols", "assets", "prototyping",
  ];

  pi.registerCommand("sketch-guide", {
    description: `Fetch a Sketch MCP guide topic. Topics: ${guideTopics.join(", ")}`,
    handler: async (args, ctx) => {
      const topic = args?.trim() || "mcp";

      if (!guideTopics.includes(topic)) {
        ctx.ui.notify(
          `Unknown topic "${topic}". Valid topics: ${guideTopics.join(", ")}`,
          "warning",
        );
        return;
      }

      ctx.ui.notify(`Fetching guide topic: ${topic}...`, "info");

      try {
        const content = await fetchGuide(topic);
        ctx.ui.notify(
          `Guide "${topic}" loaded (${content.length} chars). Available in context.`,
          "info",
        );
        console.log(`\n── Sketch MCP Guide: ${topic} ──\n${content}\n── End Guide: ${topic} ──\n`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to fetch guide "${topic}": ${message}`, "error");
      }
    },
  });

  // ── /sketch-tools — list all registered Sketch tools ───────────────
  pi.registerCommand("sketch-tools", {
    description: "List all registered Sketch MCP tools with descriptions",
    handler: async (_args, ctx) => {
      if (registeredToolNames.size === 0) {
        ctx.ui.notify("No Sketch MCP tools registered. Is the server connected?", "warning");
        return;
      }

      const tools = Array.from(registeredToolNames).sort();
      const lines = tools.map((t) => `  • ${t}`);

      ctx.ui.notify(
        `Sketch MCP Tools (${tools.length}):\n${lines.join("\n")}`,
        "info",
      );
    },
  });
}
