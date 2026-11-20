// tests/harness.ts — Offline test harness for local-context.ts todo flows.
// Run from E:\_tools\strata\opencode-plugin:
//   node --experimental-strip-types tests/harness.ts
//
// Uses a mock ctx, captured registrations, in-memory storage.
// Does NOT run opencode.

// ---------------------------------------------------------------------------
// Zero: suppress debug server (binds random port → no collision with 8765)
// ---------------------------------------------------------------------------
process.env.OPENCODE_CTX_DEBUG_PORT = "0";
process.env.OPENCODE_CTX_PROTECTED_TOKENS = "2000";

// ---------------------------------------------------------------------------
// One: tiny assert helper (counts pass/fail, exits 1 on any failure)
// ---------------------------------------------------------------------------
const PASS: number[] = [];
const FAIL: { msg: string }[] = [];

function assert(
  cond: boolean,
  msg: string,
): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    FAIL.push({ msg });
  } else {
    PASS.push(PASS.length);
    console.log(`  pass #${PASS.length}: ${msg}`);
  }
}

function assertContains(
  haystack: string | undefined,
  needle: string,
  label: string,
): void {
  if (typeof haystack !== "string" || !haystack.includes(needle)) {
    const actual = typeof haystack === "string" ? haystack.slice(0, 600) : JSON.stringify(haystack);
    console.error(`FAIL: ${label} — expected "${needle}" in output, got: ${actual.slice(0, 400)}`);
    FAIL.push({ msg: `${label}: expected "${needle}" in ${JSON.stringify(haystack)}` });
  } else {
    PASS.push(PASS.length);
    console.log(`  pass #${PASS.length}: ${label}`);
  }
}

// ---------------------------------------------------------------------------
// assert helper variant: expects a thrown error containing a needle string
// ---------------------------------------------------------------------------

async function expectThrow(
  fn: () => Promise<any>,
  needle: string,
  label: string,
): Promise<void> {
  try {
    await fn();
    assert(false, label + ": expected a thrown error containing \"" + needle + "\"");
  } catch (err: any) {
    assert(String(err?.message || err).includes(needle), label + ": error contains \"" + needle + "\" (got: " + String(err?.message || err).slice(0, 120) + ")");
  }
}

// ---------------------------------------------------------------------------
// Two: helpers to build a mock ctx + in-memory storage
// ---------------------------------------------------------------------------

function makeStorage(opts: { remove?: boolean; deleteFn?: boolean } = {}): {
  map: Map<string, string>;
  storage: any;
  removeCalls: string[];
  deleteCalls: string[];
} {
  const map = new Map<string, string>();
  const removeCalls: string[] = [];
  const deleteCalls: string[] = [];

  const storage: any = {
    async get(key: string): Promise<string | undefined> {
      return map.get(key);
    },
    async set(key: string, value: string): Promise<void> {
      map.set(key, value);
    },
    async scan(input: { prefix: string }): Promise<{ entries: { key: string; value: string }[] }> {
      const prefix = input.prefix;
      const entries: { key: string; value: string }[] = [];
      for (const [k, v] of map.entries()) {
        if (k.startsWith(prefix)) entries.push({ key: k, value: v });
      }
      return { entries };
    },
  };

  if (opts.remove !== false) {
    storage.remove = async (key: string): Promise<void> => {
      map.delete(key);
      removeCalls.push(key);
    };
  }
  // deleteFn defaults to true (present) unless explicitly false
  if (opts.deleteFn !== false) {
    storage.delete = async (key: string): Promise<void> => {
      map.delete(key);
      deleteCalls.push(key);
    };
  }

  return { map, storage, removeCalls, deleteCalls };
}

function makeMockCtx(storage: any): any {
  const toolDefs: any[] = [];
  const toolHooks: Record<string, any> = {};
  const sessionHooks: Record<string, any> = {};
  const commands: any[] = [];

  const ctx: any = {
    tool: {
      transform(cb: (reg: any) => void): void {
        const reg = {
          add: (def: any) => {
            toolDefs.push(def);
          },
        };
        cb(reg);
      },
      hook(name: string, cb: any): void {
        toolHooks[name] = cb;
      },
    },
    session: {
      hook(name: string, cb: any): void {
        sessionHooks[name] = cb;
      },
      get: () => { throw new Error("session.get should not be called in these tests"); },
      create: () => {
        if (ctx.generateResponse) {
          return { id: "temp_lookup_session" };
        }
        throw new Error("session.create should not be called in these tests");
      },
      generate: async (params: any) => {
        if (ctx.generateResponse) {
          return { text: ctx.generateResponse(params) };
        }
        throw new Error("session.generate should not be called in these tests");
      },
      remove: async () => {
        if (ctx.generateResponse) {
          return;
        }
        throw new Error("session.remove should not be called in these tests");
      },
    },
    command: {
      transform(cb: (editor: any) => void): void {
        const editor = {
          add: (def: any) => {
            commands.push(def);
          },
        };
        cb(editor);
      },
    },
    storage,
    // Captured helpers
    toolDefs,
    toolHooks,
    sessionHooks,
    commands,
  };

  return ctx;
}

// ---------------------------------------------------------------------------
// Three: Group A — single shared mock ctx for the full lifecycle
//   A1: plan with plain string → error
//   A2: plan with 3 valid tasks → checklist + storage state
//   A3: done with valid story, no steps → ERROR
//   A4: done steps [1,2] + valid story → [x] marks + state update
//   A5: done step [3] + valid story → [All tasks complete], report saved, wipe
//   A6: todo_lookup with sessionID param
//   A7: todo_lookup via context.sessionID
// ---------------------------------------------------------------------------

async function runGroupA(): Promise<void> {
  console.log("\n=== Group A: Full todo lifecycle ===\n");

  const { map, storage, removeCalls, deleteCalls } = makeStorage();
  const ctx = makeMockCtx(storage);

  // Import and run plugin setup
  const setup = (await import("../local-context.ts")).default;
  await setup.setup(ctx);

  const planTool = ctx.toolDefs.find((t: any) => t.name === "todo")!;
  const lookupTool = ctx.toolDefs.find((t: any) => t.name === "todo_lookup")!;
  const sid = "ses_testA";

  // ---------- A1: plan with plain string → throws validation error ----------
  {
    console.log("\n--- A1: plan with plain string item ---");
    await expectThrow(
      () => planTool.execute(
        { action: "plan", items: ["plain string"] },
        { sessionID: sid },
      ),
      "each plan item must be an object",
      "A1: error mentions object format",
    );
    await expectThrow(
      () => planTool.execute(
        { action: "plan", items: ["plain string"] },
        { sessionID: sid },
      ),
      '{"text"',
      "A1: error shows JSON of offending item",
    );
  }

  // ---------- A2: plan with 3 valid tasks → checklist + storage state ----------
  {
    console.log("\n--- A2: plan with 3 valid tasks ---");
    const tasks = [
      { text: "Read local-context.ts", goal: "Understand the plugin API surface" },
      { text: "Write harness.ts", goal: "Create the test file with mock ctx" },
      { text: "Run the harness", goal: "All tests pass" },
    ];
    const result = await planTool.execute(
      { action: "plan", items: tasks },
      { sessionID: sid },
    );
    assertContains(result.content, "Read local-context.ts", "A2: checklist shows task 1 text");
    assertContains(result.content, "Write harness.ts", "A2: checklist shows task 2 text");
    assertContains(result.content, "Run the harness", "A2: checklist shows task 3 text");
    assertContains(result.content, "Goal:", "A2: checklist shows at least one Goal: line");

    const stateRaw = map.get(`lc:${sid}`);
    assert(stateRaw !== undefined, "A2: storage has state key lc:sess_testA");
    const state = JSON.parse(stateRaw!);
    assert(state.todo.length === 3, "A2: state.todo has length 3");
  }

  // ---------- A3: done with valid story, no step numbers → throws ----------
  {
    console.log("\n--- A3: done with valid story, no steps ---");
    // This story is past tense, >30 chars.
    await expectThrow(
      () =>
        planTool.execute(
          {
            action: "done",
            done: [],
            completionStory:
              "Implemented the storageRemove helper and verified all delete call sites were replaced via grep.",
          },
          { sessionID: sid },
        ),
      "ERROR: no steps were marked done",
      "A3: no-step guard fires",
    );
  }

  // ---------- A4: done steps [1,2] with valid story → [x] marks ----------
  {
    console.log("\n--- A4: done steps [1,2] with valid story ---");
    const result = await planTool.execute(
      {
        action: "done",
        done: [1, 2],
        completionStory:
          "Read the plugin file thoroughly, understood the tool registration hooks, and mapped out all the API surface points for the harness design.",
      },
      { sessionID: sid },
    );
    assertContains(result.content, "[x] 1.", "A4: task 1 marked [x]");
    assertContains(result.content, "[x] 2.", "A4: task 2 marked [x]");
    assertContains(result.content, "[ ] 3.", "A4: task 3 still [ ]");
    assertContains(result.content, "Context warning", "A4: done output carries the context-drop warning");

    const stateRaw = map.get(`lc:${sid}`);
    const state = JSON.parse(stateRaw!);
    assert(state.todo[0].done, "A4: task 1 done in state");
    assert(state.todo[1].done, "A4: task 2 done in state");
    assert(!state.todo[2].done, "A4: task 3 not done in state");
    assert(
      typeof state.todo[0].completionStory === "string" && state.todo[0].completionStory.length > 0,
      "A4: task 1 has completionStory set",
    );
    assert(
      typeof state.todo[1].completionStory === "string" && state.todo[1].completionStory.length > 0,
      "A4: task 2 has completionStory set",
    );
  }

  // ---------- A5: done step [3] with valid story → [All tasks complete] ----------
  {
    console.log("\n--- A5: done step [3] → cleanup + report ---");
    const result = await planTool.execute(
      {
        action: "done",
        done: [3],
        completionStory:
          "Tested the offline harness end-to-end, verified all the todo flows work correctly, and confirmed the mock context captures every registration point in the plugin.",
      },
      { sessionID: sid },
    );
    assertContains(result.content, "[All tasks complete", "A5: completion note in output");

    // Report saved in storage
    const reportRaw = map.get(`lc:report:${sid}`);
    assert(reportRaw !== undefined, "A5: report key lc:report:sess_testA exists in storage");
    const report = JSON.parse(reportRaw!);
    assert(report.tasks.length === 3, "A5: report has 3 tasks");
    for (const t of report.tasks) {
      assert(typeof t.completionStory === "string" && t.completionStory.length > 0,
        `A5: report task "${t.text}" has completionStory`);
    }

    // Disk file exists under PERSIST_DIR
    const fs = await import("node:fs");
    const path = await import("node:path");
    const persistDir = "C:\\Users\\FakuPara\\AppData\\Local\\Temp\\opencode\\lc-persist";
    const diskPath = path.join(persistDir, `${sid}.report.json`);
    assert(fs.existsSync(diskPath), `A5: disk file exists at ${diskPath}`);

    // State key gone
    assert(map.get(`lc:${sid}`) === undefined, "A5: state key lc:sess_testA is GONE");

    // All chunk keys gone
    let chunkKeyMissing = true;
    for (const key of map.keys()) {
      if (key.startsWith(`lc:${sid}:chunk:`)) {
        chunkKeyMissing = false;
        break;
      }
    }
    assert(chunkKeyMissing, "A5: all lc:sess_testA:chunk:* keys are GONE");

    // lc:sessions no longer contains sid
    const sessionsRaw = map.get("lc:sessions");
    if (sessionsRaw) {
      const sessions = JSON.parse(sessionsRaw);
      assert(!sessions.includes(sid), "A5: lc:sessions no longer contains sess_testA");
    } else {
      // If sessions list doesn't exist, that's also fine (it was wiped)
      assert(true, "A5: lc:sessions key does not exist (was wiped)");
    }

    // Clean up disk file
    if (fs.existsSync(diskPath)) fs.unlinkSync(diskPath);
    // Clean up report key
    map.delete(`lc:report:${sid}`);
  }

  // ---------- A6: todo_lookup with sessionID param ----------
  {
    console.log("\n--- A6: todo_lookup with sessionID param ---");
    // Set the report key directly (no state) so lookup serves the report path.
    // todo_lookup: if state has todo.length, it serves state; otherwise serves report.
    await storage.set(
      `lc:report:${sid}`,
      JSON.stringify({
        sessionID: sid,
        completedAt: "2024-01-01T12:00:00.000Z",
        tasks: [
          { text: "A", goal: "G", done: true, completionStory: "Story for A", doneAt: "10:00" },
          { text: "B", goal: "G", done: true, completionStory: "Story for B", doneAt: "10:01" },
        ],
      }),
    );
    const result = await lookupTool.execute(
      { sessionID: sid },
      { sessionID: sid },
    );
    assertContains(result.content, "Completion report", "A6: lookup serves completion report");
    assertContains(result.content, "Story:", "A6: lookup shows at least one Story: line");
    assert(result.content.includes("[done]"), "A6: status should be [done] for completed tasks");
    assert(!result.content.includes("[open]"), "A6: status should NOT be [open] for completed tasks");
    map.delete(`lc:report:${sid}`);
  }

  // ---------- A7: todo_lookup via context.sessionID (no param) ----------
  {
    console.log("\n--- A7: todo_lookup via context.sessionID ---");
    await storage.set(
      `lc:report:${sid}`,
      JSON.stringify({
        sessionID: sid,
        completedAt: "2024-01-01T12:00:00.000Z",
        tasks: [
          { text: "C", goal: "G", done: true, completionStory: "Story for C", doneAt: "10:02" },
        ],
      }),
    );
    // Note: params.sessionID is undefined → tool falls back to context.sessionID
    const result = await lookupTool.execute(
      {},
      { sessionID: sid },
    );
    assertContains(result.content, "Completion report", "A7: lookup via context.sessionID finds report");
    assertContains(result.content, "Story:", "A7: lookup via context shows Story: line");
    map.delete(`lc:report:${sid}`);
  }
}

// ---------------------------------------------------------------------------
// Four: Group B — storageRemove fallback (delete-only storage)
// ---------------------------------------------------------------------------

async function runGroupB(): Promise<void> {
  console.log("\n=== Group B: storageRemove fallback (delete-only) ===\n");

  // Storage variant: remove is ABSENT, delete exists
  const { map, storage, removeCalls, deleteCalls } = makeStorage({ remove: false });
  const ctx = makeMockCtx(storage);

  const setup = (await import("../local-context.ts")).default;
  await setup.setup(ctx);

  const planTool = ctx.toolDefs.find((t: any) => t.name === "todo")!;
  const sid = "ses_testB";

  // Run the full plan→done→all-done lifecycle; wipeSession calls storageRemove
  // for each chunk + state key. With remove absent, delete must be used.
  await planTool.execute(
    {
      action: "plan",
      items: [
        { text: "B-1", goal: "Goal 1" },
        { text: "B-2", goal: "Goal 2" },
        { text: "B-3", goal: "Goal 3" },
      ],
    },
    { sessionID: sid },
  );

  await planTool.execute(
    {
      action: "done",
      done: [1, 2],
      completionStory:
        "Completed tasks B-1 and B-2 by implementing the required logic and running the verification tests successfully.",
    },
    { sessionID: sid },
  );

  await planTool.execute(
    {
      action: "done",
      done: [3],
      completionStory:
        "Finished task B-3 by writing the final implementation and confirming all tests pass with no regressions.",
    },
    { sessionID: sid },
  );

  // After all-done: wipeSession called storageRemove for chunks + state.
  // Verify delete was called (since remove is absent).
  assert(deleteCalls.length > 0, "B1: storage.delete was called during wipe path");
  assert(removeCalls.length === 0, "B1: storage.remove was NOT called (remove absent)");

  // Verify all lc:sess_testB keys are gone
  let keysRemaining = 0;
  for (const key of map.keys()) {
    if (key.startsWith("lc:sess_testB")) keysRemaining++;
  }
  assert(keysRemaining === 0, "B1: all lc:sess_testB keys removed after wipe");

  // Clean up report key if it survived
  map.delete(`lc:report:${sid}`);
}

// ---------------------------------------------------------------------------
// Five: Group C — /add-task command + context hook
// ---------------------------------------------------------------------------

async function runGroupC(): Promise<void> {
  console.log("\n=== Group C: /add-task command + context hook ===\n");

  const { map, storage } = makeStorage();
  const ctx = makeMockCtx(storage);

  const setup = (await import("../local-context.ts")).default;
  await setup.setup(ctx);

  const addTaskCmd = ctx.commands.find((c: any) => c.name === "add-task")!;
  const sid = "ses_testC";

  // Pre-plan 3 tasks so /add-task has state
  const planTool = ctx.toolDefs.find((t: any) => t.name === "todo")!;
  await planTool.execute(
    {
      action: "plan",
      items: [
        { text: "C-1", goal: "Goal 1" },
        { text: "C-2", goal: "Goal 2" },
        { text: "C-3", goal: "Goal 3" },
      ],
    },
    { sessionID: sid },
  );

  // ---------- C1: /add-task ----------
  {
    console.log("\n--- C1: /add-task command ---");
    const result = await addTaskCmd.execute({
      sessionID: sid,
      prompt: { text: "New task from command" },
    });
    assertContains(result, "Task added", "C1: /add-task returns 'Task added'");

    const stateRaw = map.get(`lc:${sid}`);
    const state = JSON.parse(stateRaw!);
    const lastTask = state.todo[state.todo.length - 1];
    assert(lastTask.text === "New task from command", "C1: new task has correct text");
    assert(lastTask.goal === "", "C1: new task has empty goal");
    assert(state.pendingTaskCount === 1, "C1: pendingTaskCount is 1 after add-task");
  }

  // ---------- C2: context hook (one-shot pendingTaskCount clear) ----------
  {
    console.log("\n--- C2: context hook triggers pendingTaskCount clear ---");
    const contextHook = ctx.sessionHooks["context"]!;
    const hookInput = {
      sessionID: sid,
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
    };
    await contextHook(hookInput);

    const stateRaw = map.get(`lc:${sid}`);
    const state = JSON.parse(stateRaw!);
    assert(state.pendingTaskCount === 0, "C2: pendingTaskCount cleared to 0 after context hook");
  }

  // ---------- C3: context hook second call — no throw, consistent ----------
  {
    console.log("\n--- C3: context hook second call — no throw ---");
    const contextHook = ctx.sessionHooks["context"]!;
    let threw = false;
    try {
      await contextHook({
        sessionID: sid,
        messages: [
          { role: "user", content: [{ type: "text", text: "hello again" }] },
        ],
      });
    } catch {
      threw = true;
    }
    assert(!threw, "C3: context hook does not throw on second call");

    // State still consistent (pendingTaskCount should still be 0)
    const stateRaw = map.get(`lc:${sid}`);
    const state = JSON.parse(stateRaw!);
    assert(state.pendingTaskCount === 0, "C3: pendingTaskCount still 0 after second call");
  }
}

// ---------------------------------------------------------------------------
// Five: Group D — fold + keys line + history_lookup
// ---------------------------------------------------------------------------

async function runGroupD(): Promise<void> {
  console.log("\n=== Group D: fold + keys line + history_lookup ===\n");

  const { map, storage } = makeStorage();
  const ctx = makeMockCtx(storage);

  const setup = (await import("../local-context.ts")).default;
  await setup.setup(ctx);

  const planTool = ctx.toolDefs.find((t: any) => t.name === "todo")!;
  const lookupTool = ctx.toolDefs.find((t: any) => t.name === "history_lookup")!;
  const sid = "ses_testD";

  // Build a 3000-char filler containing "wombat_reserve corridor"
  const fillerBase = "wombat_reserve corridor ";
  let fillerText = "";
  while (fillerText.length < 3000) {
    fillerText += fillerBase;
  }
  fillerText = fillerText.slice(0, 3000);

  // Shared helper: creates an assistant message with filler text
  const assistantMsg = (i: number) => ({
    role: "assistant" as const,
    content: "Assistant message number " + i + ": " + fillerText,
  });

  // ---------- D1: fold + keys line ----------
  {
    console.log("\n--- D1: fold triggers, keys line in step-log ---");
    await planTool.execute(
      {
        action: "plan",
        items: [
          { text: "D1-1: Plan and execute the wombat task", goal: "Get it done" },
          { text: "D1-2: Second task", goal: "Also done" },
        ],
      },
      { sessionID: sid },
    );

    await planTool.execute(
      {
        action: "done",
        done: [1],
        completionStory:
          "Planned the wombat task, executed the plan, and verified the output was correct.",
      },
      { sessionID: sid },
    );

    const hookInput = {
      sessionID: sid,
      messages: [
        { role: "system" as const, content: [{ type: "text", text: "You are a helpful assistant." }] },
        { role: "user" as const, content: [{ type: "text", text: "Anchor task: build the wombat reserve corridor" }] },
        assistantMsg(1),
        assistantMsg(2),
        assistantMsg(3),
        assistantMsg(4),
      ],
    };

    const contextHook = ctx.sessionHooks["context"]!;
    await contextHook(hookInput);

    // Assert: storage has a chunk key
    let hasChunk = false;
    for (const key of map.keys()) {
      if (key.startsWith("lc:" + sid + ":chunk:")) {
        hasChunk = true;
        break;
      }
    }
    assert(hasChunk, "D1: storage has a chunk key for the session");

    // Assert: one ev.messages entry text contains "[FOLDED CONTEXT KEYS]" and "wombat"
    let hasKeysLine = false;
    for (const msg of hookInput.messages) {
      const txt = typeof msg.content === "string" ? msg.content : "";
      if (msg.content && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (typeof part.text === "string") {
            if (part.text.includes("[FOLDED CONTEXT KEYS]") && part.text.includes("wombat")) {
              hasKeysLine = true;
              break;
            }
          }
        }
      }
      if (hasKeysLine) break;
    }
    assert(hasKeysLine, "D1: step-log message contains [FOLDED CONTEXT KEYS] and wombat");

    // Assert: state saved with folded=true
    const stateRaw = map.get(`lc:${sid}`);
    const state = JSON.parse(stateRaw!);
    assert(state.folded === true, "D1: state folded=true after hook");
  }

  // ---------- D2: plain-word query matches ----------
  {
    console.log("\n--- D2: plain-word query matches ----------");
    const result = await lookupTool.execute(
      { query: "wombat corridor" },
      { sessionID: sid },
    );
    assert(!result.content.includes("No matching history"),
      "D2: query 'wombat corridor' does NOT produce no-match response");
    assert(result.content.includes("written to:"),
      "D2: output contains 'written to:'");
    assert(result.content.includes("Lines:"),
      "D2: output contains 'Lines:'");

    // Extract file path from content (next line after "written to:")
    const lines = result.content.split("\n");
    let filePath = "";
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("written to:")) {
        // Path is on the next line
        filePath = (lines[i + 1] || "").trim();
        break;
      }
    }
    const fs = await import("node:fs");
    const path = await import("node:path");
    assert(fs.existsSync(filePath), "D2: written file exists at extracted path");
    const fileContent = fs.readFileSync(filePath, "utf8");
    assert(fileContent.includes("wombat"),
      "D2: file content contains 'wombat'");
    // Clean up for test hygiene
    try { fs.unlinkSync(filePath); } catch { /* fail-open */ }
  }

  // ---------- D3: self-healing no-match ----------
  {
    console.log("\n--- D3: self-healing no-match ----------");
    const result = await lookupTool.execute(
      { query: "zzzqqq unrelated stuff" },
      { sessionID: sid },
    );
    assertContains(result.content, "Available keywords in folded chunks",
      "D3: no-match response lists available keywords");
    assertContains(result.content, "wombat_reserve",
      "D3: available keywords include wombat_reserve");
  }

  // ---------- D4: between-folds refresh keeps keys line ----------
  {
    console.log("\n--- D4: between-folds refresh keeps keys line ----------");
    const contextHook = ctx.sessionHooks["context"]!;
    const d4Msgs: any[] = [
      { role: "system", content: [{ type: "text", text: "You are a helpful assistant." }] },
      { role: "user", content: [{ type: "text", text: "Anchor task: build the wombat reserve corridor" }] },
      assistantMsg(1),
      assistantMsg(2),
      assistantMsg(3),
      assistantMsg(4),
    ];
    // Store reference to input object so we can check ev.messages after the hook
    const input = {
      sessionID: sid,
      messages: d4Msgs,
    };
    await contextHook(input);

    // The hook does `ev.messages = newMessages` which replaces the reference.
    // Check the updated array from the input object, not d4Msgs.
    const updatedMsgs = input.messages!;
    let hasKeysLineAfterRefresh = false;
    for (let mi = 0; mi < updatedMsgs.length; mi++) {
      const msg = updatedMsgs[mi];
      if (msg.content && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (typeof part.text === "string" && part.text.includes("[FOLDED CONTEXT KEYS]")) {
            hasKeysLineAfterRefresh = true;
            break;
          }
        }
      }
      if (hasKeysLineAfterRefresh) break;
    }
    assert(hasKeysLineAfterRefresh, "D4: step-log still contains [FOLDED CONTEXT KEYS] after refresh");
  }
}


// ---------------------------------------------------------------------------
// Seven: Run all groups
// ---------------------------------------------------------------------------

(async () => {
  try {
    await runGroupA();
    await runGroupB();
    await runGroupC();
    await runGroupD();
  } catch (err: any) {
    console.error(`\nCRASH: ${err.message}\n${err.stack}`);
    process.exit(1);
  }

  console.log(`\n========================================`);
  console.log(`Results: ${PASS.length} passed, ${FAIL.length} failed`);
  console.log(`========================================`);

  if (FAIL.length > 0) {
    console.error("\nFailures:");
    for (const f of FAIL) {
      console.error(`  ✗ ${f.msg}`);
    }
    process.exit(1);
  } else {
    console.log("\nAll tests passed.");
    process.exit(0);
  }
})();
