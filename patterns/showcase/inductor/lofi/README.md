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

## Using it

1. Type a yes-or-no question about your items, such as "Is this email a bill?",
   and press "Set goal".
2. Add items: type one into the Items card, or have a connector or an agent send
   them through `addItem`. The model answers the question for each one.
3. Watch the Rules card. Once enough items surprise the current rules, the model
   proposes a new set, and the card offers to apply it if it scores better on
   the held-out items, or to dismiss it.
4. To share what you learned, connect a pool for the same question (deploy an
   `inductor-pool` with that question in a space you can reach, or link one as
   `pool`) and press "Publish rules".

The model, how many surprises start a rewrite, and the held-out share are in the
Settings card.

## How it works

Two patterns.

**`lofi-inductor`** holds one goal ("is this email a bill?") and a stream of
items (`{id, fields}`; anything can feed it through `addItem` or `addItems`: a
connector, another piece, an agent).

1. Every item is labelled by the hi-fi model (an LLM, assumed right) and by the
   lo-fi rule set (regular expressions, run as plain pattern code, assumed
   fallible).
2. When they disagree, the lo-fi set was _surprised_. Every item the hi-fi model
   has labelled is a graded example, on the training or held-out side of a split
   fixed by a hash of its id; surprises are what start a rewrite.
3. A rewrite. Once enough surprises are new (`rewriteAfter`, default 3):
   - Another call to the same model sees the current rules and the training
     examples, and proposes a whole new rule set.
   - The request is frozen on the items up to the surprise that crossed the
     threshold. Items arriving while the model answers count toward the next
     round.
   - The gate judges the answer at once. It replaces the current rules only if
     every rule is in the grammar (which includes the backtracking check), there
     are at least `MIN_HELD_OUT` (5) held-out examples, and the set's F1 on them
     beats the current set's by at least `MIN_F1_GAIN` (two points). Below five
     examples one example moves F1 by twenty points, so a win is mostly luck;
     the margin keeps a set that only ties from churning the rules.
   - Recording the judgement takes a send of `settleRewrite`: the view's button
     ("Apply new rules (F1 62% → 81%)" or "Dismiss rejected proposal") or an
     agent. A computed cannot write, and recording on every new item would read
     the rewrite while hi-fi calls are in flight (the first runtime issue
     below).
   - Every recorded proposal goes into the history, accepted or not, and marks
     answered only the surprises its request was frozen on.
   - A failed model call is not a proposal: nothing is recorded, and "Try again"
     (`retryRewrite`) asks again.
4. Some goals never settle into rules. That is a valid outcome: they stay on the
   hi-fi model.
5. Publishing sends the accepted rules to a pool for the goal, under the piece's
   pseudonym for it. The pool is the `pool` input when one is given, otherwise
   the `#inductorPool` a wish finds (favorites, then this space). A pool serves
   one goal and the wish cannot match on it, so the rules go only to a pool
   whose goal is the inductor's, ignoring case and surrounding or repeated
   space; otherwise nothing leaves the piece. The view says whether a pool for
   the goal is connected, and disables Publish when none is or there is nothing
   to send. The first publish with a rule to send mints the pseudonym, a random
   string the piece keeps, so it is the same every time this goal is published.
   Each goal's piece mints its own, so the strings do not relate across goals,
   but they are not unlinkable: the pool space's commits and `authored-by`
   labels name the person's core identity (cut 2 under "CFC debt"). The view
   says which happened: "Sent N rules to the pool for …" or "No pool for …
   found". It says sent, not published: whether the pool took them is not
   visible to the piece (a refusal is thrown in the pool's handler, and a
   contribution is confidential to the pool). Anything with a pool's shape and
   the goal receives the rules, a fake pool included: the inductor does not vet
   the receiver. What it sends is labelled with the real pool's policy instead
   (see "CFC debt"), so that, by design, a fake can receive the rules but not
   publish them. Today that holds only in part (top/3175): with server execution
   off a fake can publish a received rule directly, and in either posture one
   that stores the rules first can publish them later.

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
threshold: a rule that names one person is likely held by one contributor, and
so likely stays below the threshold and unreleased. That is not a guarantee:
enough contributors submitting the same name-bearing rule would release it.
Publishing also holds back, cheaply, any rule whose pattern has an `@` or a run
of six or more digits (`looksPersonal`), a run that spaces, dots, dashes, or
brackets break (`123-456-7890`) or a count repeats (`1{6}`) included; the view
says how many it held back. Neither is a guarantee: a rule with a name in it is
sent, and stays confidential in the pool only by its policy.

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

- `../shared/rule-grammar.ts` holds the grammar and the canonical form. It lives
  with the pool, whose policy module imports it, and the inductor imports it
  from there. The canonical form keeps what `RegExp.test` answers with the `i`
  flag and rewrites only what cannot change it: alternation order, laziness,
  capturing groups, letter case, equivalent spellings of one character or class,
  and quantifier spelling. When unsure it leaves a pattern as written, so two
  rules may compare different that mean the same, but never the reverse.
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
  and refuses a contribution of more than `MAX_RULES` (20) rules whole, taking
  none of it.
- A rule set says YES when a YES rule matches and no NO rule does.
- Scoring all labelled held-out items, not only surprises, is what lets the gate
  see a proposal that fixes the surprises by breaking items the current rules
  got right.
- The gate decides; sending `settleRewrite` only records what it decided (step
  3).
- `publish` records `{goal, rules, publishedAt, pooled}` in `published`, where
  `pooled` says whether the rules were sent to a pool, and sends them to the
  pool's `submit` (see step 5 and `showcase/inductor/pool`). With nothing to
  send, an empty rule set included, it withdraws this piece's earlier
  contribution instead, so a publish after `resetRules` leaves nothing behind.
- The goal changes only through `setGoal` (the view's "Set goal" button sends
  it), never per keystroke: every hi-fi call is asked for the goal, so each
  change asks about every item again. A new goal first withdraws this piece's
  contribution from the old goal's pool, then clears the rules, the history,
  what was published, and the pseudonym, so the pool cannot link this piece's
  contributions for two questions; the items stay, and the hi-fi model labels
  them for the new goal.
- `unpublish` takes this piece's contribution back out of the goal's pool (the
  pool's `withdraw`, which removes only the sender's) and clears `published`.
  The pseudonym stays, so publishing again comes back under it.
- One model labels the items and proposes rules: `hifiModel`, set with
  `setHifiModel`. Empty, the deployment's default `generateObject` model
  answers; a stronger model the gateway lists can be named. Both calls pass an
  explicit JSON schema in the strict form (no extra properties, every property
  required), which strict providers such as OpenAI's structured outputs take.

**Layout.** `lofi-inductor.tsx` holds the state, the verbs, and the judgements
(`rows`, `summary`, `heldOutF1`, `rewrite`, `poolOffer`, and each item's
wording, `verdictsOf`), and lays out five sub-patterns in sibling files, in the
order a person works through them. Each takes the values it shows and the
streams it sends:

- `items-card.tsx`: the add-an-item box, whose draft is per session, then each
  item with its labels, a surprise in the error tone, a "held out" badge, and a
  remove button. With no question it shows no labels; with no rules the lo-fi
  side reads "no rules yet".
- `rules-card.tsx`: the current rules, with their F1 once held-out items are
  labelled, where the rewrite stands, the ready proposal, and the buttons that
  apply or dismiss it, retry a failed call, take a rule out, or clear the set.
- `history-card.tsx`: every judged proposal, newest first.
- `pool-card.tsx`: whether a pool for the goal is connected and how to get one,
  the pool's offer, what was last published, and the buttons that adopt or
  dismiss the offer, publish, and unpublish.
- `settings-card.tsx`: the model, `rewriteAfter`, and `heldOutPercent`, folded
  away; "Apply" sends each filled-in draft to its setter.

The cards are known by their position in the view (`composition.md`), so a new
one goes after the last. The hi-fi calls stay in the parent's map rather than in
a per-item sub-pattern: one that owned its item's `generateObject` never
delivered a label (the second runtime issue below).

**Verbs.** Everything the view does, an agent can do through a stream, and a
malformed event throws rather than doing nothing:

- Items: `addItem` (`{fields, id?}`: string fields, at least one; an id the list
  holds adds nothing, and one is minted when none is given), `addItems`
  (`{items}`, a batch of the same), and `removeItem` (`{item}`, the item itself
  as read from `items`; one the list no longer holds changes nothing). The id is
  only a dedupe key, so a connector that sends the same record twice adds it
  once; nothing addresses an item by it.
- Rules: `removeRule` (`{rule}`, as read from `rules`; it also drops the rule's
  adopted mark), `resetRules` (empties the set and the marks; the history
  stays), `settleRewrite`, `retryRewrite`, and `settlePoolOffer`.
- Settings: `setGoal` (`{goal}`, not blank), `setRewriteAfter` (`{count}`, a
  whole number, at least 1), `setHeldOutPercent` (`{percent}`, above 0 and below
  100), and `setHifiModel` (`{model}`, a name, or "" for the default).
- The pool: `publish` and `unpublish`. The pool's own verbs are `submit` and
  `withdraw`.

Known runtime issues this pattern works around:

1. An action that reads state derived from mapped `generateObject` calls while
   two or more of them are in flight can lose their results for good
   (`contribution-dropped`, a builtin write superseded). Filed as top/3204. A
   rewrite reads as ready, and the pool offers a set, only once no hi-fi call is
   in flight (`labellingCount`), so `settleRewrite` and `settlePoolOffer` sent
   sooner write nothing. They still read the derived state to learn that;
   whether a read alone, with no write, can lose a result is not known.
2. A sub-pattern instance per item that owns the item's `generateObject` (an
   `ItemLabel({goal, item})` mapped over the items, returning `{id, answer}`)
   never delivers a label: every row stays unlabelled. The hi-fi calls stay in
   the parent's map.
3. An item seeded with the piece is stored inline and has no document of its
   own, so a reference held to one names its slot: once an earlier item is
   removed, that reference matches nothing, and `removeItem` with it does
   nothing. An item added through `addItem` is a link, and its reference
   survives the move.

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
witness: every contribution the function read was written by
`submitContribution`, so the function run over contributions other code wrote or
spliced together is not released. The witness names the writer function, not the
pool: `submitContribution` is exported, so code of anyone's can bind it to a
list of its own, and a release over that list is witnessed too. What bounds that
is the writer's own logic. It stamps each entry's contributor from the runtime's
principal, so an entry names its real author, and the release counts distinct
contributors; and every seal it mints or copies keeps each rule's threshold at
or above `MIN_SEALED_THRESHOLD` (5), a constant of the policy module, which the
release checks again. So a release over such a list takes at least five distinct
principals holding the rule, counting a real holder whose inductor sent to that
binding (a fake pool built on it, say). It does not take more: an attacker who
holds a rule, read from someone's contribution included, can release it with
five accounts of their own, or four beside its holder (cut 1). The details are
in `showcase/inductor/pool/README.md`, "What the witness does not cover". The
secret and the per-rule counts never leave the function; only released rules and
their counts do, as the pool's public result, read where it is computed (the
runtime refuses storing it today; see the pool's README).

**What the inductor sends is labelled with the pool's policy.** The inductor
publishes to whatever pool its `pool` input or wish gives it, checking only the
shape and the goal, so a fake pool of that shape receives the person's rules.
Trust comes from the label, not from vetting the receiver: the inductor types
what it sends as the pool's `ContributionEvent` (`../pool/pool-policy.tsx`), the
event and each rule `Confidential<…, [PolicyOf<typeof poolRules>]>`, and only
the real pool's `releaseConsensus` may drop that clause. This is the idiomatic
design, not a cut. It waits on a runtime fix, top/3175 (a send's payload arrives
unlabelled): `lofi-inductor-fake-pool.test.tsx` shows a fake that writes a
received rule straight into a public store refused with server execution on, and
landing with it off; and, in either posture, a fake that keeps the rules in a
store of its own first can publish them later, since what a handler writes from
its event does not carry the event's label. The test asserts both as they stand,
to flip when top/3175 is fixed.

**Cuts** (both approved by Alex, 2026-11-16):

1. _Distinct people._ The trusted function counts distinct contributor
   principals, as the pool's one writer stamped them from the runtime, not
   pseudonyms: one principal counts once whatever pseudonyms it sends, and a
   resubmission replaces its entry. Nothing attests that two principals are two
   people, so one person who controls several principals (accounts) counts as
   several. The hidden offset raises the cost of probing but does not stop it.
   Missing semantics: an attested distinct-principal (personhood) atom.
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
