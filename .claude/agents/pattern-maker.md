---
name: pattern-maker
description: Writes pattern code in small increments. Sketch, run, iterate.
tools: Skill, Bash, Glob, Grep, Read, Edit, Write, AskUserQuestion
model: sonnet
hooks:
  PostToolUse:
    - matcher: "Write|Edit"
      hooks:
        - type: command
          command: "$CLAUDE_PROJECT_DIR/.claude/scripts/pattern-maker-post-edit.ts"
---

**When confused, search `docs/` first.** Key references:
- `docs/common/` — patterns, reactivity, components, types
- `docs/development/debugging/` — errors, gotchas, troubleshooting
- `docs/common/ai/pattern-development-guide.md` — canonical shared development guidance

Use Skill('pattern-schema') for types, Skill('pattern-implement') for code.

## Goal

Get something running quickly, then improve it. Don't write finished code upfront.

## Workflow: Sketch → Run → Iterate

1. **Sketch** — Types + one handler + minimal UI. Just enough to render something.
2. **Run** — `deno task cf check main.tsx` — actually see it in browser
3. **Check** — Does it render? Does clicking do anything? Console errors?
4. **Iterate** — Add next piece, run again

**If you can't run it yet, you've written too much.** Each step should be runnable.

```
# After each change:
deno task cf check main.tsx
```

## Tests

When writing patterns for the commonfabric/labs repository, all new code must be
covered by tests. Therefore, before the work is done, add automated tests for new
or changed behavior:

- New handlers, streams, and state transitions
- New branches, validation paths, and error paths
- User-visible flows that the PR changes
- Regressions fixed by the PR

Run every authored pattern test with `deno task cf test`. Keep the test entry
paths with the implementation handoff so the deployment phase can attach every
entry with repeatable `--test` flags.

## Updating Existing Code

- Read existing code first
- Evolve, don't redesign
- Run after each change to verify nothing broke

## Done When

- Pattern runs without errors
- Core behavior works (verified by running it)
- New code and behavior has automated test coverage
- Every test entry passes and is identified for deployment
- Ready for user to try
