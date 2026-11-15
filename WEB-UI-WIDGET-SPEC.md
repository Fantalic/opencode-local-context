# Web UI Widget Spec — `local-context` Compression Debugger

> **DEBUG TOOL ONLY — not for production.** Embeddable standalone HTML file that
> visualises the folding / compression mechanism in the `local-context` plugin.

---

## 1. Purpose & Overview

The `local-context` plugin (in `local-context.ts`) compresses conversation
context by **folding** older messages into archived chunks and keeping only a
protected tail of recent messages in the context window. This widget helps the
developer **inspect** what actually gets folded, what the context window looks
like before and after, and the contents of archived chunks.

### What the widget shows

| Panel | Content |
|---|---|
| **Compression Timeline** | When each fold happened, token counts before / after, number of messages folded |
| **Diff View** | Before vs. after context window — which messages were in full context vs. folded context |
| **Prompt Inspection** | The actual prompt sent to the model (after folding) with syntax highlighting |
| **Chunk Archive** | Browse archived chunks, see their keywords, view their content |

### Architecture decision: HTTP endpoint (not WebSocket)

The plugin is a Node.js opencode V2 plugin running inside the opencode server
process. Adding a WebSocket would require a separate server loop. A simple
**local HTTP server on a dedicated port** is the most pragmatic approach:

- Zero extra dependencies (only `node:http` is needed)
- The server is started/stopped via an **env var** (`OPENCODE_CTX_DEBUG_HTTP=1`)
- The widget is a **single static HTML file** that `fetch()`s the JSON API
- CORS is restricted to `localhost` only

---

## 2. API Specification

All endpoints live under the path prefix `/api/local-context` on the debug
server. The server binds to `127.0.0.1:8765` (configurable via
`OPENCODE_CTX_DEBUG_PORT`).

### 2.1 `GET /api/local-context/state`

Returns the full state of all sessions managed by the plugin.

**Request:**

```
GET /api/local-context/state
```

**Response (200 OK):**

```json
{
  "sessions": [
    {
      "id": "ses123abc",
      "todo": [
        { "text": "Refactor module X", "done": true, "reason": "..." }
      ],
      "log": [
        {
          "t": "14:32",
          "text": "Refactor module X",
          "reason": "Because it is broken",
          "keywords": ["refactor", "module-x", "bug"]
        }
      ],
      "summaries": [
        {
          "text": "Refactor module X; debug auth flow",
          "keywords": ["refactor", "module-x", "auth", "debug"]
        }
      ],
      "index": [
        {
          "keywords": ["refactor", "module-x", "bug", "plugin", "context"],
          "step": "Refactor module X",
          "stepKeywords": ["refactor", "module-x"],
          "t": "14:32",
          "chunkKey": "lc:ses123abc:chunk:0"
        }
      ],
      "originalTask": "Create a web UI widget spec...",
      "folded": true,
      "pendingFold": false,
      "chunkCount": 1
    }
  ],
  "compression": [
    {
      "sessionID": "ses123abc",
      "timestamp": "2026-11-14T14:32:00.000Z",
      "tokensBefore": 28000,
      "tokensAfter": 16500,
      "messagesFolded": 7,
      "messagesKept": 4,
      "chunkKey": "lc:ses123abc:chunk:0",
      "chunkChars": 12400,
      "chunkTokens": 3100,
      "protectedTailTokens": 16500,
      "foldedTextsPreview": "First 500 chars of folded content…"
    }
  ]
}
```

**Field glossary:**

| Field | Type | Description |
|---|---|---|
| `sessionID` | string | The opencode session ID |
| `timestamp` | ISO 8601 | When the fold occurred |
| `tokensBefore` | int | Estimated token count before folding |
| `tokensAfter` | int | Estimated token count after folding |
| `messagesFolded` | int | Number of messages removed |
| `messagesKept` | int | Number of messages retained |
| `chunkKey` | string | Storage key for the archived chunk |
| `chunkChars` | int | Character count of the archived chunk |
| `chunkTokens` | int | Estimated token count of the chunk |
| `protectedTailTokens` | int | Token count of the protected tail (from `accTokens` in the plugin) |
| `foldedTextsPreview` | string | First 500 characters of the folded content for quick inspection |

### 2.2 `GET /api/local-context/chunk?key=<chunkKey>`

Returns the full content and metadata of a single archived chunk.

**Request:**

```
GET /api/local-context/chunk?key=lc:ses123abc:chunk:0
```

**Response (200 OK):**

```json
{
  "key": "lc:ses123abc:chunk:0",
  "content": "Full text of the archived chunk...",
  "keywords": ["refactor", "module-x", "bug", "plugin", "context"],
  "step": "Refactor module X",
  "stepKeywords": ["refactor", "module-x"],
  "t": "14:32"
}
```

**Response (404 Not Found):**

```json
{ "error": "Chunk not found: lc:ses123abc:chunk:0" }
```

### 2.3 `POST /api/local-context/debug`

Triggers a debug replay: reconstructs both the full and folded context for a
session by simulating the fold logic. Useful for comparing against live state.

**Request:**

```json
POST /api/local-context/debug
{
  "sessionID": "ses123abc",
  "showFullContext": true
}
```

**Response (200 OK):**

```json
{
  "sessionID": "ses123abc",
  "fullContext": [
    { "role": "user", "content": "Create a web UI widget...", "tokens": 120 },
    { "role": "assistant", "content": "Here is the spec...", "tokens": 3400 },
    { "role": "user", "content": "Add diff view support", "tokens": 80 },
    { "role": "assistant", "content": "OK, I'll add...", "tokens": 2800 },
    { "role": "user", "content": "Add prompt inspection", "tokens": 70 },
    { "role": "assistant", "content": "Done. Here is...", "tokens": 4200 },
    { "role": "user", "content": "Add chunk archive", "tokens": 60 },
    { "role": "assistant", "content": "Here is the...", "tokens": 3100 }
  ],
  "foldedContext": [
    { "role": "user", "content": "Create a web UI widget...", "tokens": 120 },
    {
      "role": "user",
      "content": "[CONTEXT STEP LOG]\n\n[14:32] Refactor module X\n    Reason: Because it is broken\n\n[SUMMARIES]\nRefactor module X; debug auth flow",
      "tokens": 400
    },
    { "role": "user", "content": "Add chunk archive", "tokens": 60 },
    { "role": "assistant", "content": "Here is the...", "tokens": 3100 }
  ],
  "compressionMetrics": {
    "originalTokenCount": 15870,
    "compressedTokenCount": 3560,
    "reductionPercent": 77.6,
    "messagesRemoved": 4,
    "messagesRetained": 4,
    "foldedChunks": [
      {
        "chunkKey": "lc:ses123abc:chunk:0",
        "tokens": 3100,
        "chars": 12400,
        "messagesFolded": 4
      }
    ]
  }
}
```

### 2.4 `GET /api/local-context/config`

Returns the current plugin configuration (read from env vars).

**Response (200 OK):**

```json
{
  "PROTECTED_TOKENS": 16000,
  "CAP_CHARS": 9000,
  "AGE_BATCH": 10,
  "ONELINER_KEEP": 6,
  "LOOKUP_TIMEOUT_MS": 60000,
  "CHUNK_MAX_CHARS": 40000,
  "POLY_URL": "http://127.0.0.1:8095",
  "POLY_MODEL": "qwen3.6-35b-a3b-ud-q3_k_m"
}
```

---

## 3. Widget UI Design

### 3.1 Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  Local Context Debugger  │  Session: ses123abc  [▼ dropdown]  [Refresh]  │
├──────────────────────────┼──────────────────────────────────────────┤
│  COMPRESSION TIMELINE    │  DIFF VIEW                               │
│  ┌────────────────────┐ │  ┌──────────────┐  ┌──────────────────┐ │
│  │ ● 14:32  28k→16.5k │ │  │ Full Context │  │ Folded Context  │ │
│  │   7 msgs folded    │ │  │ ─────────────│  │ ──────────────── │ │
│  ├────────────────────┤ │  │ user: Create │  │ user: Create    │ │
│  │ ○ 11:05  35k→18k   │ │  │ assistant: ..│  │ [STEP LOG]      │ │
│  │   12 msgs folded   │ │  │ user: Add diff│  │ user: Add chunk│ │
│  │                     │ │  │ assistant: ..│  │ assistant: ..   │ │
│  └────────────────────┘ │  │ ...          │  │ ...             │ │
│                          │  │ [12 msgs]    │  │ [4 msgs]        │ │
│                          │  └──────────────┘  └──────────────────┘ │
├──────────────────────────┼──────────────────────────────────────────┤
│  PROMPT INSPECTION       │  CHUNK ARCHIVE                           │
│  ┌────────────────────┐ │  ┌────────────────────────────────────┐ │
│  │ ```                │ │  │ chunk:0 │ chunk:1 │ chunk:2 │ ...  │ │
│  │ [CONTEXT STEP LOG] │ │  ├────────────────────────────────────┤ │
│  │                    │ │  │ [chunk content viewer]             │ │
│  │ [14:32] Refactor.. │ │  │                                    │ │
│  │     Reason: ...    │ │  │ Keywords: refactor, module-x ...   │ │
│  │                    │ │  │ Step: Refactor module X            │ │
│  │ [SUMMARIES]        │ │  │ Time: 14:32                        │ │
│  │ Refactor module X; │ │  │                                    │ │
│  │ debug auth flow    │ │  │ [Full text with scroll]            │ │
│  │                    │ │  │                                    │ │
│  │ Protected tail:    │ │  │ [View Full]                        │ │
│  │ user: Add chunk..  │ │  └────────────────────────────────────┘ │
│  │ assistant: Here..  │ │                                        │
│  │ ```                │ │  [Back to list]                        │
│  └────────────────────┘ │                                        │
└──────────────────────────┴──────────────────────────────────────────┘
```

### 3.2 Components

#### 3.2.1 Session Selector (top bar)

- Dropdown listing all session IDs from `/api/local-context/state`
- **Refresh** button re-fetches state
- Shows current session ID in a badge

#### 3.2.2 Compression Timeline

- Vertical list of fold events, newest first
- Each entry shows:
  - Timestamp (ISO or human-readable)
  - Token reduction: `28k → 16.5k` (green arrow for reduction)
  - Message count: `7 msgs folded`
  - Clicking an entry expands to show folded text preview (collapsible)
- Visual indicator: filled circle `●` for known folds, hollow `○` for suspected but unrecorded

#### 3.2.3 Diff View

- Two side-by-side panels:
  - **Left**: Full context (reconstructed via `POST /api/local-context/debug`)
  - **Right**: Folded context (the actual prompt sent to the model)
- Messages are shown in a compact list: `role: first 120 chars of content...`
- Token count shown per message in parentheses
- Folded messages are crossed out or shown as `[ARCHIVED → chunk:0]`
- Summary statistics at the bottom:
  - Original token count
  - Compressed token count
  - Reduction percentage (green bar)
  - Messages removed / retained

#### 3.2.4 Prompt Inspection

- Shows the **actual prompt** sent to the model after folding
- Syntax highlighting (simple, no external libs — basic CSS classes):
  - `user` messages: blue background
  - `assistant` messages: green background
  - `[CONTEXT STEP LOG]` section: yellow/gold background
  - `[SUMMARIES]` section: light purple background
- Copy-to-clipboard button
- Token count estimate (character count / 4)

#### 3.2.5 Chunk Archive

- Horizontal scrollable list of chunk tabs: `chunk:0 | chunk:1 | chunk:2 | ...`
- Each tab shows: step text, keywords (as tags), timestamp
- Clicking a tab loads the chunk content via `GET /api/local-context/chunk?key=...`
- Content viewer:
  - Full text in a scrollable `<pre>` block
  - Keywords displayed as tags above the content
  - Step text and timestamp shown as metadata
  - "View Full" expands to show the complete content (no char cap)

### 3.3 Data Flow

```
Widget HTML (browser)
       │
       │ GET /api/local-context/state
       ▼
┌─────────────────┐
│  Debug Server   │──► Reads from plugin's ctx.storage
│  (node:http)    │
└─────────────────┘
       │
       │ GET /api/local-context/chunk?key=...
       ▼
┌─────────────────┐
│  Chunk Content  │──► Reads from ctx.storage chunk keys
└─────────────────┘
```

### 3.4 Styling

- Single self-contained HTML file with inline CSS
- No external dependencies (no CDN, no frameworks)
- Dark theme by default (developer tool aesthetic)
- Monospace font for code/content areas
- Responsive layout (flexbox, no grid)
- Minimal JavaScript (vanilla `fetch` + DOM manipulation)

---

## 4. Integration Instructions

### 4.1 How to enable / disable

The debug HTTP server is controlled by an **environment variable**:

```
OPENCODE_CTX_DEBUG_HTTP=1   # Enable the debug server
OPENCODE_CTX_DEBUG_HTTP=    # Disable (default)
```

When enabled, the plugin starts an HTTP server on port `8765` (configurable
via `OPENCODE_CTX_DEBUG_PORT`). The server is created in the plugin's
`setup()` function and runs for the lifetime of the session.

**To disable:** unset the env var or set it to `0`. No restart needed if you
only need to toggle the server — the server checks the env var on each request
or can be restarted by reloading the plugin.

### 4.2 Adding the debug server to the plugin

The debug server is added inside the plugin's `setup()` function, after all
other hooks. It uses only `node:http` (no npm dependencies):

```typescript
// Pseudo-code for integration (NOT the actual implementation)
if (process.env.OPENCODE_CTX_DEBUG_HTTP) {
  const http = require("node:http");
  const PORT = +(process.env.OPENCODE_CTX_DEBUG_PORT || 8765);

  const server = http.createServer(async (req, res) => {
    // CORS: only allow localhost
    res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:" + PORT);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const path = url.pathname;

    if (path === "/api/local-context/state") {
      // Gather all session states from ctx.storage
      // Return JSON with sessions[] and compression[]
    } else if (path === "/api/local-context/chunk") {
      const key = url.searchParams.get("key");
      // Load chunk from ctx.storage
    } else if (path === "/api/local-context/debug") {
      // Reconstruct full + folded context
    } else if (path === "/api/local-context/config") {
      // Return plugin config from env vars
    } else {
      res.writeHead(404);
      res.end('{"error":"not found"}');
    }
  });

  server.listen(PORT, "127.0.0.1", () => {
    sideLog("debug", `server listening on port ${PORT}`);
  });
}
```

The server reads state from the **same `ctx.storage`** that the plugin uses,
so it always reflects the live state. No additional hooks are needed.

### 4.3 Security considerations

This is a **debug tool** and should never be exposed to untrusted networks:

| Concern | Mitigation |
|---|---|
| **Network exposure** | Server binds to `127.0.0.1` only — not accessible from other machines |
| **No authentication** | Intentionally no auth — it's a local debug tool. The developer should only run it on a trusted machine. |
| **CORS** | Restricted to `http://127.0.0.1:<port>` (same origin). No wildcard `*`. |
| **Data leak** | The widget shows raw conversation content. The developer must accept this risk. |
| **Port conflict** | Configurable via `OPENCODE_CTX_DEBUG_PORT`. Default `8765` is unlikely to conflict. |
| **Server lifecycle** | The server is created once in `setup()`. It runs until the opencode process exits. |
| **Sensitive data** | All data shown is from sessions the developer already has access to. No new data is created. |

### 4.4 Widget deployment

The widget is a **single HTML file**. Two options:

1. **Embedded in the widget**: Open the HTML file directly in a browser (`file://`).
   This requires the debug server to allow `file://` origin via CORS (add a
   header check for `Origin` being empty).

2. **Hosted locally**: Serve the HTML file from any static server (e.g.,
   `python -m http.server 3000`) and point it at the debug server's API.

**Recommended**: Option 1 for simplicity. The widget handles the `file://` case.

---

## 5. Example Widget Code

The following is a **minimal working example** — a single HTML file that
connects to the debug API and displays all four panels.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Local Context Debugger</title>
<style>
  /* ===== Base ===== */
  :root {
    --bg: #1a1a2e;
    --surface: #16213e;
    --surface2: #0f3460;
    --text: #e0e0e0;
    --text-dim: #888;
    --green: #4caf50;
    --blue: #2196f3;
    --yellow: #ffc107;
    --purple: #9c27b0;
    --red: #f44336;
    --border: #333;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', Consolas, monospace;
    background: var(--bg);
    color: var(--text);
    font-size: 13px;
    line-height: 1.4;
  }
  a { color: var(--blue); }

  /* ===== Header ===== */
  #header {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 10px 16px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  #header h1 { font-size: 15px; font-weight: 600; }
  #header select, #header button {
    background: var(--surface2);
    color: var(--text);
    border: 1px solid var(--border);
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
  }
  #header button:hover { background: var(--border); }
  .badge {
    background: var(--surface2);
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 12px;
    font-family: monospace;
  }

  /* ===== Grid layout ===== */
  #main {
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr 1fr;
    gap: 1px;
    background: var(--border);
    height: calc(100vh - 44px);
  }
  .panel {
    background: var(--bg);
    padding: 12px;
    overflow: auto;
  }
  .panel h2 {
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-dim);
    margin-bottom: 8px;
    border-bottom: 1px solid var(--border);
    padding-bottom: 4px;
  }

  /* ===== Compression Timeline ===== */
  .timeline-entry {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
  }
  .timeline-entry:hover { background: var(--surface); }
  .timeline-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-top: 4px;
    flex-shrink: 0;
  }
  .timeline-dot.known { background: var(--green); }
  .timeline-dot.suspected { background: var(--yellow); }
  .timeline-info { flex: 1; }
  .timeline-info .tokens {
    color: var(--green);
    font-weight: 600;
  }
  .timeline-info .folded-count { color: var(--text-dim); }
  .timeline-detail {
    display: none;
    background: var(--surface);
    padding: 6px 8px;
    border-radius: 4px;
    margin-top: 4px;
    font-family: monospace;
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .timeline-entry.expanded .timeline-detail { display: block; }

  /* ===== Diff View ===== */
  .diff-columns {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .diff-col {
    background: var(--surface);
    border-radius: 4px;
    padding: 8px;
  }
  .diff-col h3 {
    font-size: 12px;
    margin-bottom: 6px;
    color: var(--text-dim);
  }
  .diff-msg {
    padding: 3px 0;
    font-size: 12px;
    border-bottom: 1px solid rgba(255,255,255,0.05);
  }
  .diff-msg .role {
    font-weight: 600;
    margin-right: 4px;
  }
  .diff-msg.user .role { color: var(--blue); }
  .diff-msg.assistant .role { color: var(--green); }
  .diff-msg.folded {
    opacity: 0.5;
    text-decoration: line-through;
  }
  .diff-msg.archived {
    text-decoration: none;
    opacity: 1;
    color: var(--yellow);
  }
  .diff-stats {
    margin-top: 8px;
    padding: 6px;
    background: var(--surface2);
    border-radius: 4px;
    display: flex;
    gap: 16px;
    font-size: 12px;
  }
  .diff-stats .stat-value { font-weight: 600; }
  .diff-stats .stat-value.green { color: var(--green); }
  .diff-stats .stat-value.red { color: var(--red); }

  /* ===== Prompt Inspection ===== */
  .prompt-block {
    background: var(--surface);
    border-radius: 4px;
    padding: 8px;
    font-family: monospace;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-all;
    line-height: 1.5;
    max-height: 100%;
    overflow: auto;
  }
  .prompt-block .section-step-log { color: var(--yellow); }
  .prompt-block .section-summaries { color: var(--purple); }
  .prompt-block .section-tail { color: var(--green); }
  .prompt-meta {
    margin-top: 8px;
    font-size: 11px;
    color: var(--text-dim);
  }

  /* ===== Chunk Archive ===== */
  .chunk-tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 8px;
    overflow-x: auto;
    padding-bottom: 4px;
  }
  .chunk-tab {
    background: var(--surface);
    border: 1px solid var(--border);
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
    font-size: 12px;
  }
  .chunk-tab:hover { background: var(--surface2); }
  .chunk-tab.active {
    background: var(--surface2);
    border-color: var(--blue);
    color: var(--blue);
  }
  .chunk-keywords {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 8px;
  }
  .chunk-keyword {
    background: var(--surface2);
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 11px;
  }
  .chunk-content {
    background: var(--surface);
    border-radius: 4px;
    padding: 8px;
    font-family: monospace;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 400px;
    overflow: auto;
    line-height: 1.5;
  }
  .chunk-meta {
    font-size: 11px;
    color: var(--text-dim);
    margin-bottom: 8px;
  }

  /* ===== Misc ===== */
  .empty { color: var(--text-dim); font-style: italic; }
  .loading { color: var(--yellow); }
  .error { color: var(--red); }
  .copy-btn {
    position: absolute;
    top: 8px;
    right: 8px;
    background: var(--surface2);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 2px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
  }
  .copy-btn:hover { background: var(--border); }
  .panel { position: relative; }
</style>
</head>
<body>

<!-- ===== Header ===== -->
<div id="header">
  <h1>Local Context Debugger</h1>
  <select id="sessionSelect"><option value="">Loading sessions...</option></select>
  <span class="badge" id="sessionBadge">—</span>
  <button id="refreshBtn">Refresh</button>
  <span id="apiStatus" style="margin-left:auto;font-size:11px;color:var(--text-dim)"></span>
</div>

<!-- ===== Main Grid ===== -->
<div id="main">
  <div class="panel" id="timelinePanel">
    <h2>Compression Timeline</h2>
    <div id="timelineContent"><span class="empty">No compression events.</span></div>
  </div>

  <div class="panel" id="diffPanel">
    <h2>Diff View</h2>
    <div id="diffContent"><span class="empty">Select a session and refresh.</span></div>
  </div>

  <div class="panel" id="promptPanel">
    <h2>Prompt Inspection</h2>
    <button class="copy-btn" id="copyPromptBtn" title="Copy to clipboard">Copy</button>
    <div id="promptContent"><span class="empty">No prompt data.</span></div>
  </div>

  <div class="panel" id="chunkPanel">
    <h2>Chunk Archive</h2>
    <div id="chunkContent"><span class="empty">No chunks archived.</span></div>
  </div>
</div>

<!-- ===== JavaScript ===== -->
<script>
(function() {
  "use strict";

  // --- Config ---
  const API_BASE = "http://127.0.0.1:8765/api/local-context";

  // --- State ---
  let currentSession = null;
  let stateData = null;

  // --- DOM refs ---
  const $ = (sel) => document.querySelector(sel);
  const sessionSelect = $("#sessionSelect");
  const sessionBadge = $("#sessionBadge");
  const refreshBtn = $("#refreshBtn");
  const apiStatus = $("#apiStatus");
  const timelineContent = $("#timelineContent");
  const diffContent = $("#diffContent");
  const promptContent = $("#promptContent");
  const chunkContent = $("#chunkContent");
  const copyPromptBtn = $("#copyPromptBtn");

  // --- API helpers ---
  async function apiGet(path) {
    const res = await fetch(API_BASE + path);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  async function apiPost(path, body) {
    const res = await fetch(API_BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  // --- Render: Timeline ---
  function renderTimeline(compression) {
    if (!compression || compression.length === 0) {
      timelineContent.innerHTML = '<span class="empty">No compression events.</span>';
      return;
    }
    let html = "";
    for (const ev of compression) {
      const reduction = ev.tokensBefore > 0
        ? Math.round((1 - ev.tokensAfter / ev.tokensBefore) * 100)
        : 0;
      html += `
        <div class="timeline-entry" onclick="this.classList.toggle('expanded')">
          <div class="timeline-dot known"></div>
          <div class="timeline-info">
            <div>${ev.timestamp ? new Date(ev.timestamp).toLocaleString() : ev.timestamp}</div>
            <div class="tokens">${ev.tokensBefore} → ${ev.tokensAfter} tokens
              <span style="color:var(--green)">(${reduction}% reduction)</span></div>
            <div class="folded-count">${ev.messagesFolded} folded, ${ev.messagesKept} kept</div>
          </div>
        </div>
        <div class="timeline-detail">${escapeHtml(ev.foldedTextsPreview || "")}</div>
      `;
    }
    timelineContent.innerHTML = html;
  }

  // --- Render: Diff View ---
  async function renderDiff(sessionID) {
    diffContent.innerHTML = '<span class="loading">Loading diff...</span>';
    try {
      const data = await apiPost("/debug", { sessionID, showFullContext: true });
      if (!data.fullContext) {
        diffContent.innerHTML = '<span class="empty">No context data for this session.</span>';
        return;
      }
      const fc = data.fullContext;
      const foc = data.foldedContext;
      const metrics = data.compressionMetrics;

      // Build full context list
      let fullHtml = fc.map((m, i) => {
        const isFolded = m._archived;
        const cls = isFolded ? "diff-msg folded" : `diff-msg ${m.role}`;
        const preview = truncate(m.content, 100);
        const tokens = m.tokens || "?";
        return `<div class="${cls}"><span class="role">${m.role}</span> ${escapeHtml(preview)} <span style="color:var(--text-dim)">(${tokens}t)</span></div>`;
      }).join("");

      // Build folded context list
      let foldedHtml = foc.map((m) => {
        const preview = truncate(m.content, 100);
        const tokens = m.tokens || "?";
        return `<div class="diff-msg ${m.role}"><span class="role">${m.role}</span> ${escapeHtml(preview)} <span style="color:var(--text-dim)">(${tokens}t)</span></div>`;
      }).join("");

      const reduction = metrics
        ? Math.round((1 - metrics.compressedTokenCount / metrics.originalTokenCount) * 100)
        : 0;

      diffContent.innerHTML = `
        <div class="diff-columns">
          <div class="diff-col">
            <h3>Full Context (${fc.length} msgs, ${metrics ? metrics.originalTokenCount : "?"} tokens)</h3>
            ${fullHtml}
          </div>
          <div class="diff-col">
            <h3>Folded Context (${foc.length} msgs, ${metrics ? metrics.compressedTokenCount : "?"} tokens)</h3>
            ${foldedHtml}
          </div>
        </div>
        <div class="diff-stats">
          <span>Original: <span class="stat-value">${metrics ? metrics.originalTokenCount : "?"}</span></span>
          <span>Compressed: <span class="stat-value green">${metrics ? metrics.compressedTokenCount : "?"}</span></span>
          <span>Reduction: <span class="stat-value green">${reduction}%</span></span>
          <span>Removed: <span class="stat-value red">${metrics ? metrics.messagesRemoved : "?"}</span></span>
          <span>Retained: <span class="stat-value">${metrics ? metrics.messagesRetained : "?"}</span></span>
        </div>
      `;

      // Also render prompt panel from folded context
      renderPrompt(foc, metrics);
    } catch (err) {
      diffContent.innerHTML = `<span class="error">Error: ${escapeHtml(err.message)}</span>`;
    }
  }

  // --- Render: Prompt Inspection ---
  function renderPrompt(messages, metrics) {
    let html = "";
    for (const m of messages) {
      const content = m.content || "";
      let sectionClass = "section-tail";
      if (content.startsWith("[CONTEXT STEP LOG]")) sectionClass = "section-step-log";
      else if (content.startsWith("[SUMMARIES]")) sectionClass = "section-summaries";

      const labeled = content.split("\n").map((line) => {
        if (line.includes("[CONTEXT STEP LOG]")) return `<span class="section-step-log">${escapeHtml(line)}</span>`;
        if (line.includes("[SUMMARIES]")) return `<span class="section-summaries">${escapeHtml(line)}</span>`;
        if (line.startsWith("[") && line.includes("]")) return `<span class="section-tail">${escapeHtml(line)}</span>`;
        return escapeHtml(line);
      }).join("\n");

      html += `<div><strong style="color:var(--blue)">${m.role}</strong></div>`;
      html += `<pre style="margin:4px 0 8px 0">${labeled}</pre>`;
    }

    const tokenEstimate = metrics
      ? Math.round(metrics.compressedTokenCount)
      : "?";

    promptContent.innerHTML = `
      <div class="prompt-block">${html}</div>
      <div class="prompt-meta">Token estimate: ~${tokenEstimate} tokens (chars / 4)</div>
    `;
  }

  // --- Render: Chunk Archive ---
  async function renderChunks(index, sessionID) {
    if (!index || index.length === 0) {
      chunkContent.innerHTML = '<span class="empty">No chunks archived.</span>';
      return;
    }

    let tabsHtml = index.map((entry, i) =>
      `<div class="chunk-tab" data-idx="${i}" data-key="${entry.chunkKey}">chunk:${i} — ${escapeHtml(entry.step ? entry.step.slice(0, 30) : "N/A")}</div>`
    ).join("");

    chunkContent.innerHTML = `
      <div class="chunk-tabs" id="chunkTabs">${tabsHtml}</div>
      <div id="chunkViewer"><span class="empty">Click a chunk to view.</span></div>
    `;

    // Attach click handlers
    const tabs = chunkContent.querySelectorAll(".chunk-tab");
    tabs.forEach((tab) => {
      tab.addEventListener("click", async () => {
        tabs.forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        const key = tab.getAttribute("data-key");
        const idx = tab.getAttribute("data-idx");

        try {
          const chunk = await apiGet(`/chunk?key=${encodeURIComponent(key)}`);
          const entry = index[parseInt(idx)];

          let keywordsHtml = (entry.keywords || []).map(k =>
            `<span class="chunk-keyword">${escapeHtml(k)}</span>`
          ).join("");

          document.getElementById("chunkViewer").innerHTML = `
            <div class="chunk-meta">
              Key: ${escapeHtml(key)} | Step: ${escapeHtml(entry.step || "N/A")} | Time: ${entry.t || "N/A"}
            </div>
            <div class="chunk-keywords">${keywordsHtml}</div>
            <div class="chunk-content">${escapeHtml(chunk.content || "[empty]")}</div>
          `;
        } catch (err) {
          document.getElementById("chunkViewer").innerHTML =
            `<span class="error">Error loading chunk: ${escapeHtml(err.message)}</span>`;
        }
      });
    });
  }

  // --- Main refresh ---
  async function refresh() {
    apiStatus.textContent = "Loading...";
    try {
      stateData = await apiGet("/state");

      // Populate session dropdown
      const sessions = stateData.sessions || [];
      sessionSelect.innerHTML = sessions.map((s) =>
        `<option value="${s.id}">${s.id}</option>`
      ).join("");

      if (sessions.length > 0 && !currentSession) {
        currentSession = sessions[0].id;
        sessionSelect.value = currentSession;
      }

      apiStatus.textContent = `OK — ${sessions.length} session(s)`;

      // Render all panels
      renderTimeline(stateData.compression || []);

      if (currentSession) {
        sessionBadge.textContent = currentSession.slice(0, 12) + "...";
        const sessionState = sessions.find((s) => s.id === currentSession);
        if (sessionState) {
          renderChunks(sessionState.index, currentSession);
        }
        await renderDiff(currentSession);
      }
    } catch (err) {
      apiStatus.textContent = "ERROR: " + err.message;
      apiStatus.style.color = "var(--red)";
    }
  }

  // --- Event listeners ---
  refreshBtn.addEventListener("click", refresh);
  sessionSelect.addEventListener("change", () => {
    currentSession = sessionSelect.value;
    refresh();
  });
  copyPromptBtn.addEventListener("click", () => {
    const text = promptContent.innerText;
    navigator.clipboard.writeText(text).then(() => {
      copyPromptBtn.textContent = "Copied!";
      setTimeout(() => { copyPromptBtn.textContent = "Copy"; }, 1500);
    });
  });

  // --- Helpers ---
  function escapeHtml(s) {
    if (!s) return "";
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function truncate(s, max) {
    if (!s) return "";
    return s.length > max ? s.slice(0, max) + "…" : s;
  }

  // --- Init ---
  refresh();
})();
</script>
</body>
</html>
```

---

## 6. How the Widget Maps to Plugin Code

| Widget Feature | Plugin Code Reference |
|---|---|
| **Compression Timeline** | `sideLog("fold", ...)` calls at lines 575, 659, 672 — each logs a fold event with token counts |
| **Diff View** | `ev.messages` before the fold (line 439) vs. `newMessages` after (line 639) |
| **Prompt Inspection** | `ev.messages = newMessages` (line 639) — this is the final prompt sent to the model |
| **Chunk Archive** | `saveChunk()` at line 559, `state.index` entries at line 568, `loadChunk()` at line 149 |
| **Token estimation** | `estimateTokens()` at line 23 — `Math.ceil(chars / 4)` |
| **Protected tail** | Lines 532–543 — walks messages from end until `accTokens >= PROTECTED_TOKENS` |
| **Aging / summaries** | Lines 642–665 — merges oldest log entries into summaries |
| **Config values** | Lines 9–16 — read from `process.env.*` |

---

## 7. Quick Start Checklist

1. **Set the env var:** `OPENCODE_CTX_DEBUG_HTTP=1`
2. **Restart opencode** (so the plugin picks up the new env var)
3. **Open the HTML file** in a browser (double-click the `.html` file)
4. **Verify** the header shows `OK — N session(s)` and the panels populate
5. **To disable:** unset `OPENCODE_CTX_DEBUG_HTTP` and restart

---

## 8. Future Extensions (not in scope)

- **Live WebSocket feed** — push compression events in real-time
- **Chunk merge** — allow merging two adjacent chunks into one
- **Search across chunks** — full-text search over all archived content
- **Export** — download the full context (before/after) as JSON or Markdown
- **Token breakdown** — per-message token estimates instead of character-based approximation
