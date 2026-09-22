# Manual Testing Guide

This is the canonical reference for runtime validation of Common Fabric
patterns.

## Core Goals

- deploy the pattern in a representative environment
- verify key flows through both CLI and UI where appropriate
- record findings with severity and reproduction notes

## CLI Validation Loop

For handler-based checks:

1. deploy or update the pattern
2. call the handler
3. run `piece step`
4. inspect resulting state

Always remember that `cf cell set` and `cf piece call` do not trigger recomputation
on their own. The follow-up `piece step` is part of the test, not optional
cleanup.

## Browser Validation Loop

When using `agent-browser` or an equivalent browser harness:

1. open the deployed pattern
2. snapshot the page and read the ref for the element you are about to touch
3. interact using that ref, immediately
4. snapshot again before the next interaction
5. capture screenshots at key states

Typical command shape:

```bash
agent-browser open <url>
agent-browser snapshot -i
agent-browser click @e1
agent-browser wait --load networkidle
agent-browser snapshot -i
agent-browser screenshot
```

### A ref is only valid until the next snapshot

`agent-browser` renumbers its refs on **every** snapshot, not only when the DOM
changes, and its snapshot modes number independently of one another — so the
same `@e1` names a checkbox in one snapshot and a heading in the next. A ref
read from an earlier snapshot is not stale in a way that errors; it silently
addresses a different element, and the click appears to succeed.

Read the ref immediately before each click. Do not collect a set of refs and
work through them, and do not carry a ref across a `wait`, a screenshot, or a
second snapshot taken to check what the first one showed.

What this costs when ignored is not a failed test but a **wrong finding**: a
control reported broken because the click landed on a heading, or reported
working because it landed on something that did move. Both have happened, in one
session, and both survived review until the checks were re-run with refs read
fresh. When a browser result contradicts what the code says should happen,
re-run it this way before believing the result.

## Browser State and Session Discipline

- isolate stale browser state when a previous login, draft, or cached view can
  influence the test
- save and reload browser state only when persistence is intentional
- use separate named sessions when comparing environments or parallel flows
- remember that a ref is invalidated by the next snapshot, not merely by a page
  transition or a DOM update — see "A ref is only valid until the next snapshot"
- verify the active Common Fabric DID before drawing conclusions about scoped
  visibility

## Identity and Scoped Visibility

For Common Fabric tests that touch `PerUser`, `PerSession`, favorites,
home-space data, drafts, or user-local UI state, the browser and CLI must use the
same identity unless the test is explicitly about multi-user behavior. Use
[`docs/features/shared-identity.md`](../../features/shared-identity.md) as
the canonical workflow.

Before debugging "missing" data, compare the CLI DID:

```bash
deno run -A packages/cli/mod.ts id did "$CF_IDENTITY"
```

with the browser console line:

```text
[Identity] User DID: did:key:...
```

When using `agent-browser`, import the CLI key into the browser session under
test and then inspect the console:

```bash
agent-browser --session cf-shared open http://localhost:8000/<space>/<piece>
agent-browser --session cf-shared snapshot -i
# Click Login, then Import CLI Key.
agent-browser --session cf-shared upload @<choose-file-ref> "$CF_IDENTITY"
agent-browser --session cf-shared click @<import-key-ref>
agent-browser --session cf-shared console
```

Use separate `agent-browser --session` names for different users and verify the
`shell.identity` log in each session. Do not assume a fresh session has the
identity you intended; stale stored credentials are a common source of false
test results.

Expected visibility:

- unscoped and `PerSpace` data remains visible across identities in the same
  space
- `PerUser` data is per active user DID and may look default or missing under a
  different identity
- `PerSession` data is per active user DID and browser/runtime session
- if the whole piece does not load, investigate URL, space, slug, server state,
  source errors, and authorization before blaming identity scope

## Headed vs Headless

Use a headed browser session when:

- layout debugging matters
- you need to visually confirm motion, overlays, hover behavior, or focus
- the page is difficult to reason about from snapshots alone

Use headless/browser snapshots when:

- the flow is straightforward
- you need speed and repeatability
- visual confirmation is not the main question

## Runtime Debugging

When behavior is unclear:

- inspect cell values
- inspect rendered VDOM state
- check for non-idempotent updates
- verify action schema expectations
- compare the CLI DID with the browser `shell.identity` log before treating
  scoped defaults as missing storage
- confirm that any identity-sensitive logic is not being masked by a CLI-only
  test path

One known limitation is that CLI-driven calls with plain JSON objects may not
exercise identity-sensitive `equals()` behavior the same way the browser does.
For handlers that depend on identity comparisons, browser testing is the more
reliable verification path.

## Common `agent-browser` Patterns

### Form submission

```bash
agent-browser open https://example.com/form
agent-browser snapshot -i
agent-browser fill @e1 "Jane Doe"
agent-browser fill @e2 "jane@example.com"
agent-browser click @e3
agent-browser wait --load networkidle
agent-browser snapshot -i
```

### Authentication with saved state

```bash
agent-browser open https://app.example.com/login
agent-browser snapshot -i
agent-browser fill @e1 "$USERNAME"
agent-browser fill @e2 "$PASSWORD"
agent-browser click @e3
agent-browser wait --url "**/dashboard"
agent-browser state save auth.json
```

### Parallel sessions

```bash
agent-browser --session baseline open https://site-a.example
agent-browser --session candidate open https://site-b.example
agent-browser session list
```

## Test Report Expectations

The report should include:

- environment details
- what flows were tested
- what passed
- what failed
- severity-tagged issues
- screenshots or artifact references when relevant
- any constraints that limited coverage
