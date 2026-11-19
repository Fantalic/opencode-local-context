# Local-Context Plugin: Conversation Context Compression

## 1. Overview

The local-context plugin compresses conversation context using a todo-list-driven folding mechanism. When the `todo` tool marks steps `done`, those completed steps' conversation history is folded out of the live message list and stored as indexed chunks in `ctx.storage`. The step log (a compact summary of completed tasks with timestamps and stories) replaces the full history in the active context. Folded chunks are recoverable via the `history_lookup` tool (keyword search with TF-IDF scoring and LLM extraction) or `todo_lookup` (live state + completion report + root-session fallback for sub-agents). When all tasks are done, the session's heavy data (chunks, index, state) is wiped and a durable completion report is persisted to both storage and disk. The plugin is pure ASCII, uses only `node:fs` (no other external dependencies), and is implemented as a single file: `local-context.ts` (1684 lines).

## 2. When Compression Happens

**Trigger 1: `pendingFold` set by `todo done`.** After marking steps done in the `todo` tool (line 544), `state.pendingFold` is set to `true`. The next `ctx.session.hook("context")` call detects this flag and triggers a fold. The `todo done` handler runs four validation phases: (a) `completionStory` is required and must be at least 30 characters; (b) step numbers must be valid 1-based integers in range 1..state.todo.length; (c) at least one valid step number must be provided; (d) strict step order (step N may only be done when all earlier steps are done), with `confirm: true` as an escape hatch for out-of-order cases. Story quality is enforced through the tool description (past tense, WHAT was produced, HOW it was verified).

**Trigger 2: Between-folds refresh.** When `state.folded` is `true` but `pendingFold` is `false`, the context hook does not fold again. Instead, it refreshes the step-log message in place (lines 588-614) so the step log stays current without re-folding. This happens on every context hook call for sessions that have already folded. The refresh rebuilds the log body from `state.log` (timestamped entries with completion stories) and appends `[SUMMARIES]` if `state.summaries` is non-empty.

**Trigger 3: `pendingTaskCount` branch (one-shot).** When `/add-task` increments `state.pendingTaskCount`, the context hook enters a special branch (lines 620-665) that rebuilds the step log with a `[PENDING TASKS]` section appended, showing all tasks with `[x]`/`[ ]` marks and their stories. This is a one-shot: `pendingTaskCount` is set to `0` after this refresh. (Bug fix: it used to stick forever, silently disabling all compression after any `/add-task`.)

**No-op.** If there is no state (no `todo` tool use) or no `pendingFold` and not `folded`, the hook returns immediately (line 585).

## 3. The Fold, Step by Step

1. **Entry detection.** The context hook checks `state.pendingFold` and `state.folded` (line 585). If `pendingFold` is `true`, folding proceeds. If `folded` is true but `pendingFold` is false, the between-folds refresh path runs. If `pendingTaskCount > 0`, the one-shot pending-tasks refresh runs.

2. **Capture `originalTask` + `sessionLabel`.** On the first fold (`!state.originalTask`), the hook scans messages for the first `user`-role message, extracts its text as `originalTask` (line 671). A `sessionLabel` is derived as the first 50 chars of the user message with whitespace collapsed and trimmed. `rootSessionID` is resolved via `resolveRootSession` (walks parent chain via `ctx.session.get`, max 10 levels, returns the leaf session if no parent or circular).

3. **Protected-tail walk.** The hook walks messages from the end (line 689), accumulating token estimates via `estimateTokens(chars)` = `Math.ceil(chars / 4)` (line 32). The `extractMessageText` helper handles three message shapes: plain `msg.content` string, `msg.content` array (iterates parts, extracts `c.text` strings, `c.output`/`c.result`/`c.content` from `tool-result` parts up to 4000 chars, falls back to JSON.stringify up to 2000 chars), and `msg.text` strings. Walk stops when accumulated tokens reach `PROTECTED_TOKENS` (default 32000). `tailStart` is the index of the first message in the protected tail. If the walk reaches message 0 without reaching the threshold, `tailStart` stays 0.

4. **Task-anchor preservation.** The first `user`-role message is located (lines 708-714) and never folded into a chunk. It serves as the "original task anchor" in the rebuilt message list.

5. **System-prompt preservation.** Every leading `system`-role message (before `tailStart`) is never folded or cut.

6. **Chunk building.** Messages before `tailStart` that are neither `system` nor the first `user` message are extracted via `extractMessageText` and joined with `\n\n` into `chunkText` (lines 716-725). The chunk is saved via `saveChunk` (capped to `CHUNK_MAX_CHARS` = 40000 at line 172).

7. **Index entry creation.** Keywords are extracted from `chunkText` via `extractKeywords` (lines 74-89): four regex patterns applied sequentially, up to 12 results per pattern (early exit when `out.length >= 12`), all lowercased, min 3 chars, deduplicated. The patterns are: (a) file paths `[\w.-]+[\\/][\w.\-\/\\]+`, (b) file extensions `[\w-]+\.(ts|js|py|md|json|ya?ml|ps1|toml|txt|log)`, (c) PascalCase `[A-Z][A-Za-z0-9_]{2,}`, (d) snake_case `[a-z]+_[a-z0-9_]+`. Keywords are merged with the last log entry's keywords into a combined set of up to 16. The index entry stores: `keywords` (combined, max 16), `step` (last completed task text), `stepKeywords` (from log entry), `t` (timestamp like "14:30"), and `chunkKey` (storage key `lc:<sessionID>:chunk:<n>`).

8. **Chunk metadata update.** `state.chunkCount` is incremented (starts at 0, each fold appends a new chunk). `state.pendingFold` set to `false`; `state.folded` set to `true`. State is persisted.

9. **`ev.messages` rebuild.** The new message list is constructed as:
   - All leading `system` messages (before `tailStart`)
   - The first `user` message (task anchor)
   - The step-log user message (new or updated in-place, containing `[CONTEXT STEP LOG]` marker followed by `[HH:MM] text` entries with optional `Story:` lines, and `[SUMMARIES]` section if summaries exist)
   - All messages from `tailStart` onward (protected tail)

   If a step-log message already exists (detected by `extractMessageText` returning text starting with `[CONTEXT STEP LOG]`), it is updated in place. If not, a new `user`-role message is inserted after the task anchor.

10. **Aging check.** If `state.log.length > ONELINER_KEEP + AGE_BATCH` (default: 6 + 10 = 16), the oldest `AGE_BATCH` (default 10) log entries are spliced out and merged into one summary entry: their `text` fields joined with `"; "`, with keywords unioned (deduplicated, min 3 chars, max 16). This summary is appended to `state.summaries`. After aging, if `state.summaries.length > 20`, the array is truncated to the last 20.

### State Shape

The session state object (stored as JSON at `lc:<sessionID>`) contains:
- `todo`: array of `{text: string, goal: string, done: boolean, completionStory?: string, doneAt?: string}`
- `originalTask`: string (first user message text)
- `sessionLabel`: string (50-char truncated first user message)
- `rootSessionID`: string (resolved root session ID)
- `log`: array of `{t: string, text: string, completionStory: string, keywords: string[]}`
- `summaries`: array of `{text: string, keywords: string[]}`
- `index`: array of `{keywords: string[], step: string, stepKeywords: string[], t: string, chunkKey: string}`
- `folded`: boolean
- `pendingFold`: boolean
- `chunkCount`: number
- `pendingTaskCount`: number (for /add-task one-shot trigger)

## 4. Aging

When the step-log exceeds `ONELINER_KEEP + AGE_BATCH` entries (default 16), the oldest `AGE_BATCH` (default 10) entries are merged into one summary line: their `text` fields joined with `"; "`, with keywords unioned (deduplicated, min 3 chars, max 16). This summary is appended to `state.summaries`. After aging, if `state.summaries.length > 20`, the array is truncated to the last 20.

The aging happens during every fold, so the step log stays within a bounded size while preserving a rolling summary of older work. Summaries appear in the step-log message in the live context under a `[SUMMARIES]` section. The `ONELINER_KEEP` value (default 6) ensures the most recent 6 step-log entries are never aged out.

## 5. Recovery Paths

**`history_lookup`** (lines 855-1035): Searches folded chunks by keyword. Extracts keywords from the query via `extractKeywords`. Computes document frequency (how many index entries contain each keyword) across all entries for TF-IDF-like weighting: score for each query keyword = `1 / documentFrequency`. Scores each index entry by summing scores for matched query keywords (substring match: `kw.toLowerCase().includes(qw) || qw.includes(kw.toLowerCase())`). The best-scoring index entry's chunk is loaded via `loadChunk`. Extraction then tries three paths:
1. `ctx.session.generate` on a temporary session (creates "history-lookup" session, runs generate with prompt: "Context: this chunk was archived for todo step <step> at <t>. Answer the query using ONLY these notes. Notes: <chunkText> Query: <query>", aborts after `LOOKUP_TIMEOUT_MS` = 60000ms default, removes temp session)
2. Direct HTTP POST to `POLY_URL` (default `http://127.0.0.1:8095`) using `POLY_MODEL` (default `qwen3.6-35b-a3b-ud-q3_k_m`), 400-token max (`max_tokens: 400`), same prompt format
3. Raw chunk head (first 3000 chars) as final fallback, with `[recovered via keywords: <matched>]` annotation

The result is the LLM's extraction or raw chunk, annotated with matched keywords (top 12).

**`todo_lookup`** (lines 1037-1122): Returns task status, goals (open), and completion stories (done). Renders compactly via `fmtTasks`: `Task N: <text> [done/open]`, `Goal: <goal>` for open, `Story: <story>` (capped at 400 chars) for done. Resolution order: (1) `loadState` on current session (returns only if `state.todo.length > 0`), (2) `loadCompletionReport` (storage then disk fallback at `PERSIST_DIR`), (3) `resolveRootSession` for sub-agent case, (4) error message suggesting sessionID override.

**Step-log.** The step-log message in the live context contains all completed tasks with `[HH:MM]` timestamps, task text, and full completion stories. Aged summaries appear under a `[SUMMARIES]` section. When pending tasks exist, a `[PENDING TASKS]` section is added.

## 6. Safety Nets

**Compaction hook** (lines 1148-1197): If the native session compaction fires and the session has no state (no `todo` tool used), it creates a deterministic summary: the first user message (capped at 500 chars) plus every message role + first 120 chars of text. It also preserves session identity across compaction by storing root-session mapping in storage (`lc:rootSession:<sid>` and `lc:sessionId:<root>`), so the PolyStrata affinity queue keeps matching after the fold. The active session tracking (`lc:activeSession`) is cleared. If the session has state, native lifecycle proceeds (hook returns without modification).

**`execute.after` truncation cap** (lines 1124-1146): After every tool execution, the result's text content is checked against `CAP_CHARS` (default 9000). ANSI codes are stripped before the length check (`stripAnsi` uses `ANSI_RE = \x1b\[[0-9;]*[A-Za-z]`). If exceeded (and not already truncated -- checks for ` ...[truncated ` marker), it is cut to `CAP_CHARS` with marker: ` ...[truncated <N> chars - re-read or use history_lookup]`.

**Fail-open everywhere.** Every hook, storage operation, and helper wraps its logic in `try/catch` with a no-op catch. Errors are logged to `SIDE_LOG` (append-only, file path `C:\Users\FakuPara\AppData\Local\Temp\opencode\local-context.log`) but never propagate. The plugin never breaks opencode's normal operation. The `storageRemove` helper defensively tries both `ctx.storage.remove` and `ctx.storage.delete` to handle API drift across opencode versions. The debug HTTP server runs inside a try-catch so it never breaks the plugin if the port is unavailable.

## 7. Completion Cleanup

When all tasks are marked done (the `todo done` handler checks `state.todo.every(t => t.done)` at line 554, after `state.todo.length > 0`):

1. **`saveCompletionReport`** (lines 302-326): Writes a JSON report to `ctx.storage` under key `lc:report:<sessionID>` and to disk at `<PERSIST_DIR>/<sessionID>.report.json` where `PERSIST_DIR` is `C:\Users\FakuPara\AppData\Local\Temp\opencode\lc-persist`. The report includes `sessionID`, `sessionLabel`, `originalTask`, `completedAt` (ISO timestamp), and all tasks with their `text`, `goal`, `completionStory`, and `doneAt`. The disk copy survives storage resets.

2. **`wipeSession`** (lines 252-277): Iterates through all chunk keys (`chunkKey(sessionID, n)` for n=0,1,2,...) and removes each (stops when `ctx.storage.get(ck)` returns undefined). Scans for legacy `lc:persist:<sid>` junk keys (using `ctx.storage.scan` with prefix, up to 1000 entries) and removes those. Removes the session state via `removeState`. Unregisters the session from `lc:sessions` via `unregisterSession` (removes from array). The completion report survives this wipe (stored under `lc:report:`, not `lc:<sid>`, and `wipeSession` does not touch it).

3. After `/clear-history` (lines 1227-1256), `wipeSession` is called for the current session. If no session ID can be determined, `wipeAllSessions` (wipes every registered session) is called instead. The completion report is preserved.

## 8. Configuration

| Environment Variable | Default | Effect |
|---|---|---|
| `OPENCODE_CTX_PROTECTED_TOKENS` | 32000 | Tokens of trailing context to protect during fold (kept in live messages) |
| `OPENCODE_CTX_CAP_CHARS` | 9000 | Max chars per `execute.after` result before truncation |
| `OPENCODE_CTX_AGE_BATCH` | 10 | Number of oldest log entries merged into one summary per aging cycle |
| `OPENCODE_CTX_ONELINER_KEEP` | 6 | Minimum step-log entries to keep un-aged (aging threshold = ONELINER_KEEP + AGE_BATCH = 16) |
| `OPENCODE_CTX_LOOKUP_TIMEOUT_MS` | 60000 | Timeout for `history_lookup` extraction (abort + HTTP request) |
| `OPENCODE_CTX_POLY_URL` | `http://127.0.0.1:8095` | Base URL for `history_lookup` HTTP fallback extraction |
| `OPENCODE_CTX_POLY_MODEL` | `qwen3.6-35b-a3b-ud-q3_k_m` | Model used for `history_lookup` extraction via HTTP |
| `OPENCODE_CTX_HARD_COMPRESS_TOKENS` | 64000 | Hard-compress threshold for stateless sessions (sub-agents, plain sessions) |
| `OPENCODE_CTX_DEBUG_PORT` | 8765 | Port for the debug HTTP server (listens on 127.0.0.1) |

**Hardcoded constants (no env override):**
- `CHUNK_MAX_CHARS` = 40000 (max stored chunk size, line 18)
- `PERSIST_DIR` = `C:\Users\FakuPara\AppData\Local\Temp\opencode\lc-persist` (line 296)
- `SIDE_LOG` = `C:\Users\FakuPara\AppData\Local\Temp\opencode\local-context.log` (line 27)
- `estimateTokens` = `Math.ceil(chars / 4)` (line 32)
- `KEYWORD_RE` = 4 patterns (lines 67-72): (a) file paths, (b) file extensions (.ts/.js/.py/.md/.json/.yaml/.yml/.ps1/.toml/.txt/.log), (c) PascalCase (min 3 chars after first), (d) snake_case
- `ANSI_RE` = `\x1b\[[0-9;]*[A-Za-z]` (line 93)

## 9. Key Functions

| Function | Lines | Purpose |
|---|---|---|
| `estimateTokens` | 31-33 | Estimate tokens from character count (chars / 4, ceiling) |
| `extractMessageText` | 37-63 | Extract readable text from message (handles string content, array with text/tool-result/string parts capped at 4000/2000 chars, nested msg.text) |
| `extractKeywords` | 74-89 | Deterministic keyword extraction: 4 regex patterns, up to 12 per pattern (max 48 total), min 3 chars, deduplicated, lowercased |
| `renderChecklist` | 101-117 | Render todo list as `[x]` / `[ ]` with goals (open, shown under `[ ]`) and stories (done, capped 400 chars with "... (full story via todo_lookup)" suffix) |
| `sideLog` | 121-131 | Append timestamped log line to SIDE_LOG file (create dir recursively); never fails |
| `stateKey` | 135-137 | Storage key prefix `lc:<sessionID>` for session state |
| `chunkKey` | 140 | Storage key `lc:<sessionID>:chunk:<n>` for folded chunks |
| `loadState` / `saveState` | 143-159 | JSON-serialize session state to/from storage; fail-open |
| `saveChunk` / `loadChunk` | 161-179 | Save chunk text (capped to CHUNK_MAX_CHARS = 40000) and load it; fail-open |
| `removeChunk` / `removeState` | 181-195 | Remove individual chunks or session state; fail-open |
| `storageRemove` | 199-209 | Drift-safe removal: tries ctx.storage.remove, falls back to delete; fail-open |
| `initSessionRegistry` / `saveSessionRegistry` | 211-227 | Read/write `lc:sessions` JSON array in storage |
| `registerSession` / `unregisterSession` | 229-250 | Add/remove session from lc:sessions registry (no duplicates) |
| `wipeSession` | 252-277 | Remove all chunks (sequential scan), legacy lc:persist:<sid> keys (scan prefix, 1000 limit), state, and registry entry |
| `wipeAllSessions` | 279-289 | Wipe every registered session, then remove lc:sessions |
| `saveCompletionReport` | 302-326 | Save report to storage (lc:report:<sid>) and disk (<sid>.report.json) |
| `loadCompletionReport` | 328-342 | Load report from storage or disk fallback; fail-open |
| `resolveRootSession` | 344-361 | Walk parent chain via ctx.session.get (max 10 levels) to find root session ID |
| Context hook | 575-853 | Core folding: protected tail walk, chunking, step-log insertion, aging, message rebuild, fail-open |
| `history_lookup` tool | 855-1035 | Keyword-search folded chunks with TF-IDF scoring (1/documentFrequency), LLM extraction (generate or HTTP), raw fallback |
| `todo_lookup` tool | 1037-1122 | Show task status/goals/stories; fallback chain: live state -> completion report -> root session |
| `execute.after` hook | 1124-1146 | Truncation cap on tool output (CAP_CHARS = 9000, ANSI-stripped before check) |
| `compaction` hook | 1148-1197 | Safety net for sessions without todo state; deterministic summary; preserves identity across compaction |
| `http.request` hook | 1199-1225 | Inject X-Session-Id, X-Root-Session, X-Agent headers for PolyStrata affinity queue (cached root resolution) |
| `clear-history` command | 1227-1256 | Wipe all local-context state/chunks for a session; or all sessions if session ID is undetermined |
| `add-task` command | 1258-1326 | Add a task to the todo list and increment pendingTaskCount (one-shot trigger for context hook); supports multiple invocation shapes |
| Debug HTTP server | 1328-1670 | REST API on OPENCODE_CTX_DEBUG_PORT (default 8765): `/api/local-context/state` returns sessions/chunks/index/compression stats; `/api/local-context/chunk?key=` returns full chunk content (capped at 500 chars in state endpoint) |
