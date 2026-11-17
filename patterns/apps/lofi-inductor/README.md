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
   set. The request is frozen on the items up to the surprise that crossed the
   threshold, so items arriving while the model answers do not ask it again;
   they count toward the next round. The gate judges the answer at once: it
   would replace the current rules only if every rule is in the grammar (which
   includes the backtracking check), there are at least `MIN_HELD_OUT` (5)
   held-out examples, and the set's F1 on them beats the current set's by at
   least `MIN_F1_GAIN` (two points). Below five examples one example moves F1 by
   twenty points, so a win is mostly luck; the margin keeps a set that only ties
   from churning the rules and what was published. No one approves rules one by
   one, but **recording the judgement takes a send** of `settleRewrite`: the
   view's button, labelled with what it does ("Apply new rules (F1 62% → 81%)"
   or "Dismiss rejected proposal", under the proposed rules), or an agent. A
   computed cannot write, and an action that recorded on its own whenever an
   item arrived would read the rewrite while hi-fi calls are in flight, which
   can lose their results (the second runtime issue below). Every recorded
   proposal goes into the history, accepted or not, and marks answered only the
   surprises its request was frozen on. A failed model call is not a proposal:
   nothing is recorded, and "Try again" (`retryRewrite`) asks again.
4. Some goals never settle into rules. That is a valid outcome: they stay on the
   hi-fi model.
5. Publishing sends the accepted rules to a pool for the goal, under the piece's
   pseudonym for it. The pool is the `pool` input when one is given, otherwise
   the `#inductorPool` a wish finds (favorites, then this space). A pool serves
   one goal and the wish cannot match on it, so the rules go only to a pool
   whose goal is the inductor's, ignoring case and surrounding or repeated
   space; otherwise nothing leaves the piece. With no rules there is nothing to
   publish, and the button is disabled. The first publish mints the pseudonym, a
   random string the piece keeps, so it is the same every time this goal is
   published and unlinkable to the person's other goals. The view says which
   happened: "Sent N rules to the pool for …" or "No pool for … found". It says
   sent, not published: whether the pool took them is not visible to the piece
   (a refusal is thrown in the pool's handler, and a contribution is
   confidential to the pool).

6. The pool's release comes back. The inductor reads the rules the pool for its
   goal releases (`consensus`, public by the pool's policy) and offers them as a
   candidate set, judged by the same gate as a rewrite on the person's own
   held-out items (`poolOffer`). A released rule that matches none of those
   items is left out first: the score cannot see what it does, so it would ride
   along unexamined (a NO exception aimed at a sender the person has not heard
   from yet, say). The view lists every released rule as offered, refused, or
   left out. Recording it takes a send of `settlePoolOffer`: "Adopt the pool's
   rules (F1 a → b)" or "Dismiss the pool's rules". A set already judged is not
   offered again; a new release is. A rule adopted from the pool is marked
   (`adopted`, by key) and publishing leaves it out: the pool's counts measure
   independent learners, and a rule sent back by everyone who took it would keep
   itself above threshold on others' learning. It stays marked while the rules
   keep it, through later rewrites too, since the model saw it among the current
   rules.

Rules use a restricted regex grammar (no backreferences, no lookaround) and are
compared by a canonical form, so two people who learned the same rule in
slightly different spellings count as proposing the same rule.

**Personal details in rules.** The design calls for personal details to go in
parameter slots rather than a rule's text. Parameter slots are not built. The
protection against a published rule carrying someone's details is the pool's
threshold: a rule that names one person is held by one contributor and is never
released. Publishing also holds back, cheaply, any rule whose pattern has an `@`
or a run of six or more digits (`looksPersonal`), a run that spaces, dots,
dashes, or brackets break (`123-456-7890`) or a count repeats (`1{6}`) included;
the view says how many it held back. Neither is a guarantee: a rule with a name
in it is sent, and stays confidential in the pool only by its policy.

**`inductor-pool`** collects contributions and releases consensus.

- Each person contributes under one pseudonym per goal: the same pseudonym every
  time they publish for that goal, and a different one for each goal, so their
  goals are not linked by pseudonym (cut 2 says what still links them). The pool
  counts each principal once, whatever pseudonym they send.
- A rule is released, with its count, once the number of distinct pseudonyms
  that proposed it reaches its threshold. The threshold is a configurable centre
  (default 15) plus a per-rule offset in `[-k, +k]` (default `k = 5`), and never
  below five, a floor the pool's policy module fixes: a keyed hash of a pool
  secret and the rule's canonical form. It is deterministic, so the rule's
  threshold never moves, and unguessable without the secret, so a prober cannot
  plant exactly "threshold − 1" contributions to test whether someone else holds
  a rule. The secret is not hidden from everyone: the first contributor's
  runtime mints it, and any runtime that runs the pool can read it (the platform
  limit below).
- What the offset buys is bounded: someone adding fake contributors one at a
  time can still watch for release, but cannot tell whether up to about `2k` of
  the contributors were real people.

Builds on `apps/self-improving-classifier` (`classifier-logic.ts`): scoring, and
the shape of `isRegexSafe`, which the grammar's backtracking check generalizes.
Design notes: the "hi-fi → lo-fi pump" in the enricher-ecosystem PRD
(§6.8–6.10).

## Building `lofi-inductor`

- `../inductor-pool/rule-grammar.ts` holds the grammar and the canonical form.
  It lives with the pool, whose policy module imports it, and the inductor
  imports it from there. The canonical form keeps what `RegExp.test` answers
  with the `i` flag and rewrites only what cannot change it: alternation order,
  laziness, capturing groups, letter case, equivalent spellings of one character
  or class, and quantifier spelling. When unsure it leaves a pattern as written,
  so two rules may compare different that mean the same, but never the reverse.
- The grammar is also the safety check, and it runs on the canonical form, which
  is what runs, so `(a|b)+` is accepted as `[ab]+`. It refuses a repeated group
  holding a choice (`(a|aa)+`, exponential), and bounds polynomial backtracking:
  counting the ways the pattern can match one span (a sequence multiplies, an
  alternation adds, an unbounded quantifier counts as `MAX_TESTED_LENGTH`), it
  allows at most `MAX_BACKTRACK_COST`, eight times `MAX_TESTED_LENGTH`, for all
  the top-level alternatives together, since `RegExp.test` tries each of them at
  every position. In practice that is one unbounded quantifier with a few small
  choices beside it: `invoice.*due` passes, `.*.*!` does not (seconds on a
  thousand characters, measured). Three things the count sees through, so
  ordinary rules fit (`order\s*#?\s*\d+`, `total:?\s*\$\d+`): a quantifier over
  one character set whose characters cannot start what must follow, or that ends
  the pattern, scans its run once rather than giving characters back; an
  alternation whose branches start on different characters sends only one on;
  and a leading character that nothing after it can consume gates the start
  positions, so their scans do not overlap. The rewrite prompt states the limit.
  A rule tests only a field's first `MAX_TESTED_LENGTH` (1000) code units, which
  turns that count into a bound on time: about fifteen milliseconds per rule and
  field at worst, measured. Every rule of a set runs on every item, so a set's
  patterns together may cost at most `MAX_SET_BACKTRACK_COST`, four patterns'
  worth. The pool applies the same grammar and set budget to every contribution,
  and takes at most `MAX_RULES` (20) rules from one.
- A rule set says YES when a YES rule matches and no NO rule does.
- Scoring all labelled held-out items, not only surprises, is what lets the gate
  see a proposal that fixes the surprises by breaking items the current rules
  got right.
- The gate decides; sending `settleRewrite` only records what it decided (step
  3).
- `publish` records `{goal, rules, publishedAt, pooled}` in `published`, where
  `pooled` says whether the rules were sent to a pool, and sends them to the
  pool's `submit` (see step 5 and `apps/inductor-pool`).
- The goal changes only through `setGoal` (the view's "Set goal" button sends
  it), never per keystroke: every hi-fi call is asked for the goal, so a live
  input re-asked about every item on each key. A new goal clears the rules, the
  history, what was published, and the pseudonym, so the pool cannot link this
  piece's contributions for two questions; the items stay, and the hi-fi model
  labels them for the new goal.
- Agents drive it through its streams: `setGoal`, `submitItem`, `removeItem`,
  `settleRewrite`, `retryRewrite`, `settlePoolOffer`, and `publish`. The pool's
  are `submit` and `withdraw`.
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
own logic, so they need no new CFC machinery. The rule also requires an input
witness: everything the function read was written by the pool's own
`submitContribution`, so the function run over contributions anyone else made up
is not released (`apps/inductor-pool/README.md`). The secret and the per-rule
counts never leave the function; only released rules and their counts do, as the
pool's public result, read where it is computed (the runtime refuses storing it
today; see the pool's README).

**Cuts** (both approved by Alex, 2026-11-16):

1. _Distinct people._ The trusted function counts distinct pseudonyms. Nothing
   attests that two pseudonyms are two people, so one person with many
   pseudonyms counts as many. The hidden offset raises the cost of probing but
   does not stop it. Missing semantics: an attested distinct-principal
   (personhood) atom.
2. _Pseudonym linkability._ Commits and owner-integrity labels in the pool space
   name the contributor's core identity (`docs/specs/profile-delegation.md`,
   "Attribution and unlinkability"; the intermediate key is deferred). And the
   release is exact and live: a released rule's count moves the moment a
   contribution lands, and each contribution is an identity-signed commit, so
   anyone who reads the pool space can tell which principal's commit moved a
   released rule's count, and so that they hold it. Missing semantics:
   unlinkable pseudonymous authorship.

**Platform limit, not a pattern cut.** Labels are enforced by the client; a
reader with raw access to the pool space sees confidential contributions. This
holds for every labelled store today.
