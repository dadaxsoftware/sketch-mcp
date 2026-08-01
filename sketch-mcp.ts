/**
 * sketch-mcp.ts — Backward-compatible entry point.
 *
 * For users who installed v1.x by copying sketch-mcp.ts directly to
 * ~/.pi/agent/extensions/, this file re-exports from the new v2.0 src/.
 *
 * New installations should use the directory-based extension with
 * package.json → src/index.ts (auto-discovery).
 *
 * Migration: replace your flat sketch-mcp.ts with the full directory.
 *   git clone https://github.com/dadaxsoftware/sketch-mcp.git ~/.pi/agent/extensions/sketch-mcp
 */

export { default } from "./src/index";
