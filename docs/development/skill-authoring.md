# Skill Authoring: Maps, Not Procedures

> Guidance for writing and reviewing repo-local skills (`skills/**/SKILL.md`).
> The bar is not "thorough" — it's "ages well." A good skill makes a capable
> agent better today and an even more capable agent better tomorrow.

## Why this exists

When we add a skill, that skill is loaded into an agent's context on every
invocation: it competes with the actual task for attention, and it shapes how
the agent thinks before it has looked at anything. That is real leverage and a
real failure mode. A skill can **augment** an agent (supply what it cannot know)
or **constrain** it (channel it down paths someone hard-coded). As the
underlying models get better at the work, the augmenting parts grow more
valuable and the constraining parts turn into drag. This doc is the line we draw
between the two.

## The core distinction

Every line in a skill is one of two things, and they have opposite trajectories.

- **Map & values** — non-derivable local knowledge. Where the canonical hash
  lives. That the tree already carries three forked SHA-256s. That pattern
  source is two abstraction levels above what runs. How harsh our reviews should
  be; that we ship many PRs and don't demand pristine. A frontier model with
  perfect judgment _still won't know these_ — they are facts about our repo, our
  history, and our preferences. This content **appreciates**: a smarter agent
  does more with a good map.
- **Procedure** — "order findings by impact," "label verified vs. suspected,"
  the report template, the step-by-step. A capable model already does this. This
  content **depreciates**: first it is redundant, then it actively fights a
  better instinct.

> Write the map. Minimize the procedure.

The over-constraint we (rightly) worry about lives almost entirely in the
procedure half. The fix is not "less detail" — a detailed map is the best thing
a skill can be — it is "less _procedure_."

## Principles over enumerations

The specific thing that caps an agent is a **closed list presented as
complete.** Give an agent "check for A, B, C, D" and it pattern-matches those
four and stops looking; the cost is the fifth thing it never considers, because
the list implied the space was covered.

Prefer a **generative principle** that produces the right behavior on cases
nobody enumerated:

- ✅ "A searcher who lands on a doc must not be misled." (generates coverage)
- ⚠️ "Check try/catch, singletons, async-in-handlers, schema drift."
  (caps at what was known when written)

Concrete tells _are_ useful — so when you enumerate, mark the list as seed, not
boundary: "tells include, e.g., …". Same words, higher ceiling.

## Floor, not ceiling

A skill trades a little ceiling for a lot of floor. It slightly caps the
best-case run (anchoring) in exchange for sharply raising the worst-case one — a
tired invocation, a cheaper model, an agent having an off moment. For anything
run often across varied contexts, that trade wins, because a _confidently wrong_
run costs far more than a merely mediocre one. Prescribe in proportion to
**frequency × variance × cost-of-a-bad-run.** A one-off you supervise needs
almost none; a review skill run by many agents on every PR earns its map.

## Values don't depreciate

Much of what reads as "constraint" is really a _parameter the model can't
infer_: how aggressive to be, what we tolerate, what counts as done. Better
models do not converge on your team's taste on their own — it has to be told.
Supplying that is not capping capability; it is configuration. Keep it.

## Facts rot — so make them testable

The cruel part: the highest-value content (the map of canonical homes, exact
symbol names, file paths) is also the highest-rot. The moment the tree moves, an
authoritative-looking fact starts actively misleading — the exact failure most
skills exist to prevent. Two defenses:

1. **Point, don't copy.** Reference the canonical doc or symbol; don't restate
   its contents where they will drift out of sync.
2. **Make load-bearing facts testable.** If a skill asserts "`@commonfabric/x`
   exports `y`," a one-line CI grep checking those mentions against real exports
   converts a rot-prone asset into a durable one. Every skill already gets this
   for the two facts a machine can check exactly: `deno task check-skill-facts`
   fails when a repo path or a `@commonfabric/...` specifier a skill cites stops
   resolving. Write a path in backticks and from the repo root and it is checked;
   write it as a placeholder (`runtime/<pkg>/mod.ts`) to mark it as an
   illustration. See [`skill-audit.md`](./skill-audit.md).

## The editing test

For each line of a skill — writing one, or reviewing one — ask:

> Would a frontier model with no repo context but excellent judgment already do
> this?

- **Yes** → it's procedure. Cut it, or compress to a one-line reminder.
- **No, because it's a fact about our repo / history / values** → keep it. That's
  the map.

A good skill reads as a **map and a statement of values, not a recipe.** If you
can delete a section and a competent agent's output barely changes, that section
was spending context and ceiling for nothing.
