# Sketch MCP Bridge for Pi

Bridge extension that connects [Pi](https://github.com/earendil-works/pi) — a lightweight AI coding agent harness — to the [Sketch](https://www.sketch.com/) MCP Server, enabling AI-assisted design workflows directly from your terminal.

When active, your Pi agent gains access to the full Sketch document model: it can read layer hierarchies, export assets, capture screenshots, execute SketchAPI scripts, and more — all through dynamically discovered MCP tools.

## Prerequisites

- **Sketch 2025.2.4 or later** (macOS direct download — not the Mac App Store version)
- **Pi** (the AI coding agent harness)
- **MCP Server started** in Sketch: press `⌘K`, type "MCP", and choose **Start MCP Server**

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/dadaxsoftware/sketch-mcp.git ~/.pi/agent/extensions/sketch-mcp
```

### 2. Or copy the extension file directly

```bash
mkdir -p ~/.pi/agent/extensions
cp sketch-mcp.ts ~/.pi/agent/extensions/
```

### 3. Restart Pi

The extension is auto-discovered from `~/.pi/agent/extensions/`. No additional configuration needed.

## Available Tools

On session start, the extension discovers and registers all tools exposed by the Sketch MCP Server. Each tool is prefixed with `sketch_`:

| Pi Tool | Description |
|---|---|
| `sketch_get_document_info` | Structured overview of the open document: ID, filename, pages, layer counts, top-level frame names and dimensions |
| `sketch_get_layer_tree_summary` | Readable text hierarchy of layers — types, IDs, positions, dimensions, stack layouts, text content, override counts |
| `sketch_get_design_assets` | Design assets from the current document: symbols, text styles, layer styles, color swatches, frame templates, graphic templates |
| `sketch_get_screenshot` | Screenshot of a specific layer or the current canvas state |
| `sketch_get_libraries` | Information about libraries linked to the current document |
| `sketch_get_symbol_overrides` | Override properties for a given symbol instance — what can be customized without detaching |
| `sketch_get_guide` | Sketch's built-in reference guides on specific topics |
| `sketch_run_code` | Execute arbitrary JavaScript via the [SketchAPI](https://developer.sketch.com/reference/api/) — full plugin-level control |

## Commands

| Command | Description |
|---|---|
| `/sketch-status` | Show whether the Sketch MCP server is connected and how many tools are registered |
| `/sketch-reconnect` | Force a reconnection and re-discover all tools from the MCP server |

## Usage Examples

Once connected, you can prompt your Pi agent with natural language:

```
> Export all "icon/" symbols from the current Sketch page as SVG to my Desktop

> Find inconsistencies in the design system on the selected frame

> Get the complete layer tree of the current document

> Create a vertical stack of four rectangles and apply unique gradients to each

> Fix grammar and spelling mistakes on all text layers in the selected frame

> Generate React component code from the selected Sketch frame
```

### Referring to Specific Layers

You can copy a layer's unique ID in Sketch via **Command Bar → Copy Layer ID** (or use the context menu when the MCP server is running), then paste it into your prompt.

## How It Works

```
┌──────────────┐     HTTP JSON-RPC     ┌───────────────────┐
│              │◄──────────────────────►│                   │
│  Pi Agent    │     (localhost:31126)  │  Sketch MCP       │
│  + Extension │                        │  Server (built-in)│
│              │                        │                   │
└──────────────┘                        └───────────────────┘

1. Extension starts on session_start
2. Sends MCP "initialize" request
3. Calls "tools/list" to discover available Sketch tools
4. Converts JSON Schema → TypeBox for each tool's parameters
5. Registers each tool as a native Pi tool (sketch_*)
6. AI can call these tools; extension forwards via "tools/call"
```

The extension transforms the MCP JSON-RPC protocol (HTTP transport) into Pi's native tool system, so the AI agent doesn't need to know about MCP — it just sees a set of Sketch-specific tools available for use.

## Troubleshooting

### Extension can't connect

1. Verify Sketch is running and the MCP server is started (`⌘K → "Start MCP Server"`)
2. Check **System Settings → Privacy & Security → Local Network** — Sketch must be enabled
3. Run `/sketch-reconnect` in Pi to retry the connection
4. Run `/sketch-status` to check the current connection state

### Port conflicts

If you need to change the MCP server port, quit Sketch and run:

```bash
defaults write com.bohemiancoding.sketch3 mcpServerPortNumber -int 1234
```

Then update the `DEFAULT_MCP_URL` constant in `sketch-mcp.ts` to match.

### "Sketch 2025.2.4 or later required"

The MCP Server is not available in the Mac App Store version. Download the latest version from [sketch.com](https://www.sketch.com/releases/mac/).

## Security

- The Sketch MCP server is **local-only** (127.0.0.1); it cannot be accessed remotely
- The server is **off by default** in Sketch
- This extension only connects to localhost and makes no outbound requests
- No data leaves your machine

## License

[MIT](https://github.com/dadaxsoftware/sketch-mcp/blob/main/LICENSE)
