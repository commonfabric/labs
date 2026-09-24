# Running the cf-harness demos

Four demos, in the order to run them. Each was run to a working page and checked
in a browser, on labs `a77e958513` and again on `edd1f71108` — with two
exceptions, whose wording has changed since. Demo 2's prompt names its two parts
where the browser-checked runs pasted their ids; three runs of the wording below
reach the same two parts, read from the source each submitted, but none of the
three was clicked through. Demo 4's prompt names none of its parts; six runs of
the wording below composed all three published parts, read the same way, and
none was clicked through. Treat those two demos' pages as unverified until
someone clicks through them.

Everything else — the counts, the findings behind them, the demos that are not
on this page and why — is in [DEMOS-EVIDENCE.md](DEMOS-EVIDENCE.md). Read this
page to run them; read that one to understand them.

## Before you start

1. **Start a fresh console.** Not one that has been running all day: a console a
   few hours old can exit on a heap out-of-memory, and nothing announces it.
2. `loom update`, then `loom restart loom --include-toolshed`.
3. Note the build you landed on: `curl -sS <your-toolshed>/api/meta`, and put
   the `gitSha` it reports in your run notes. **On the toolshed, not the
   console** — the console has no `/api/meta` and answers 404.
4. Run one search from the command pill — `pomodoro` will do — and let it
   finish. The first search of a session is slower than the rest.
5. **Set the browser to a light color surface.** One proven page renders correct
   amounts that cannot be read against a dark background.
6. Check your grants. Demos 1 and 2 need none. Demo 3 needs a finance grant.
   Demo 4 needs a finance grant and an email grant.

**Why note the sha rather than match it.** These counts were measured on
`a77e958513` and `edd1f71108`, and `loom update` may land you on something
newer. That is the intended way to run these, and the newer build is not claimed
to be proven. So a demo that misbehaves on a build these were not measured on is
a new observation rather than a contradiction of the count — and the sha in your
run notes is the only thing that lets anyone tell those two apart afterwards.

Slugs are never reused, and a run picks another name by itself when the one it
tries is taken. Nothing in these prompts needs to tell it to.

---

## 1. A pomodoro timer

```text
I want a pomodoro timer.
```

**What appears:** the console thinks for half a minute or so with nothing drawn,
then finds a timer in the library and names the piece.

**Stop when:** the timer renders and the countdown advances after you press
Start.

**Rough time:** about a minute.

**If nothing is drawn for the first half minute,** that is the opening pass, not
a hang. Wait.

## 2. A checklist and a running total

```text
Make a dinner-preparation page by composing CheckList for tasks and AmountLedger for expenses. Use the published components' existing controls with writable local state. Start with tasks Buy pasta, Set the table and Chill drinks, all unchecked. Start with Pasta costing $12.50 and Drinks costing $7.50, against a $50 budget. AmountLedger's amount and budget inputs are in whole dollars: pass 12.50 and 7.50, not 1250 and 750, despite the published description mentioning cents. I need to add and check off tasks, add expenses, and see the running total and remaining budget. This page uses no connectors.
```

**What appears:** a checklist beside an expense ledger, both built from the two
published parts named in the prompt.

**Stop when:** you have added a task, checked one, added an expense, watched the
total and remaining budget move — and reloaded and found it all still there.
"Clear completed" and per-row Remove both work.

**Rough time:** about five minutes.

**If a row's Remove seems to do nothing,** scroll the row fully into view and
click again. A control below the fold can look dead when it is not.

## 3. This month's bank transactions as a table

```text
Show me this month's bank transactions as a sortable table with a count on top.
```

**What appears:** a table of the month's transactions with a count above it.

**Stop when:** the rows on screen match the month's transactions.

**Rough time:** about five and a half minutes.

**Sorting works — click a column header.** Asking for a sortable table is what
reaches the published sortable part; a prompt that does not ask for it does not
get it.

**If a sorted header reads "DateContent hidden by policy",** that is CT-2418 and
not your run. The sort itself is correct and the rows are right; the caret
beside the header is replaced by a policy placeholder once that column has been
sorted. Sort a column you are not about to point at, or leave sorting for last.

The count may render as a phrase rather than a number — "7 Transactions in
2026-09" is the count, not a missing one.

## 4. Bills this month, from mail and bank together

```text
Show me the bills I need to deal with this month, using both my email and my bank transactions. Pair up the ones that are the same bill so I can see what is already paid. Don't send my mail or my transactions to an AI model.
```

**What appears:** bills from your mail paired with the bank payments that
settled them, built from three published parts: a mail reader, a bank reader and
a matcher.

**Stop when:** every pairing on the page is one a person would make.

**Rough time:** three to seven minutes.

**If the detail text is hard to read,** that is the dark surface, not the page —
the amounts are correct. This is the demo the light-surface step exists for.

**Unmatched payments showing zero is right, not a gap.** The pairing part only
considers bill-like payments, so a coffee or a grocery shop is never a
candidate.

---

Run these four in this order and nothing else from this package is needed. What
is deliberately not on this page — and the evidence behind every count here — is
in [DEMOS-EVIDENCE.md](DEMOS-EVIDENCE.md).
