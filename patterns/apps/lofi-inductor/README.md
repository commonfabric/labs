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
2. When they disagree, the lo-fi set was *surprised*. The item and the hi-fi
   label join the graded set, which keeps a held-out split.
3. After surprises accumulate, another LLM call proposes a whole new rule set.
   It replaces the current one only if every rule compiles, passes the regex
   safety check, and the set scores better on the held-out examples. No one has
   to approve rules one by one.
4. Some goals never settle into rules. That is a valid outcome: they stay on the
   hi-fi model.
5. Publishing sends the accepted rules to a pool under the goal's pseudonym.

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

Builds on `apps/self-improving-classifier` (`classifier-logic.ts`): regex
compiling, `isRegexSafe`, and scoring. Design notes: the "hi-fi → lo-fi pump"
in the enricher-ecosystem PRD (§6.8–6.10).

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
carries `LlmDerived` and the confidentiality of what it read. Contributions,
and the secret keying the threshold offsets, are
`Confidential<…, [PolicyOf<rules>]>`. The only release is through one trusted
function of the policy module, `releaseConsensus`: the runtime stamps what it
writes `TransformedBy{THIS_POLICY.moduleIdentity, "releaseConsensus"}`, and the
policy's one exchange rule drops the clause on that stamp, as
`examples/cfc-exchange-rules/blessed-computation.tsx` releases a tally. The
threshold, its hidden offset, and the rule that nothing below threshold is
emitted (not the rule, not its count, not that it exists) are that function's
own logic, so they need no new CFC machinery. The secret and the per-rule
counts never leave the function; only released rules and their counts do, into
a public store.

**Proposed cuts** (each pending approval; this section is updated as each is
decided):

1. *Distinct people.* The trusted function counts distinct pseudonyms. Nothing
   attests that two pseudonyms are two people, so one person with many
   pseudonyms counts as many. The hidden offset raises the cost of probing but
   does not stop it. Missing semantics: an attested distinct-principal
   (personhood) atom.
2. *Pseudonym linkability.* Commits and owner-integrity labels in the pool space
   name the contributor's core identity (`docs/specs/profile-delegation.md`,
   "Attribution and unlinkability"; the intermediate key is deferred). Missing
   semantics: unlinkable pseudonymous authorship.

**Platform limit, not a pattern cut.** Labels are enforced by the client; a
reader with raw access to the pool space sees confidential contributions. This
holds for every labelled store today.
