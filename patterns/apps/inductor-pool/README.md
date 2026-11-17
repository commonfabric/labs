# Inductor pool

## Why

A lo-fi inductor (`apps/lofi-inductor`) learns cheap regex rules for one
yes-or-no goal from one person's private items. A rule many people learned
independently is worth sharing, and sharing it says nothing about any of them; a
rule only one person learned may say a lot. The pool collects rule sets for one
goal and releases a rule, with its count, only once enough distinct contributors
hold it. The policy is the one in `apps/lofi-inductor/README.md` ("CFC debt");
this pattern is its implementation.

## How it works

- **Config.** `thresholdCenter` (default 15) and `jitter` `k` (default 5), set
  when the pool is made. The first contribution seals them (below), so anything
  that can write the pool's inputs, a contributor included, cannot lower the
  threshold once there is something to release
  (`inductor-pool-config.test.tsx`).
- **Contribute.** `submit` takes `{pseudonym, rules}`, the rules in canonical
  form (`CanonicalRule` from `apps/lofi-inductor/rule-grammar.ts`). The handler
  checks every rule against the grammar again, stores it in canonical form, and
  keeps a rule given twice once. A rule out of grammar refuses the whole set.
- **One pseudonym per person per goal.** Each stored contribution is labelled
  `authored-by` the principal it acted for, by the runtime
  (`AuthoredByCurrentUser`), and only `submitContribution` may write one
  (`WriteAuthorizedBy`). The principal, not the pseudonym, is the binding: each
  principal holds one entry, and a resubmission replaces it, under whatever
  pseudonym it names. The handler refuses a pseudonym another principal holds.
  So no one contributes under someone else's pseudonym, and no principal is
  counted twice. (Refusing a principal's new pseudonym instead locked out a
  contributor whose two runs of one publish minted two.)
- **Withdraw.** `withdraw` takes the sender's entry out, by principal. It sends
  `submit` `{ withdraw: true }`, so `submitContribution` stays the only code
  that writes a contribution, which the release's input witness needs. Once
  every contributor has withdrawn, the next contribution seals afresh.
- **The seal.** The first contribution mints a 128-bit pool secret
  (`Math.random`, the sandbox's, which a handler may call) and copies the
  configured `thresholdCenter` and `jitter` beside it. That seal is stored in
  the contribution, and every later contribution copies the first one's. So the
  secret and threshold are written only by `submitContribution`, like the rules,
  and the release reads them from the contributions alone.
- **Release.** `releaseConsensus`, a `lift` exported from `inductor-pool.tsx`,
  takes the contributions and nothing else. It counts the distinct pseudonyms
  holding each rule. A rule is counted by its field, label and canonical
  pattern, not by its 64-bit `key`, whose FNV hash anyone can collide. Each
  rule's threshold is `thresholdCenter + offset`, from the seal, where `offset`
  is in `[-k, +k]`: the first 32 bits of HMAC-SHA-256(secret, rule), reduced to
  the range. It is deterministic, and it cannot be predicted without the secret.
  The threshold is never under 2, because a threshold of 1 would publish one
  person's rule. The function emits only the rules at or above their threshold,
  with their counts. Of the rest it emits nothing: not the rule, not its count,
  not that it exists, not how many there are. When the contributions' seals
  disagree, or one has none, it emits nothing at all. That output, `consensus`,
  is the pool's public result, with `releasedCount` and the view derived from
  it. It is not stored (see "Workaround: the release is not stored").

The pure logic is in `consensus.ts`. The policy module's identity covers it
because a module's identity covers the modules it imports.

## Discovery and wiring

The output's doc comment carries `#inductorPool`, so a lo-fi inductor finds a
pool with `wish({ query: "#inductorPool" })`, the way folksonomy-tags finds its
aggregator. A pool serves one goal. Until the wish can match on the goal, an
inductor should take a `pool` input directly, or check that `pool.goal` equals
its own goal before it submits.

The lo-fi inductor does this: it takes an optional
`pool?: Pick<InductorPoolOutput, "goal" | "submit">`, falls back to
`wish({ query: "#inductorPool", scope: ["~", "."] })`, and its `publish` action
mints a stable per-goal pseudonym once and sends `submit` only when the pool's
goal is its own, ignoring case and surrounding or repeated space.

Under the approved cut 2, a random string kept by the inductor piece is the
idiomatic pseudonym today. It is stable for that piece, so for the person's
goal. It is unlinkable to their other goals' pseudonyms, since each piece mints
its own. And the pool binds it to the authenticated principal, so a second piece
for the same goal cannot double count. A self-owned random space per goal
(`inSpace(name, { selfOwned: true })`) would give a random DID instead. That
buys nothing yet, because commits and labels still name the core identity (cut
2), but it is the hook the deferred intermediate key would hang on
(`docs/specs/profile-delegation.md`, "Attribution and unlinkability").

## CFC debt

**The intended policy** is the lo-fi inductor's. A contribution, and the secret
that keys the threshold offsets, are confidential to the pool's policy. Anyone
may learn a rule and its contributor count once at least the rule's threshold of
distinct, independent people have each contributed it. Below the threshold no
one learns the rule, its count, or whether it exists. No one learns which
pseudonyms contributed, and a pseudonym is not linkable to its owner or to their
other pseudonyms.

**What is real CFC.** Contributions (each rule too, since each rule object is a
document of its own), with the seal inside them, are
`Confidential<…, [PolicyOf<poolRules>]>`. The only release is
`releaseThresholdConsensus`: it drops the clause on what the runtime stamped
`TransformedBy{THIS_POLICY.moduleIdentity, "releaseConsensus"}` with the input
witness `TransformedBy{THIS_POLICY.moduleIdentity, "submitContribution"}`: every
confidential input the release read must have been written by the pool's own
submit handler (`docs/specs/cfc-transformed-by-input-witnesses.md`, as
`examples/cfc-exchange-rules/witnessed-chain.tsx` uses it). Without the witness,
any code could run `releaseConsensus` over contributions of its own making, such
as the pool's doubled under made-up pseudonyms, and the rule would bless the
output. `inductor-pool-replay.test.tsx` shows a public store refusing exactly
that; `inductor-pool-multi-user.test.tsx` shows it taking the honest release. A
public input does not constrain a witness, so the secret and threshold are not
inputs of the release: they travel inside the witnessed contributions. The tests
also show that `tallyEveryRule`, a function of the same module that no rule
names, is refused by a public store, and so is a contribution copied out raw.

**What the witness does not cover.** It pins one level: whoever wrote the
contributions was `submitContribution`. It says nothing about who called it.
`submitContribution` is exported, so code can bind it to a contribution list of
its own and feed it any event, rules read from someone else's contribution
included, and the release over that list is witnessed like an honest one. The
handler still binds one pseudonym to each principal, and the seal it mints still
floors the threshold at 2, so this takes as many principals as the threshold
(cut 1). Closing it needs evidence minted where a contribution enters, a
person's gesture on a trusted surface, which is the proof-of-gesture work the
witness spec names.

## Workaround: the release is not stored

This is a runtime workaround, not a CFC debt cut: the policy is unchanged, and
only the storing of the release is avoided.

The pool was built to copy `consensus` into a public store, `released`
(`MaxConfidentiality<ReleasedRule[], []>`, written only by a `publishRelease`
handler). The runtime refuses that write: once a confidential contribution sits
in the pool's argument document, writing an array of objects into a
`MaxConfidentiality` store beside it is refused ("maxConfidentiality failed at
/released"), even a literal array (top/3205; related, top/2502). So the pool
stores no release. Its public result is `consensus`, the blessed function's own
output, read where it is computed, and `releasedCount` and the view count and
render from it. The refusal tests bring their own small public stores, which is
enough for what they assert: that the store refuses.

When top/3205 is fixed, a stored release can come back if something needs one (a
release that outlives a change to the inputs, say). Until then nothing does.

**Cuts** (both approved by Alex, 2026-11-16, and the only ones taken):

1. _Distinct people._ `releaseConsensus` counts distinct pseudonyms. The pool
   binds pseudonyms to principals one to one, but nothing attests that two
   principals are two people. Principled CFC would count an attested
   distinct-principal (personhood) atom on each contribution in the release
   rule. Comment at `releaseConsensus`.
2. _Pseudonym linkability._ The `authored-by` label and the commit name the
   contributor's core identity, which anyone who reads the pool space can see.
   Principled CFC would sign with an intermediate key chained from the per-goal
   pseudonym, have the server attest it, and label with the pseudonym. Comment
   at `submitContribution`.

**Not cuts, but worth Berni's eye:**

- `thresholdCenter` and `jitter` are ordinary inputs until the first
  contribution copies them into the seal, which only `submitContribution`
  writes. Before that, whoever can write the inputs chooses them. A principled
  version would fix the threshold into the policy when the pool is made.
- The keyed offset is computed in pattern code from a secret any runtime that
  runs the pool can read. That is the platform limit the lo-fi inductor README
  names: labels are enforced by the client.

## CFC snags (runtime, found while building this)

1. **A public array of objects cannot be written beside a labelled sibling**
   (top/3205; related, top/2502). The cause: `anchorValueAsEntity()` in
   `runtime/runner/src/data-updating.ts` reads the parent's whole value just to
   ask whether it is an array, and that read takes on the whole document's
   label. Reading the parent `nonRecursive` fixes it (verified in a scratch
   copy). The pool works around it by not storing the release (above).
2. **A confidential default beside a public field fails the piece's start
   commit** (top/3102; "maxConfidentiality failed at /<public field>"). The
   cause: the start reads the confidential slot as content (`runner.ts`
   `#readStoredArgument`, `#materializeDerivedInternalCells`, and a
   link-resolution probe). The pool's secret once had a field of its own, with
   no default for this reason; it now lives in the contributions' seal. The same
   path may refuse a restart or a pattern update once `/contributions` holds a
   value; that has not been tested.
3. **`principalOf(list.key(i), "authored-by")` after an in-place
   `list.key(i).set(obj)` reads `undefined`.** With `{ label: "written" }` it
   reads whoever pushed to the list last. So a replacement drops the old entry
   and appends the new one.
4. **Question for Berni: which schema's `maxConfidentiality` binds a write?**
   The ceiling looks to be judged against the schema the writer's binding
   declares for the store. In the tests, the probe's handlers declare their
   target as a plain `Writable<ReleasedRule[]>`, and the refusal names the probe
   pattern's `/leakedRaw`, whose input schema carries the ceiling. If a pattern
   that declared the same store without the ceiling could write confidential
   data into it, a public store's ceiling holds only together with
   `WriteAuthorizedBy` (which is why the old `released` had both). Is that the
   intended reading, or should the ceiling travel with the store?
