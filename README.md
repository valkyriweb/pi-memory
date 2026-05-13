# pi-memory v2

Prompt-driven memory extension for the [pi coding-agent](https://github.com/mariozechner/pi-coding-agent), modelled after Anthropic Claude Code's `memdir` design.

**v2 is a clean replacement for v1.** v1 was ~1500 LOC of memory-specific tools (`memory_write`, `memory_read`, `scratchpad`), daily-log injection, qmd recall, and an LLM-driven shutdown summariser. v2 is ~400 LOC of pure extension wiring — there are no memory tools at all.

## What it does

1. **Injects save instructions** into the main agent's system prompt: type taxonomy (`user | feedback | project | reference`), the "what NOT to save" list, frontmatter shape, and the two-step write protocol (typed file + `MEMORY.md` index entry). Verbatim from claude-code's `memoryTypes.ts`, with one pi-specific adaptation (the "already documented in CLAUDE.md" bullet is broadened to `MEMORY.md`, `AGENTS.md`, `CLAUDE.md`, or skill files).
2. **Watches `write`/`edit` to memory paths** and emits inline `memory_saved` transcript entries so writes are visible: `● Saved 1 memory` / `● Improved 2 memories`.
3. **Path B background extraction** — at every `turn_end`, if the main agent did NOT inline-save AND no memory write has happened this session (session-wide mutex), calls `ctx.forkAgent()` with a restricted-tool extraction prompt. Throttled: a non-forced fork only runs when ≥3 new turns have passed since the last attempt (trivial follow-ups are silent). Coalesces concurrent triggers, drains in-flight forks on shutdown with a 60 s timeout.
4. **Priority-bump detector** — `remember`, `note that`, `for next time`, `no`, `stop doing`, `actually`, `yes exactly`, `perfect`, `keep doing`, … force Path B to fire on the next `turn_end` regardless of throttle.
5. **Structured shutdown journal** at `~/.pi/agent/journal/YYYY-MM-DD.md` — deterministic markdown entry with cwd, message counts, tool histogram, top file edits, first user prompt, last assistant text. **No LLM in the path** — no `None.` blocks possible by construction.
   - Gated: ≥2 user messages OR ≥1 tool call.
   - Skipped when any memory write happened this session (mutex with Path A/B).
   - Skipped on `session_shutdown` `reason: "reload"` to avoid duplicate entries on `/reload`.

## What it explicitly does NOT do

- No `memory_write`, `memory_read`, or `scratchpad` tools. None of v1's tools exist. **Zero tool registrations.**
- No daily-log auto-injection.
- No qmd-backed recall — that's [dream-memory-harness](https://github.com/.../dream-memory-harness)'s `active-memory` job.
- No `session_before_compact` handoff writer (pi's compactor owns that).
- No `MEMORY.md` reconciliation loop — index drift is accepted, claude-code does the same.

## Layout

```
~/.pi/agent/
├── memory/
│   ├── profile/                  # cross-project, user-level memories
│   │   ├── MEMORY.md             # one-line index
│   │   └── <type>_<slug>.md      # typed: user|feedback|project|reference
│   ├── project/<project-slug>/   # per-project memories (slug from resolveProjectSlug)
│   │   ├── MEMORY.md
│   │   └── <type>_<slug>.md
│   └── inbox/                    # dream-only (excluded from live recall)
└── journal/
    └── YYYY-MM-DD.md             # structured shutdown journal
```

Project slug resolution: `.dream-memory.yml`'s `project_slug:` → git remote origin → cwd basename. Vendored from `dream-memory-harness/src/store.ts`.

## Architecture

```
pi-memory/
├── index.ts             # extension factory + hook wiring (123 LOC)
├── src/
│   └── util.ts          # paths, slug, triggers, prompt comp, journal, Path B, type shim (274 LOC)
├── prompts/             # verbatim text from claude-code memdir
│   ├── types-individual.md
│   ├── what-not-to-save.md
│   ├── save-instructions.md
│   └── extract-prompt.md
└── test/
    ├── unit.test.ts     # bun:test
    └── e2e.ts           # mock-API integration
```

The prompt `.md` files are loaded with `readFileSync` at runtime and **kept verbatim** from claude-code (one pi-specific bullet adaptation noted above). They contribute zero to the `.ts` LOC budget.

## Install

```bash
git clone https://github.com/jayzeng/pi-memory ~/.pi/agent/extensions/pi-memory
cd ~/.pi/agent/extensions/pi-memory
npm install
```

Then enable in `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["~/.pi/agent/extensions/pi-memory/index.ts"]
}
```

## Develop

```bash
npm run lint          # biome check .
npx tsc --noEmit      # typecheck
npm run test:unit     # bun test test/unit.test.ts
npm run test:e2e      # npx tsx test/e2e.ts
npm test              # both
```

LOC budget: total `.ts` source kept under 400.

## Environment

- `PI_MEMORY_DIR` — override `~/.pi/agent/memory`.
- `PI_JOURNAL_DIR` — override `~/.pi/agent/journal`.
- `PI_MEMORY_EXTRACTION_MODEL` — (planned) override fork model; inherits parent by default for cache-preservation.

## Upstream dependency

This extension depends on two pi-mono-fork APIs landed by the v2 PR:

- `ctx.forkAgent({...})` — cache-preserving background subagent.
- `ctx.transcript.append({...})` — structured inline transcript entries.

The published `@mariozechner/pi-coding-agent` package does not yet expose these — pi-memory v2 carries a small `ExtensionContext` shim in `src/util.ts` that lets the code typecheck against either world. Once the published package ships these APIs, delete the shim.

## Why v2

See `design-v2.md` for the full rationale. Two failure modes in v1:

1. **Daily-log noise.** Trivial sessions produced four `None.` sections; near-duplicate HANDOFF blocks crowded recall.
2. **No active recall.** Blanket injection of `MEMORY.md` + today's + yesterday's tails on every turn.

v2 borrows claude-code's `memdir` design — typed memories, a save-prompt as the gate, mutual exclusion between main-agent saves and a forked background extractor — and removes everything duplicative or noisy.
