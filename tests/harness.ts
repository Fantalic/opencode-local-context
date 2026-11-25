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
// Six: Group E — todo show + update
// ---------------------------------------------------------------------------

async function runGroupE(): Promise<void> {
  console.log("\n=== Group E: todo show + update ===\n");

  const { map, storage } = makeStorage();
  const ctx = makeMockCtx(storage);
  const setup = (await import("../local-context.ts")).default;
  await setup.setup(ctx);

  const todoTool = ctx.toolDefs.find((t: any) => t.name === "todo")!;
  const sid = "sess_E";

  // ---------- E1: show with no state ----------
  {
    console.log("\n--- E1: show with no state ---");
    const result = await todoTool.execute({ action: "show" }, { sessionID: sid });
    assertContains(result.content, "No active todo list for session " + sid, "E1: shows 'No active todo list' message");
    assertContains(result.content, "todo_lookup", "E1: mentions todo_lookup");
  }

  // ---------- E2: plan then show ----------
  {
    console.log("\n--- E2: plan 3 tasks then show ---");
    await todoTool.execute(
      {
        action: "plan",
        items: [
          { text: "Task A", goal: "Goal A" },
          { text: "Task B", goal: "Goal B" },
          { text: "Task C", goal: "Goal C" },
        ],
      },
      { sessionID: sid },
    );
    const result = await todoTool.execute({ action: "show" }, { sessionID: sid });
    assertContains(result.content, "Tasks for session " + sid + ": 0/3 done, 3 open", "E2: show summary line");
    assertContains(result.content, "Task A", "E2: contains Task A");
    assertContains(result.content, "Task B", "E2: contains Task B");
    assertContains(result.content, "Task C", "E2: contains Task C");
  }

  // ---------- E3: update set preserves done ----------
  {
    console.log("\n--- E3: update set preserves done ---");
    // Mark task 1 done
    await todoTool.execute(
      {
        action: "done",
        done: [1],
        completionStory: "Completed task A by implementing and verifying the expected output.",
      },
      { sessionID: sid },
    );
    // Update: change task 1 text via set
    const updateResult = await todoTool.execute(
      {
        action: "update",
        ops: [{ op: "set", index: 1, text: "Task A revised" }],
      },
      { sessionID: sid },
    );
    assertContains(updateResult.content, "Task A revised", "E3: updated text visible in output");
    assertContains(updateResult.content, "[x]", "E3: done mark preserved in output");
    assertContains(updateResult.content, "Done steps keep their completion stories", "E3: done-steps-preserved message");

    // Verify state: task 1 still done, same story, new text
    const stateRaw = map.get("lc:" + sid);
    const state = JSON.parse(stateRaw!);
    assert(state.todo[0].done === true, "E3: task 1 still done in state");
    assert(
      state.todo[0].completionStory === "Completed task A by implementing and verifying the expected output.",
      "E3: task 1 completionStory preserved",
    );
    assert(state.todo[0].text === "Task A revised", "E3: task 1 text updated to 'Task A revised'");
  }

  // ---------- E4: update add/remove/move ----------
  {
    console.log("\n--- E4: update add/remove/move ---");
    // Current state before this op:
    //   1=Task A revised (done), 2=Task B (open), 3=Task C (open)
    // remove index 2 → removes Task B (original index 2)
    // add Task D → appends
    // move from 3 (Task C) to position 1 → Task C goes to front
    // Expected final order: Task C, Task A revised, Task B is gone, Task D
    const updateResult = await todoTool.execute(
      {
        action: "update",
        ops: [
          { op: "add", text: "Task D", goal: "Goal D" },
          { op: "remove", index: 2 },
          { op: "move", from: 3, to: 1 },
        ],
      },
      { sessionID: sid },
    );
    // Verify content
    assertContains(updateResult.content, "Task C", "E4: Task C present in output");
    assert(!updateResult.content.includes("Task B"), "E4: Task B removed from output");
    assertContains(updateResult.content, "Task D", "E4: Task D present in output");
    assertContains(updateResult.content, "Task A revised", "E4: Task A revised still in output");

    // Verify state order via storage
    const stateRaw = map.get("lc:" + sid);
    const state = JSON.parse(stateRaw!);
    assert(state.todo.length === 3, "E4: 3 tasks in state after add/remove/move (3 orig - 1 removed + 1 added)");
    assert(state.todo[0].text === "Task C", "E4: Task C is first (moved to position 1)");
    assert(state.todo[1].text === "Task A revised", "E4: Task A revised is second");
    assert(state.todo[2].text === "Task D", "E4: Task D is third (appended)");
    assert(state.todo[0].done === false, "E4: Task C is not done");
    assert(state.todo[1].done === true, "E4: Task A revised is still done");
  }

  // ---------- E5: update rejects remove-done ----------
  {
    console.log("\n--- E5: update rejects remove-done ---");
    // After E4's add/remove/move, current order: 1=Task C (open), 2=Task A revised (done), 3=Task D (open)
    // Use index 2 to target the done step (Task A revised)
    await expectThrow(
      () =>
        todoTool.execute(
          { action: "update", ops: [{ op: "remove", index: 2 }] },
          { sessionID: sid },
        ),
      "Cannot remove done step",
      "E5: rejects removing done step",
    );
  }

  // ---------- E6: update rejects bad index / empty ops / unknown op / no-state ----------
  {
    console.log("\n--- E6: update rejects bad index / empty ops / unknown op / no-state ---");
    // Empty ops
    await expectThrow(
      () =>
        todoTool.execute(
          { action: "update", ops: [] },
          { sessionID: sid },
        ),
      "non-empty ops array",
      "E6: rejects empty ops array",
    );
    // Unknown op type
    await expectThrow(
      () =>
        todoTool.execute(
          { action: "update", ops: [{ op: "nope", index: 1 }] },
          { sessionID: sid },
        ),
      "Invalid op type",
      "E6: rejects unknown op type",
    );
    // Bad index (out of range)
    await expectThrow(
      () =>
        todoTool.execute(
          { action: "update", ops: [{ op: "set", index: 99, text: "x" }] },
          { sessionID: sid },
        ),
      "range 1..",
      "E6: rejects out-of-range index",
    );
    // No state on different session
    await expectThrow(
      () =>
        todoTool.execute(
          { action: "update", ops: [{ op: "set", index: 1, text: "x" }] },
          { sessionID: "sess_E_empty" },
        ),
      "No active todo list",
      "E6: rejects update with no state",
    );
  }
}

// ---------------------------------------------------------------------------
// Six: Group F — compaction todo injection
// ---------------------------------------------------------------------------

async function runGroupF(): Promise<void> {
  console.log("\n=== Group F: compaction todo injection ===\n");

  const { map, storage } = makeStorage();
  const ctx = makeMockCtx(storage);
  const setup = (await import("../local-context.ts")).default;
  await setup.setup(ctx);

  const todoTool = ctx.toolDefs.find((t: any) => t.name === "todo")!;
  const compactionHook = ctx.sessionHooks["compaction"];

  // ---------- F1: compaction with todo state injects checklist ----------
  {
    console.log("\n--- F1: compaction with todo state injects checklist ---");
    assert(compactionHook !== undefined, "F1: compaction hook exists");

    // Plan 2 tasks
    await todoTool.execute(
      {
        action: "plan",
        items: [
          { text: "F1-Task 1", goal: "Goal 1" },
          { text: "F1-Task 2", goal: "Goal 2" },
        ],
      },
      { sessionID: "sess_F" },
    );

    const ev: any = {
      sessionID: "sess_F",
      messages: [
        { role: "user", content: [{ type: "text", text: "Do the thing" }] },
        { role: "assistant", content: [{ type: "text", text: "Working on it" }] },
      ],
      result: undefined,
    };
    await compactionHook(ev);

    assert(ev.result === undefined, "F1: ev.result is undefined (not set by state branch)");
    assert(ev.messages.length === 3, "F1: 3 messages (original 2 + 1 injected)");

    // Check injected message
    const injected = ev.messages[2];
    assert(injected.role === "user", "F1: injected message role is 'user'");
    const injectedText = injected.content[0].text;
    assertContains(injectedText, "[TODO STATE - preserve this checklist in the compaction summary]", "F1: TODO STATE header");
    assertContains(injectedText, "Tasks for session sess_F: 0/2 done, 2 open", "F1: summary line");
    assertContains(injectedText, "F1-Task 1", "F1: contains Task 1");
    assertContains(injectedText, "F1-Task 2", "F1: contains Task 2");
    assertContains(injectedText, 'todo action="show"', "F1: mentions todo action=show");
    assertContains(injectedText, "todo_lookup", "F1: mentions todo_lookup");
  }

  // ---------- F2: compaction with no state sets deterministic summary ----------
  {
    console.log("\n--- F2: compaction with no state sets summary ---");
    const { map: map2, storage: storage2 } = makeStorage();
    const ctx2 = makeMockCtx(storage2);
    await setup.setup(ctx2);

    const ev: any = {
      sessionID: "sess_F_none",
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello there" }] },
        { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      ],
      result: undefined,
    };
    const hook2 = ctx2.sessionHooks["compaction"];
    await hook2(ev);

    assert(ev.result !== undefined, "F2: ev.result is defined (no-state branch sets summary)");
    assertContains(ev.result.summary, "Hello there", "F2: summary contains user text");
    assert(ev.messages.length === 2, "F2: no extra message injected (messages length still 2)");
  }

  // ---------- F3: compaction with state but empty todos does not inject ----------
  {
    console.log("\n--- F3: compaction with state but empty todos does not inject ---");
    const { map: map3, storage: storage3 } = makeStorage();
    const ctx3 = makeMockCtx(storage3);
    await setup.setup(ctx3);

    // Save a state with empty todos directly
    await storage3.set(
      "lc:sess_F_empty",
      JSON.stringify({
        todo: [],
        log: [],
        summaries: [],
        index: [],
        folded: false,
        pendingFold: false,
        chunkCount: 0,
      }),
    );

    const ev: any = {
      sessionID: "sess_F_empty",
      messages: [
        { role: "user", content: [{ type: "text", text: "Only one message" }] },
      ],
      result: undefined,
    };
    const hook3 = ctx3.sessionHooks["compaction"];
    await hook3(ev);

    assert(ev.result === undefined, "F3: ev.result is undefined (state exists but empty todos)");
    assert(ev.messages.length === 1, "F3: no extra message injected (messages length still 1)");
  }
}

// ---------------------------------------------------------------------------
// Seven: Group G — execute.after cap, subagent skip, read recovery, cleanup
// ---------------------------------------------------------------------------

async function runGroupG(): Promise<void> {
  console.log("\n=== Group G: execute.after cap, subagent skip, read recovery ===\n");

  const { map, storage } = makeStorage();
  const ctx = makeMockCtx(storage);

  const setup = (await import("../local-context.ts")).default;
  await setup.setup(ctx);

  // The execute.after hook should be registered
  const execAfter = ctx.toolHooks["execute.after"];
  assert(typeof execAfter === "function", "G0: execute.after hook is registered");

  // ---------- G1: normal tool output over CAP_CHARS gets truncated + cap file created ----------
  {
    console.log("\n--- G1: normal tool output over CAP_CHARS gets truncated + cap file created ---");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const CAP_DIR = "C:\\Users\\FakuPara\\AppData\\Local\\Temp\\opencode\\lc-cap";

    // Create a string longer than CAP_CHARS (default 9000)
    const filler = "A".repeat(9000 + 100);

    const ev: any = {
      sessionID: "ses_testG1",
      tool: "some_tool",
      result: { content: [{ type: "text", text: filler }] },
    };

    await execAfter(ev);

    assert(ev.result.content[0].text.includes("...[truncated"), "G1: truncated marker present");
    assert(ev.result.content[0].text.includes("Full output saved to:"), "G1: file path message present");
    assertContains(ev.result.content[0].text, "use the read tool", "G1: read tool hint present");

    // Extract the file path from the message
    const pathMatch = ev.result.content[0].text.match(/Full output saved to: (C:\\.+\.txt)/);
    assert(pathMatch !== null, "G1: file path extracted from message");

    const capFilePath = pathMatch![1];
    assert(fs.existsSync(capFilePath), "G1: cap file exists on disk");
    assert(capFilePath.startsWith(CAP_DIR), "G1: cap file is inside CAP_DIR");
    assert(fs.readFileSync(capFilePath, "utf8").length === filler.length, "G1: cap file contains full original output");

    // Cleanup
    try { fs.unlinkSync(capFilePath); } catch {}
  }

  // ---------- G2: subagent spawn is NOT truncated ----------
  {
    console.log("\n--- G2: subagent spawn is NOT truncated ---");
    const filler = "B".repeat(9000 + 100);

    // Test with ev.tool === "subagent"
    const ev1: any = {
      sessionID: "ses_testG2",
      tool: "subagent",
      result: { content: [{ type: "text", text: filler }] },
    };
    await execAfter(ev1);
    assert(ev1.result.content[0].text.length === filler.length, "G2: subagent via ev.tool NOT truncated");

    // Test with ev.toolName === "subagent"
    const ev2: any = {
      sessionID: "ses_testG2",
      toolName: "subagent",
      result: { content: [{ type: "text", text: filler }] },
    };
    await execAfter(ev2);
    assert(ev2.result.content[0].text.length === filler.length, "G2: subagent via ev.toolName NOT truncated");

    // Test with ev.name === "subagent"
    const ev3: any = {
      sessionID: "ses_testG2",
      name: "subagent",
      result: { content: [{ type: "text", text: filler }] },
    };
    await execAfter(ev3);
    assert(ev3.result.content[0].text.length === filler.length, "G2: subagent via ev.name NOT truncated");

    // Test with ev.input.tool === "task"
    const filler2 = "C".repeat(9000 + 100);
    const ev4: any = {
      sessionID: "ses_testG2",
      input: { tool: "task" },
      result: { content: [{ type: "text", text: filler2 }] },
    };
    await execAfter(ev4);
    assert(ev4.result.content[0].text.length === filler2.length, "G2: task via ev.input.tool NOT truncated");
  }

  // ---------- G3: cap file readable + read on CAP_DIR is not re-capped ----------
  {
    console.log("\n--- G3: cap file readable + read-path skip ---");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const CAP_DIR = "C:\\Users\\FakuPara\\AppData\\Local\\Temp\\opencode\\lc-cap";

    // 1. Create a cap file in CAP_DIR, verify it exists and content is readable
    fs.mkdirSync(CAP_DIR, { recursive: true });
    const testCapPath = path.join(CAP_DIR, "testG3_capfile.txt");
    const testCapContent = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n";
    fs.writeFileSync(testCapPath, testCapContent, "utf8");
    assert(fs.existsSync(testCapPath), "G3: cap file created on disk");
    const readBack = fs.readFileSync(testCapPath, "utf8");
    assert(readBack === testCapContent, "G3: cap file content matches written content (agent can read it)");

    // 2. Simulate execute.after with a `read` tool whose filePath points INSIDE CAP_DIR.
    //    The hook should NOT truncate (path resolved starts with CAP_DIR).
    const largeString = "X".repeat(9000 + 500);
    const evInside: any = {
      sessionID: "ses_testG3",
      tool: "read",
      args: { filePath: testCapPath },
      result: { content: [{ type: "text", text: largeString }] },
    };
    await execAfter(evInside);
    assert(evInside.result.content[0].text.length === largeString.length, "G3: read on CAP_DIR path NOT truncated");

    // 3. Simulate execute.after with a `read` tool whose filePath is OUTSIDE CAP_DIR.
    //    The hook SHOULD truncate (normal read behavior).
    const largeString2 = "Y".repeat(9000 + 500);
    const evOutside: any = {
      sessionID: "ses_testG3",
      tool: "read",
      args: { filePath: "C:\\some\\other\\file.txt" },
      result: { content: [{ type: "text", text: largeString2 }] },
    };
    await execAfter(evOutside);
    assert(evOutside.result.content[0].text.includes("...[truncated"), "G3: read outside CAP_DIR IS truncated");

    // Cleanup test files
    try { fs.unlinkSync(testCapPath); } catch {}
  }

  // ---------- G4: cleanupCapFilesForSession removes cap files ----------
  {
    console.log("\n--- G4: cleanupCapFilesForSession removes cap files ---");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const CAP_DIR = "C:\\Users\\FakuPara\\AppData\\Local\\Temp\\opencode\\lc-cap";

    // Create cap files with session prefix
    const prefix = "ses_testCleanup_";
    const testFile1 = path.join(CAP_DIR, prefix + "abc123_some_tool.txt");
    const testFile2 = path.join(CAP_DIR, prefix + "def456_another_tool.txt");
    fs.mkdirSync(CAP_DIR, { recursive: true });
    fs.writeFileSync(testFile1, "data1", "utf8");
    fs.writeFileSync(testFile2, "data2", "utf8");

    // Create a file with a different prefix that should NOT be deleted
    const otherFile = path.join(CAP_DIR, "ses_otherSession_xyz789_tool.txt");
    fs.writeFileSync(otherFile, "other", "utf8");

    // wipeSession is internal; exercise it through the clear-history command.
    const clearCmd = ctx.commands.find((c: any) => c.name === "clear-history");
    assert(clearCmd !== undefined, "G4: clear-history command registered");
    await clearCmd.execute({ sessionID: "ses_testCleanup" });

    // Check files were cleaned
    assert(!fs.existsSync(testFile1), "G4: cap file with session prefix removed");
    assert(!fs.existsSync(testFile2), "G4: second cap file with session prefix removed");
    assert(fs.existsSync(otherFile), "G4: file with different session prefix preserved");

    try { fs.unlinkSync(otherFile); } catch {}
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
    await runGroupE();
    await runGroupF();
    await runGroupG();
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
