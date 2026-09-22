# Running the cf-harness demos

Four demos, in the order to run them. Each was run to a working page on the
build named below — three times for demos 2, 3 and 4, twice for demo 1 — with
the page checked in a browser every time.

Everything else — the counts, the findings behind them, the demos that are not
on this page and why — is in [DEMOS-EVIDENCE.md](DEMOS-EVIDENCE.md). Read this
page to run them; read that one to understand them.

## Before you start

1. **Start a fresh console.** Not one that has been running all day: a console a
   few hours old can exit on a heap out-of-memory, and nothing announces it.
2. Pin this session to the proven build:
   `loom vendor sync labs --ref a77e958513`, then
   `loom restart loom --include-toolshed`.

   **Do not run `loom update`.** It pulls loom's main and takes no ref, and
   loom's main now pins a labs newer than the one these demos are proven on. It
   is the one command here that will silently move you off it. The pin above
   does not persist either — it leaves `vendors.json` alone — so a later
   `loom update` undoes it and step 3 is what catches that.
3. Confirm the build: `curl -sS <your-toolshed>/api/meta` should report `gitSha`
   opening `a77e958513`. **On the toolshed, not the console** — the console has
   no `/api/meta` and answers 404.
4. Run one search from the command pill — `pomodoro` will do — and let it
   finish. The first search of a session is slower than the rest.
5. **Set the browser to a light color surface.** One proven page renders correct
   amounts that cannot be read against a dark background.
6. Check your grants. Demos 1 and 2 need none. Demo 3 needs a finance grant.
   Demo 4 needs a finance grant and an email grant.

If the build does not match, these demos may still work, but nothing on this
page is a claim about your console. Run each one yourself before showing it.

Every prompt below ends with a sentence authorizing a slug retry. Keep it: slugs
are never reused, so without it the second run of a demo stops to ask.

---

## 1. A pomodoro timer

```text
I want a pomodoro timer. Use a pattern from the library if one fits. Give it a slug that is not already in use; if a slug you try is taken, choose another and retry without asking me.
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
Make a dinner-preparation page by composing cf:pattern:vAx2Uy1C64duK47NIl9a0fb0UtfnHrXRrxM8giA1hWM for tasks and cf:pattern:BEf5ZMjTIzX9J5HE6wec1s3zcQNqTAg-lFoD6W7pBHs for expenses. Use the published components' existing controls with writable local state. Start with tasks Buy pasta, Set the table and Chill drinks, all unchecked. Start with Pasta costing $12.50 and Drinks costing $7.50, against a $50 budget. AmountLedger's amount and budget inputs are in whole dollars: pass 12.50 and 7.50, not 1250 and 750, despite the published description mentioning cents. I need to add and check off tasks, add expenses, and see the running total and remaining budget. This page uses no connectors. Give it a slug that is not already in use; if a slug you try is taken, choose another and retry without asking me.
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
Show me this month's bank transactions as a table with a count on top. Use patterns from the library where they fit. Give it a slug that is not already in use; if a slug you try is taken, choose another and retry without asking me.
```

**What appears:** a table of the month's transactions with a count above it.

**Stop when:** the rows on screen match the month's transactions.

**Rough time:** about five and a half minutes.

**If the column headers show a hand cursor,** say that they do not sort before
anyone reaches for one. Whether they look clickable varies from run to run; they
never sort. The count may also render as a phrase rather than a number — "7
Transactions in 2026-09" is the count, not a missing one.

## 4. Bills this month, from mail and bank together

```text
Compose these three library patterns into one page: cf:pattern:-xx1hxtvAbY7AL6FeYuQWuEzbC0nOpUOHgXseIac2_w (this month's email headers from my Gmail), cf:pattern:v6_KSFHs9AmTg9PKwMmPdZyEHxZ9Oykhno4HBOfUo5s (this month's transactions from my bank) and cf:pattern:d_z9mtdCBUwBpG0A6nBwOy5_2fxqySuk2zNxeIdXAYA (pairs email bills with the bank payments that settled them). Show the bills I need to deal with: pair an email bill with the bank payment that settled it using plain text rules on subject, sender and merchant name only; list unpaid email bills and unmatched bank payments separately. Do not send my mail or my transactions to an AI model. Give it a slug that is not already in use; if a slug you try is taken, choose another and retry without asking me.
```

**What appears:** paid bills paired with the payments that settled them, with
unpaid bills and unmatched payments listed separately.

**Stop when:** every pairing on the page is one a person would make.

**Rough time:** six to eleven minutes. It varies widely on identical text, so
leave room for the long end rather than expecting the short one.

**If the detail text is hard to read,** that is the dark surface, not the page —
the amounts are correct. This is the demo the light-surface step exists for.

**Unmatched payments showing zero is right, not a gap.** The pairing part only
considers bill-like payments, so a coffee or a grocery shop is never a
candidate.

---

Run these four in this order and nothing else from this package is needed. What
is deliberately not on this page — and the evidence behind every count here — is
in [DEMOS-EVIDENCE.md](DEMOS-EVIDENCE.md).
