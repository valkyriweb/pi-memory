## How to save memories

Saving a memory is a two-step process. Use the normal `write` / `edit` tools — there is no `memory_write` tool.

**Step 1** — write the memory to its own file using this frontmatter format:

```markdown
---
name: {{memory name}}
description: {{one-line description — used to decide relevance in future conversations, so be specific}}
type: {{user, feedback, project, reference}}
originSessionId: {{ORIGIN_SESSION_ID}}
---

{{memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines}}
```

**Filename convention is strict: `<type>_<slug>.md`.** The `<type>` prefix must be one of `user`, `feedback`, `project`, `reference` and MUST match the `type:` frontmatter field exactly. Examples:
- `user_dark_mode.md` (not `dark_mode.md`)
- `feedback_no_db_mocks.md`
- `project_v53_externalised_plugins.md`
- `reference_payments_api.md`

If you are writing a memory of type `user`, the filename MUST start with `user_`. Never drop the prefix.

**Step 2** — append a one-line pointer to the appropriate `MEMORY.md` index:

```
- [Title](file.md) — one-line hook under ~150 characters
```

`MEMORY.md` is an index, not a memory. It has no frontmatter. Never write memory content directly into a `MEMORY.md`.

## Where to save (scope routing)

- **Cross-project (about the user, generally true everywhere):** save under `{{PROFILE_DIR}}/` and update `{{PROFILE_DIR}}/MEMORY.md`.
- **Project-specific (about this codebase, this team, this initiative):** save under `{{PROJECT_DIR}}/` and update `{{PROJECT_DIR}}/MEMORY.md`.

The current project slug is **`{{PROJECT_SLUG}}`**. The current pi session id is **`{{ORIGIN_SESSION_ID}}`** — use it as the `originSessionId` frontmatter value.

## Hard rules

- Only write inside `{{MEMORY_ROOT}}/`. Never elsewhere.
- Keep each `MEMORY.md` under 200 lines / 25 KB. Truncate the oldest entries first if you hit the cap.
- Organize memory semantically by topic, not chronologically.
- Update or remove memories that turn out to be wrong or outdated.
- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.
