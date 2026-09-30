# Bug Report Command

File a structured, evidence-based bug report. Works mid-debugging (uses existing conversation context) or cold (gathers evidence first).

## Usage

```
/bug-report <optional description of the bug>
```

## Process

### Step 1: Assess What We Already Know

Scan the current conversation for existing evidence:
- Error messages, stack traces, console output
- Files already investigated and what was found
- Reproduction steps already identified
- Hypotheses tested and their outcomes
- Any debugging steps already taken

Summarize what you have in 2-3 bullet points. If the user provided a description via `$ARGUMENTS`, incorporate that.

### Step 2: Ask the User What Additional Evidence to Capture

Present what's already known, then ask the user if they want to gather more before filing. Offer these options:

- **Browser probe** — use the `agent-browser` skill to inspect the running UI: capture console messages, network requests, visual state, and screenshots
- **Dev server logs** — tail recent log output from disk for errors and warnings
- **Source investigation** — read relevant source files and check docs/specs to confirm expected behavior (use the `oracle` subagent — never guess how an abstraction works)
- **Regression check** — consult `git log` for recent changes to the affected files/area and identify whether this is a recent regression. Offer to `git bisect` to pinpoint the breaking commit if it looks like one.
- **Skip — enough context** — go straight to writing the report

The user may pick multiple. Do only what they ask for.

### Step 3: Gather Evidence (if requested)

Use Task tool subagents (e.g., Explore agents, oracle agents) to gather evidence in parallel where possible. This keeps the main context clean and speeds up investigation. For example, launch an Explore agent to check git history while simultaneously launching another to read source files.

For each evidence type the user selected:

**Browser probe:**
- Use the `agent-browser` skill to navigate to the relevant UI state
- Capture console errors, network failures (method, URL, status, response body), and screenshots
- Record observations verbatim — do not paraphrase error messages

**Dev server logs:**
- Check for recent log files and tail them for errors/warnings around the time of the bug
- Extract timestamped excerpts — include only lines relevant to the issue

**Source investigation:**
- Read the relevant source files
- Use the `oracle` subagent (Task tool with subagent_type='oracle') to verify how the relevant system is *supposed* to work according to docs, specs, and tests
- Never claim something is broken without confirming the expected behavior from an authoritative source

**Regression check:**
- Run `git log --oneline -20 -- <affected files/directories>` to see recent changes to the area
- Look for commits that could have introduced the bug (refactors, dependency updates, behavioral changes)
- If it looks like a regression, note the suspect commit(s) in the report
- Offer to run `git bisect` to pinpoint the exact breaking commit — only proceed if the user agrees and there's a reliable way to test for the bug at each step

### Step 4: Draft the Report

Use this exact template. Omit sections that have no content (e.g., skip "Network failures" if there were none). Every claim must reference evidence — no speculation.

```markdown
## Bug: <concise title>

### Summary
1-2 sentences. What is broken and what should happen instead.

### Reproduction Steps
Numbered steps to trigger the bug. If not reliably reproducible, describe what triggers it and how often it occurs.

### Observed Behavior
What actually happens. Error messages and stack traces verbatim in code blocks.

### Expected Behavior
What should happen, citing the doc/spec/test that confirms it.

### Evidence
Include only subsections with actual evidence:

**Console errors:**
```
<verbatim console output>
```

**Network failures:**
| Method | URL | Status | Response |
|--------|-----|--------|----------|
| ...    | ... | ...    | ...      |

**Log excerpts:**
```
<timestamped log lines>
```

**Screenshots:**
<attached if captured via agent-browser>

### Regression?
If investigated: is this a recent regression? Which commit likely introduced it? Link to the commit.
If not investigated or unclear, state that.

### Relevant Code
Link to files on GitHub with line ranges. Use small focused snippets only when needed to explain the issue inline.

Format: `https://github.com/commonfabric/labs/blob/<branch>/<path>#L<start>-L<end>`

Get the current branch via `git rev-parse --abbrev-ref HEAD` and current commit via `git rev-parse --short HEAD`.

### What We Tried
Bullet list of debugging steps taken and what each revealed. Include things that ruled out hypotheses — negative results are valuable.

### Current Working Model
If you have a hypothesis about the root cause, state it here — clearly marked as a hypothesis. Reference specific evidence from above that supports it. If you don't have a working model, say so.

### Environment
- Branch: <branch name>
- Commit: <short hash>
- Node: <node --version>
- Browser: <if UI-related>
- Relevant packages: <versions of packages involved>
```

### Step 5: Review With User

Show the drafted report to the user. Ask if anything should be added, removed, or corrected before filing.

### Step 6: File the Report

Check if the Linear CLI is available:
```bash
which linear
```

**If Linear CLI is available:**
1. Ask the user to confirm the priority:
   - **P1 Urgent** — data loss, crash, or complete feature failure
   - **P2 High** — broken feature, major degradation
   - **P3 Medium** — degraded experience, workaround exists
   - **P4 Low** — cosmetic, minor inconvenience
2. Write the report body to a temp file:
   ```bash
   mktemp /tmp/bug-report-XXXXXX.md
   ```
3. Create the issue:
   ```bash
   linear issue create --title "<Bug: concise title>" --description-file <tempfile> --team CT --label bug --priority <1-4>
   ```
4. Share the Linear issue URL with the user.

**If Linear CLI is NOT available:**
1. Write the report to `./bug-reports/<YYYY-MM-DD>-<slug>.md` (create the directory if needed)
2. Tell the user the file path and that they can copy its contents into a new Linear issue.

## Rules

- **No speculation.** Every claim about system behavior must be backed by evidence you gathered or verified in this session.
- **No noise.** Omit empty sections. Don't pad with filler text. A shorter report that's all signal is better than a comprehensive one full of maybes.
- **Link, don't embed.** Reference GitHub file URLs with line ranges instead of pasting large code blocks. Use inline snippets only when a few lines are needed to explain the point.
- **Verbatim errors.** Never paraphrase error messages, stack traces, or log output. Copy them exactly.
- **Verify before claiming.** If you need to state how an abstraction is supposed to work, check the docs or source first. Use the oracle subagent if needed.
