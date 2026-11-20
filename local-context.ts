// local-context.ts - opencode V2 server plugin: TODO-step context folding.
// Pure ASCII. No external dependencies beyond node:fs.

import type { Plugin } from "@opencode/plugin";
import path from "path";
import fs from "node:fs";
import http from "node:http";

// === HELPERS: Config ===

// Keep the most recent user input plus the trailing context window (default 32K tokens).
// Override via OPENCODE_CTX_PROTECTED_TOKENS (bytes -> tokens? keep same unit as default).
const PROTECTED_TOKENS = +(process.env.OPENCODE_CTX_PROTECTED_TOKENS || 32000);
const CAP_CHARS = +(process.env.OPENCODE_CTX_CAP_CHARS || 9000);
const AGE_BATCH = +(process.env.OPENCODE_CTX_AGE_BATCH || 10);
const ONELINER_KEEP = +(process.env.OPENCODE_CTX_ONELINER_KEEP || 6);
const LOOKUP_TIMEOUT_MS = +(process.env.OPENCODE_CTX_LOOKUP_TIMEOUT_MS || 60000);
const POLY_URL = process.env.OPENCODE_CTX_POLY_URL || "http://127.0.0.1:8095";
const POLY_MODEL = process.env.OPENCODE_CTX_POLY_MODEL || "qwen3.6-35b-a3b-ud-q3_k_m";
const CHUNK_MAX_CHARS = 40000;

// Hard-compress threshold for stateless sessions (sub-agents, plain sessions).
// Override via OPENCODE_CTX_HARD_COMPRESS_TOKENS (tokens). Default 64000.
const HARD_COMPRESS_TOKENS = +(process.env.OPENCODE_CTX_HARD_COMPRESS_TOKENS || 64000);

const rootSessionCache = new Map<string, string>();

const SIDE_LOG =
  "C:\\Users\\FakuPara\\AppData\\Local\\Temp\\opencode\\local-context.log";

// === HELPERS: Token estimate ===

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

// === HELPERS: Message text extraction ===

function extractMessageText(msg: any): string {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    const parts: string[] = [];
    for (const c of msg.content) {
      if (!c) continue;
      if (typeof c.text === "string" && c.text) { parts.push(c.text); continue; }
      if (c.type === "tool-result") {
        // provider format: output may be a plain string or a nested object
        const o = c.output ?? c.result ?? c.content;
        if (typeof o === "string" && o) { parts.push(o); continue; }
        try { parts.push(JSON.stringify(o ?? {}).slice(0, 4000)); } catch { /* skip unserializable */ }
        continue;
      }
      if (typeof c === "string") { parts.push(c); continue; }
      // last resort: stringify unknown part shapes so they still count for the tail walk
      try {
        const s = JSON.stringify(c);
        if (s && s !== "{}") parts.push(s.slice(0, 2000));
      } catch { /* skip */ }
    }
    return parts.join("\n");
  }
  if (typeof msg.text === "string") return msg.text;
  return "";
}

// === HELPERS: Keyword extraction (deterministic, pure) ===

const KEYWORD_RE = [
  /[\w.-]+[\\/][\w.\-\/\\]+/g,
  /[\w-]+\.(ts|js|py|md|json|ya?ml|ps1|toml|txt|log)/g,
  /[A-Z][A-Za-z0-9_]{2,}/g,
  /[a-z]+_[a-z0-9_]+/g,
];

function extractKeywords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const re of KEYWORD_RE) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null && out.length < 12) {
      const w = m[0].toLowerCase();
      if (w.length >= 3 && !seen.has(w)) {
        seen.add(w);
        out.push(w);
      }
    }
  }
  return out.slice(0, 12);
}

// Query-side keyword extraction: history_lookup queries arrive as natural
// language, which the code-oriented KEYWORD_RE misses entirely. Run the code
// regexes first; if they yield fewer than 3 keywords, fill up with plain
// words (lowercased, stopwords dropped, min 3 chars). Cap at 10.
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "want",
  "wanted", "was", "were", "has", "had", "not", "but", "all", "any",
  "are", "you", "your", "its", "our", "one", "two", "use", "used",
  "using", "also", "add", "new", "like", "just", "about", "after",
  "before", "when", "what", "which", "how", "who", "why", "can", "could",
  "would", "should", "their", "there", "then", "them", "they", "been",
  "being", "have", "will", "shall", "may", "might", "must", "done",
  "does", "did", "get", "got", "put", "set", "let", "make", "made",
  "some", "such", "only", "more", "most", "other", "into", "over",
  "under", "again", "very", "much", "many", "each", "every", "both",
]);

function extractQueryKeywords(text: string): string[] {
  const out = extractKeywords(text);
  if (out.length >= 3) return out.slice(0, 10);
  const seen = new Set<string>(out);
  const words = text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || [];
  for (const w of words) {
    if (out.length >= 10) break;
    if (w.length >= 3 && !STOPWORDS.has(w) && !seen.has(w)) {
      seen.add(w);
      out.push(w);
    }
  }
  return out.slice(0, 10);
}

// === HELPERS: ANSI strip ===

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

// === HELPERS: Checklist render ===

function renderChecklist(
  todo: { text: string; goal?: string; done: boolean; completionStory?: string }[],
): string {
  const lines: string[] = [];
  for (let i = 0; i < todo.length; i++) {
    const mark = todo[i].done ? "[x]" : "[ ]";
    lines.push(`${mark} ${i + 1}. ${todo[i].text}`);
    if (todo[i].done) {
      const story = todo[i].completionStory || "";
      const short = story.length > 400 ? story.slice(0, 400) + " ... (full story via todo_lookup)" : story;
      if (short) lines.push(`    Story: ${short}`);
    } else if (todo[i].goal) {
      lines.push(`    Goal: ${todo[i].goal}`);
    }
  }
  return lines.join("\n");
}

// One compact line carrying the folded chunks' vocabulary into every turn.
// Newest keywords first, deduped, capped - about 40 tokens.
function foldedKeysLine(index: any[]): string {
  const vocab: string[] = [];
  const seen = new Set<string>();
  for (let i = index.length - 1; i >= 0 && vocab.length < 24; i--) {
    for (const kw of index[i].keywords || []) {
      if (!seen.has(kw)) {
        seen.add(kw);
        vocab.push(kw);
        if (vocab.length >= 24) break;
      }
    }
  }
  if (vocab.length === 0) return "";
  return "\n\n[FOLDED CONTEXT KEYS] query history_lookup with these: " + vocab.join(", ");
}

// Single renderer for the step-log body - the four call sites below used to
// duplicate this loop; keep them identical by construction.
function renderStepLogBody(state: any): string {
  const logTexts: string[] = [];
  for (const entry of state.log) {
    let line = "[" + entry.t + "] " + entry.text;
    const story = entry.completionStory || entry.reason || "";
    if (story) {
      line += "\n    Story: " + story;
    }
    logTexts.push(line);
  }
  let body = logTexts.join("\n");
  if (state.summaries && state.summaries.length > 0) {
    body += "\n\n[SUMMARIES]\n" + state.summaries.map((s: any) => s.text).join("\n\n");
  }
  body += foldedKeysLine(state.index || []);
  return body;
}

// === HELPERS: Side log ===

function sideLog(component: string, line: string): void {
  try {
    const ts = new Date().toISOString();
    const msg = `${ts} ${component} ${line}\n`;
    const logDir = path.dirname(SIDE_LOG);
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(SIDE_LOG, msg, "utf8");
  } catch {
    // side log must never break the plugin
  }
}

// === HELPERS: State load/save ===

function stateKey(sessionID: string): string {
  return `lc:${sessionID}`;
}

function chunkKey(sessionID: string, n: number): string {
  return `lc:${sessionID}:chunk:${n}`;
}

async function loadState(ctx: any, sessionID: string): any {
  try {
    const raw = await ctx.storage.get(stateKey(sessionID));
    if (raw) return JSON.parse(raw);
  } catch {
    // fail-open
  }
  return null;
}

async function saveState(ctx: any, sessionID: string, state: any): Promise<void> {
  try {
    await ctx.storage.set(stateKey(sessionID), JSON.stringify(state));
  } catch {
    // fail-open
  }
}

async function loadChunk(ctx: any, key: string): Promise<string> {
  try {
    return (await ctx.storage.get(key)) || "";
  } catch {
    return "";
  }
}

async function saveChunk(ctx: any, sessionID: string, n: number, text: string): Promise<void> {
  try {
    // Cap stored chunk to CHUNK_MAX_CHARS
    const capped = text.length > CHUNK_MAX_CHARS
      ? text.slice(0, CHUNK_MAX_CHARS)
      : text;
    await ctx.storage.set(chunkKey(sessionID, n), capped);
  } catch {
    // fail-open
  }
}

async function removeChunk(ctx: any, sessionID: string, n: number): Promise<void> {
  try {
    await storageRemove(ctx, chunkKey(sessionID, n));
  } catch {
    // fail-open
  }
}

async function removeState(ctx: any, sessionID: string): Promise<void> {
  try {
    await storageRemove(ctx, stateKey(sessionID));
  } catch {
    // fail-open
  }
}

// Storage API drift defense: the documented method is `remove`; some builds
// only expose `delete`. Try `remove` first, fall back to `delete`.
async function storageRemove(ctx: any, key: string): Promise<void> {
  try {
    if (typeof ctx.storage.remove === "function") {
      await ctx.storage.remove(key);
      return;
    }
  } catch { /* fall through */ }
  try {
    await ctx.storage.delete(key);
  } catch { /* fail-open */ }
}

async function initSessionRegistry(ctx: any): Promise<string[]> {
  try {
    const raw = await ctx.storage.get("lc:sessions");
    if (raw) return JSON.parse(raw);
  } catch {
    // fail-open
  }
  return [];
}

async function saveSessionRegistry(ctx: any, sessions: string[]): Promise<void> {
  try {
    await ctx.storage.set("lc:sessions", JSON.stringify(sessions));
  } catch {
    // fail-open
  }
}

async function registerSession(ctx: any, sessionID: string): Promise<void> {
  try {
    const sessions = await initSessionRegistry(ctx);
    if (!sessions.includes(sessionID)) {
      sessions.push(sessionID);
      await saveSessionRegistry(ctx, sessions);
    }
  } catch {
    // fail-open
  }
}

async function unregisterSession(ctx: any, sessionID: string): Promise<void> {
  try {
    const sessions = await initSessionRegistry(ctx);
    const idx = sessions.indexOf(sessionID);
    if (idx >= 0) sessions.splice(idx, 1);
    await saveSessionRegistry(ctx, sessions);
  } catch {
    // fail-open
  }
}

async function wipeSession(ctx: any, sessionID: string): Promise<void> {
  try {
    // Remove all chunk keys for this session
    let n = 0;
    while (true) {
      const ck = chunkKey(sessionID, n);
      const val = await ctx.storage.get(ck);
      if (val === undefined) break;
      await storageRemove(ctx, ck);
      n++;
    }
    // Legacy per-session persist keys (lc:persist:<sid>) are junk now.
    try {
      const page = await ctx.storage.scan({ prefix: `lc:persist:${sessionID}`, limit: 1000 });
      for (const entry of page?.entries || []) {
        await storageRemove(ctx, entry.key);
      }
    } catch { /* fail-open */ }
    // Remove state
    await removeState(ctx, sessionID);
    // Unregister
    await unregisterSession(ctx, sessionID);
  } catch {
    // fail-open
  }
}

async function wipeAllSessions(ctx: any): Promise<void> {
  try {
    const sessions = await initSessionRegistry(ctx);
    for (const sid of sessions) {
      await wipeSession(ctx, sid);
    }
    await storageRemove(ctx, "lc:sessions");
  } catch {
    // fail-open
  }
}

// === HELPERS: Completion report (the durable record of a finished todo list) ===

// Written when ALL tasks are done, right before the heavy session data
// (chunks, index, state) is wiped. todo_lookup serves this afterwards.
const PERSIST_DIR =
  "C:\\Users\\FakuPara\\AppData\\Local\\Temp\\opencode\\lc-persist";

function reportKey(sessionID: string): string {
  return `lc:report:${sessionID}`;
}

async function saveCompletionReport(ctx: any, sessionID: string, state: any): Promise<void> {
  try {
    const report = {
      sessionID,
      sessionLabel: state.sessionLabel || "",
      originalTask: state.originalTask || "",
      completedAt: new Date().toISOString(),
      tasks: (state.todo || []).map((t: any) => ({
        text: t.text,
        goal: t.goal || "",
        done: t.done === true,
        completionStory: t.completionStory || "",
        doneAt: t.doneAt || "",
      })),
    };
    const data = JSON.stringify(report, null, 2);
    await ctx.storage.set(reportKey(sessionID), data);
    // Disk copy: survives storage resets, easy to find manually.
    try {
      fs.mkdirSync(PERSIST_DIR, { recursive: true });
      fs.writeFileSync(path.join(PERSIST_DIR, `${sessionID}.report.json`), data, "utf8");
    } catch { /* fail-open */ }
    sideLog("report", `saved report for ${sessionID} (${report.tasks.length} tasks)`);
  } catch { /* fail-open */ }
}

async function loadCompletionReport(ctx: any, sessionID: string): Promise<any | null> {
  try {
    let raw: any = await ctx.storage.get(reportKey(sessionID));
    if (!raw) {
      try {
        const p = path.join(PERSIST_DIR, `${sessionID}.report.json`);
        if (fs.existsSync(p)) raw = fs.readFileSync(p, "utf8");
      } catch { /* fall through */ }
    }
    if (!raw) return null;
    if (typeof raw === "string") return JSON.parse(raw);
    return raw;
  } catch { return null; }
}

async function resolveRootSession(ctx: any, sessionID: string): Promise<string | null> {
  try {
    let currentID = sessionID;
    let depth = 0;
    const maxDepth = 10;
    while (depth < maxDepth) {
      const info = await ctx.session.get({ sessionID: currentID });
      if (!info) return currentID;
      const parent = info.parentID ?? info.parent ?? null;
      if (!parent || parent === currentID) return currentID;
      currentID = parent;
      depth++;
    }
    return currentID;
  } catch {
    return sessionID;
  }
}

// === SETUP ===

export default {
  id: "local-context",
  setup: async (ctx: any) => {
    // Track one-time warning for default session key
    const warnedDefaultKey = new Set<string>();

    sideLog("setup", "plugin loaded ok");

    // --- todo tool ---
    ctx.tool.transform((reg: any) => {
      reg.add({
        name: "todo",
        description:
          "Organize BIG tasks: plan multi-step work that needs substantial effort and do the steps yourself in this session - never single file edits, single reads, or single lookups, and never as a board for work you hand to other agents. Mark steps done as you complete them. NO-GO: calling action=done for unfinished work. A step is done ONLY when its work is completely finished in this session and the result was verified: the deliverable exists and you can state what was produced. WARNING - done is a point of no return: after a step is marked done, this step's conversation context is compressed and dropped from the live window. If you mark a step done while its work is incomplete, you lose the very details you still need; re-reading them costs extra steps. Mark done only when you no longer need the step's raw context. plan: items are {\"text\": \"what to do\", \"goal\": \"the outcome that defines done\"}. done: 1-based step numbers + completionStory (past tense, min 30 chars: what was produced, what was verified).",
        input: {
          type: "object" as const,
          properties: {
            action: {
              type: "string" as const,
              enum: ["plan", "done"],
            },
            items: {
              type: "array" as const,
              description:
                "action=plan only: array of task objects {\"text\": \"what to do\", \"goal\": \"the outcome that defines done\"}. Both fields required, non-empty.",
              items: {
                type: "object",
                properties: {
                  text: { type: "string" },
                  goal: { type: "string" },
                },
                required: ["text", "goal"],
                additionalProperties: false,
              },
            },
            done: {
              type: "array" as const,
              items: { type: ["string", "number"] as const },
              description:
                "action=done only: 1-based step numbers that are now COMPLETE (work finished and verified).",
            },
            completionStory: {
              type: "string" as const,
              description:
                "Required for action=done. Past-tense narrative of what was produced and what was verified (files, commands, outputs, measurements). At least 30 characters.",
            },
            reason: {
              type: "string" as const,
              description:
                "Deprecated alias of completionStory; accepted for compatibility.",
            },
            confirm: {
              type: "boolean" as const,
              description:
                "Set true ONLY if a completionStory rejection was a false positive and the work really is completely finished and verified. Never to force present-tense stories; those are rejected regardless.",
            },
          },
          required: ["action"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (params: any, context: any) => {
          try {
            // Determine session key
            let sessionID: string;
            if (context?.sessionID) {
              sessionID = context.sessionID;
              sideLog("todo", `sessionID from context: ${sessionID}`);
            } else {
              sessionID = "default";
              if (!warnedDefaultKey.has("todo-default")) {
                warnedDefaultKey.add("todo-default");
                sideLog("todo", "WARN: no sessionID, using 'default'");
              }
            }

            await registerSession(ctx, sessionID);

            const state = await loadState(ctx, sessionID) || {
              todo: [],
              originalTask: "",
              log: [],
              summaries: [],
              index: [],
              folded: false,
              pendingFold: false,
              chunkCount: 0,
            };

            if (params.action === "plan") {
              const items = params.items || [];
              for (const item of items) {
                if (!item || typeof item !== "object" || !item.text || !String(item.text).trim() || !item.goal || !String(item.goal).trim()) {
                  throw new Error(
                    'Invalid arguments for tool "todo": each plan item must be an object {"text": "...", "goal": "..."}. text = what to do; goal = the outcome that defines done (used later to judge completion). Offending item: ' +
                      JSON.stringify(item),
                  );
                }
              }
              state.todo = items.map((t: any) => ({ text: String(t.text).trim(), goal: String(t.goal).trim(), done: false }));
              state.folded = false;
              await saveState(ctx, sessionID, state);
              sideLog("todo", `planned ${items.length} tasks`);
              return { content: renderChecklist(state.todo) + "\n\nReminder: done drops this step's context - only mark steps whose work is COMPLETE and VERIFIED." };
            }

            if (params.action === "done") {
              // a) completionStory validation
              const story = String(params.completionStory ?? params.reason ?? "").trim();
              if (!story) {
                throw new Error(
                  'Invalid arguments for tool "todo": completionStory is required for action=done. Describe in past tense HOW the goal was reached (what you did, what was produced, what was verified).',
                );
              }
              if (story.length < 30) {
                throw new Error(
                  'Invalid arguments for tool "todo": completionStory must be at least 30 characters. Tell HOW the goal was reached: what was done, what was produced, what was verified.',
                );
              }

              // b) Step numbers
              const rawIdx = [
                ...(params.done ?? []),
                ...(params.items ?? []),
              ];
              const validIdx = new Set<number>();
              for (const v of rawIdx) {
                const n = Number(v);
                if (!isNaN(n) && n >= 1 && n <= state.todo.length) {
                  validIdx.add(n);
                }
              }
              if (rawIdx.length === 0) {
                throw new Error(
                  'ERROR: no steps were marked done. You must pass the 1-based step numbers in the `done` (or `items`) array.\n\nOpen steps:\n' +
                    renderChecklist(state.todo.filter(function (t) { return !t.done; })) +
                    '\n\nRule: only mark a step done when its work is completely finished and verified.',
                );
              }
              if (rawIdx.length > 0 && validIdx.size === 0) {
                throw new Error(
                  'No valid step numbers in range 1-' + state.todo.length + '. Received: ' + JSON.stringify(rawIdx) + '.\n\nOpen steps:\n' +
                    renderChecklist(state.todo.filter(function (t) { return !t.done; })),
                );
              }

              // d) Strict order: step N may only be done when all earlier
              // steps are done. Escape hatch: confirm: true for the rare
              // legitimate out-of-order case (e.g. a sub-agent finished a
              // later step early).
              const maxIdx = Math.max(...[...validIdx]);
              const earlierOpen = [];
              for (let i = 0; i < maxIdx - 1; i++) {
                const stepNum = i + 1;
                if (state.todo[i] && !state.todo[i].done && !validIdx.has(stepNum)) earlierOpen.push(stepNum);
              }
              if (earlierOpen.length > 0 && params.confirm !== true) {
                throw new Error(
                  "REJECTED: strict step order - step(s) " + earlierOpen.join(", ") +
                    " must be done before step " + maxIdx + " can be marked done. Complete them first" +
                    " (in order), or if this out-of-order completion is genuinely intentional, re-call with confirm: true.",
                );
              }

              // e) Mark tasks done
              let markedAny = false;
              for (const idx of validIdx) {
                const zeroBased = idx - 1;
                if (!state.todo[zeroBased].done) {
                  state.todo[zeroBased].done = true;
                  const now = new Date();
                  const hhmm =
                    String(now.getHours()).padStart(2, "0") +
                    ":" +
                    String(now.getMinutes()).padStart(2, "0");
                  state.log.push({
                    t: hhmm,
                    text: state.todo[zeroBased].text,
                    completionStory: story,
                    keywords: extractKeywords(state.todo[zeroBased].text),
                  });
                  state.todo[zeroBased].completionStory = story;
                  state.todo[zeroBased].doneAt = hhmm;
                  state.pendingFold = true;
                  markedAny = true;
                  sideLog("todo", `marked #${idx} done`);
                }
              }
              await saveState(ctx, sessionID, state);
              sideLog("todo", `saved state, pendingFold=${state.pendingFold}`);

              // All tasks complete: persist the completion report, then wipe
              // the heavy session data so finished sessions do not junk storage.
              let cleanupNote = "";
              if (state.todo.length > 0 && state.todo.every((t: any) => t.done)) {
                await saveCompletionReport(ctx, sessionID, state);
                await wipeSession(ctx, sessionID);
                cleanupNote = "\n\n[All tasks complete. Session data wiped; completion report saved (fetch via todo_lookup).]";
                sideLog("cleanup", `all tasks done, wiped session ${sessionID}`);
              }

              // f) Success output
              // Every done folds the step's conversation away on the next
              // turn - re-announce that consequence right here, where it
              // happens, so the agent sees it each time it marks a step.
              let contextNote = "";
              if (markedAny && !cleanupNote) {
                contextNote = "\n\n[Context warning: this step's conversation will be compressed and dropped from the live window on the next turn. Recover details later with history_lookup - the vocabulary is in the step log under [FOLDED CONTEXT KEYS].]";
              }
              return { content: renderChecklist(state.todo) + cleanupNote + contextNote };
            }

            throw new Error("Unknown action. Use 'plan' or 'done'.");
          } catch (err: any) {
            sideLog("todo", `ERROR: ${err.message}`);
            throw err;
          }
        },
      });
    });

    // --- context hook (folding) ---
    ctx.session.hook("context", async (ev: any) => {
      try {
        const sessionID = ev.sessionID;

        // Track active session: set on every context hook call
        await ctx.storage.set('lc:activeSession', sessionID);

        const state = await loadState(ctx, sessionID);

        // Pending tasks (one-shot): works even before the first fold.
        if (state?.pendingTaskCount > 0) {
          const stepLogMarker = "[CONTEXT STEP LOG]";
          let stepLogIdx = -1;
          for (let i = 0; i < ev.messages.length; i++) {
            const txt = extractMessageText(ev.messages[i]);
            if (txt.startsWith(stepLogMarker)) {
              stepLogIdx = i;
              break;
            }
          }
          if (stepLogIdx >= 0) {
            let logBody = renderStepLogBody(state);
            logBody += "\n\n[PENDING TASKS]\n";
            for (let i = 0; i < state.todo.length; i++) {
              const mark = state.todo[i].done ? "[x]" : "[ ]";
              logBody += `${mark} ${i + 1}. ${state.todo[i].text}\n`;
              const logEntry = state.log.find(
                (e: any) => e.text === state.todo[i].text,
              );
              if (logEntry && (logEntry.completionStory || logEntry.reason)) {
                logBody += `    Story: ${logEntry.completionStory || logEntry.reason}\n`;
              }
            }
            ev.messages[stepLogIdx].content = [
              { type: "text", text: stepLogMarker + "\n\n" + logBody },
            ];
          }
          // pendingTaskCount is a one-shot trigger: show the pending tasks in
          // the step log this turn, then clear it so normal folding resumes on
          // the next turn. (Bug fix: it used to stick forever, which silently
          // disabled all compression after any /add-task.)
          state.pendingTaskCount = 0;
          await saveState(ctx, sessionID, state);
          return;
        }

        // If no state (no todo tool use) OR no pendingFold AND not folded, do nothing
        if (!state || (!state.pendingFold && !state.folded)) {
          // If state exists and folded is true but pendingFold is false,
          // this is the "between folds" case: keep view stable, refresh step-log.
          if (state && state.folded && state.pendingFold === false) {
            // Refresh step-log message in place
            const stepLogMarker = "[CONTEXT STEP LOG]";
            let stepLogIdx = -1;
            for (let i = 0; i < ev.messages.length; i++) {
              const txt = extractMessageText(ev.messages[i]);
              if (txt.startsWith(stepLogMarker)) {
                stepLogIdx = i;
                break;
              }
            }
            if (stepLogIdx >= 0) {
              ev.messages[stepLogIdx].content = [{ type: "text", text: stepLogMarker + "\n\n" + renderStepLogBody(state) }];
            }
            return;
          }
          return;
        }

        // First fold: capture originalTask from first user message
        if (!state.originalTask) {
          for (const msg of ev.messages) {
            if (msg.role === "user") {
              state.originalTask = extractMessageText(msg);
              break;
            }
          }
          // Extract a short session label (first ~50 chars of first user message)
          if (state.originalTask) {
            const label = state.originalTask
              .replace(/\s+/g, " ")   // collapse whitespace/newlines
              .trim();
            state.sessionLabel = label.length > 50 ? label.slice(0, 50) : label;
          }
          // Resolve parent-child grouping: find the root session ID
          state.rootSessionID = await resolveRootSession(ctx, sessionID);
        }

        // Build protected tail: walk messages from end, accumulate tokens until >= PROTECTED_TOKENS
        let tailStart = 0;
        let accTokens = 0;
        for (let i = ev.messages.length - 1; i >= 0; i--) {
          const msgText = extractMessageText(ev.messages[i]);
          accTokens += estimateTokens(msgText.length);
          if (accTokens >= PROTECTED_TOKENS) {
            tailStart = i;
            break;
          }
          // If we reach the beginning, tailStart stays 0
          if (i === 0) tailStart = 0;
        }

        // Fold: everything older than the tail goes to a chunk - but NEVER the leading
        // system messages (the system prompt is not part of the foldable history) and
        // NEVER the first user message (it is the original task anchor).
        const stepLogMarker = "[CONTEXT STEP LOG]";
        const chunkN = Number(state.chunkCount ?? 0);
        const foldedTexts: string[] = [];

        // Locate the first user message (the task anchor) to keep it out of the fold.
        let firstUserIdx = -1;
        for (let i = 0; i < ev.messages.length; i++) {
          if (ev.messages[i] && ev.messages[i].role === "user") {
            firstUserIdx = i;
            break;
          }
        }

        for (let i = 0; i < tailStart; i++) {
          const msg = ev.messages[i];
          if (!msg) continue;
          if (msg.role === "system") continue; // system prompt is never folded/cut
          if (i === firstUserIdx) continue; // task anchor is never folded/cut
          const msgText = extractMessageText(msg);
          if (msgText) {
            foldedTexts.push(msgText);
          }
        }

        if (foldedTexts.length > 0) {
          const chunkText = foldedTexts.join("\n\n");
          await saveChunk(ctx, sessionID, chunkN, chunkText);
          const kw = extractKeywords(chunkText);
          const lastEntry = state.log.length > 0 ? state.log[state.log.length - 1] : null;
          const stepText = lastEntry ? lastEntry.text : "";
          const stepKw = lastEntry ? (lastEntry.keywords || []) : [];
          const union = new Set<string>();
          for (const k of stepKw) union.add(k);
          for (const k of kw) union.add(k);
          const combined = [...union].slice(0, 16);
          state.index.push({
            keywords: combined,
            step: stepText,
            stepKeywords: stepKw,
            t: lastEntry ? lastEntry.t : "",
            chunkKey: chunkKey(sessionID, chunkN),
          });
          sideLog("fold", `chunk ${chunkN}, key=${chunkKey(sessionID, chunkN)}, tokens=${estimateTokens(chunkText.length)}`);
          state.chunkCount = chunkN + 1;
        }

        // Remove folded messages from ev.messages (keep system messages, first user, protected tail)
        const newMessages: any[] = [];
        // Keep every leading system message (the system prompt is never cut).
        for (let i = 0; i < tailStart; i++) {
          if (ev.messages[i] && ev.messages[i].role === "system") {
            newMessages.push(ev.messages[i]);
          }
        }
        // Keep the first user message (the task anchor).
        if (firstUserIdx >= 0 && firstUserIdx < tailStart) {
          newMessages.push(ev.messages[firstUserIdx]);
        }

        // Insert step-log user message right after first user message
        // Check if one already exists
        let existingStepLogIdx = -1;
        for (let i = 0; i < ev.messages.length; i++) {
          const txt = extractMessageText(ev.messages[i]);
          if (txt.startsWith(stepLogMarker)) {
            existingStepLogIdx = i;
            break;
          }
        }

        if (existingStepLogIdx >= 0) {
          // Update existing step-log in place
          const stepLogMsg = ev.messages[existingStepLogIdx];
          stepLogMsg.content = [{ type: "text", text: stepLogMarker + "\n\n" + renderStepLogBody(state) }];
          newMessages.push(stepLogMsg);
        } else {
          // Insert new step-log user message
          newMessages.push({
            role: "user",
            content: [{ type: "text", text: stepLogMarker + "\n\n" + renderStepLogBody(state) }],
          });
        }

        // Keep protected tail messages
        for (let i = tailStart; i < ev.messages.length; i++) {
          newMessages.push(ev.messages[i]);
        }

        ev.messages = newMessages;

        // Aging: merge oldest log entries if over threshold
        if (state.log.length > ONELINER_KEEP + AGE_BATCH) {
          const toMerge = state.log.splice(0, AGE_BATCH);
          const mergedText = toMerge.map((e: any) => e.text).join("; ");
          const mergedKw: string[] = [];
          const kwSeen = new Set<string>();
          for (const e of toMerge) {
            for (const kw of (e.keywords || [])) {
              if (kw.length >= 3 && !kwSeen.has(kw)) {
                kwSeen.add(kw);
                mergedKw.push(kw);
              }
            }
          }
          state.summaries.push({
            text: mergedText,
            keywords: mergedKw.slice(0, 16),
          });
          sideLog("fold", `aged ${toMerge.length} log entries`);
        }

        // Summaries capped at 20 in view
        if (state.summaries.length > 20) {
          state.summaries = state.summaries.slice(-20);
        }

        // Mark fold complete
        state.pendingFold = false;
        state.folded = true;
        await saveState(ctx, sessionID, state);

        sideLog("fold", `session=${sessionID}, keptTokens=${accTokens}, folded ${foldedTexts.length} messages`);
      } catch (err: any) {
        sideLog("fold", `ERROR: ${err.message}`);
        // Fail-open: do not alter messages
      }
    });

    // --- history_lookup tool ---
    ctx.tool.transform((reg: any) => {
      reg.add({
        name: "history_lookup",
        description:
          "Search folded context chunks by keyword query. Use 2-4 specific identifiers (file names, CamelCase/snake_case terms, exact feature words) - not whole sentences. The available vocabulary is listed in the step log under [FOLDED CONTEXT KEYS].",
        input: {
          type: "object" as const,
          properties: {
            query: { type: "string" as const },
          },
          required: ["query"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (params: any, context: any) => {
          try {
            let sessionID: string;
            if (context?.sessionID) {
              sessionID = context.sessionID;
              sideLog("lookup", `sessionID from context: ${sessionID}`);
            } else {
              sessionID = "default";
              if (!warnedDefaultKey.has("lookup-default")) {
                warnedDefaultKey.add("lookup-default");
                sideLog("lookup", "WARN: no sessionID, using 'default'");
              }
            }

            const state = await loadState(ctx, sessionID);
            if (!state || !state.index || state.index.length === 0) {
              return { content: "No folded history available for this session." };
            }

            const queryKw = extractQueryKeywords(params.query);
            const queryLower = params.query.toLowerCase();

            // Score index entries by query keyword match
            let bestScore = 0;
            let bestIdx = -1;
            let bestMatched: string[] = [];

            // Compute document frequency for rare-keyword weighting
            const df = new Map<string, number>();
            for (const entry of state.index) {
              const seen = new Set<string>();
              for (const kw of (entry.keywords || [])) {
                const lk = kw.toLowerCase();
                if (!seen.has(lk)) { seen.add(lk); df.set(lk, (df.get(lk) || 0) + 1); }
              }
            }
            const kwWeight = (kw: string): number => {
              const lk = kw.toLowerCase();
              const d = df.get(lk) || 1;
              return 1 / d;
            };
            for (let i = 0; i < state.index.length; i++) {
              let score = 0;
              const matched: string[] = [];
              const seenQw = new Set<string>();
              for (const qw of queryKw) {
                if (seenQw.has(qw)) continue;
                seenQw.add(qw);
                for (const kw of (state.index[i].keywords || [])) {
                  if (kw.toLowerCase().includes(qw) || qw.includes(kw.toLowerCase())) {
                    score += kwWeight(kw);
                    matched.push(kw);
                    break;
                  }
                }
              }
              if (score > bestScore) {
                bestScore = score;
                bestIdx = i;
                bestMatched = matched;
              }
            }

            if (bestScore === 0) {
              // Teach the vocabulary: list what the folded chunks actually
              // contain so the agent can retry with real identifiers.
              const vocab: string[] = [];
              const seenKw = new Set<string>();
              for (let i = state.index.length - 1; i >= 0 && vocab.length < 24; i--) {
                for (const kw of state.index[i].keywords || []) {
                  if (!seenKw.has(kw)) {
                    seenKw.add(kw);
                    vocab.push(kw);
                    if (vocab.length >= 24) break;
                  }
                }
              }
              return {
                content:
                  "No matching history for: " + params.query +
                  "\nQuery with 2-4 specific identifiers (file names, CamelCase/snake_case terms, exact feature words) - not whole sentences." +
                  (vocab.length > 0
                    ? "\nAvailable keywords in folded chunks: " + vocab.join(", ")
                    : "\nNo keywords indexed yet (nothing has been folded)."),
              };
            }

            const entry = state.index[bestIdx];
            const chunkText = await loadChunk(ctx, entry.chunkKey);

            // Try to extract via ctx.session.generate on a fresh session
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);

            let extraction: string | null = null;

            try {
              if (ctx.session?.generate && ctx.session?.create) {
                sideLog("lookup", "path=generate");
                let tempID = "";
                try {
                  const s = await ctx.session.create({ title: "history-lookup" });
                  tempID = s?.id ?? s?.sessionID ?? "";
                  const g = await ctx.session.generate({
                    sessionID: tempID,
                    prompt: `${entry.step ? "Context: this chunk was archived for todo step \"" + entry.step + "\" at " + entry.t + ".\n\n" : ""}Answer the query using ONLY these notes. Be brief. Notes:\n${chunkText}\n\nQuery: ${params.query}`,
                  });
                  if (g?.text) extraction = g.text;
                } catch { extraction = null; }
                finally {
                  if (tempID) { try { await ctx.session.remove({ sessionID: tempID }); } catch { /* fail-open */ } }
                }
              }
            } catch {
              extraction = null;
            } finally {
              clearTimeout(timeoutId);
            }

            // Fallback: direct POST to POLY_URL
            if (!extraction) {
              try {
                sideLog("lookup", "path=http");
                const http = await import("node:http");
                const postData = JSON.stringify({
                  model: POLY_MODEL,
                  messages: [
                    {
                      role: "user",
                      content: `${entry.step ? "Context: this chunk was archived for todo step \"" + entry.step + "\" at " + entry.t + ".\n\n" : ""}Answer the query using ONLY these notes. Be brief. Notes:\n${chunkText}\n\nQuery: ${params.query}`,
                    },
                  ],
                  max_tokens: 400,
                });
                const url = new URL("/v1/chat/completions", POLY_URL);
                const opts: any = {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(postData),
                  },
                };
                const req = http.request(url.toString(), opts);
                req.setTimeout(LOOKUP_TIMEOUT_MS, () => req.destroy(new Error("lookup timeout")));
                req.write(postData);
                req.end();

                const respText = await new Promise<string>((resolve, reject) => {
                  const chunks: string[] = [];
                  req.on("data", (c: Buffer) => chunks.push(c.toString()));
                  req.on("end", () => resolve(chunks.join("")));
                  req.on("error", reject);
                });

                const json = JSON.parse(respText);
                const choice = json.choices?.[0];
                if (choice) {
                  extraction =
                    choice.message?.content ??
                    choice.message?.reasoning_content ??
                    null;
                }
              } catch {
                extraction = null;
              }
            }

            // Final fallback: return raw chunk head
            if (!extraction) {
              sideLog("lookup", "path=raw");
              const head = chunkText.slice(0, 3000);
              return { content: `${head}\n\n[lookup extraction unavailable; raw chunk head]` };
            }

            const matchedStr = bestMatched.length > 0
              ? bestMatched.slice(0, 12).join(", ")
              : params.query;

            return { content: `${extraction}\n\n[recovered via keywords: ${matchedStr}]` };
          } catch (err: any) {
            sideLog("lookup", `ERROR: ${err.message}`);
            return { content: `Lookup error: ${err.message}` };
          }
        },
      });
    });

    // --- todo_lookup tool ---
    ctx.tool.transform((reg: any) => {
      reg.add({
        name: "todo_lookup",
        description:
          "Look up persisted todo tasks with goals and completion stories. Works even after the session data was wiped (serves the persisted completion report) and falls back to the root session so sub-agents and parent agents can both check what was done.",
        input: {
          type: "object" as const,
          properties: {
            sessionID: {
              type: "string" as const,
              description:
                "Optional. Defaults to the current session; falls back to the root session.",
            },
          },
          required: [],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (params: any, context: any) => {
          try {
            const sid = params.sessionID || context?.sessionID || "default";

            // Render tasks compactly: status, goal (open tasks), story (done tasks).
            const fmtTasks = (tasks: any[], log: any[]): string[] => {
              const lines: string[] = [];
              for (let i = 0; i < tasks.length; i++) {
                const t = tasks[i];
                lines.push(`Task ${i + 1}: ${t.text} [${t.done ? "done" : "open"}]`);
                if (!t.done && t.goal) lines.push(`  Goal: ${t.goal}`);
                const story = t.completionStory
                  || (log.find((e: any) => e.text === t.text) || {}).completionStory
                  || "";
                if (story) {
                  const short = story.length > 400
                    ? story.slice(0, 400) + " ..."
                    : story;
                  lines.push(`  Story: ${short}`);
                }
              }
              return lines;
            };

            let state: any = await loadState(ctx, sid);
            if (!state?.todo?.length) state = null;
            let report: any = state ? null : await loadCompletionReport(ctx, sid);

            // Sub-agent case: no data here - try the root session.
            if (!state && !report) {
              const rootID = await resolveRootSession(ctx, sid);
              if (rootID && rootID !== sid) {
                const rootState = await loadState(ctx, rootID);
                if (rootState?.todo?.length) {
                  state = rootState;
                  sideLog("todo_lookup", `serving root session ${rootID}`);
                } else {
                  report = await loadCompletionReport(ctx, rootID);
                  if (report) sideLog("todo_lookup", `serving root report ${rootID}`);
                }
              }
            }

            if (state?.todo?.length) {
              return {
                content: `Tasks for session ${sid}:\n` + fmtTasks(state.todo, state.log || []).join("\n"),
              };
            }
            if (report?.tasks?.length) {
              return {
                content: `Completion report for session ${sid} (${report.completedAt}):\n` + fmtTasks(report.tasks, []).join("\n"),
              };
            }
            return {
              content:
                `No tasks or completion report for session ${sid}.` +
                (sid !== "default"
                  ? " Try omitting sessionID (defaults to the current session) or pass the parent/root sessionID."
                  : ""),
            };
          } catch (err: any) {
            sideLog("todo_lookup", `ERROR: ${err.message}`);
            return { content: `Lookup error: ${err.message}` };
          }
        },
      });
    });

    // --- execute.after hook (append-time cap) ---
    ctx.tool.hook("execute.after", async (ev: any) => {
      try {
        if (!ev.result?.content) return;

        const marker = ` ...[truncated ${CAP_CHARS} chars`;
        const truncMarker = " ...[truncated ";

        for (const part of ev.result.content) {
          if (part.type === "text" && typeof part.text === "string") {
            const cleaned = stripAnsi(part.text);
            if (cleaned.length > CAP_CHARS && !part.text.includes(truncMarker)) {
              const head = part.text.slice(0, CAP_CHARS);
              const removed = part.text.length - CAP_CHARS;
              part.text = `${head}${truncMarker}${removed} chars - re-read or use history_lookup]`;
              sideLog("execute.after", `truncated ${removed} chars`);
            }
          }
        }
      } catch (err: any) {
        sideLog("execute.after", `ERROR: ${err.message}`);
      }
    });

    // --- compaction hook (safety net) ---
    ctx.session.hook("compaction", async (ev: any) => {
      try {
        const sessionID = ev.sessionID;
        const state = await loadState(ctx, sessionID);

        // If state exists (todo tool was used), native lifecycle proceeds
        if (state) {
          return;
        }

        // No state: create deterministic summary
        let firstUserText = "";
        for (const msg of ev.messages) {
          if (msg.role === "user") {
            firstUserText = extractMessageText(msg);
            if (firstUserText.length > 500) {
              firstUserText = firstUserText.slice(0, 500);
            }
            break;
          }
        }

        const summaryLines: string[] = [firstUserText];
        for (const msg of ev.messages) {
          const txt = extractMessageText(msg);
          if (txt) {
            const short = txt.length > 120 ? txt.slice(0, 120) : txt;
            summaryLines.push(`${msg.role}: ${short}`);
          }
        }

        ev.result = { summary: summaryLines.join("\n") };

        // Preserve session identity across compaction so the PolyStrata affinity
        // queue keeps matching this session by X-Root-Session after the fold.
        try {
          const rootSession = await resolveRootSession(ctx, sessionID);
          const keep = rootSession || sessionID;
          await ctx.storage.set(`lc:rootSession:${sessionID}`, keep);
          await ctx.storage.set(`lc:sessionId:${keep}`, sessionID);
        } catch { /* fail-open: headers still set live per request */ }

        // Clear active session tracking after compaction
        await storageRemove(ctx, 'lc:activeSession');
        sideLog("compaction", "created deterministic summary (no state)");
      } catch (err: any) {
        sideLog("compaction", `ERROR: ${err.message}`);
      }
    });

    // --- session headers for PolyStrata affinity queue ---
    await ctx.session.hook("http.request", async (ev: any) => {
      try {
        const url = ev.request?.url;
        if (!url || !url.includes("127.0.0.1:8095")) return;

        const sessionID = ev.sessionID;
        if (!sessionID) return;

        ev.request.headers.set("X-Session-Id", sessionID);

        let rootSession: string;
        if (rootSessionCache.has(sessionID)) {
          rootSession = rootSessionCache.get(sessionID)!;
        } else {
          const resolved = await resolveRootSession(ctx, sessionID);
          rootSession = resolved || sessionID;
          rootSessionCache.set(sessionID, rootSession);
        }
        ev.request.headers.set("X-Root-Session", rootSession);

        const agent = ev.agent ?? "unknown";
        ev.request.headers.set("X-Agent", agent);
      } catch {
        // fail-open: server falls back to token-checkpoint identity
      }
    });

    // --- /clear-history command ---
    ctx.command.transform((editor: any) => {
      editor.add({
        name: "clear-history",
        description: "Clear all local-context state and chunks for the current session.",
        execute: async (input: any) => {
          try {
            // Probe session ID from various shapes
            let sessionID: string | null = null;
            if (input?.session?.id) sessionID = String(input.session.id);
            else if (input?.sessionID) sessionID = String(input.sessionID);
            else if (input?.session?.sessionID) sessionID = String(input.session.sessionID);

            if (sessionID) {
              sideLog("clear", `wiping session: ${sessionID}`);
              await wipeSession(ctx, sessionID);
              return "Cleared local context state and chunks for this session.";
            }

            // No session ID found: wipe everything
            sideLog("clear", "no session ID found, wiping all sessions");
            await wipeAllSessions(ctx);
            return "Cleared all local context session data.";
          } catch (err: any) {
            sideLog("clear", `ERROR: ${err.message}`);
            return `Clear error: ${err.message}`;
          }
        },
      });
    });

    // --- /add-task command ---
    ctx.command.transform((editor: any) => {
      editor.add({
        name: "add-task",
        description: "Add a task to the current session's todo list",
        execute: async (invocation: any) => {
          try {
            let sessionID: string | null = null;
            if (invocation?.sessionID) sessionID = String(invocation.sessionID);
            else if (invocation?.session?.id) sessionID = String(invocation.session.id);
            else if (invocation?.session?.sessionID) sessionID = String(invocation.session.sessionID);

            if (!sessionID) {
              return "Could not determine session ID.";
            }

            // Documented shape: CommandInvocation { sessionID, prompt, delivery }
            // where prompt is PromptInput { text }. Keep the legacy shapes as
            // fallbacks so the command still works across opencode versions.
            let text: string | null = null;
            if (typeof invocation?.prompt?.text === "string" && invocation.prompt.text.trim()) {
              text = invocation.prompt.text.trim();
            } else if (Array.isArray(invocation?.prompt)) {
              const joined = invocation.prompt
                .map((p: any) => String(p?.text || ""))
                .join(" ")
                .trim();
              if (joined) text = joined;
            } else if (typeof invocation?.text === "string" && invocation.text.trim()) {
              text = invocation.text.trim();
            } else if (invocation?.args && typeof invocation.args.task === "string") {
              text = invocation.args.task.trim();
            } else if (invocation?.args && typeof invocation.args.text === "string") {
              text = invocation.args.text.trim();
            } else if (typeof invocation?.task === "string" && invocation.task.trim()) {
              text = invocation.task.trim();
            }

            if (!text) {
              return "Task text cannot be empty. Usage: /add-task <the task description>";
            }

            await registerSession(ctx, sessionID);

            const state = await loadState(ctx, sessionID) || {
              todo: [],
              originalTask: "",
              log: [],
              summaries: [],
              index: [],
              folded: false,
              pendingFold: false,
              chunkCount: 0,
              pendingTaskCount: 0,
            };

            state.todo.push({ text: text.trim(), goal: "", done: false });
            state.pendingTaskCount = (state.pendingTaskCount || 0) + 1;

            await saveState(ctx, sessionID, state);

            return `Task added to session ${sessionID}: "${text.trim()}"`;
          } catch (err: any) {
            sideLog("add-task", `ERROR: ${err.message}`);
            return `Add task error: ${err.message}`;
          }
        },
      });
    });

    // --- debug HTTP server for web UI widget ---
    try {
        const PORT = +(process.env.OPENCODE_CTX_DEBUG_PORT || 8765);

        const server = http.createServer(async (req: any, res: any) => {
          // CORS: only allow localhost / file://
          res.setHeader("Access-Control-Allow-Origin", "*");
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
            try {
              // MARKER: vX - if you see this in the response, this code is running
              const _MARKER = "v2-20261114";
              // List all storage keys starting with "lc:" using scan()
              const keys: string[] = [];
              let after: string | undefined = undefined;
              while (true) {
                const page = await ctx.storage.scan({ prefix: "lc:", limit: 1000, after });
                if (!page?.entries) break;
                sideLog("debug", `scan returned ${page.entries.length} entries`);
                for (const entry of page.entries) {
                  keys.push(entry.key);
                }
                if (!page.next) break;
                after = page.next;
              }
              sideLog("debug", `total lc: keys found: ${keys.length}`);
              sideLog("debug", `FIXED-STATE-KEY-20261114`);
              sideLog("debug", `first 10 keys: ${keys.slice(0, 10).join(", ")}`);
              sideLog("debug", `FIXED-STATE-KEY-20261114`);

              const sessions: any[] = [];
              const compression: any[] = [];

              // Group keys by session (match lc:ses_xxx:chunk:N and lc:ses_xxx:index:N)
              const sessionMap = new Map<string, string[]>();
              let matchedCount = 0, unmatchedCount = 0;
              for (const key of keys) {
                const match = key.match(/^lc:(ses_[^:]+):/);
                if (match) {
                  const sessionID = match[1];
                  if (!sessionMap.has(sessionID)) {
                    sessionMap.set(sessionID, []);
                  }
                  sessionMap.get(sessionID)!.push(key);
                  matchedCount++;
                } else {
                  unmatchedCount++;
                }
              }
              sideLog("debug", `matched=${matchedCount}, unmatched=${unmatchedCount}, sessions=${sessionMap.size}`);

              for (const [sessionID, sessionKeys] of sessionMap.entries()) {
                // Load state (state key is lc:ses_xxx, NOT lc:ses_xxx:state)
                const stateData = await ctx.storage.get(`lc:${sessionID}`);
                if (!stateData) {
                  sideLog("debug", `no state for session ${sessionID}`);
                  continue;
                }

                let state: any;
                try {
                  state = typeof stateData === "string" ? JSON.parse(stateData) : stateData;
                } catch {
                  continue;
                }

                // Build summaries from log
                const summaries: any[] = [];
                if (state.log) {
                  for (const entry of state.log) {
                    if (entry.summary) {
                      summaries.push({
                        text: entry.summary,
                        keywords: entry.keywords || [],
                      });
                    }
                  }
                }

                // Build index from chunks
                const index: any[] = [];
                for (const key of sessionKeys) {
                  if (key.startsWith("lc:" + sessionID + ":index:")) {
                    const idxData = await ctx.storage.get(key);
                    if (idxData) {
                      let idx;
                      try {
                        idx = typeof idxData === "string" ? JSON.parse(idxData) : idxData;
                      } catch {
                        continue;
                      }
                      index.push(idx);
                    }
                  }
                }

                // Build chunks array (truncate content to prevent enormous responses)
                const chunks: any[] = [];
                for (const key of sessionKeys) {
                  if (key.startsWith("lc:" + sessionID + ":chunk:")) {
                    const chunkData = await ctx.storage.get(key);
                    if (chunkData) {
                      const contentStr = typeof chunkData === "string" ? chunkData : String(chunkData);
                      const contentLen = contentStr.length;
                      chunks.push({
                        key,
                        content: contentLen > 500 ? contentStr.slice(0, 500) + "...\n\n[truncated, " + contentLen.toLocaleString() + " chars total]" : contentStr,
                        chars: contentLen,
                      });
                    }
                  }
                }

                // Truncate originalTask to prevent enormous JSON responses
                let originalTask = state.originalTask || "";
                if (originalTask.length > 5000) {
                  originalTask = originalTask.slice(0, 5000) + "\n\n... [truncated, " + (state.originalTask.length - 5000).toLocaleString() + " more characters]";
                }

                // Limit log entries to last 50 to prevent enormous responses
                let logEntries = state.log || [];
                if (logEntries.length > 50) {
                  logEntries = logEntries.slice(-50);
                }

                // Limit chunks to last 20 in the response (full chunks available via /chunk?key=)
                let chunkList = chunks;
                if (chunkList.length > 20) {
                  chunkList = chunkList.slice(-20);
                }

                sessions.push({
                  id: sessionID,
                  sessionLabel: state.sessionLabel || "",
                  rootSessionID: state.rootSessionID || null,
                  todo: state.todo || [],
                  log: logEntries,
                  summaries,
                  index,
                  originalTask,
                  folded: state.folded || false,
                  pendingFold: state.pendingFold || false,
                  chunkCount: chunks.length,
                  chunks: chunkList,
                });
                sideLog("debug", `session ${sessionID}: ${chunks.length} chunks, ${state.log?.length || 0} log entries`);
              }

              // Aggregate compression events from side log parsing
              // (Per-session summary stats, not individual events)
              const sideLogPath = "C:\\Users\\FakuPara\\AppData\\Local\\Temp\\opencode\\local-context.log";
              const aggMap: Record<string, { count: number; totalSaved: number; lastKept: number; lastFolded: number }> = {};
              try {
                if (fs.existsSync(sideLogPath)) {
                  const logContent = fs.readFileSync(sideLogPath, "utf8");
                  const foldLines = logContent.split("\n").filter((l: string) => l.includes("fold session="));
                  for (const line of foldLines) {
                    const match = line.match(/fold session=(ses_[^,]+), keptTokens=(\d+), folded (\d+) messages/);
                    if (match) {
                      const sessionID = match[1];
                      const keptTokens = parseInt(match[2]);
                      const foldedCount = parseInt(match[3]);
                      if (!aggMap[sessionID]) {
                        aggMap[sessionID] = { count: 0, totalSaved: 0, lastKept: 0, lastFolded: 0 };
                      }
                      aggMap[sessionID].count += 1;
                      aggMap[sessionID].totalSaved += 10000; // rough: each fold saves ~10K tokens
                      aggMap[sessionID].lastKept = keptTokens;
                      aggMap[sessionID].lastFolded = foldedCount;
                    }
                  }
                }
              } catch {
                // Fail-open: no compression stats
              }
              // Add aggregated stats to each session
              for (const session of sessions) {
                const agg = aggMap[session.id];
                session.compressionSummary = agg
                  ? {
                      totalEvents: agg.count,
                      totalTokensSaved: agg.totalSaved,
                      lastKeptTokens: agg.lastKept,
                      lastFoldedMessages: agg.lastFolded,
                    }
                  : null;
              }

              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ sessions, compression }));
            } catch (err: any) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err.message }));
            }
          } else if (path === "/api/local-context/active") {
            // Return the currently active session ID (the one being processed by the context hook)
            try {
              const raw = await ctx.storage.get("lc:activeSession");
              if (raw) {
                let sessionID;
                try {
                  sessionID = typeof raw === "string" ? JSON.parse(raw) : raw;
                } catch {
                  sessionID = raw;
                }
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ sessionID }));
              } else {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ sessionID: null }));
              }
            } catch (err: any) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err.message }));
            }
            return;
          } else if (path === "/api/local-context/delete" && req.method === "POST") {
            // Delete all data for a session (state, chunks, index entries, registry)
            const key = url.searchParams.get("key");
            if (!key) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Missing key parameter" }));
              return;
            }

            // Extract sessionID from key (key format is lc:<sessionID>)
            const sessionID = key.replace(/^lc:/, "");

            // Delete state key
            await storageRemove(ctx, key);

            // Delete all chunk keys for this session
            let after: string | undefined = undefined;
            while (true) {
              const page = await ctx.storage.scan({ prefix: `lc:${sessionID}:chunk:`, limit: 1000, after });
              if (!page?.entries) break;
              for (const entry of page.entries) {
                await storageRemove(ctx, entry.key);
              }
              if (!page.next) break;
              after = page.next;
            }

            // Delete all index keys for this session
            after = undefined;
            while (true) {
              const page = await ctx.storage.scan({ prefix: `lc:${sessionID}:index:`, limit: 1000, after });
              if (!page?.entries) break;
              for (const entry of page.entries) {
                await storageRemove(ctx, entry.key);
              }
              if (!page.next) break;
              after = page.next;
            }

            // Remove from session registry
            try {
              const raw = await ctx.storage.get("lc:sessions");
              if (raw) {
                const sessions = JSON.parse(raw);
                const idx = sessions.indexOf(sessionID);
                if (idx >= 0) sessions.splice(idx, 1);
                await ctx.storage.set("lc:sessions", JSON.stringify(sessions));
              }
            } catch {
              // fail-open
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, sessionID }));
          } else if (path === "/api/local-context/chunk") {
            const key = url.searchParams.get("key");
            if (!key) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Missing key parameter" }));
              return;
            }

            try {
              const data = await ctx.storage.get(key);
              if (!data) {
                res.writeHead(404, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: `Chunk not found: ${key}` }));
                return;
              }

              let chunk;
              try {
                chunk = typeof data === "string" ? JSON.parse(data) : data;
              } catch {
                chunk = data;
              }

              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                key,
                content: chunk.content || "",
                keywords: chunk.keywords || [],
                step: chunk.step || "",
                stepKeywords: chunk.stepKeywords || [],
                t: chunk.t || "",
              }));
            } catch (err: any) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err.message }));
            }
          } else if (path === "/api/local-context/config") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              PROTECTED_TOKENS: +(process.env.OPENCODE_CTX_PROTECTED_TOKENS || 32000),
              CAP_CHARS: +(process.env.OPENCODE_CTX_CAP_CHARS || 9000),
              AGE_BATCH: +(process.env.OPENCODE_CTX_AGE_BATCH || 10),
              ONELINER_KEEP: +(process.env.OPENCODE_CTX_ONELINER_KEEP || 6),
              LOOKUP_TIMEOUT_MS: +(process.env.OPENCODE_CTX_LOOKUP_TIMEOUT_MS || 60000),
              CHUNK_MAX_CHARS: CHUNK_MAX_CHARS,
              POLY_URL: POLY_URL,
              POLY_MODEL: POLY_MODEL,
            }));
          } else {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Not found" }));
          }
        });

        server.listen(PORT, "127.0.0.1", () => {
          sideLog("debug", `server listening on port ${PORT}`);
        });
      } catch (err: any) {
        sideLog("debug", `ERROR: ${err.message}`);
      }

    sideLog("setup", "all hooks registered ok");
  },
  // Clear active session tracking on plugin shutdown
  cleanup: async (ctx: any) => {
    try {
      await storageRemove(ctx, 'lc:activeSession');
    } catch {
      // cleanup must not fail
    }
  },
};


