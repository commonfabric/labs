# Running the cf-harness demos

Every demo this package is shown with, what has to be true before each one can
run, and whether it has been proven to run end to end. It is written so an agent
pointed at a person's own console can answer, mechanically, whether they can run
a given demo — and so nobody is asked to demonstrate something that has not been
run end to end first.

[Driving the console from Weaver](WEAVER.md) owns the arrangement these are
typed into, and its §7 holds the demo tasks this document measures. Nothing here
replaces those; this adds the preflight and the proof.

## How to read an entry

Each entry carries a **preflight** an agent can check without running anything,
the **prompt verbatim**, the **done condition**, a **typical wall time**, the
**likely failure**, and a **proof status**.

Proof status is a count of clean runs with identical prompt text on one console.

**PROVEN means three.** Three clean runs with the piece produced every time, and
the done condition exercised in a browser on at least one. An entry short of
three says so and carries the runs it has.

A timing is a separate claim from a count, and it carries one extra condition:
**a wall time is only meaningful from a run that had the console to itself.**
Concurrent runs still establish whether a demo works and whether its output is
right — load does not change what a matcher matches — but they establish nothing
about how long it takes, and a run that hits a time cap under load has not
established that the cap is real. Where an entry's runs overlapped, it says so.

- **PROVEN (n/n)** — three or more clean runs, the expected piece on every one
  **and** the done condition exercised in a browser.
- **PARTLY PROVEN (m of n)** — clean so far, but short of three. It works; the
  count is not yet a claim about reliability.
- **PIECE PRODUCED (n/n), INTERACTION UNVERIFIED** — every run returned a named
  piece, and nobody opened it. A run finishing is not the page working, and this
  status exists because that distinction was learned the hard way.
- **NOT PROVEN (m/n)** — did not, with the evidence named.
- **NEEDS <X>** — cannot run without a grant or connection the runner must
  supply. Not a failure; a prerequisite.

## Preflight common to every demo

### Which build you are on

Every timing, count and proof status here was measured on one build: labs
`e5b9f57c6c`, which is what `loom-stable-2026-09-22-2` vendors. Check yours:

```sh
curl -sS <your-toolshed>/api/meta
```

`gitSha` should open `e5b9f57c6c`. Your console reports the same build as its
store path in `/api/health/detail`.

**If it matches, change nothing.** Do not run `loom vendor sync`, and do not
take a newer bump before demonstrating. Every proof below is a statement about
this build and no other, and the fastest way to turn a working demo into an
unknown one is to update it the night before.

**If it does not match**, the proof statuses and timings below do not apply to
you. The demos may well work — most are not sensitive to the difference — but
either go back to the pinned bump, or treat every entry as unproven and run it
once yourself before showing it to anybody. A proof status is a claim about a
console, a corpus and a build together, and the build is the part that moves
without anyone touching the demo.

Read these off the console's launch printout and `GET /api/health/detail`. Loom
writes the printout to `packages/cf-harness/local-dev-console.log` under the
labs checkout it vendors.

| Check          | Expected                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------- |
| Console health | `GET <console>/api/health` returns `ok: true`, and `fabricApiUrl` names **your** toolshed |
| Model          | a connected provider; `model.auth` reads connected                                        |
| Sandbox        | `sandbox.docker` responding and `sandbox.runtime` `runsc-cfc registered`                  |
| Index          | `index.reachable` responding **and** `index.enrolled` console identity enrolled           |
| Posture        | `max-enforcement`, flow labels `persist`, `enforce-strict`                                |

A console proxied behind a loom daemon answers the same routes under
`/harness-console/`. Confirm `console.base` in `/api/health/detail` names the
console you meant: an acceptance instance does not start one of its own, and its
`/harness-console` prefix resolves to the primary instance's console.

**Every demo pays an opening research pass** — 35–105 seconds at the start of
any fresh session, during which the console draws nothing. It is not a hang. The
pass is what establishes which data and composable pieces the session has, and
it is why these demos reuse indexed patterns instead of authoring from scratch.
Withholding it where the task is already closed is CT-2401; drawing it in the
live pane is CT-2402.

**Compile attempts are normal.** On this build, a task that composes or authors
a page usually takes several `run_pattern` attempts before one compiles — two to
five in a day of runs. That is the loop working, not a fault. A run that revises
its finished piece more than once is a different matter: it is not a clean demo,
and it should be re-run rather than shown.

**Slugs.** `assign_slug` requires a slug, never makes one unique itself, and
refuses one that already names another piece — and pieces are never deleted. A
prompt naming a fixed slug therefore works once and stops to ask on every later
run. Every prompt below ends with the sentence that authorizes the retry, which
is what makes the same text work repeatedly and on someone else's console.

## Checking an index entry is discoverable

Demos that reuse a published pattern need it discoverable from your identity.
Ask the console's read-only index route — this makes no session and writes
nothing:

```sh
curl -sS -H 'Content-Type: application/json' \
  -d '{"fn":"searchPatterns","body":{"text":"pomodoro","limit":5}}' \
  "<console>/api/index/call"
```

A hit carries `patternId`, `quality`, and `kind`. `403` means the identity is
not on the pattern-index allowlist and every index-backed demo below is
unavailable.

---

## 1. A pomodoro timer, found in the library

**Preflight:** common only. No connectors. The index must hold a discoverable
pomodoro entry — `SS1kA5AVHQ4unNC1XWDf7k-6f59cyDhCv3yZZMzxveA`, a standalone
timer with an empty argument schema, published 2026-09-07.

**Prompt:**

```text
I want a pomodoro timer. Use a pattern from the library if one fits. Give it a slug that is not already in use; if a slug you try is taken, choose another and retry without asking me.
```

**Expected:** after the opening pass, `run_pattern` runs the indexed pattern and
`assign_slug` names it. The piece is a working timer with a countdown,
start/pause/reset, focus and break modes, and cycle progress.

**Done when:** the timer renders and the countdown is set.

**Typical wall time:** 59–101 s across the four runs, of which 58–64 s is the
opening pass. The spread is mostly the opening pass, not the work.

**Likely failure:** the slug it first tries is taken; it picks another and
carries on. A second `assign_slug` in the timeline is the retry working, not a
fault.

**Proof status: PROVEN (4/4).** Four runs of the prompt above, each with the
console to itself: `pomodoro-timer-2`, `pomodoro-focus-timer`,
`pomodoro-focus-clock`, and `pomodoro-timer-session`. Browser-verified: pressing
Start advances the countdown — `15:00` to `14:51` to `14:43` over sixteen
seconds (`proof/pomodoro-retest.png`).

## 2. A dinner party page, composed from two library parts

**Preflight:** common only. No connectors. The index must hold discoverable
checklist and amount-ledger parts, which `deno task seed-pattern-index`
publishes from `packages/patterns/primitives`.

**Prompt:**

```text
I'm hosting a dinner party. Give me a page with a checklist of what I need to prepare, and a running total of what the ingredients cost. Give it a slug that is not already in use; if a slug you try is taken, choose another and retry without asking me.
```

The wording names neither the index nor any pattern. That is deliberate: it is
what makes the reuse a discovery rather than an instruction.

**Expected:** the opening pass, then `delegate_task` to a child that submits
source carrying `cf:pattern:` imports — visible in the run's Patterns pane —
then `assign_slug`.

**Done when:** you can tick an item and the total moves.

**Typical wall time:** about 5 minutes — 4 m 52 s on the run that was opened, of
which the first 39 s is the opening pass with nothing drawn, and the authoring
child spent 226 s more before its first `run_pattern`. The wall time is not the
complaint; the silence at the front of it is.

**Likely failure:** the child authors from scratch instead of composing. The
page still works; the run is longer and the Patterns pane shows no `cf:pattern:`
line.

**Proof status: NOT PROVEN — removal does not work.** Four runs across two
prompts each returned a named piece composing CheckList and AmountLedger by
`cf:pattern:` id with no compile error. Browser-verified on
`dinner-party-prep-planner` (`proof/dinner2-retest.png`):

- **Ticking works.** Checking the first item moves the count from
  `5 left, 0
  done` to `4 left, 1 done`.
- **Removal does not.** Clicking Remove leaves five checkboxes on the page and
  the counts unchanged — and removal is what Ben reported broken from the
  recorded take.

So the page is half-live: the part's own checkbox writes back and its removal
control does not. The cause is under investigation and is **not** what an
earlier revision of this document claimed — the parents do pass real writable
cells, so "wired with literal values" is withdrawn. What remains suspected is
the hydration or event-write path for the removal control specifically.

Prompt text does not reach it: a run whose prompt says "I need to add and remove
items and have the total update" produced the same behaviour.

One defect there looked prompt-sensitive and was not. The first piece rendered
`$12950.00` for entries stored as 12950 cents, and a later run got the units
right (`$18.50`, `$34.75`, `$16.25`). The cause is that AmountLedger's amounts
are in whole currency units while its header comment described the internal
rounding step as though the input were cents — and that header is what the
pattern index serves as the part's description, so it is what an agent reads
when composing it. The run believed the header, stored cents, and had them
rendered as dollars. The wording is corrected in the tree; the published index
entry carries the old text until it is republished, so a run can still read the
wrong contract.

## 3. This month's bank transactions as a sortable table

**Preflight:** common, **plus a finance grant**. The launch printout must carry
a line of the form `grant <your-plaid-connection> (finance)`. There is no
simulated finance store: the runner supplies their own Plaid connection, and the
connection name is theirs.

**Prompt:**

```text
Show me this month's bank transactions as a sortable table with a count on top. Use patterns from the library where they fit. Give it a slug that is not already in use; if a slug you try is taken, choose another and retry without asking me.
```

Nothing is attached to the task; the grant carries the data.

**Expected:** the opening pass, `describe_handle` against the granted store,
then a child composing an indexed reader, then `assign_slug`.

**Done when:** rows are on screen and a column header reorders them.

**Typical wall time:** ~5 m 20 s – 5 m 35 s, of which 48–67 s is the opening
pass.

**Likely failure:** an empty table on first paint is a pending read, not an
empty month — reopen the piece rather than re-running.

**Proof status: PIECE PRODUCED (2/2); rows verified, sorting does not work.**
`monthly-bank-transactions` was opened: seven real rows render for 2026-09,
matching the ledger (`proof/bank-before.png`). **Clicking a column header does
not reorder anything** — the row order is byte-identical before and after
(`proof/bank-after.png`), and the only interactive element on the page is the
title button, while six `columnheader` nodes carry no interaction at all. The
prompt asked for a sortable table and got a table.

## 4. Bills this month, from mail and bank together

The [WEAVER §7](WEAVER.md) task, unchanged but for the slug sentence.

**Preflight:** common, **plus both an email and a finance grant** —
`grant <your-mail-connection> (email)` and
`grant <your-plaid-connection> (finance)`.

**Prompt:**

```text
Show me the bills I need to deal with this month, using both my email and my bank transactions. From email, look only at the most recent 200 messages from this month and ignore message bodies; decide what counts as a bill from the subject line and sender with plain text rules. From my bank, look at this month's transactions and pick out the ones that look like bill payments (utilities, subscriptions, insurance, rent) with plain text rules on the merchant name. Where an email bill and a bank transaction look like the same bill, show them together as one paid bill; otherwise list unpaid email bills and unmatched bank bill payments separately. Do not send my mail or my transactions to an AI model. Give it a slug that is not already in use; if a slug you try is taken, choose another and retry without asking me.
```

**Done when:** both sections carry rows. Whether it pairs them is a property of
the matcher that run wrote; unpaired panes are a pass.

**Likely failure:** authoring from scratch and failing the compiler repeatedly.
A run of this shape on a build with the opening pass withheld made four
consecutive `run_pattern` calls, none carrying a `cf:pattern:` import, and
produced no piece. The rejections cluster into a handful of recurring authoring
mistakes — a nonexistent `cf-alert` prop, a `Set` in pattern inputs, a loop in a
callback body — tracked as CT-2403.

**Proof status: PARTLY PROVEN (1 of 3), and NEEDS an email grant and a finance
grant.** One clean run, browser-verified — short of the three-run bar, so it is
not yet proven. Browser-verified (`proof/bills.png`): `monthly-bills-mail-bank`
shows **Paid · 4** with each row an email paired to a bank transaction, **Needs
attention · 1**, and **Unmatched payments · 0**. Its source line reads "Email:
100 headers · Bank: 7 live transactions", and the page states "No message bodies
or snippets are used. No AI model is used." This is the only entry here whose
done condition has been exercised end to end. One run delivered
`monthly-bills-mail-bank` in 427 s, 61 s of it the opening pass, importing both
indexed readers into an authored wrapper. Its first submission failed on a
`cf-alert` prop and the repaired version ran; its first naming attempt collided
and the second succeeded, which is the slug sentence working. The run's own
final text says its counts and matches were not independently verified, because
policy withheld the results from the model — so this establishes a named piece
and indexed composition, not that the bills it lists are the right ones. Whether
the pairings are right is the subject of
[§5](#5-bills-from-gmail-and-plaid-composing-two-library-patterns-by-id), which
runs the same job with the readers named and records what varies between runs.

## 5. Bills from Gmail and Plaid, composing two library patterns by id

The same job as §4, with the two readers named outright instead of discovered.
Naming them removes the question of whether the run finds the right parts; what
it does not remove is what §4 leaves open, and this entry exists to record that.

**Preflight:** common, **plus both an email and a finance grant**, **plus** both
reader ids discoverable — check them with the `searchPatterns` call above.

**Prompt:**

```text
Compose these two library patterns into one page: cf:pattern:-xx1hxtvAbY7AL6FeYuQWuEzbC0nOpUOHgXseIac2_w (this month's email headers from my Gmail) and cf:pattern:v6_KSFHs9AmTg9PKwMmPdZyEHxZ9Oykhno4HBOfUo5s (this month's transactions from my bank). Show the bills I need to deal with: pair an email bill with the bank payment that settled it using plain text rules on subject, sender and merchant name only; list unpaid email bills and unmatched bank payments separately. Do not send my mail or my transactions to an AI model. Give it a slug that is not already in use; if a slug you try is taken, choose another and retry without asking me.
```

**Done when:** every pairing on the page is one a person would make.

**Likely failure:** the pairings are wrong, or absent, while the counts look
consistent. Also expect several `run_pattern` attempts before one compiles.

**Proof status: NOT PROVEN.** Three runs, three different matchers, three
different outcomes — same prompt, same readers, same build, same store:

| Run                    | What the model wrote                                                                   | Result                  |
| ---------------------- | -------------------------------------------------------------------------------------- | ----------------------- |
| `0a2bc75e`, 2026-09-17 | every pair enumerated, **scored by shared-token length**, assigned globally best-first | **4 of 4 correct**      |
| `ba249e85`, 2026-09-22 | any **one** shared token, 3-character floor, first unused row                          | 2 of 4 wrong            |
| `0fe142a5`, 2026-09-22 | **two** shared tokens required, 4-character floor                                      | 0 of 4 — nothing paired |

The 09-17 piece was reopened on this build and still renders all four pairings
correctly, so **nothing regressed**: the readers, the data and the build are not
the variable. The matcher is.

The variable is the threshold and the token-length cutoff, and nothing in the
prompt constrains either. In this store every merchant reads `Sim <x>` and every
subject reads `Your Sim <x> bill is ready`, so `sim` is shared by every pair and
carries no information. A run that keeps it pairs everything; a run that drops
it and then demands two shared tokens pairs nothing.

That also says what a correct run needs, and it is not a tuning value: the only
run that worked **weighted by how long the shared token is**, which is what
separates `internet` from `sim`. Counting shared tokens cannot do it at any
threshold — one lets everything through and two blocks everything.

**So this demo's correctness is a property of the code the model writes on the
day, not of the prompt, the parts or the build.** Running it more times samples
that spread rather than narrowing it. What fixes it is a published, reviewed
pairing part named by id — `bills-this-month` in #7893 — so the matcher stops
being rewritten per run; the authoring guidance in #7895 addresses the repeated
compile attempts alongside it.

## 6. A skill's script, run in the sandbox, folded into a piece

The [WEAVER §7](WEAVER.md) task, unchanged but for the slug sentence.

**Preflight:** common, **plus a finance grant**, **plus** a console whose
printout reads `skill scripts: run in the sandbox` — `not run` means the child's
script call is refused and the piece carries no budgets — **plus** a skills
registry configured, and network to GitHub.

**Prompt:**

```text
Use the skill commonfabric/labs/cf-spend-digest: run its budget script and build me a piece showing my actual spending against those budgets from my bank transactions. Give it a slug that is not already in use; if a slug you try is taken, choose another and retry without asking me.
```

The skill id is the full `owner/repo/slug`; a bare slug is ambiguous and the run
will not guess.

**Done when:** the budgets from the script stand beside non-zero spend.

**Likely failure:** a digest of zeros, which is a failed run rather than an
empty month. Failing that, the compiler rejections in CT-2403: all three
recorded runs hit them before reaching a slug.

**Proof status: NOT PROVEN (0/3 within an eight-minute cap), and NEEDS a finance
grant with skill scripts enabled.** The two runs examined in detail acquired the
skill, ran its script, and authored a wrapper importing the indexed bank reader;
no run of the three assigned a slug before the cap: 480.7 s, 481.5 s and 481.2 s
wall, with 88.6 s, 63.5 s and 105.1 s in the opening pass. The first hit a
compile error; the second submitted six times — two compile errors, then four
accepted results carrying pending concerns and a withheld value; the third
reached one accepted result after two compile errors. Acquisition and sandboxed
execution work; the demo reaching a named piece does not yet. All three ran with
other sessions in flight on one console, so the cap may be a property of that
load; a solo run is untested.

## 7. Revise a piece in place

The [WEAVER §7](WEAVER.md) task. **Not runnable from the command pill**: it
depends on the pill attaching the focused pane's piece, which is CT-2344. Loom's
own conversation path already attaches the piece, so the same request works from
there.

**Proof status: NEEDS CT-2344.**

---

## Where the evidence is

Run artifacts sit under the console's own artifact root. The proof runs behind
the counts above are recorded there in a `demo-proof-<date>/` directory on the
machine they ran on: per-run request, events, result, and measurement files,
with the ordered tool sequence and source paths for each. Your own runs land in
the same place under your console's root.

## What these numbers are

Every timing and count above comes from runs against one console on the pinned
labs build with the opening research pass in place, reading the run artifacts
rather than the pane. A count of `n/n` says only that the demo produced its
piece on that console with those grants; it is not a population success rate,
and it establishes nothing about a different corpus, a different model, or a
different set of connections.
