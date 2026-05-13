# pi-memory v2 — Design

**Status:** locked design, not yet implemented. Supersedes [`design.md`](./design.md).
**Date:** 2026-05-13.
**Author:** Luke + Rusty, grilled into shape with [`matt-pocock/grill-with-docs`](https://github.com/.../grill-with-docs).

---

## Why v2

v1 (this directory's current behavior) was a plain-markdown memory store with
qmd-backed search, daily logs, a scratchpad checklist, and per-turn injection
of MEMORY.md + today's + yesterday's daily logs. Two failure modes drove the
rewrite:

1. **Daily-log noise.** Every `session_shutdown` ran an LLM to summarise the
   session and appended the result to today's daily log. Trivial sessions
   produced four `None.` sections under "Decisions / Lessons / Notes /
   Follow-ups". 19/29 entries on 2026-05-13 were full-None blocks; 96
   near-duplicate HANDOFF blocks on 2026-05-12 collapsed to 15 unique bodies.
   Both got auto-injected into the next session and indexed by qmd, polluting
   recall.

2. **No active recall.** v1's `runRecallBroker` did keyword-grade qmd search
   and pasted the top hits in. No selection step, no ranking by relevance to
   the user's actual prompt. Combined with always-on daily-log tails, every
   session paid a fixed tax for context that was usually irrelevant.

v2 borrows the parts of Claude Code's `memdir` design that actually work for
this problem, slots them in next to dream-memory-harness (which already owns
consolidation + qmd-hybrid + haiku-rerank recall), and removes everything
duplicative or noisy from pi-memory.

---

## Design principles

1. **Memory is small, durable, typed, indexed.** Journal is large, raw,
   write-once, dream-only. Never confuse the two.
2. **The save-prompt is the gate.** No heuristic "is this session
   substantive" filter — claude-code shows the prompt itself filters
   correctly when paired with a hard `WHAT_NOT_TO_SAVE` list.
3. **Active recall over blanket injection.** Frontmatter scan → small-model
   selection → load only what's chosen. Never inject "the last 3KB of
   today's daily" by default.
4. **One write format, three writers.** Inline (main agent), forked
   (background subagent), dream (cross-session batch). All produce the
   same typed frontmatter files.
5. **No new infrastructure where existing infra fits.** Reuse
   dream-memory-harness's `active-memory.ts`, `resolveProjectSlug`,
   inbox/journal/canonical pipeline, qmd integration.

---

## Layout

```
~/.pi/agent/
├── memory/
│   ├── profile/
│   │   ├── MEMORY.md                    # global index, auto-injected, capped 200 lines / 25KB
│   │   └── <type>_<slug>.md             # typed: usually user|feedback|reference
│   ├── project/<slug>/
│   │   ├── MEMORY.md                    # per-project index, auto-injected when cwd matches, capped
│   │   └── <type>_<slug>.md             # typed: usually feedback|project|reference
│   └── inbox/                           # dream-only, EXCLUDED from active recall
└── journal/
    └── YYYY-MM-DD.md                    # dream-only, NEVER auto-injected
```

Project slug resolution: `.dream-memory.yml` `project_slug:` → git remote
origin → cwd basename, with slug-map persistence and rename-detection.
Already implemented in `dream-memory-harness/src/store.ts:resolveProjectSlug`.

`profile/` is cross-project. `project/<slug>/` is per-project, auto-injected
only when the active cwd resolves to that slug. `inbox/` and `journal/` are
inputs to dream consolidation, never visible to the live agent.

---

## Memory file format

Borrowed verbatim from claude-code's `memdir/memoryTypes.ts`.

```yaml
---
name: <human-readable title — used in MEMORY.md index>
description: <one-line description — used by active-recall selector to decide relevance>
type: user | feedback | project | reference
originSessionId: <pi session id that produced this memory>
---
[body — for feedback/project, lead with the rule/fact then **Why:** and **How to apply:** lines]
```

**Types** (claude-code's taxonomy):

- `user` — facts about Luke's role, preferences, knowledge.
- `feedback` — corrections + validated approaches. Body has `**Why:**` and
  `**How to apply:**`.
- `project` — ongoing-work facts, initiatives, deadlines. Body has `**Why:**`
  and `**How to apply:**`.
- `reference` — pointers to external systems (Linear, Grafana, etc.).

**MEMORY.md** in each scope is an **index only**, never content:

```markdown
- [Title](feedback_some_topic.md) — one-line hook under ~150 chars.
- [Another](project_v53_plugins.md) — what makes this worth recalling.
```

Hard caps: **200 lines / 25 KB** per `MEMORY.md`, truncation warning appended
when either is hit. Verbatim from claude-code (`memdir.ts`).

---

## What NOT to save

Lifted verbatim from claude-code's `WHAT_NOT_TO_SAVE_SECTION`:

- Code patterns, conventions, architecture, file paths, project structure —
  derivable from current project state.
- Git history, recent changes, who-changed-what — `git log` / `git blame`
  are authoritative.
- Debugging solutions / fix recipes — the fix is in the code, the commit
  message has the context.
- Anything already documented in `MEMORY.md`, `AGENTS.md`, `CLAUDE.md`, or
  skill files.
- Ephemeral task details: in-progress work, temporary state, current
  conversation context.

**These exclusions apply even when the user explicitly asks you to save.**
If the user asks to save a PR list or activity summary, ask what was
*surprising* or *non-obvious* — that's the part worth keeping.

Added pi-specific exclusion:

- Session shutdown summaries with no surprising outcome. If nothing in the
  session would change future behavior, write nothing.

---

## Tool surface: zero memory-specific tools

Claude-code has no `memory_write`, no `memory_read`, no memory tools at all.
Memory is purely a **prompt + harness** concern. v2 adopts the same shape:

- **Write:** agent uses pi's existing `write` / `edit` against
  `~/.pi/agent/memory/...`. Format and index-step live in the system prompt.
- **Read by relevance:** automated injection via dream-memory-harness's
  `active-memory` (no tool involved).
- **Read by name / listing:** agent uses pi's existing `read` / `glob` against
  the memory directory like any other directory.

v1's `memory_write`, `memory_read`, and `scratchpad` tools are all removed.
Pi-memory's tool surface is **nothing**.

Index drift risk mirrors claude-code's: the save-prompt instructs the agent
to append a one-line entry to `MEMORY.md` as step 2. Trust the prompt; if
drift becomes a real problem, add a periodic reconciler later.

## Write paths

| Path | Trigger | Mechanism |
|---|---|---|
| **A — Inline** | Main agent decides during conversation | Always-on save-prompt in main system prompt → agent uses generic `write` / `edit` on typed file + MEMORY.md index entry |
| **B — Background fork** | `turn_end` hook | `ctx.forkAgent()` (new upstream pi API) → cache-preserving fork with parent's model, restricted tools, two-turn extraction prompt. Mutual exclusion with A. |
| **C — Dream batch** | 4h / 50 events / 64KB inbox / 24h backstop | dream-memory-harness existing batch — cross-session dedup, merge, classification, prune |

### Path A — Inline

Main agent's system prompt always contains `TYPES_SECTION_INDIVIDUAL` +
`WHAT_NOT_TO_SAVE_SECTION`, plus the file-format spec (frontmatter shape,
naming convention `<type>_<slug>.md`, target paths for `profile/` vs
`project/<slug>/`, and the "step 2: update MEMORY.md" instruction).

When the agent decides to save, it calls `write` (or `edit` for updates)
with the typed-file path and the typed body. The agent is responsible for
the MEMORY.md index entry as a follow-up tool call.

The `after_tool_use` hook watches for `write`/`edit` whose target path is
under `~/.pi/agent/memory/...` and emits a structured transcript message
(see TUI section).

### Path B — Forked extraction (background)

After every `turn_end`, if Path A did not fire this turn, pi-memory's
extension hook calls `ctx.forkAgent({...})` to spawn a cache-preserving fork
of the main session.

- **Model:** same as parent. Different model → different cache key → forfeits
  the entire cache benefit, so always inherit. Override via
  `PI_MEMORY_EXTRACTION_MODEL` env var if needed.
- **Tools restricted** (port of claude-code's `createAutoMemCanUseTool`):
  `read`, `grep`, `glob`, read-only `bash`, and `write`/`edit` only inside
  the memory directory. Everything else denied. Enforced via `ctx.forkAgent`
  `allowedTools` option + path-predicate for `write`/`edit`.
- **Prompt** (adapted from claude-code's `buildExtractAutoOnlyPrompt`):
  "Analyze the last ~N messages, save memories that qualify, two-turn
  budget — turn 1 parallel reads of all files you might update, turn 2
  parallel writes."
- **Mutual exclusion (`hasMemoryWritesSince`):** track UUID of last
  message processed as a cursor. Scan messages added since cursor for any
  `memory_write` tool_use; if found, advance cursor and skip this turn's
  fork. Direct port of claude-code's pattern.
- **Coalesced + drained:** mid-extraction calls stash for one trailing
  run. Shutdown awaits in-flight forks with a 60s timeout.

### Path C — Dream batch (cross-session)

Unchanged from dream-memory-harness's current behaviour. Reads journal +
inbox, classifies/consolidates into typed memories, evicts consumed
entries, advances watermark.

### Save-criteria triggers

- **Always-on** in main system prompt + `memory_write` tool description.
- **Triggered priority-bump:** detect save-language (`remember`,
  `note that`, `for next time`, `save this`), correction-language (`no`,
  `stop doing X`, `don't`), or validation-language (`yes exactly`,
  `perfect`, `keep doing that`) in the user input. When detected, fire
  Path B forked extraction regardless of throttle.

---

## Active recall

No `memory_read` tool. Recall is **automated injection** — same pattern as
claude-code's `getRelevantMemoryAttachments`. Owned by
`dream-memory-harness/src/active-memory.ts` (already implemented, opt-in via
`DREAM_ACTIVE_RECALL=1`). Enabled by default after the v2 rework.

### Flow per turn

1. `before_agent_start` hook fires with user prompt.
2. Frontmatter-only scan over `memory/profile/` + `memory/project/<slug>/`.
   **`inbox/` excluded** (new in v2).
3. qmd hybrid search (BM25 + vectors, `candidate_limit=40`) returns top-K.
4. Haiku-class model receives `(prompt, recent_tools, candidate manifest)`
   and selects ≤5 picks per claude-code's selector prompt:
   *"Return filenames that will clearly be useful. If unsure, exclude."*
5. Selected file bodies injected via per-turn `message` (cache-safe,
   never `systemPrompt`).

Champion config (autoresearch-tuned): `qmd_mode: "query"`,
`prompt_variant: "terse"`, `candidate_limit: 40`,
`auto_none_threshold: 0.4`, `min_prompt_length: 20`, `context_turns: 1`.

### Why inbox is excluded

Inbox is raw, uncurated, intentionally noisy. Active recall is a
high-precision surface (≤5 picks per turn). Including raw inbox content
dilutes the selector's signal-to-noise. Inbox is dream's input, not the
live agent's. Once dream consolidates an entry into `profile/` or
`project/<slug>/`, it becomes recall-visible.

---

## Shutdown

- Append one **structured journal entry** to `journal/YYYY-MM-DD.md` if
  the session was **substantive**: `≥2 user messages OR ≥1 tool call`.
- **Skip** if Path A or Path B already wrote memory this session (cursor
  check).
- **No LLM call.** Deterministic format.

Entry format:

```markdown
## 2026-05-13T14:32Z [sid:abc123]
- cwd: pi-mono-fork
- msgs: 8 user / 14 assistant
- tools: Edit×4, Bash×6, Read×2
- files: src/foo.ts, src/bar.ts
- first_user: "let's redesign pi-memory's daily log..."
- last_assistant: "Locked Q9: same model as parent."
```

The structured shape gives dream a richer signal for cross-session
classification than a bare line would: file lists + tool counts let
dream prioritize substantive sessions; first/last snippets convey topic
without reading the full transcript.

---

## Removed from v1

- **`memory_write` tool.** Replaced by prompt-driven generic `write`/`edit`
  against typed-file paths. Save criteria live in the system prompt, same
  as claude-code's design.
- **`memory_read` tool.** Replaced by automated active-memory injection +
  generic `read`/`glob` for explicit lookups.
- **`scratchpad` tool + `SCRATCHPAD.md`.** Removed entirely. Claude-code's
  `TodoWriteTool` shows the right pattern: session-local, in-memory,
  no disk, no cross-session persistence. If pi ever needs todos within a
  session, port that pattern as a separate extension. Not memory.
- **Daily-log auto-injection** (today's + yesterday's tails). Replaced by
  active recall.
- **`session_before_compact` handoff writer.** Pi's compactor already
  handles state preservation across compaction.
- **Shutdown daily-log summary writer** (the None/None bug source).
  Replaced by deterministic journal entry, no LLM.
- **`runRecallBroker` / `searchRelevantMemories`.** Replaced by
  active-memory.

v1 is ~1500 LOC. v2 is roughly **150-300 LOC** — system-prompt content +
four small hooks. The rest moves into pi core (forkAgent, transcript API)
and dream-memory-harness (already there).

## TUI visibility

Claude-code surfaces memory writes inline in the transcript via a custom
system-message subtype `memory_saved`, rendered by `MemorySavedMessage`:

```
● Saved 3 memories
  feedback_x99_pod_check.md
  feedback_no_invented_thresholds.md
  project_v53_externalized_plugins.md
```

Verb is `"Saved"` for direct writes, `"Improved"` for dream/autoDream
consolidation runs.

v2 ports this exactly. Pi-memory's `after_tool_use` hook watches `write`
/ `edit` calls whose path matches `~/.pi/agent/memory/...`, batches paths
for the current turn, and emits:

```ts
ctx.transcript.append({
  kind: "memory_saved",
  verb: "Saved",       // or "Improved" when path B detects an update
  paths: [...]
});
```

The `ctx.transcript.append` API is part of the upstream pi PR (next section).

---

## Upstream pi-mono-fork PR

Two new `ExtensionContext` APIs, bundled into one PR.

### `ctx.forkAgent(opts)`

Wraps the existing `executeAgentTool` from `core/agents/executor.ts` with
extension-shaped defaults:

- Inherits parent's frozen system prompt + active tools + cwd from `ctx`.
- Runs background (returns a handle, doesn't block the hook).
- Optional `allowedTools: string[]` restriction.
- Optional `model` override (default: parent's model — required for cache
  preservation).
- Optional `prompt` for the forked agent's first user message.
- Optional `signal` for abort.

Useful far beyond memory: verification subagents, summarisation, audit
runs, any "do this in parallel with a shared cache" pattern.

### `ctx.transcript.append(entry)`

Append a structured system-message to the live transcript, inline
between user/assistant turns. First custom message subtype:

```ts
{ kind: "memory_saved", verb: "Saved" | "Improved", paths: string[] }
```

Renderer in pi's TUI matches claude-code's `MemorySavedMessage` layout.
The API is extensible — future subtypes can serve other extensions
(`background_agent_done`, `consolidation_complete`, etc.).

Not a toast (`ui.notify`) and not a footer status — a first-class
transcript entry the user can scroll back to.

---

## Migration plan

1. `cp -r ~/.pi/agent/memory ~/.pi/agent/memory-archive-2026-05-13/`
2. Delete `~/.pi/agent/memory/SCRATCHPAD.md` outright.
3. In the archive copy, strip:
   - `<!-- HANDOFF ... -->` blocks (regex on daily logs).
   - `## Session Summary` blocks where all four sections are `None.`.
4. Run a one-off dream batch with the pruned content as inbox input.
   Generates typed `profile/` + `project/<slug>/` files.
5. Review the generated tree. Keep what's good, edit what needs editing,
   delete what's wrong.
6. Drop the archive after ~1 month if nothing useful turns up missing.

---

## Build sequence

Four steps. Steps 1–3 run in parallel. Step 4 depends on step 1.

1. **Upstream pi PR** — `ctx.forkAgent()` + `ctx.transcript.append()` +
   `memory_saved` renderer in TUI. Independent unit. Land + merge first.
2. **Migration** — cleanup + dream-port of existing daily logs into typed
   memory. Strip handoffs and None/None blocks first, run dream once with
   the pruned content as inbox, review and promote output.
3. **Enable `DREAM_ACTIVE_RECALL=1`** in dream-memory-harness, exclude
   inbox from candidate scan, verify recall quality for a few days.
4. **Rewrite pi-memory to v2 shape** — single landing:
   - Inject `TYPES_SECTION_INDIVIDUAL` + `WHAT_NOT_TO_SAVE_SECTION` +
     file-format spec into main agent system prompt.
   - `turn_end` hook fires Path B forked extraction via `ctx.forkAgent()`,
     with restricted tools and mutual-exclusion cursor.
   - `after_tool_use` hook watches memory-path writes and emits
     `ctx.transcript.append({kind: "memory_saved", ...})`.
   - `session_shutdown` hook writes a deterministic structured journal
     entry if substantive and no memory was written this session.
   - Triggered priority-bump detector for save/correction/validation
     language on user input.
   - Delete v1 surfaces: `memory_write`, `memory_read`, `scratchpad`,
     daily-log injection, handoff writer, shutdown summary, recall broker.

v1 → v2 is a clean replacement, not a gradual migration. The migration
step (2) handles the data; the rewrite step (4) handles the code.

---

## Open questions (deferred, not blocking)

- **`ctx.forkAgent()` API surface details** — exact opts shape, return
  handle, abort semantics. Resolve in the upstream PR.
- **Inline-vs-fork drift** — if Path A reliably catches everything, Path B
  is redundant cost. Measure save-rate by path after 1-2 weeks; consider
  dropping B if A's recall is high enough.
- **Per-cwd vs global active-memory budgets** — current dream-memory-harness
  active-memory has a single global hit-count. With project/<slug>/ + profile/,
  worth measuring whether per-scope budgets (e.g. 2 profile + 3 project)
  beat the combined manifest's selector judgment.
- **Cap tuning** — 200 lines / 25 KB is claude-code's number. May want to
  shrink for pi if always-loaded budget creeps up.
- **`originSessionId` privacy** — UUIDs are fine for self-use; if these
  files ever sync to a team setup, may want to redact.

### Surfaced during v2 implementation (2026-05-13)

- **Forked-agent write-path predicate is prompt-only, not enforced.**
  Claude-code enforces "only write under `~/.pi/agent/memory/`" inside the
  forked subagent via `canUseTool` returning `behavior: deny` for non-memory
  paths (`createAutoMemCanUseTool` in extractMemories.ts). Pi's
  `ctx.forkAgent({ allowedTools })` accepts a tool **name** allowlist but
  has no per-call path predicate hook on the child. A parent-side `tool_call`
  handler can't distinguish child-fork tool calls from parent tool calls
  cleanly. **For v2 the path restriction lives only in the extraction prompt
  text** ("only write under `${MEMORY_ROOT}/`"). Acceptable risk: the fork
  uses the same model + system prompt as the parent and is constrained by
  the extraction prompt to a two-turn read/write budget; we have not seen
  a fork wander outside the memory dir. A future pi extension to forkAgent
  (e.g. `canUseTool?: (tool, input) → boolean | { deny: string }`) would
  make this enforceable.
- **Published `@mariozechner/pi-coding-agent` dist lacks `ctx.forkAgent`
  and `ctx.transcript.append` at time of v2 implementation.** The new APIs
  exist in `~/Projects/personal/pi-mono-fork` (the upstream fork) but the
  npm dist used as a peerDep does not yet ship them. v2 carries a tiny
  `ExtensionContext` shim in `src/util.ts` that extends `BaseCtx` with the
  new methods so typecheck passes against the installed dist; the runtime
  needs the upstream pi to actually function. Drop the shim once the
  published package ships the upstream PR.
- **Path B “memory file paths” are detected by mtime-snapshot diff**
  rather than by mining the fork's terminal `AgentToolDetails`. The
  details shape is internal and we don't have a stable accessor for the
  child's tool-use blocks; an mtime/size snapshot of `profile/` +
  `project/<slug>/` before/after `handle.wait()` is simpler and robust. If
  the upstream PR later exposes `result.messages` with tool-use details,
  swap to a direct mine.
- **Slug resolution is vendored, not imported.** Live import from
  `dream-memory-harness/src/store.ts` would couple pi-memory to dream’s
  internal API. Vendored a 30-line subset with a `TODO` to extract both
  callers to a shared `@howaboua/pi-slug` package.
- **`SessionShutdownEvent.reason`** is not yet in the installed dist; the
  reload-skip check uses a `(event as { reason?: string }).reason` cast.
  Drop once the new event shape ships in the published package.
- **Path-B mutex moved from message-scan to session-wide boolean.** The
  original design called for a cursor of the last processed message id with
  per-turn scanning of assistant content blocks for write/edit toolCalls
  under `MEMORY_ROOT`. In practice the live `AgentMessage` content shape on
  `turn_end` events did not match the JSONL `toolCall` block shape, so the
  scan returned false even after Path A had written, causing Path B to fork
  on every subsequent turn (~30k tokens each, plus an unbounded `messages`
  array → OOM after ~100 turns). v2 instead uses the
  `journal.memoryWrittenThisSession` flag set by the `tool_result` hook,
  which is a known-good signal: once any write/edit lands under
  `MEMORY_ROOT`, Path B is muted for the rest of the session. Coarser than
  the cursor design but reliable and trivially testable.
- **Path-B “≥3 new turns” throttle.** Without a throttle, Path B fired on
  every `turn_end` including trivial acknowledgements (“thanks”, “ok”),
  burning a fork run each time. v2 requires `≥3` new user+assistant turns
  since the last fork attempt before a non-forced fork runs (priority-bump
  still forces). Constant lives at the top of the extractor module.
- **No `messages[]` retention in the extension.** Originally the extension
  held `AgentMessage[]` to compute cursor + new-message counts. Tool results
  on long sessions with large background-agent payloads bloated the array
  to GB scale. v2 only keeps a plain integer turn counter; pi already keeps
  full history internally.
- **Background-agent completion notifications spam the transcript for
  extension-initiated forks.** `_forkAgentFromExtension` in pi-mono-fork
  wires `onBackgroundTerminal → _emitAgentCompletion`, which sends a
  `<agent_completion>` followUp message into the transcript. Extensions
  awaiting `handle.wait()` don't need this. Upstream fix candidate: skip
  the notification (or expose `silent?: boolean` on `ForkAgentOptions`)
  when the run was launched via `ctx.forkAgent()`.

---

## References

- v1 design: [`design.md`](./design.md)
- Claude Code memdir: `~/Projects/testing/claude-code-cli-src-code/src_extracted/src/memdir/`
- Claude Code extractMemories: `~/Projects/testing/claude-code-cli-src-code/src_extracted/src/services/extractMemories/`
- Claude Code autoDream: `~/Projects/testing/claude-code-cli-src-code/src_extracted/src/services/autoDream/`
- dream-memory-harness: `~/Projects/testing/dream-memory-harness/src/`
- pi fork API: `~/Projects/personal/pi-mono-fork/packages/coding-agent/src/core/agents/executor.ts`
