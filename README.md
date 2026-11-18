# local-context - OpenCode V2 Context-Compression Plugin

`local-context` is an OpenCode V2 plugin that compresses conversation context with a todo-list-driven fold mechanism: completed steps get folded into indexed, recoverable chunks; the live context keeps a compact step log; when the task list completes, heavy session data is wiped and a durable completion report remains.

## Features

- **`todo` tool** - `plan` items require `{"text","goal"}`; `done` requires 1-based step numbers + past-tense `completionStory` >= 30 chars; phrase guard rejects in-progress language, strict step-order guard - both with `confirm: true` escape hatch; hard errors list open steps; `description` discourages trivial single-action steps
- **Step-log folding** with protected tail (`OPENCODE_CTX_PROTECTED_TOKENS`, default 32 K tokens); aging merges old log entries into a rolling summary
- **`history_lookup`** - keyword recovery via TF-IDF scoring on folded chunks, LLM extraction with raw fallback
- **`todo_lookup`** - optional `sessionID`, completion-report fallback, root-session fallback for sub-agents
- **Auto-cleanup on completion** - report to storage `lc:report:<sid>` + disk `lc-persist/<sid>.report.json`, then wipe chunks/state/registry; report survives `/clear-history`
- **`/add-task`** and **`/clear-history`** commands
- **Tool-output truncation cap** - `CAP_CHARS` (default 9000), ANSI-stripped before check
- **Optional PolyStrata affinity headers** - `X-Session-Id`, `X-Root-Session`, `X-Agent` (only when requests target the PolyStrata URL)

## Installation

1. Copy `local-context.ts` to the OpenCode plugins directory (or run `apply-plugin.ps1`)
2. Restart OpenCode: `opencode service restart`

Single-file plugin, no dependencies beyond Node builtins, Node 22+.

## Usage

**Plan tasks:**

```json
{ "action": "plan", "items": [
  { "text": "Read local-context.ts", "goal": "Understand the plugin's folding logic" },
  { "text": "Write README.md", "goal": "Document the plugin for publishing" }
]}
```

**Mark a step done:**

```json
{ "action": "done", "done": [1], "completionStory": "Read the entire local-context.ts source, understood the context hook, chunking, and index logic." }
```

**Rejected done call** (phrase guard):

```
REJECTED: this does not read like completed work (matched phrase: "let me").
A step is done ONLY when its work is completely finished AND verified.
```

**Rejected done call** (step order):

```
REJECTED: strict step order - step(s) 1 must be done before step 2 can be marked done.
```

**`todo_lookup` output example:**

```
Tasks for session ses_xxx:
Task 1: Read local-context.ts [done]
  Story: Read the entire local-context.ts source, understood the context hook, chunking, and index logic.
Task 2: Write README.md [open]
  Goal: Document the plugin for publishing
```

## Configuration

| Environment Variable | Default | Effect |
|---|---|---|
| `OPENCODE_CTX_PROTECTED_TOKENS` | 32000 | Trailing tokens to protect during fold |
| `OPENCODE_CTX_CAP_CHARS` | 9000 | Max chars per tool-output before truncation |
| `OPENCODE_CTX_AGE_BATCH` | 10 | Oldest log entries merged per aging cycle |
| `OPENCODE_CTX_ONELINER_KEEP` | 6 | Min step-log entries never aged out |
| `OPENCODE_CTX_LOOKUP_TIMEOUT_MS` | 60000 | Timeout for `history_lookup` extraction |
| `OPENCODE_CTX_POLY_URL` | `http://127.0.0.1:8095` | Base URL for `history_lookup` HTTP fallback |
| `OPENCODE_CTX_POLY_MODEL` | `qwen3.6-35b-a3b-ud-q3_k_m` | Model used for HTTP fallback extraction |
| `OPENCODE_CTX_HARD_COMPRESS_TOKENS` | 64000 | Hard-compress threshold for stateless sessions |
| `OPENCODE_CTX_DEBUG_PORT` | 8765 | Debug HTTP server port (listens on 127.0.0.1) |

`OPENCODE_CTX_DEBUG_PORT` - debug tool only. Exposes a REST API at `http://127.0.0.1:<port>/api/local-context/state` that returns session states, chunks, and index.

## How Compression Works

See [COMPRESSION.md](./COMPRESSION.md) for the full folding lifecycle, aging rules, and recovery paths.

## Development

- **Tests:** `node --experimental-strip-types tests/harness.ts`
- **Deploy:** `apply-plugin.ps1` - syntax-checks the plugin, copies `.ts` and `.json` files to the OpenCode plugins directory. Adjust the `$TargetDir` path in the script for other machines.

## Docs

- [COMPRESSION.md](./COMPRESSION.md) - folding lifecycle, state shape, config, key functions
- [WEB-UI-WIDGET-SPEC.md](./WEB-UI-WIDGET-SPEC.md) - debug widget spec
- [SESSION-HEADERS-HANDOFF.md](./SESSION-HEADERS-HANDOFF.md) - affinity header notes

## Compatibility

Requires OpenCode V2. Storage API defended via `storageRemove` (tries `ctx.storage.remove` first, falls back to `delete` to handle drift).
