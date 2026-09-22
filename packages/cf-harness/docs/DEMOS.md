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
- **NOT PROVEN (m pass, n fail)** — a run did not produce a working page. The
  count is kept beside the cause, because the two are different claims: several
  entries here fail on a defect that has nothing to do with the demo, and an
  entry read as "this does not work" when it means "this worked twice and once
  hit a known runtime fault" is misleading in the direction that matters.
- **NEEDS <X>** — cannot run without a grant or connection the runner must
  supply. Not a failure; a prerequisite.

## Preflight common to every demo

### Start a fresh console

**Before anything else, restart the console rather than using one that has been
running all day.**

A console that has served a few hours of sessions can exit on a V8 heap
out-of-memory — observed at about 4.8 hours and roughly thirty sessions, with
its last two collections freeing about 30 MB each against a 4.1 GB heap, which
is a heap that cannot be recovered rather than a spike (CT-2414).

**Nothing announces it.** Every route answers until the process is gone, the
last line in its log is an unrelated warning, and the loom daemon beside it goes
on reporting healthy on its one-minute cycle — **the watchdog does not cover
it**. From the outside: a demo appears to hang, then the console refuses
connections. Nobody would trace that to memory.

If it happens mid-session, restart the console and **treat whatever it was
carrying as lost rather than as a failure.** A run whose console died is not a
failed run and its result must not be recorded as one.

**After a restart, expect `unknown` rows and do not read them as failures.** The
external rows — `sandbox.*` and `index.*` — are probed asynchronously and are
not awaited when the route is read, so a page read soon after start shows them
as _unknown_, meaning **not yet checked**.

A later read usually settles them and is **not guaranteed to**: a probe that
cannot run stays `unknown` indefinitely, and a dial with nothing configured
behind it — an index that is not set up — has no probe to run at all.
`config.store` also reads `unknown` when the store was discovered automatically
rather than named. Treat `unknown` as _no answer yet_, which is distinct from a
failure, and confirm the ones you actually need by exercising them rather than
by re-reading the page.

### Which build you are on

Every timing, count and proof status here was measured on one build: labs
`e5b9f57c6c`, which is what `loom-stable-2026-09-22-2` vendors. Check yours:

```sh
curl -sS <your-toolshed>/api/meta
```

**On the toolshed, not the console** — the console has no `/api/meta` and
answers 404. `gitSha` should open `e5b9f57c6c`. Your console reports the same
build as its store path in `/api/health/detail`.

**This sha is what the proofs below were measured on, and it moves only when a
build has been re-proven against it** — not when a newer one exists. Every proof
here is a statement about a console, a corpus and a build together, and the
build is the part that moves without anyone touching the demo.

**If it matches, change nothing before demonstrating.**

**A demo runs only on the sha this document names.** A `loom update` that would
move you off it is not preparation — it is a build change, and nobody runs one
before a demo unless this document names the new sha. Loom's own pin moves ahead
of the build these demos were proven against, so updating to be current is the
careful-seeming action that lands you somewhere nothing here describes.

Update deliberately, to the sha named above, and never speculatively before a
session. The fastest way to turn a working demo into an unknown one is to update
it and not re-run it.

**If it does not match**, the proof statuses and timings below do not apply to
you. The demos may well work — most are not sensitive to the difference — but
either go back to the pinned bump, or treat every entry as unproven and run it
once yourself before showing it to anybody. A proof status is a claim about a
console, a corpus and a build together, and the build is the part that moves
without anyone touching the demo.

Read these off the console's launch printout and `GET /api/health/detail`. Loom
writes the printout to `packages/cf-harness/local-dev-console.log` under the
labs checkout it vendors.

| Check          | Expected                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Console health | `GET <console>/api/health` returns `ok: true`, and `fabricApiUrl` names **your** toolshed. Necessary, **not sufficient** — see below |
| Model          | a connected provider; `model.auth` reads connected                                                                                   |
| Sandbox        | `sandbox.docker` responding and `sandbox.runtime` `runsc-cfc registered`                                                             |
| Index          | `index.reachable` responding **and** `index.enrolled` console identity enrolled                                                      |
| Posture        | **not on this route** — read it from your toolshed, below                                                                            |

**A healthy signal from this console means very little, and its absence is
announced by nothing.** Two separate observations on one evening: the health
route answered while the fabric routes behind it were dead, and later the
process exited on a heap out-of-memory with no record of it anywhere an operator
would look.

**`/api/health` answering does not mean the fabric is answering, and the reason
is structural.** That route answers from the console's own process and makes no
round trip to the fabric, so it reports on the process rather than on the
system. It was observed returning `200` in under a millisecond while
`/api/status` and `/api/turns` on the same console had stopped responding
entirely, because the toolshed behind them had stopped serving HTTP — still
accepting TCP connections, still with a normal load average, and recovering
unaided about a minute later.

So health is a static route and a stall hides behind it. If a run seems to hang:

```sh
curl -sS -m 10 <your-toolshed>/api/meta   # reachability and build only
cf cell get <a cell you know exists>      # an actual Fabric operation
```

**The first is not a liveness check either.** `/api/meta` serves static
metadata, so a toolshed whose Fabric work is stalled can still answer it in a
millisecond — the same trap as the console's health route, one layer down. It
tells you the process is up and which build it is running. **Only the second
tells you the Fabric is doing work.**

The stall observed here showed as `/api/meta` timing out, which is the severe
case; a milder one would answer that route and still not serve a read. It
recovered on its own; nothing was restarted. **Any wall time measured across
such a window is not a measurement** — the same rule as a concurrent run, for
the same reason.

**The posture is on the toolshed, not the console.** `/api/health/detail` has no
posture row — its groups are console, model, sandbox, index, connectors and
skills. Read the posture from the fabric instead:

```sh
curl -sS <your-toolshed>/api/meta
```

Under `cfc`, check **all** of these, not only the first two — a deployment can
pass on `enforcementMode` alone while a lower dial is weaker than you assume:

| Dial                           | Expected                                                        |
| ------------------------------ | --------------------------------------------------------------- |
| `enforcementMode.rung`         | `enforce-strict`, `diagnosticOnly` false                        |
| `flowLabels.rung`              | `persist`                                                       |
| `writeFloor.rung`              | `enforce`                                                       |
| `policyEvaluation.rung`        | `enforce`                                                       |
| `labelMetadataProtection.rung` | `enforce`                                                       |
| `deviations`                   | read every entry — this is where a weak posture declares itself |

`declaredMonotonicity` reads `observe` and `diagnosticOnly` true on the build
these demos were measured on, which is expected rather than a finding.

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

**How much a run has to author predicts whether it works — and discovery is not
the variable.** Ordered by how much each demo left the run to write:

| Demo                    | What the run had to write                  | Result         |
| ----------------------- | ------------------------------------------ | -------------- |
| §1 pomodoro             | nothing; one published part does the job   | proven 4/4     |
| Readwise "never opened" | nothing; one published part does the job   | 2 of 2         |
| §2a checklist and total | two published parts, minimal glue          | proven 3/3     |
| §3 bank table           | a published reader plus an authored table  | 2 pass, 1 fail |
| §5 bills                | published readers plus an authored matcher | 1 correct in 5 |

**The control for this is a pair of Readwise runs** from prompts identical but
for one sentence naming the pattern's id. The run told nothing **found the same
published pattern unaided**, and the two pages agree to the digit — same totals,
same category and source breakdowns. Discovery cost 144 seconds and two extra
compile attempts. It cost nothing in the answer.

So where the index holds a pattern whose description closely matches the ask,
naming its id buys **speed and determinism, not capability**. On a goal the
index does not already cover, there is no evidence either way.

Two things this ordering does _not_ promise. A demo's position is not fixed —
the same prompt has produced both a direct call and a delegated wrapper on
different runs. And it predicts _mechanical_ reliability only: a run at the very
top of it produced a page correct in every figure whose headline asserted the
one claim its prompt forbade.

**A reactive value touched by ordinary JavaScript produces a page that is
silently wrong.** Two instances in one evening, from different authors against
different prompts. The first is **documented behaviour an author missed**; the
second is an open defect:

| What the source did                         | What the page showed                       |
| ------------------------------------------- | ------------------------------------------ |
| `.length` on a mapped array inside a branch | lists latched empty beneath correct counts |
| `` `${transaction.signed_amount}` ``        | every amount read `[object Object]`        |

**Both compile, type-check, run, and produce a page.** Nothing in the tree
catches them. A compile error is visible and cheap — a run simply tries again,
which is why these tasks take two to five attempts and still succeed. These are
silent, and the page looks finished.

The second is the clearest illustration: every other cell in that table passed
its value straight through and rendered correctly. The author reached for
stringification on exactly one field, the numeric one, and that was the only
field that broke.

Whether each is a transformer fault or a context the transformer does not cover
is being established one at a time by reduction rather than by rule — the first
of them turned out **not** to be what it looked like, and a rule written from
the symptom would have been wrong. See the `.length` case, which is CT-2410.

**An unambiguous instruction not to say something can be honoured in a footnote
and broken in the headline.** A prompt asked for a page about saves with no
recorded reading progress, and said outright: _call this zero recorded progress,
not proof that I have never opened an item._

The page it produced was correct in every figure — 4232 qualifying, the category
and source breakdowns matching two other runs to the digit, the oldest saves
genuinely oldest-first with working links. Its headline read **"Reading, never
opened"** and its largest stat was labelled **"never read"**. At the bottom, an
alert read: _"Zero recorded progress" is not proof that an item was never
opened._

So the same page carried the claim and its refutation, with **the claim in the
headline and the caveat in a footnote.** A viewer reads the headline.

This is worth separating from every mechanical failure here. The page renders,
the numbers are right, nothing is broken — and it asserts something false about
the person looking at it. 4232 saves with no recorded progress is not 4232 items
they never opened, and the instruction had anticipated exactly that.

**Check what a piece says, not only what it computes.** A page can be right and
still make a claim you did not authorise, and no gate, browser check or row diff
will catch it.

**An ambiguous instruction is not queried. It is resolved silently, and
differently from one run to the next.** This is the single most useful thing
learned from running these demos repeatedly, and it applies to every prompt
below.

Two instances, from different prompts on the same evening:

- _"settled, successful rows"_ is ambiguous between **the reader having
  completed** and **the transaction's own status**. One run took the second
  reading, invented a status vocabulary to express it, and filtered every row
  away. The page rendered empty with no error anywhere.
- _"a single short or numeric token is not a match"_ is ambiguous between **a
  single token that is short or numeric** and **a single token, which is short
  or numeric**. One run honoured the qualifiers and correctly paired a bill on
  the one word `rent`. Another dropped them, required two overlapping words, and
  left three correct pairs unmatched with the email and the payment carrying the
  _same merchant name_, on screen at the same time.

Same sentence, **three readings across three runs** — qualifiers honoured, read
as a count, and read as its exclusion alone — with opposite failures either side
of the one that worked. **Nothing on any of those pages says which reading it
took** without going to the source.

The consequence for anyone adding a clause to one of these prompts: an ambiguity
cannot be closed by adding another sentence, only by writing one that has a
single reading. Adding clauses addresses the model's freedom where the prompt is
_silent_; it does nothing about its freedom where the prompt is _ambiguous_, and
the two look identical from a pass-fail count.

**A word that names two things will be resolved to one of them, silently.** A
request asking for "settled, successful rows" is ambiguous between _the reader
having completed_ — `pending: false`, no error — and _the transaction's own
status_. One run resolved it the second way, invented a status vocabulary to
express it, and filtered every row away: the store's rows are `posted` and
`pending`, and nothing in it is `successful` or `settled`. The page rendered
empty with no error anywhere.

Say which you mean. "After the reader reports `pending: false` and no error" is
unambiguous and does not invite a vocabulary the data does not use.

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

**None of those four had the console to itself.** Each overlapped two to four
other sessions — bank-table, dinner-party and skill-script runs. The behaviour
they establish is unaffected: the piece was produced every time and the
countdown was verified advancing. The _timing_ is a measurement taken under
load, which is the honest label for it.

Read alongside a 14 m 14 s bills run that did have the console to itself, this
is informative rather than merely a caveat: a short task stayed short under load
while a long one stayed long alone, so **duration here is a property of the task
rather than of the machine.** Expect these numbers to hold on a quiet console.

**Likely failure:** the slug it first tries is taken; it picks another and
carries on. A second `assign_slug` in the timeline is the retry working, not a
fault.

**Proof status: PROVEN (4/4), timing under load.** Four runs of the prompt
above: `pomodoro-timer-2`, `pomodoro-focus-timer`, `pomodoro-focus-clock`, and
`pomodoro-timer-session`. Browser-verified: pressing Start advances the
countdown — `15:00` to `14:51` to `14:43` over sixteen seconds
(`proof/pomodoro-retest.png`).

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
control does not. **The newer published parts fix this** — see
[§2a](#2a-a-checklist-and-a-running-total-composed-by-id), where removal is
demonstrated working across four checks. This entry's failures predate them, and
its runs were judged before the viewport hazard described there was known, so
they should be re-checked with visible targets before being relied on.

The runtime cause behind the original defect is CT-2407: `Cell.remove` never
matched a row of a constructor-seeded inline array, because reads of such an
array are represented as immutable data-URI cells and identity never matched.
The primitives work around it in authored source.

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

## 2a. A checklist and a running total, composed by id

The same job as §2, with the two parts named outright instead of discovered, and
staying clear of the one control that does not work. **It needs no connectors at
all**, which makes it the demo that cannot be broken by a grant going stale.

**Preflight:** common only. No connectors. The two published parts must be
discoverable — `vAx2Uy1C64duK47NIl9a0fb0UtfnHrXRrxM8giA1hWM` (CheckList) and
`BEf5ZMjTIzX9J5HE6wec1s3zcQNqTAg-lFoD6W7pBHs` (AmountLedger). **Use these rather
than the older pair**, which they supersede — and read what they do and do not
fix, below.

**Prompt:** name both ids, ask for a preparation checklist beside a running
total of what the ingredients cost against a budget, and **state that amounts
are in whole dollars.** That last clause is not optional: AmountLedger's
_published_ description says it sums "in integer cents" while its field is in
whole currency units, so a run that trusts the description passes cents and the
page renders 100× the intended figure. The tree is corrected; the published
entry is not until it is republished.

**Done when:** you can add a task, check one, add an expense, watch the total
move — and reload, and find it all still there.

**Typical wall time:** ~5 minutes.

**Proof status: PROVEN (3/3).** Three runs of an identical request. Each added a
task, checked one, added a $5 expense to reach $25 of a $50 budget, and **kept
all of it across a reload.** Source inspected every time: both published parts
imported by id, and the wrapper renders their own UI rather than reimplementing
them.

**"Clear completed" works** — one click takes exactly the checked items, keeps
the rest, corrects the counts and hides itself, and the expenses are untouched.
It survives a reload. That matters because it is the gesture a viewer actually
makes after ticking things off.

**These ids carry both fixes, and both are demonstrated.**

The **unit description is fixed**: the published entry no longer says the ledger
sums "in integer cents", so a run that trusts it does not render a hundred times
the intended figure.

**Per-row Remove works.** Verified on the corrected parts across two runs and
four checks — a seeded task, a seeded expense, and a task and an expense the run
had added itself — each removing the right row, correcting the counts, and
surviving a reload.

That result took a retraction to reach, and the reason is worth carrying into
every browser check:

> A click reported as successful is not a click that happened. `agent-browser`
> returns success for a target outside the viewport, having done nothing —
> silently, with no error, leaving a page indistinguishable from one whose
> control is dead. One control here sat at y≈573 in a 577-high viewport, its
> centre just below the fold. It was reported broken twice. Brought into view,
> the identical click removed the row.

**Confirm the target is in the viewport before clicking, and hold a no-op to the
evidence a success would need** — it is a claim that something did not happen.
An off-screen click produces only false negatives, which are the ones nobody
re-checks.

## 3. This month's bank transactions as a table

**Preflight:** common, **plus a finance grant**. The launch printout must carry
a line of the form `grant <your-plaid-connection> (finance)`. There is no
simulated finance store: the runner supplies their own Plaid connection, and the
connection name is theirs.

**Prompt:**

```text
Show me this month's bank transactions as a table with a count on top. Use patterns from the library where they fit. Give it a slug that is not already in use; if a slug you try is taken, choose another and retry without asking me.
```

Nothing is attached to the task; the grant carries the data.

**Expected:** the opening pass, `describe_handle` against the granted store,
then a child composing an indexed reader, then `assign_slug`.

**Done when:** the rows on screen match the month's transactions.

**Typical wall time:** ~5 m 20 s – 5 m 35 s, of which 48–67 s is the opening
pass.

**Likely failure:** an empty table on first paint is a pending read, not an
empty month — reopen the piece rather than re-running.

**Proof status: NOT PROVEN — 2 pass, 1 fail on this wording.** The piece is
produced every time and the rows are right whenever they render; one run in
three rendered every amount as `[object Object]`, which is the reactive-coercion
family described in the preflight rather than a fault of this demo.

The prompt above asks for a table; two earlier clean runs asked for a _sortable_
table, and this document counts runs of **identical** text, so they do not count
toward this entry. They are worth recording as evidence about the done condition
rather than as proof of it: both asked for more than this prompt does and still
delivered correct rows.

The run against this wording — `monthly-bank-transactions-2` — was verified
against the store rather than by eye. All seven rows were diffed read-only
against the ledger and matched on **every field, including status and
category**:

| Date       | Merchant            | Amount   | Category           | Status  |
| ---------- | ------------------- | -------- | ------------------ | ------- |
| 2026-09-07 | Sim Insurance Group | −176.30  | GENERAL_SERVICES   | pending |
| 2026-09-06 | Sim Phone Co        | −45.00   | RENT_AND_UTILITIES | pending |
| 2026-09-06 | Sim Fuel Stop       | −48.95   | TRANSPORTATION     | posted  |
| 2026-09-05 | Sim Internet        | −89.99   | RENT_AND_UTILITIES | posted  |
| 2026-09-04 | Sim Grocery Market  | −91.72   | FOOD_AND_DRINK     | posted  |
| 2026-09-02 | Sim Coffee Roasters | −6.75    | FOOD_AND_DRINK     | posted  |
| 2026-09-01 | Sim Rent LLC        | −2450.00 | RENT_AND_UTILITIES | posted  |

Count on top reads 7. Nothing missing and nothing invented.

**The headers do not sort. Whether they _look_ clickable varies by run** — one
piece styled all six with `cursor: pointer`, another styled them `auto`, from
the same prompt. So a viewer may get a hand cursor over a column that does
nothing. **Check the piece you actually produced before demonstrating it**, and
say so if it invites the click.

They are also not exposed in the accessibility tree as interactive, which is why
a snapshot reports the only interactive element as the title button. **That is a
gap between what a snapshot can find and what a person sees**, and it runs both
ways: the published sortable part has headers that _do_ sort and are equally
invisible to the tree (CT-2411). A check leaning on accessibility output alone
will call a working control dead and a dead one harmless.

**The prompt no longer asks for sorting, because sorting does not work.** An
earlier wording asked for a _sortable_ table and got a table: clicking a column
header reordered nothing, the row order was byte-identical before and after
(`proof/bank-after.png`), and six `columnheader` nodes carried no interaction at
all while the only interactive element on the page was the title button. A demo
should not ask on camera for behaviour that will not appear, so it asks for what
it reliably gets.

The gap is recorded as CT-2404 rather than hidden. A sortable-table part already
exists in the index and in `packages/patterns/primitives`, so this is more
likely a question of what discovery surfaces than of a missing part — composing
it by id against the bank reader would separate the two in a single run.

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
not yet proven.

**Treat that one run as a sample, not as a result.** This demo asks for the
bills to be shown together where an email and a transaction "look like the same
bill", and says nothing about how strongly they must look alike. That is the
same freedom §5 leaves, and §5's four runs show what it costs: four different
pairing rules and three different answers. This entry's successful run is one
draw from that distribution rather than evidence the demo is reliable, and on a
store whose merchants share a common word it is the wrong draw that is likely.
[§5a](#5a-the-same-composition-with-the-pairing-rule-stated) states the property
that separates a run that pairs correctly from one that does not; the same
sentence would apply here. Browser-verified (`proof/bills.png`):
`monthly-bills-mail-bank` shows **Paid · 4** with each row an email paired to a
bank transaction, **Needs attention · 1**, and **Unmatched payments · 0**. Its
source line reads "Email: 100 headers · Bank: 7 live transactions", and the page
states "No message bodies or snippets are used. No AI model is used." This is
the only entry here whose done condition has been exercised end to end. One run
delivered `monthly-bills-mail-bank` in 427 s, 61 s of it the opening pass,
importing both indexed readers into an authored wrapper. Its first submission
failed on a `cf-alert` prop and the repaired version ran; its first naming
attempt collided and the second succeeded, which is the slug sentence working.
The run's own final text says its counts and matches were not independently
verified, because policy withheld the results from the model — so this
establishes a named piece and indexed composition, not that the bills it lists
are the right ones. Whether the pairings are right is the subject of
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

**Proof status: NOT PROVEN — 1 correct in 5.** Five runs, five different
matchers — same prompt, same readers, same build, same store:

| Run                    | What the model wrote                                                                   | Result                  |
| ---------------------- | -------------------------------------------------------------------------------------- | ----------------------- |
| `0a2bc75e`, 2026-09-17 | every pair enumerated, **scored by shared-token length**, assigned globally best-first | **4 of 4 correct**      |
| `ba249e85`, 2026-09-22 | any **one** shared token, 3-character floor, first unused row                          | 2 of 4 wrong            |
| `0fe142a5`, 2026-09-22 | **two** shared tokens required, 4-character floor                                      | 0 of 4 — nothing paired |
| `e4aa6b1f`, 2026-09-22 | any shared token, but refuses a pair unless each side has exactly one candidate        | 0 of 4 — nothing paired |
| `a834e7e1`, 2026-09-22 | shared-word count **plus a bonus when the whole merchant name appears**, best-first    | **4 of 4 correct**      |

The 09-17 piece was reopened on this build and still renders all four pairings
correctly, so **nothing regressed**: the readers, the data and the build are not
the variable. The matcher is.

**They differ only in how they rank candidates, and three of the five cannot
rank at all.** In this store every merchant reads `Sim <x>` and every subject
reads `Your Sim <x> bill is ready`, so `sim` is shared by every possible pair
and carries no information. No run excludes it. What separates them is how each
then tries to disambiguate, and three of those approaches cannot work at all:

- keep `sim` and take the first unused row — everything matches, so the pairing
  is decided by row order;
- drop short tokens and demand two shared words — `sim` goes, one word is left,
  nothing matches;
- demand that each side have exactly one candidate — every email has many
  candidates, so nothing matches.

Counting shared words cannot succeed here at any threshold: one admits
everything, two admits nothing — which is why three of the five runs paired
badly or not at all.

**Two different mechanisms have been observed to work, and they share a property
rather than a technique.** One weighted by how long the shared words are, so
`insurance` outweighs `sim`. The other counted shared words but added a bonus
when the whole merchant name appeared in the email text, so
`Sim Insurance Group` scored 6 against `Sim Fuel Stop`'s 1 — a tie that counting
alone would not have broken. Neither is the rule; both are instances of the same
one: **rank candidates best-first on a signal that distinguishes the specific
merchant from the word every merchant shares.**

That is worth stating precisely, because a rule named too narrowly steers a run
toward the weaker instance of it.

**So this demo's correctness is a property of the code the model writes on the
day, not of the prompt, the parts or the build.** Running it more times samples
that spread rather than narrowing it.

Two things narrow it. A published, reviewed pairing part named by id stops the
matcher being rewritten per run, and that is the real fix. Short of that, the
prompt can state the property the one correct run had — see §5a.

Note what does _not_ help much. Of a 14 m 14 s run, every `run_pattern` call
together took **30 seconds**; the authoring child's own model time took 411 s.
These runs are long because the child is thinking, not because it is fighting
the compiler, so guidance that reduces compile attempts buys a few percent here.

## 5a. The same composition, with the pairing rule stated

§5 leaves the pairing rule to the run, and five runs wrote five different ones.
This entry is §5 with the property that worked stated in the prompt, so the
difference between constraining the rule and leaving it open can be measured
rather than argued about.

**Preflight:** identical to §5.

**Prompt:** §5's text, with this sentence added before the slug sentence:

```text
Rank candidate pairs by the total length of the words they share and pair the best-scoring candidates first, each email and each payment at most once; a word shared by most merchants counts for nothing.
```

**Why this wording.** Each clause names a property that separated a run which
paired correctly from one which did not: scoring rather than counting, assigning
_best-first_ rather than first-fit, consuming each side _at most once_, and
discounting a word every merchant carries. The last clause is the one that would
have excluded `sim`.

**Done when:** every pairing on the page is one a person would make.

**Typical wall time:** one solo run took 16 m 46 s. The other runs of this entry
were concurrent with other sessions and carry no timing claim, so there is no
range to give — a concurrent run's wall time cannot be attributed.

**Likely failure:** not the matching — see run 2 below.

### Proof status: NOT PROVEN — 2 passes, 2 fails in four runs

The two failures are unlike each other and neither is a failure of ranking, so
the count alone misleads in both directions. Separating them:

- **Ranking held on all four.** Every run scored by shared-word length, sorted
  best-first, consumed each side once, and discounted the word every merchant
  shares. That is what the added sentence asks for, and it was never the
  problem.
- **Admission failed on run 4.** It ranked the four real pairs correctly and
  then kept going, adding a fifth nobody would make. The sentence says how to
  rank and nothing about when to stop.
- **Rendering failed on run 2**, which computed the right answer and never drew
  it — a defect that would hit any pattern and has nothing to do with this
  entry.

So the clause does what it says, it does not say enough, and one run failed for
an unrelated reason.

**Run 1 — pass.** `bill-payment-review` (`95f37b32`), 16 m 46 s with the console
to itself: Settled 4, Needs attention 1, Unmatched 3, every pairing right and
nothing borderline.

It implemented the clause literally. Scores are total shared-word length —
`insurance`(9) + `group`(5) = 14, `rent`+`llc`+`sep` = 10, `internet` = 8,
`phone` = 5 — and `sim` appears in no shared-terms list at all. The piece states
its own rule for the reader:

> Shared words used by a strict majority of distinct merchant/name texts score
> zero. Remaining distinct shared words score their character length. Candidates
> are ranked by score, then email and payment order, and greedily consumed once
> each.

**A page that explains the rule it used is worth more on screen than one that is
merely right**, because a viewer can check the pairing instead of trusting it.

**Run 3 — pass.** `monthly-bills-dashboard` (`d62aba06`), concurrent with other
work so no timing claim: 4 matched, 0 unpaid, 3 unmatched. Every pairing correct
and `sim` again in no shared-terms list. It prints its rule too, in a "How this
works" block:

> Words shorter than 3, generic stopwords, and words found in strictly more than
> half of distinct merchants score zero. Remaining shared words score by total
> character length; highest scores pair first, with each item used once.

**One honest difference between the two passing runs.** Run 1 reported 1 unpaid
and run 3 reported 0. Run 3's bill rule admits only subjects containing
`invoice`, `bill`, `payment due` and similar, and "Subscription renewal reminder
Sep 26" contains none of them — so it was never classified as a bill, rather
than classified and left unpaid.

That is a classification difference, not a pairing error, and both runs pass the
done condition. It is recorded because a viewer may well notice two runs
disagreeing about whether a renewal notice is a bill. It also marks the next
axis of variance: **the added sentence constrains pairing, and nothing in the
prompt constrains classification.**

**Run 4 — fail: it paired a fifth pair that nobody would make.** The first four
are perfect and scored exactly as the clause asks — 14, 10, 8, 7, with `sim`
discounted throughout. The fifth reads:

> score 2 · shared: `12` — "🌐 Meet 10 Dependable Offshore Pros:
> $12.8k–$31.2k/yr" paired to `SIM GROCERY MARKET #12`

A spam email matched to a grocery payment because `$12.8k` and `#12` both
tokenise to `12`. A viewer spots that instantly.

**The clause did its job and stopped one step short.** Every property it names
held: the common word was discounted, the four real pairs sorted above the junk,
nothing was consumed twice. What the sentence does not say is **when to stop
pairing.** With no floor, best-first exhausts the good candidates and then
admits the best remaining one however bad it is, and a two-character numeric
coincidence is still a positive score.

So the missing constraint is an **admission threshold, not a ranking one** — a
different axis from everything the sentence addresses. §5b adds exactly that and
nothing else.

**Run 2 — fail, on rendering rather than matching.** It computed 4 settled, 1
unpaid and 3 unmatched — the same answer as run 1 — and then rendered three
empty lists beneath those correct counts. The page read "4 settled" above "No
matches found."

Its source read `matchedRows.length` to choose between the rows and an
empty-state label. **The ternary around it is not the cause**, and the mechanism
is already written down in this tree:
`docs/development/debugging/gotchas/scoped-cell-pitfalls.md` records that
`.length` read directly on a reactive array "snapshots once, does not track
reactively", with `computed(() => …)` as the fix.

Reducing it confirmed exactly that. A hand-authored
`ifElse(matchedRows.length >
0, …)` fails identically, so the construct around
the read is irrelevant; a branch on a separately derived reactive count passes.
The counts beside the empty list stayed correct for the same reason — they read
a derived value rather than the array's length.

The same file used `ifElse()` correctly four times a few lines above. The author
knew the primitive; what they missed was a documented gotcha about a property
read. **Nothing in the tree catches it**: it compiles, type-checks, runs, and
produces a page. CT-2410 asks whether the dependency emission should be fixed so
the documented workaround stops being necessary.

### A weakness predicted for this wording, and withdrawn on evidence

Before it was run, the concern was that "total length of the words they share"
names only one of the two mechanisms observed to work — a whole-name containment
bonus being the other, and on this store the stronger one — so a model might
count characters and lose.

Run 1 counted characters and paired all four correctly. Why the prediction
failed is the instructive part: **the fourth clause does the disambiguation, not
the first.** Discounting the word a majority of merchants share removes `sim`
before any scoring happens, and once it is gone every remaining shared word
already distinguishes. Length never had to carry that work alone.

A softened wording is kept as a candidate in case a later run fails in the
predicted way. It is not a recommendation; one run is one run:

```text
Rank candidate pairs by how specifically the shared text identifies that merchant — a whole-name match counts for more than a single shared word — and pair the best-scoring candidates first, each email and each payment at most once; a word shared by most merchants counts for nothing.
```

### Where the variance went

Constraining the pairing rule moved the variance rather than removing it, and
both places it moved to are named rather than guessed:

- **No admission floor.** Ranking is constrained; stopping is not. Run 4's fifth
  pair is the result.
- **Classification is unconstrained, and varies more widely than pairing ever
  did.** Run 3 admitted almost nothing as a bill; run 4 admitted 96 headers,
  including Linear notifications, a calendar invite and a security alert. Same
  prompt. That spread is also what supplied run 4's junk candidate, so the two
  axes interact.

**What it is not.** A prompt clause narrows the spread; it does not collapse it,
because the model still writes the code. A published pairing part named by id is
what removes the variable entirely, and this entry should be retired when one
exists.

## 5b. The same composition, with the pairing rule and an admission floor

§5a's entry showed that stating the pairing rule produces a correct matcher
every time and still lets one bad pair through, because ranking says which
candidate is best and nothing says when to stop. This entry adds exactly that
and nothing else.

**Preflight:** identical to §5.

**Prompt, assembled in full** rather than by reference, so that a later edit to
§5 or §5a cannot silently change what these runs measured. This is §5's prompt
with two added sentences, and it is what was run:

```text
Compose these two library patterns into one page: cf:pattern:-xx1hxtvAbY7AL6FeYuQWuEzbC0nOpUOHgXseIac2_w (this month's email headers from my Gmail) and cf:pattern:v6_KSFHs9AmTg9PKwMmPdZyEHxZ9Oykhno4HBOfUo5s (this month's transactions from my bank). Show the bills I need to deal with: pair an email bill with the bank payment that settled it using plain text rules on subject, sender and merchant name only; list unpaid email bills and unmatched bank payments separately. Do not send my mail or my transactions to an AI model. Rank candidate pairs by the total length of the words they share and pair the best-scoring candidates first, each email and each payment at most once; a word shared by most merchants counts for nothing. Only pair when the shared words identify the merchant: a single short or numeric token is not a match. Give it a slug that is not already in use; if a slug you try is taken, choose another and retry without asking me.
```

The sentence this entry adds over §5a is the second of the two above:

```text
Only pair when the shared words identify the merchant: a single short or numeric token is not a match.
```

**Done when:** every pairing on the page is one a person would make, and nothing
is paired that should not be.

**Typical wall time:** ~12 minutes.

**Proof status: NOT PROVEN — 1 pass, 2 fail. This line of work is closed.**

**Run 3 failed a third way, by reading the clause as its exclusion alone.** It
paired a Claude Code newsletter — "…start sessions from your phone…" — to the
`Sim Phone Co` payment on the single word `phone`, scored 5, and consumed the
payment, so the real phone bill lost its match and the rent bill went unpaired
too. Two correct pairs, one absurd one, two real pairs lost.

`phone` is neither short nor numeric, so the pair satisfies the letter of the
clause while defeating its purpose: the sentence also says the shared words must
_identify the merchant_, and that half was dropped.

**Why it stopped here.** That run admitted **98 of 101 headers** as bill
candidates. The newsletter was only ever a candidate because classification
admitted almost every email; with classification doing its job the word `phone`
never gets the chance to match anything. Classification was the axis
deliberately left unconstrained while one variable at a time was tested, and it
is now the axis that decides the outcome.

**Three runs, three readings of one sentence** — qualifiers honoured, read as a
count, read as an exclusion with its positive half dropped. That is the
ambiguity described in the preflight, on a single clause, three times.

**The conclusion, which is the useful result rather than a consolation.**
Constraining a prompt has diminishing returns against authored variance, because
every added or reworded sentence is another sentence with its own readings. A
fourth wording was prepared and not run: it had been written against the
over-application in run 2, and would have _licensed_ the under-application in
run 3. **What removes the variance is a published, reviewed part named by id —
not a longer prompt.**

**Run 2 failed by reading the same sentence the other way.** It required _two_
overlapping identifying words — its page says so outright, "at least two
identifying words must overlap", and its source carries `shared.length >= 2`. It
had dropped the qualifiers: "a single short or numeric token is not a match"
became "a single token is not a match". Once the majority-shared `sim` is
discounted, `Sim Internet` has exactly one identifying word left and cannot
clear a two-word bar however good the match is.

The result is three pairs missed where the email and the payment carry the
**same merchant name**, both on the page at once: Insurance Group, Phone Co and
Internet all sat unpaid beside their own unmatched payments. Only `Sim Rent LLC`
paired, on three words.

**That is precisely the overcorrection run 1 avoided**, from identical text —
see the preflight note on ambiguity above. It is why the next set reworded the
sentence rather than adding another one.

**Run 1 — pass.** `monthly-bills-match` (`d524ea4a`): Email headers 101 · Bank
payments 7 · Matched bills 4 · Needs attention 1. All four pairings correct,
matched on `insurance, group`, `internet`, `phone` and `rent` respectively.

**The floor did what it was added for.** §5a's failing run paired five, the
fifth being recruitment spam matched to `SIM GROCERY MARKET #12` on the shared
token `12`. Here Sim Grocery Market sits in unmatched payments where it belongs
and the count stops at four. Same store, same readers, one added sentence.

**And it did not overcorrect, which is the harder half.** `Sim Rent LLC` matched
on `rent` alone — a single token — and was still admitted, correctly: the clause
excludes a single _short or numeric_ token, and `rent` is neither. A floor read
as "never pair on one word" would have lost a real pair and produced the
opposite failure.

**Still unconstrained: classification.** This run admitted one unpaid bill, the
same call §5a's first run made — neither §5a run 3's near-zero nor run 4's
ninety-six headers. The spread is live and no version of this prompt addresses
it; see §5a.

## 5c. The same page, with the pairing part named by id

§5 names the two readers and leaves the pairing to the run, and five runs wrote
five matchers. §5a and §5b tried to constrain it with sentences; both closed
short. **This entry names a published pairing part instead**, which is what the
evidence says actually removes the variance.

**Preflight:** as §5, **plus** the pairing part discoverable —
`d_z9mtdCBUwBpG0A6nBwOy5_2fxqySuk2zNxeIdXAYA`.

**Prompt:** §5's text, with the pairing part added as a third id to the compose
sentence and nothing else changed. **No ranking clause and no admission floor**
— those were attempts to do in a prompt what a reviewed part does properly, and
carrying them here would confuse which one worked.

**Done when:** every pairing on the page is one a person would make.

**Proof status: PENDING.** Being run three times with fresh-ref browser checks.

**What each outcome would mean**, stated before the runs so the result cannot be
read to taste:

- **It imports the part and pairs correctly** — the ordering above holds, and a
  reviewed part does what no wording could.
- **It imports the part and still mispairs** — the part has a defect its tests
  missed, and the ordering is not the whole story.
- **It ignores the part and authors a matcher anyway** — the most interesting of
  the three: naming an id would not stop a run authoring, and the ordering needs
  a term for that.

**Where this entry sits, predicted before the runs.** The pairing part takes row
arrays — `headers` and `transactions` — not database handles, so a run must wire
both readers' outputs into a third part. That is more glue than the pomodoro
shape and less than authoring a matcher, which places this **in the middle of
the ordering above rather than at the top.**

So the failure to expect here, if there is one, is **binding rather than
pairing**: wiring two row arrays into a third part is exactly the seam where
both of this evening's confirmed coercion defects lived. A run that mispairs
indicts the part; a run that renders empty or `[object Object]` indicts the
glue. Those are different results and the entry will say which.

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
execution work; the demo reaching a named piece does not yet.

**The cap is the likeliest reason, not the demo.** A run of comparable shape was
later measured end to end with the console to itself: 14 m 14 s, of which the
opening pass was 125 s, the authoring child's own model time 411 s, and every
`run_pattern` call together **30 seconds**. Compilation is not where the time
goes; the authoring child thinking is. A task of that shape cannot finish inside
eight minutes whether or not the console is busy, so these three runs were cut
off rather than failed.

Re-run it against a cap matched to that shape — fifteen minutes — before reading
anything else into the count.

**Two published parts now exist for the job this demo authors.** Its recorded
difficulty was that the skill's budget names — groceries, dining, transport — do
not match the Plaid primaries a bank reader returns, so a join on exact equality
returns zeros over a full ledger and looks like an answer:

- `AVBtedLF7sb0Aq7JlCV6odH9h7LUtHmIPYmyDuJHORQ` — totals transactions by
  category in whole currency units, and refuses rather than combining mixed
  currencies.
- `tocW3dnw6gnwYRuaOotUo2hrVfbgt4pFqtHNKV7vh8Y` — sets budgets beside actual
  spending, joining on a normalized key with a published alias table behind it,
  and **reports every budget and category it could not match rather than showing
  a confident zero.**

Neither has been used in a run of this demo. Naming them is the obvious next
thing to try here, for the reason set out above: a reviewed part removes
authoring variance where a prompt only narrows it. The three runs above also
shared a console, which is a separate reason their wall times cannot be
attributed, but it is not the reason they stopped.

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
