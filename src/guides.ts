/**
 * guides.ts — Guide preloading, caching, and prompt injection.
 *
 * The Sketch MCP Server requires loading `get_guide` topic `mcp` before any
 * other tool call. This module:
 * - Preloads the core `mcp` guide on session start
 * - Caches guide content with TTL
 * - Builds a system prompt snippet with Sketch MCP best practices
 * - Provides topic-specific guidance on demand
 */

import { mcpCall } from "./mcp-client";

// ── Types ─────────────────────────────────────────────────────────────────

export interface GuideCache {
  content: string;
  fetchedAt: number;
}

export interface MCPGuideTopics {
  /** General MCP operation, prerequisites, target resolution, safe run_code, screenshots, completion rules. */
  mcp: string;
  /** Troubleshooting: connection failures, stale document IDs, empty run_code output, etc. */
  troubleshooting: string;
  /** General Sketch document work: inspect before mutating, reuse libraries/assets, create/place layers. */
  use: string;
  /** Layout, stacks, flex layout, page placement, sizing, pins, wrapping, reordering. */
  layout: string;
  /** Styling: swatches, shared styles, fills, borders, corners, blurs, masks, typography, tint. */
  styling: string;
  /** Symbols/components, overrides, nested symbols, library symbols, image overrides. */
  symbols: string;
  /** Assets, export, screenshots vs exports, images, SVG import, image layers. */
  assets: string;
  /** Prototyping, flow connections, HotSpots, start points, prototype graph probing. */
  prototyping: string;
}

// ── State ────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const guideCache = new Map<string, GuideCache>();

// ── Core API ─────────────────────────────────────────────────────────────

/**
 * Fetch a guide topic from the Sketch MCP server, with caching.
 * Returns Markdown content. Throws on failure.
 */
export async function fetchGuide(topic: string): Promise<string> {
  const cached = guideCache.get(topic);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.content;
  }

  const result = await mcpCall("tools/call", {
    name: "get_guide",
    arguments: topic ? { topic } : {},
  });

  const content = extractGuideText(result.result as Record<string, unknown> | undefined);
  guideCache.set(topic, { content, fetchedAt: Date.now() });
  return content;
}

/**
 * Preload the essential guides on session start.
 * Returns the `mcp` guide content and preloads `troubleshooting` in background.
 */
export async function preloadEssentialGuides(): Promise<{ mcpGuide: string }> {
  const mcpGuide = await fetchGuide("mcp");
  // Preload troubleshooting in background (non-blocking)
  fetchGuide("troubleshooting").catch(() => {});
  return { mcpGuide };
}

/**
 * Clear all cached guides (used on reconnect).
 */
export function clearGuideCache(): void {
  guideCache.clear();
}

// ── Prompt Building ──────────────────────────────────────────────────────

/**
 * Build a compact "Sketch MCP Best Practices" snippet for injection into the
 * system prompt. Distills the critical rules from the `mcp` and `use` guides
 * so the AI doesn't need to load them on every turn.
 *
 * Designed to be appended via `before_agent_start` systemPrompt chaining.
 */
export function buildSketchMcpPromptSnippet(): string {
  return `\n## Sketch MCP Design Tools — Best Practices

You have access to Sketch design tools (prefixed \`sketch_\`). Follow these rules:

### Before Any Sketch Tool Call
1. If you haven't loaded the \`mcp\` guide this session, call \`sketch_get_guide\` with topic \`mcp\` first.
2. Always call at least \`sketch_get_document_info\` to understand the document structure before making changes.

### For Read-Only Operations (inspection, export, analysis)
- Use \`sketch_get_document_info\` for document overview.
- Use \`sketch_get_layer_tree_summary\` for layer hierarchy (depth 1-10).
- Use \`sketch_get_screenshot\` to visually inspect layers — the image is shown to you.
- Use \`sketch_get_design_assets\` for symbols, styles, swatches (kind: symbol|textStyle|layerStyle|swatch|frameTemplate|graphicTemplate).
- Use \`sketch_get_libraries\` and \`sketch_get_symbol_overrides\` for component work.

### For Content-Modifying Operations (via sketch_run_code)
- Call \`sketch_get_guide\` topic \`use\` before your first \`sketch_run_code\` call.
- For layout work, also load topic \`layout\`; for styling, topic \`styling\`; for symbols, topic \`symbols\`.
- Every script MUST start with \`const sketch = require('sketch')\`.
- Use only the public Sketch JavaScript API.
- Keep scripts small and flat — one focused action per call.
- Do NOT include comments inside submitted scripts.
- Report results with \`console.log(JSON.stringify({ ok: true, ... }))\`.
- Re-resolve document, selection, and target layers in every script.
- For layer images, use \`sketch_get_screenshot\`; for file exports, follow the \`assets\` guide.

### On Failure
- If \`sketch_run_code\` fails, load \`sketch_get_guide\` topic \`troubleshooting\` before retrying.
- Common causes: missing \`require('sketch')\`, stale references, wrong API usage.

### Completion
- After making changes, use \`sketch_get_screenshot\` to verify the result visually.
- Report what was done and any IDs/names of created or modified layers.`;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function extractGuideText(result: Record<string, unknown> | undefined): string {
  const content = result?.content as Array<{ type: string; text?: string }> | undefined;
  if (!content || !Array.isArray(content)) {
    return JSON.stringify(result, null, 2);
  }

  const textParts: string[] = [];
  for (const item of content) {
    if (item.type === "text" && item.text) {
      textParts.push(item.text);
    }
  }
  return textParts.join("\n") || "(empty guide)";
}
