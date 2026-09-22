---
name: agent-browser
description: Browser automation CLI for AI agents. Use when the user needs to interact with websites, including navigating pages, filling forms, clicking buttons, taking screenshots, extracting data, testing web apps, or automating any browser task. Triggers include requests to "open a website", "fill out a form", "click a button", "take a screenshot", "scrape data from a page", "test this web app", "login to a site", "automate browser actions", or any task requiring programmatic web interaction.
allowed-tools: Bash(agent-browser:*)
---

Start with the shared manual testing guidance in:

- `docs/common/ai/manual-testing-guide.md`

Read that guide first. It is the canonical reference.

# Browser Automation with agent-browser

## cf-harness browser profile

When this skill is activated inside a `cf-harness` browser-profile subagent, the
profile intentionally narrows the generic `agent-browser` capability surface
described below. There is no shell in that profile: page actions go through the
harness's `browser` tool, and the harness attaches the leased CDP endpoint
itself. Allowlisted skill scripts likewise receive the endpoint through
`AGENT_BROWSER_CDP` in their environment; do not pass `--cdp` to them.

The cf-harness browser profile allows only a small set of page commands: `open`
for HTTP(S) URLs, `snapshot`, `get title/url/text`, bounded `wait`, and
ref-based `fill`, `type`, `select`, `check`, `click`, and `press`. Broader
commands in this skill, including storage/cookie/session/HAR/network/file
capture, profile/session setup, and auth workflows, may be unavailable in that
profile. The default allowlisted skill scripts are limited to
`scripts/form-automation.sh` and `scripts/capture-workflow.sh`; credentialed
workflows such as `scripts/authenticated-session.sh` require a separate,
explicit credential grant and origin-binding design.

Under the cf-harness profile, the manual-testing-guide's screenshots,
`--session` workflows, state save/load, console reading, and the Import-CLI-Key
identity flow are unavailable. Substitute `snapshot` + `get text` for
screenshots; skip multi-identity checks and record them as not-runnable in the
report.

## Core Workflow

Every browser automation follows this pattern:

1. Navigate: `agent-browser open <url>`
2. Snapshot: `agent-browser snapshot -i`
3. Interact: use refs to click, fill, select, or inspect
4. Re-snapshot before the next interaction — refs are renumbered by every
   snapshot

```bash
agent-browser open https://example.com/form
agent-browser snapshot -i
# Output: @e1 [input type="email"], @e2 [input type="password"], @e3 [button] "Submit"

agent-browser fill @e1 "user@example.com"
agent-browser fill @e2 "password123"
agent-browser click @e3
agent-browser wait --load networkidle
agent-browser snapshot -i
```

## Essential Commands

```bash
# Navigation
agent-browser open <url>
agent-browser close

# Snapshot
agent-browser snapshot -i             # Interactive elements with refs
agent-browser snapshot -s "#selector"

# Interaction
agent-browser click @e1
agent-browser fill @e2 "text"
agent-browser type @e2 "text"
agent-browser select @e1 "option"
agent-browser check @e1
agent-browser press Enter
agent-browser scroll down 500

# Get information
agent-browser get text @e1
agent-browser get url
agent-browser get title

# Wait
agent-browser wait @e1
agent-browser wait --load networkidle
agent-browser wait --url "**/page"
agent-browser wait 2000

# Capture
agent-browser screenshot
agent-browser screenshot --full
agent-browser pdf output.pdf
```

## Common Patterns

### Form submission

```bash
agent-browser open https://example.com/signup
agent-browser snapshot -i
agent-browser fill @e1 "Jane Doe"
agent-browser fill @e2 "jane@example.com"
agent-browser select @e3 "California"
agent-browser check @e4
agent-browser click @e5
agent-browser wait --load networkidle
```

### Authentication with state persistence

```bash
agent-browser open https://app.example.com/login
agent-browser snapshot -i
agent-browser fill @e1 "$USERNAME"
agent-browser fill @e2 "$PASSWORD"
agent-browser click @e3
agent-browser wait --url "**/dashboard"
agent-browser state save auth.json

agent-browser state load auth.json
agent-browser open https://app.example.com/dashboard
```

### Common Fabric identity checks (host/interactive runs only)

This recipe needs `--session`, `upload`, and `console`, which the cf-harness
profile does not allow — run it only in host or interactive sessions.

For Common Fabric tests that touch `PerUser`, `PerSession`, favorites, drafts,
or home-space state, import the same CLI key used by `deno task cf` into the
browser session via `Import CLI Key`.

```bash
agent-browser --session cf-shared open http://localhost:8000/<space>/<piece>
agent-browser --session cf-shared snapshot -i
# Click Login, then Import CLI Key.
agent-browser --session cf-shared upload @<choose-file-ref> "$CF_IDENTITY"
agent-browser --session cf-shared click @<import-key-ref>
agent-browser --session cf-shared console
```

The browser console should include `[Identity] User DID: ...`; compare it with:

```bash
deno run -A packages/cli/mod.ts id did "$CF_IDENTITY"
```

Use distinct `--session` names when comparing identities. A different identity
should still see unscoped/`PerSpace` data in the same space, but `PerUser` and
`PerSession` fields resolve to separate instances and may look empty/default.
See `docs/features/shared-identity.md` for the full workflow.

### Data extraction

```bash
agent-browser open https://example.com/products
agent-browser snapshot -i
agent-browser get text @e5
agent-browser get text body > page.txt
agent-browser snapshot -i --json
agent-browser get text @e1 --json
```

### Parallel sessions

```bash
agent-browser --session site1 open https://site-a.com
agent-browser --session site2 open https://site-b.com
agent-browser --session site1 snapshot -i
agent-browser --session site2 snapshot -i
agent-browser session list
```

### Visual browser debugging

```bash
agent-browser --headed open https://example.com
agent-browser snapshot -i
agent-browser highlight @e1
agent-browser record start demo.webm
```

### Local files

```bash
agent-browser open file:///path/to/document.pdf
agent-browser open file:///path/to/page.html
agent-browser screenshot output.png
```

### Mobile-style workflows

If your environment includes device emulation or a mobile browser harness, use
the same open -> snapshot -> interact -> re-snapshot rhythm there. Treat those
flows as provider-specific extensions rather than core `agent-browser` CLI
commands unless your local install documents them explicitly.

## Ref Lifecycle

Refs (`@e1`, `@e2`, and so on) are invalidated by **the next snapshot**, whether
or not the page changed. Read the ref immediately before the command that uses
it, and do not carry one across another snapshot, a `wait`, or a screenshot.

A page change is the obvious case, and these all require a fresh snapshot:

- clicking links or buttons that navigate
- form submissions
- dynamic content loading such as dropdowns or modals

The quieter case is a snapshot taken for any other reason — to check what the
last one showed, or in a different snapshot mode, since the modes number
independently. Reusing a ref across one does not error: it addresses a different
element and the command appears to succeed.

```bash
agent-browser click @e5
agent-browser snapshot -i
agent-browser click @e1
```

## When Things Break

- **CDP endpoint unreachable**: verify with `agent-browser get url`. If
  connection errors persist, record the failure in your notes/report and stop
  rather than retrying blindly.
- **A `wait` that never resolves**: bound every wait with a `wait <ms>`
  fallback. Prefer `wait "<selector>" --state hidden` or `wait --fn "<expr>"`
  for spinners and loading text.
- **Element missing from snapshot**: `agent-browser scroll down 500` and
  re-snapshot; then `agent-browser snapshot -s "<container-selector>"`; then
  fall back to `find` semantic locators.
- **Screenshot unavailable (restricted profiles)**: substitute
  `agent-browser snapshot -i` + `agent-browser get text` and record evidence
  textually.

Verify each command against `agent-browser --help` (or
`agent-browser <command> --help`) before writing it.

## Semantic Locators

When refs are unavailable or unreliable, use semantic locators:

```bash
agent-browser find text "Sign In" click
agent-browser find role button click --name "Submit"
agent-browser find placeholder "Search" type "query"
agent-browser find testid "submit-btn" click
```

> **Note:** `fill` requires a native `<input>` or `<textarea>`. It does not work
> on `cf-*` custom element hosts. Use `type @ref "text"` instead.

For Common Fabric UIs, prefer these semantic locators before shadow-piercing
selectors. `cf-button` exposes `role="button"` on the host, and `cf-input`
exposes `role="textbox"` on the host with ARIA state such as `aria-disabled`,
`aria-required`, `aria-readonly`, and `aria-invalid`.

```bash
agent-browser find role button click --name "Save"

# For text inputs, use type with a ref — not bare type after click.
# Bare type sends keystrokes to page focus, which may not land in the
# inner native input. type @ref targets the element directly.
agent-browser snapshot -i            # → textbox "Name" [ref=e4]
agent-browser type @e4 "Ada"
```

> **Important:** `cf-input` and `cf-textarea` hosts are custom elements, not
> native inputs. `fill` does not work — use `type @ref "text"` instead.

If a component has not yet been updated with host semantics, fall back to the
documented pierce selectors such as `[data-cf-button]` or `[data-cf-input]`.

## Deep-Dive References

| Reference                                                            | When to Use                                               |
| -------------------------------------------------------------------- | --------------------------------------------------------- |
| [references/commands.md](references/commands.md)                     | Full command reference with all options                   |
| [references/snapshot-refs.md](references/snapshot-refs.md)           | Ref lifecycle, invalidation rules, troubleshooting        |
| [references/session-management.md](references/session-management.md) | Parallel sessions, state persistence, concurrent scraping |
| [references/authentication.md](references/authentication.md)         | Login flows, OAuth, 2FA handling, state reuse             |
| [references/video-recording.md](references/video-recording.md)       | Recording workflows for debugging and documentation       |
| [references/proxy-support.md](references/proxy-support.md)           | Proxy configuration, geo-testing, rotating proxies        |

## Ready-to-Run Scripts

When `run_skill_script` is available and exactly allowlisted, prefer these
bundled scripts over constructing equivalent shell commands. Invoke them with
`skill="agent-browser"` and the listed `scripts/...` path. These scripts expect
the `agent-browser` CLI to be available on `PATH` in the script execution
environment.

These bundled scripts read the CDP origin from `AGENT_BROWSER_CDP` when their
`--cdp` flag is omitted; the `agent-browser` CLI itself does not honor that
variable. Inside a cf-harness browser-profile run, the harness sets
`AGENT_BROWSER_CDP` from the Browser Access lease and refuses a `--cdp`
argument, so pass only the script's other arguments there. The `--cdp` forms
below are for direct host usage outside the harness. The scripts intentionally
avoid browser state, screenshots, PDFs, uploads, downloads, and local file
output; they print snapshots and extracted content to stdout for harness
capture.

| Script                                                               | Description                                      |
| -------------------------------------------------------------------- | ------------------------------------------------ |
| [scripts/form-automation.sh](scripts/form-automation.sh)             | Discover form refs or run ordered form actions   |
| [scripts/authenticated-session.sh](scripts/authenticated-session.sh) | Discover login refs or submit provided refs      |
| [scripts/capture-workflow.sh](scripts/capture-workflow.sh)           | Capture page metadata, snapshot, and text output |

```bash
./scripts/form-automation.sh --cdp http://host.docker.internal:9222 https://example.com/form
./scripts/form-automation.sh --cdp http://host.docker.internal:9222 https://example.com/form \
  --type @e1="Ada" --click @e3 --wait-url "**/success"

APP_USERNAME="user@example.com" APP_PASSWORD="..." \
  ./scripts/authenticated-session.sh --cdp http://host.docker.internal:9222 \
  https://app.example.com/login --username-ref @e1 --password-ref @e2 --submit-ref @e3

./scripts/capture-workflow.sh --cdp http://host.docker.internal:9222 https://example.com

# Inside a cf-harness browser-profile run: the harness supplies the endpoint.
# run_skill_script skill="agent-browser" path="scripts/capture-workflow.sh" \
#   args=["https://example.com"]
```
