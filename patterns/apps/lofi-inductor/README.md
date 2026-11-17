# Lo-fi inductor

## Why

A frontier model can answer "is this email a bill?" well, but it is slow and
costly to ask it about every email forever. Most such questions have a cheap
answer hiding in them: a handful of regular expressions that get almost every
case right. This pattern finds that cheap answer by watching the expensive one.

It is also a showcase for a release policy that people want and that CFC should
make possible: a rule learned from one person's private mail stays theirs, until
enough different people have independently learned the very same rule that
knowing it says nothing about any one of them.

## How it works

Two patterns.

**`lofi-inductor`** holds one goal ("is this email a bill?") and a stream of
items (`{id, fields}`; anything can feed it: a connector, another piece, an
agent).

1. Every item is labelled by the hi-fi model (an LLM, assumed right) and by the
   lo-fi rule set (regular expressions, run as plain pattern code, assumed
   fallible).
2. When they disagree, the lo-fi set was _surprised_. Every item the hi-fi model
   has labelled is a graded example, on the training or held-out side of a split
   fixed by a hash of its id; surprises are what start a rewrite.
3. After enough new surprises (`rewriteAfter`, default 3), another LLM call sees
   the current rules and the training examples and proposes a whole new rule
   set. It replaces the current one only if every rule is in the grammar and
   passes the grammar's backtracking check, and the set's F1 on the held-out
   examples is strictly higher; a tie keeps the current set. No one has to
   approve rules one by one. Every judged proposal goes into the history,
   accepted or not.
4. Some goals never settle into rules. That is a valid outcome: they stay on the
   hi-fi model.
5. Publishing sends the accepted rules to a pool for the goal, under the piece's
   pseudonym for it. The pool is the `pool` input when one is given, otherwise
   the `#inductorPool` a wish finds (favorites, then this space). A pool serves
   one goal and the wish cannot match on it, so the rules go only to a pool
   whose goal, trimmed, equals the inductor's; otherwise nothing leaves the
   piece. The first publish mints the pseudonym, a random string the piece
   keeps, so it is the same every time this goal is published and unlinkable to
   the person's other goals. The view says which happened: "Published N rules to
   the pool for …" or "No pool for … found".

Rules use a restricted regex grammar (no backreferences, no lookaround) and are
compared by a canonical form, so two people who learned the same rule in
slightly different spellings count as proposing the same rule. Personal details
belong in parameter slots, never in a rule's text, or no one else's rule will
ever match it.

**`inductor-pool`** collects contributions and releases consensus.

- Each person contributes under one pseudonym per goal: the same pseudonym every
  time they publish for that goal, so they are never counted twice for a rule,
  and a different one for each goal, so their goals cannot be linked.
- A rule is released, with its count, once the number of distinct pseudonyms
  that proposed it reaches its threshold. The threshold is a configurable centre
  (default 15) plus a per-rule offset in `[-k, +k]` (default `k = 5`): a keyed
  hash of a pool secret and the rule's canonical form. It is deterministic, so
  the rule's threshold never moves, and unguessable, so no one can plant
  "threshold − 1" contributions to probe whether someone else holds a rule.
- What the offset buys is bounded: someone adding fake contributors one at a
  time can still watch for release, but cannot tell whether up to about `2k` of
  the contributors were real people.

Builds on `apps/self-improving-classifier` (`classifier-logic.ts`): scoring, and
the shape of `isRegexSafe`, which the grammar's backtracking check generalizes.
Design notes: the "hi-fi → lo-fi pump" in the enricher-ecosystem PRD
(§6.8–6.10).

## Building `lofi-inductor`

- `rule-grammar.ts` holds the grammar and the canonical form. The canonical form
  keeps what `RegExp.test` answers with the `i` flag and rewrites only what
  cannot change it: alternation order, laziness, capturing groups, letter case,
  equivalent spellings of one character or class, and quantifier spelling. When
  unsure it leaves a pattern as written, so two rules may compare different that
  mean the same, but never the reverse.
- The grammar is also the safety check, and it runs on the canonical form, which
  is what runs, so `(a|b)+` is accepted as `[ab]+`. It refuses a repeated group
  holding a choice (`(a|aa)+`, exponential), and bounds polynomial backtracking:
  counting the ways each top-level alternative can match one span (a sequence
  multiplies, an alternation adds, an unbounded quantifier counts as
  `MAX_TESTED_LENGTH`), it allows at most `MAX_BACKTRACK_COST`, eight times
  `MAX_TESTED_LENGTH`. In practice that is one unbounded quantifier with a few
  small choices beside it: `invoice.*due` passes, `.*.*!` does not (seconds on a
  thousand characters, measured). A rule tests only a field's first
  `MAX_TESTED_LENGTH` (1000) code units, which turns that count into a bound on
  time: a few milliseconds per rule and field at worst. The pool applies the
  same grammar to every contribution, and takes at most `MAX_RULES` (20) rules
  from one.
- A rule set says YES when a YES rule matches and no NO rule does.
- Scoring all labelled held-out items, not only surprises, is what lets the gate
  see a proposal that fixes the surprises by breaking items the current rules
  got right.
- A computed cannot write, so the judgement is derived and recorded by the
  `settleRewrite` stream, which the view's "Record the judgement" button and
  agents send. The gate decides; sending only records what it decided. Adding an
  item does not record as well, because of the second issue below.
- `publish` records `{goal, rules, publishedAt, pooled}` in `published`, where
  `pooled` says whether the rules were sent to a pool, and sends them to the
  pool's `submit` (see step 5 and `apps/inductor-pool`).
- The goal changes only through `setGoal` (the view's "Set goal" button sends
  it), never per keystroke: every hi-fi call is asked for the goal, so a live
  input re-asked about every item on each key. A new goal clears the rules, the
  history, what was published, and the pseudonym, so the pool cannot link this
  piece's contributions for two questions; the items stay, and the hi-fi model
  labels them for the new goal.
- Choose the hi-fi model with `hifiModel`; omitted, the deployment's default
  `generateObject` model answers.

Known runtime issues this pattern works around:

1. In a block-bodied `map` callback, `const answer = generateObject({...})` with
   a reactive argument is lowered into a `lift` that calls `generateObject`, and
   the graph never settles. The hi-fi map is written expression-bodied. (Not yet
   reduced to a minimal repro: a plain block-bodied map settles.)
2. An action that reads state derived from mapped `generateObject` calls while
   two or more of them are in flight can lose their results for good
   (`contribution-dropped`, a builtin write superseded). Recording the judgement
   while hi-fi calls are in flight can still hit it. Filed as top/3204.

(A third, a first publish that ran twice under server execution and minted two
pseudonyms, locked the contributor out of the pool. The pool now binds the
principal rather than the pseudonym, so the second run's submission replaces the
first's.)

## CFC debt

**The intended policy.** A person's items, the hi-fi labels, and the rules
induced from them are theirs alone. A rule leaves their instance only into a
pool, confidential to the pseudonym that contributed it. Anyone may learn a rule
and its contributor count once at least the rule's threshold of distinct,
independent people have each contributed it. Below the threshold no one learns
the rule, its count, or whether it exists. No one learns which pseudonyms
contributed, and a pseudonym is not linkable to its owner or to their other
pseudonyms.

**What is real CFC.** Items and induced rules are private by default; LLM output
carries `LlmDerived` and the confidentiality of what it read. Contributions, and
the secret keying the threshold offsets, are
`Confidential<…, [PolicyOf<rules>]>`. The only release is through one trusted
function of the policy module, `releaseConsensus`: the runtime stamps what it
writes `TransformedBy{THIS_POLICY.moduleIdentity, "releaseConsensus"}`, and the
policy's one exchange rule drops the clause on that stamp, as
`examples/cfc-exchange-rules/blessed-computation.tsx` releases a tally. The
threshold, its hidden offset, and the rule that nothing below threshold is
emitted (not the rule, not its count, not that it exists) are that function's
own logic, so they need no new CFC machinery. The secret and the per-rule counts
never leave the function; only released rules and their counts do, into a public
store.

**Cuts** (both approved by Alex, 2026-11-16):

1. _Distinct people._ The trusted function counts distinct pseudonyms. Nothing
   attests that two pseudonyms are two people, so one person with many
   pseudonyms counts as many. The hidden offset raises the cost of probing but
   does not stop it. Missing semantics: an attested distinct-principal
   (personhood) atom.
2. _Pseudonym linkability._ Commits and owner-integrity labels in the pool space
   name the contributor's core identity (`docs/specs/profile-delegation.md`,
   "Attribution and unlinkability"; the intermediate key is deferred). Missing
   semantics: unlinkable pseudonymous authorship.

**Platform limit, not a pattern cut.** Labels are enforced by the client; a
reader with raw access to the pool space sees confidential contributions. This
holds for every labelled store today.
