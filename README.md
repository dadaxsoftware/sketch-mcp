# Sketch MCP Bridge for Pi

Bridge extension connecting [Pi](https://github.com/earendil-works/pi) — the AI coding agent harness — to the built-in [Sketch](https://www.sketch.com/) MCP Server, enabling AI-assisted design workflows from your terminal.

**v2.0** introduces guide-aware prompting, smart `run_code` pre-flight checks, connection health monitoring, and enriched tool descriptions — all built on a modular multi-file architecture.

## What's New in v2.0

| Feature | Description |
|---|---|
| **Guide-Aware Prompting** | Auto-injects Sketch MCP best practices into the system prompt via `before_agent_start`. AI knows to load guides before making tool calls. |
| **Smart run_code** | Enriched tool descriptions remind AI about `require('sketch')`, no-comments rule, and `console.log` result reporting. Auto-suggests loading `troubleshooting` guide on failure. |
| **Guide Preloading** | `mcp` and `troubleshooting` guides are preloaded on session start and cached (30min TTL). |
| **Enriched Tool Meta** | Each tool gets a detailed description with parameter hints, known value sets (e.g., `kind: symbol|textStyle|layerStyle|swatch|frameTemplate|graphicTemplate`), and prerequisite guides. |
| **New Commands** | `/sketch-guide [topic]` — fetch any guide on demand. `/sketch-tools` — list all registered Sketch tools. |
| **Modular Architecture** | `src/mcp-client.ts`, `src/schema.ts`, `src/guides.ts`, `src/index.ts` — clean separation of concerns. |

## Prerequisites

- **Sketch 2025.2.4 or later** (macOS direct download — not the Mac App Store version)
- **Pi** (the AI coding agent harness)
- **MCP Server started** in Sketch: press `⌘K`, type "MCP", and choose **Start MCP Server**

## Installation

### As a Pi Extension (auto-discovery)

```bash
# Clone to global extensions directory
git clone https://github.com/dadaxsoftware/sketch-mcp.git ~/.pi/agent/extensions/sketch-mcp
```

Or copy the `src/` directory and `package.json` to any extension location:

```bash
mkdir -p ~/.pi/agent/extensions/sketch-mcp
cp -r src/ package.json ~/.pi/agent/extensions/sketch-mcp/
```

### Quick Test (no install)

```bash
pi -e ./src/index.ts
```

### Configuration

By default, the extension connects to `http://localhost:31126/mcp`. Override via environment variable:

```bash
export SKETCH_MCP_URL=http://localhost:1234/mcp
```

## Architecture

```
┌──────────────────┐                         ┌───────────────────────┐
│                  │  HTTP JSON-RPC           │                       │
│  Pi Agent        │◄────────────────────────►│  Sketch MCP Server    │
│  + Extensions    │  (localhost:31126)       │  (built into Sketch)  │
│                  │                         │                       │
└──────────────────┘                         └───────────────────────┘
        │
        │ pi hooks
        ▼
┌──────────────────────────────────────────────────────────────┐
│  sketch-mcp extension (src/)                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │ mcp-client.ts│  │  schema.ts   │  │   guides.ts        │  │
│  │ JSON-RPC     │  │ JSON Schema  │  │ Guide preloading   │  │
│  │ transport    │  │ → TypeBox    │  │ System prompt      │  │
│  │ content ext. │  │ + enrichment │  │ snippet builder    │  │
│  └──────────────┘  └──────────────┘  └────────────────────┘  │
│                          │                                    │
│                   index.ts (entry)                            │
│                   Tool registration + Lifecycle hooks         │
└──────────────────────────────────────────────────────────────┘
```

### How It Works

1. **session_start** — Initializes MCP handshake, discovers tools via `tools/list`, registers each as a native pi tool (`sketch_*`), preloads essential guides.
2. **before_agent_start** — Injects "Sketch MCP Best Practices" snippet into the system prompt, teaching the AI proper tool usage without repeated guide calls.
3. **Tool calls** — Forwarded to `tools/call` on the MCP server. Image content (screenshots) is passed through so the LLM can visually analyze designs.
4. **session_shutdown** — Graceful MCP session teardown.

## Available Tools

All tools are prefixed with `sketch_`. They are auto-discovered from the MCP server on connect.

| Tool | Description |
|---|---|
| `sketch_get_guide` | **PREREQUISITE** — Load MCP usage guides. Topics: `mcp`, `troubleshooting`, `use`, `layout`, `styling`, `symbols`, `assets`, `prototyping` |
| `sketch_get_document_info` | Document overview: filename, pages, layer counts, top-level frames |
| `sketch_get_layer_tree_summary` | Layer hierarchy with types, IDs, positions, dimensions, text, stack layouts |
| `sketch_get_design_assets` | Design assets: symbols, text styles, layer styles, swatches, templates |
| `sketch_get_screenshot` | PNG screenshot of a layer or selection (AI can see the image) |
| `sketch_get_libraries` | Linked library information |
| `sketch_get_symbol_overrides` | Editable override properties on a symbol instance |
| `sketch_run_code` | Execute SketchAPI JavaScript — full plugin-level control |

## Commands

| Command | Description |
|---|---|
| `/sketch-status` | Show connection state and server URL |
| `/sketch-reconnect` | Force reconnection and tool re-discovery |
| `/sketch-guide [topic]` | Fetch a guide topic (mcp, troubleshooting, use, layout, styling, symbols, assets, prototyping) |
| `/sketch-tools` | List all registered Sketch MCP tools |

## Usage Examples

Once connected, prompt your Pi agent naturally:

```
> Export all "icon/" symbols from the current Sketch page as SVG to my Desktop

> Find inconsistencies in the design system on the selected frame

> Get the complete layer tree of the current document

> Create a vertical stack of four rectangles with unique gradients each

> Fix grammar and spelling mistakes on all text layers in the selected frame

> Generate React component code from the selected Sketch frame
```

### Referring to Specific Layers

In Sketch, open the **Command Bar (`⌘K`) → Copy Layer ID** (or use the context menu when MCP server is running), then paste the ID into your prompt.

## Troubleshooting

### Extension can't connect

1. Verify Sketch is running and MCP server is started (`⌘K → "Start MCP Server"`)
2. Check **System Settings → Privacy & Security → Local Network** — Sketch must be allowed
3. Run `/sketch-reconnect` in Pi to retry
4. Run `/sketch-status` to check the current state

### Port conflicts

Change the MCP server port:

```bash
defaults write com.bohemiancoding.sketch3 mcpServerPortNumber -int 1234
export SKETCH_MCP_URL=http://localhost:1234/mcp
```

### "Sketch 2025.2.4 or later required"

The MCP Server is not available in the Mac App Store version. Download from [sketch.com](https://www.sketch.com/releases/mac/).

## Security

- The Sketch MCP server is **local-only** (127.0.0.1); no remote access
- The server is **off by default** in Sketch
- This extension only connects to localhost; no outbound requests
- No data leaves your machine

## License

[MIT](https://github.com/dadaxsoftware/sketch-mcp/blob/main/LICENSE)
