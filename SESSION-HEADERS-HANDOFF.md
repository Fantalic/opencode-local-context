# HANDOFF: opencode plugin `local-context.ts` — session headers for the PolyStrata affinity queue

**Written for:** the agent implementing the plugin side.
**Date:** 2026-11-14. **Server state:** the bundle-aware admission is implemented, committed
(`587ce9a` on `vision-toggle`) and live-verified against `http://127.0.0.1:8095`.
**Your target file:** `C:\Users\FakuPara\.config\opencode\plugins\local-context.ts`
(this handoff sits next to it).

## What the server now does (done, no work needed on your side)

The poly server (PolyStrata, `E:\_tools\strata\_build\PolyStrata`, launched by
`E:\_tools\strata\serve_poly.ps1` on port 8095) runs an affinity admission
(`serve/affinity.py`): one request takes the model's single turn at a time; after a big
turn it holds the turn open for `hold_s` (default 20 s) so the same conversation's follow-up
runs back-to-back (a cold re-prefill of the other session costs ~15-25 s; a continuation ~1-3 s).

As of `587ce9a` the server reads **three HTTP headers on every `/v1/chat/completions`,
`/v1/messages`, `/v1/responses` request** (read in `Service.begin_request`, `serve/server.py`
~line 4223; HTTP header names are case-insensitive, so `X-Session-Id` and `x-session-id` are equal):

| Header | Meaning | Value |
|---|---|---|
| `X-Session-Id` | the session that issued THIS request | opencode `session.id` |
| `X-Root-Session` | the TOP-LEVEL (main) session of this call chain | see below |
| `X-Agent` | which agent made the call | e.g. `architect`, `explore`, `builder` |

**The bundling key is `X-Root-Session` (falling back to `X-Session-Id`).** All requests sharing
one root session are treated as ONE conversation by the admission, regardless of prompt content.
This is what makes sub-agent spawns work: a sub-agent's first request shares nothing with the
main session's prompt, but shares the root — so:

- after the main session's big turn, the 20 s hold counts for the WHOLE bundle: the sub-agent's
  call runs inside the window instead of stealing the turn from the main session's continuation,
  and a FOREIGN session (different root) waits out the hold;
- a sub-agent finishing does NOT hand the turn to a foreign session while more of the bundle is in flight.

**The server does NOT resolve parent chains.** It only sees the headers. If you send the immediate
parent instead of the root, sub-sub-agents would form their own bundle under the sub-agent, not the
main agent. The plugin MUST walk `parentID` up to the top and send that top-level session id in
`X-Root-Session`. For a main session (no parent), `X-Root-Session` = its own `session.id`.

Absent headers are fine: the server falls back to its token-checkpoint identity (previous behavior),
so a request without the plugin behaves as before. Partial adoption (only some requests tagged) is
safe but weakens the bundling — tag everything or nothing.

## What the queue view shows

`GET /api/queue` (own-page + key gated) returns per waiting entry now:
`id, path, snippet (last user msg), session_name (first user msg), session_id, root_session,
agent, arrived, prompt_tokens, small, state ("queued"|"hold"|"focus"|"affinity"), waited_s`,
plus top-level `hold {remaining_s, at}, focused, counters {runs, holds, deferred, skips}, paused, running`.

The Monitor tab's Request queue panel (`http://127.0.0.1:8095/#monitor`) shows these live.
`agent` / `root_session` are not yet displayed in the panel — a small frontend follow-up if wanted.

## How to verify (worked exactly like this in the live check)

```powershell
$base = 'http://127.0.0.1:8095'
$junk = ('lorem ipsum dolor sit amet ' * 300)   # >4096 tokens so it is "big" (small_toks=4096)

# 1) main session's big request -> when it ends, the hold arms for root ses_main
Invoke-RestMethod "$base/v1/chat/completions" -Method Post -ContentType 'application/json' `
  -Headers @{ 'X-Session-Id'='ses_main'; 'X-Root-Session'='ses_main'; 'X-Agent'='architect' } `
  -Body (@{ model='qwen3.6-35b-a3b-ud-q3_k_m'; max_tokens=1; stream=$false;
            messages=@(@{ role='user'; content="MAIN $junk" }) } | ConvertTo-Json -Depth 5 -Compress)

# immediately GET /api/queue -> "hold": { "remaining_s": ~20 }  (holds counter +1)

# 2) sub-agent call, different prompt, same root -> runs AT ONCE (no 20 s wait)
Invoke-RestMethod "$base/v1/chat/completions" -Method Post -ContentType 'application/json' `
  -Headers @{ 'X-Session-Id'='ses_sub1'; 'X-Root-Session'='ses_main'; 'X-Agent'='explore' } `
  -Body (@{ model='qwen3.6-35b-a3b-ud-q3_k_m'; max_tokens=1; stream=$false;
            messages=@(@{ role='user'; content="SUB $junk" }) } | ConvertTo-Json -Depth 5 -Compress)

# 3) foreign session inside the window -> waits ~20 s (state "hold" in /api/queue while waiting)
Invoke-RestMethod "$base/v1/chat/completions" -Method Post -ContentType 'application/json' `
  -Headers @{ 'X-Session-Id'='ses_foreign'; 'X-Root-Session'='ses_foreign'; 'X-Agent'='other' } `
  -Body (@{ model='qwen3.6-35b-a3b-ud-q3_k_m'; max_tokens=1; stream=$false;
            messages=@(@{ role='user'; content="FORE $junk" }) } | ConvertTo-Json -Depth 5 -Compress)
```

Expected: (2) completes in its own runtime (~2-5 s for a 7-8K-token prompt), (3) takes
~hold_s + runtime. `counters.deferred` increments once for (3).

## What YOUR side must do (the plugin)

1. Find the opencode plugin hook that can observe an outgoing LLM provider call and ADD REQUEST
   HEADERS to it. Start from opencode's plugin docs (`https://opencode.com/docs/plugins/`) and the
   installed version's types; if no direct header hook exists, wrapping the provider's fetch/baseURL
   (a custom provider `fetch` or a plugin-level HTTP interceptor) is the accepted fallback — any
   mechanism that ends up with the three headers on the wire to `127.0.0.1:8095` is fine.
2. For each call resolve: own `session.id`, the ROOT session id (walk `parentID` to the top),
   and the agent name that is running. Sub-sub-agents must resolve to the MAIN session's id.
3. Set the three headers on every request to the poly server. Do not set them (or send them empty)
   for other providers/endpoints.
4. Keep it fail-open: if the session/parent cannot be resolved, send nothing — the server's
   fallback keeps working.

## Environment facts

- `STRATA_AFFINITY=1` is set by `serve_poly.ps1`; the queue panel can toggle it at runtime
  (`POST /api/queue/settings {"enabled": false}`) — if the hold seems absent, check `GET /api/queue`'s
  `settings.enabled` and the counters first.
- Python code changes need a server restart (`poly.cmd tall` / `tall-vision`); the web frontend
  reloads per request (Ctrl+F5).
- The current server runs mode `tall` (196K ctx, vision OFF). The architect may want `tall-vision`.
- Engine stats land in `C:\.strata\logs\poly\strata-qwen36-ud-q3_k_m.log` (no timestamps);
  server stdout (affinity wait lines, turn progress) in `C:\.strata\logs\serve-poly.log`.
- Repo: `E:\_tools\strata\_build\PolyStrata`, branch `vision-toggle`. Feature doc:
  `E:\_tools\strata\_build\PolyStrata\docs\AFFINITY_QUEUE.md` (update it when behavior changes).
- Scratch/plans: `E:\_tools\strata\.ai\queue-redesign-plan.md` (gitignored).
