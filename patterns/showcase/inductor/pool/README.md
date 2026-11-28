# Inductor pool

## Why

A lo-fi inductor (`showcase/inductor/lofi`) learns cheap regex rules for one
yes-or-no goal from one person's private items. A rule many people learned
independently is worth sharing, and sharing it says nothing about any of them; a
rule only one person learned may say a lot. The pool collects rule sets for one
goal and releases a rule, with its count, only once enough distinct contributors
hold it. The policy is the one in `showcase/inductor/lofi/README.md` ("CFC
debt"); this pattern is its implementation.

## How it works

- **Config.** `thresholdCenter` (default 15) and `jitter` `k` (default 5), set
  when the pool is made. The first contribution seals them (below), so anything
  that can write the pool's inputs, a contributor included, cannot lower the
  threshold once there is something to release
  (`inductor-pool-config.test.tsx`). Whatever the config says, no rule's
  threshold is below `MIN_SEALED_THRESHOLD` (5), a constant of the policy
  module: sealing refuses a centre below it and narrows the jitter so that the
  centre less the jitter is never below it (see "What the witness does not
  cover" for why).
- **Contribute.** `submit` takes `{pseudonym, rules}`, the rules in canonical
  form (`CanonicalRule` from `../shared/rule-grammar.ts`), typed
  `ContributionEvent`: labelled with the policy, the event and each rule, as a
  stored contribution is. A sender that types what it sends this way, as the
  lo-fi inductor does, labels it with this pool's policy whoever receives it, so
  that, by design, a pool of the same shape that is not this one cannot make it
  public. Today that holds only in part (top/3175): with server execution off a
  receiver can publish the payload directly, and in either posture one that
  stores it first can publish it later (see "Discovery and wiring"). The handler
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
- **Withdraw.** `withdraw` takes the sender's entry out, by principal, and does
  nothing for a sender who holds none. The pool binds `submitContribution` a
  second time, set `withdrawing`, and `withdraw` sends to that binding, so
  `submitContribution` stays the only code that writes a contribution, which the
  release's input witness and the entries' `WriteAuthorizedBy` need. (`withdraw`
  is a small action in front of the binding, not the binding itself, because a
  stream's event type is exact: the binding takes a contribution, and `withdraw`
  takes nothing.) Once every contributor has withdrawn, the next contribution
  seals afresh. A withdrawn pseudonym is free for anyone to take (see "Not
  cuts").
- **The seal.** The first contribution mints a 128-bit pool secret
  (`Math.random`, the sandbox's, which a handler may call) and copies the
  configured `thresholdCenter` and `jitter` beside it. That seal is stored in
  the contribution, and every later contribution copies the first one's. So the
  secret and threshold are written only by `submitContribution`, like the rules,
  and the release reads them from the contributions alone.
- **Release.** `releaseConsensus`, a `lift` exported from `pool-policy.tsx`,
  takes the contributions and nothing else. It counts the distinct contributors
  holding each rule: the principal `submitContribution` stamped on each
  contribution from the runtime, which no one else can write. So a principal
  counts once even if someone replays their replaced or withdrawn entries into
  the release. A rule is counted by its field, label and canonical pattern, not
  by its 64-bit `key`, whose FNV hash anyone can collide. Each rule's threshold
  is `thresholdCenter + offset`, from the seal, where `offset` is in `[-k, +k]`:
  the first 32 bits of HMAC-SHA-256(secret, rule), reduced to the range. It is
  deterministic, and it cannot be predicted without the secret. A sealed
  threshold is never under `MIN_SEALED_THRESHOLD`, and the release refuses a
  seal that breaks it. The function emits only the rules at or above their
  threshold, with their counts. Of the rest it emits nothing: not the rule, not
  its count, not that it exists, not how many there are. When the contributions'
  seals disagree, or one has none, it emits nothing at all. That output,
  `consensus`, is the pool's public result, with `releasedCount` and the view
  derived from it. It is not stored (see "Workaround: the release is not
  stored"), and today a public store refuses it (CFC snag 6, top/3226).
- **The view** shows the goal, the configured threshold centre and jitter, and
  the released rules with their counts. It does not show how many people have
  contributed: the policy releases nothing about the contributions but the
  released rules, so the view reads nothing else.

The policy, its released function, and its one writer are in `pool-policy.tsx`;
the pattern and its view are in `inductor-pool.tsx`, which the policy module
does not import. The pure logic is in `consensus.ts`, and the rule grammar in
`../shared/rule-grammar.ts`. The policy module's identity covers both, because a
module's identity covers the modules it imports, and it does not cover the view,
so a view edit leaves stored contributions releasable. Both live in the inductor
family's own folders, so that the policy's identity depends only on its files;
the lo-fi inductor imports the grammar from `../shared`.

## Discovery and wiring

The output's doc comment carries `#inductorPool`, so a lo-fi inductor finds a
pool with `wish({ query: "#inductorPool" })`, the way folksonomy-tags finds its
aggregator. A pool serves one goal. Until the wish can match on the goal, an
inductor should take a `pool` input directly, or check that `pool.goal` equals
its own goal before it submits.

The lo-fi inductor does this: it takes an optional `pool?: PoolTarget`, a
structural type of its own (`goal`, `submit`), falls back to
`wish({ query: "#inductorPool", scope: ["~", "."] })`, and its `publish` action
mints a stable per-goal pseudonym once and sends `submit` only when the pool's
goal is its own, ignoring case and surrounding or repeated space.

Anything of that shape and goal receives the rules: a fake pool in a shared
space, say. The inductor does not vet the receiver. What it sends is typed with
this pool's `ContributionEvent`, so it carries `PolicyOf<typeof poolRules>`, and
only this module's `releaseConsensus` may drop that clause; a fake pool can
receive the rules but not write them anywhere public. Today that holds only in
part, waiting on a runtime fix (top/3175):
`../lofi/lofi-inductor-fake-pool.test.tsx` shows a fake that writes a received
rule straight into a public store refused with server execution on, and landing
with it off, where the payload arrives unlabelled; and in either posture a fake
that first keeps the rules in a store of its own can publish them later, since
what a handler writes from its event does not carry the event's label.

Under the approved cut 2, a random string kept by the inductor piece is the
idiomatic pseudonym today. It is stable for that piece, so for the person's
goal. Each piece mints its own, so the strings do not relate across goals, but
they are not unlinkable: commits and `authored-by` labels in the pool space name
the core identity (cut 2). And the pool binds it to the authenticated principal,
so a second piece for the same goal cannot double count. A self-owned random
space per goal (`inSpace(name, { selfOwned: true })`) would give a random DID
instead. That buys nothing yet, because commits and labels still name the core
identity (cut 2), but it is the hook the deferred intermediate key would hang on
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
output. A public input does not constrain a witness, so the secret and threshold
are not inputs of the release: they travel inside the witnessed contributions.

What the tests show, and what they cannot yet. Each probe writes a scalar (a
rule's pattern, a count, a pseudonym, the secret) into a scalar public store,
through a handler that types the store with its ceiling, and a literal lands in
a store of the same shape beside it (`inductor-pool-test-fixture.ts`). A public
store refuses the unthresholded tally (`tallyEveryRule`, a function of the same
module that no rule names), the release over forged contributions, and a
contribution's rule, pseudonym, seal secret, or the number of contributions,
read raw (`inductor-pool-multi-user.test.tsx`, `inductor-pool-replay.test.tsx`).
The genuine release should land in such a store, and today it does not: the
runtime does not match an input witness naming a handler that wrote what its
event carried (top/3226). Until it does, the tally and forgery refusals show
only that those values are not public, not that the policy tells them apart from
the release; dropping the witness from the rule does let the forgeries through.
And a handler that types the same store plainly writes the tally in, because the
runtime checks a store's ceiling only against the writing handler's own type for
it (top/3219, kept as a probe in `inductor-pool.test.tsx`).

**Editing the policy module strands stored contributions.** The rule names
`THIS_POLICY.moduleIdentity`, the content identity of `pool-policy.tsx` with
everything it imports (`consensus.ts`, `../shared/rule-grammar.ts`). Any edit to
those files, a grammar fix included, gives the module a new identity, and stored
contributions carry the old one's `PolicyOf` clause and `TransformedBy`
witnesses. As far as we can tell, the new release rule matches neither, so a
pool updated in place releases nothing from contributions made before the update
until each contributor submits again. And because the release reads every
contribution, one that has not been resubmitted carries the old clause into the
whole output: the release stalls entirely, rules held only by contributors who
did resubmit included, until the last contributor resubmits or withdraws.
**Question for Berni:** is that the intended consequence of content-addressed
policy identity, and is there an idiomatic way for a policy to name its
successor (the attested-succession path `WritePolicyAnyOf` has for writers)?

**What the witness does not cover.** It pins one level: whoever wrote the
contributions was `submitContribution`. It says nothing about who called it.
`submitContribution` is exported, so code can bind it to a contribution list of
its own and feed it any event, rules read from someone else's contribution
included, and the release over that list is witnessed like an honest one. The
handler still binds one pseudonym to each principal, and the binding chooses the
list's configuration, but not the floor: `mintSeal` refuses a centre below
`MIN_SEALED_THRESHOLD` (5), a constant of the policy module, and narrows the
jitter so no rule's threshold is below it, and the release refuses a seal below
it (a list whose first entry was planted with a lower seal included). So a
public release of a rule over such a list, a rule read from someone else's
contribution included, costs `MIN_SEALED_THRESHOLD` principals (cut 1), not the
2 it cost while the binding could choose a centre of 1.

Precisely, what such a list can and cannot do. Every entry in it was written by
`submitContribution`, so each names the principal that ran it, and the release
counts distinct principals; the release refuses seals that disagree or break the
floor. An entry `submitContribution` did not write into that very list does not
count: a link to the real pool's entry, or to an old entry a contributor
replaced or withdrew, is a slot other code wrote, which the spec gives no
witness (`docs/specs/cfc-transformed-by-input-witnesses.md`, the slot-stamp
rules), so the release over a list holding one is not released. What the
attacker controls is who submits into their binding: their own accounts, each
with a rule value they hold, and anyone whose inductor sends to it, such as a
fake pool built on it. So the floor is five distinct principals, and a rule's
real holder who sent to the fake is one of them: four accounts beside the holder
release the holder's rule. Nothing on this path lowers a threshold or counts one
principal twice. (All of this is the design; today even the honest release is
refused, CFC snag 6.) Closing it needs evidence minted where a contribution
enters, a person's gesture on a trusted surface, which is the proof-of-gesture
work the witness spec names.

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
render from it. The refusal tests bring their own public stores, scalar ones,
since an array of objects is refused there whatever it holds.

When top/3205 is fixed, a stored release can come back if something needs one (a
release that outlives a change to the inputs, say). Until then nothing does.

**Cuts** (both approved by Alex, 2026-11-16, and the only ones taken):

1. _Distinct people._ `releaseConsensus` counts distinct principals, as the
   pool's one writer stamped them, but nothing attests that two principals are
   two people. Principled CFC would count an attested distinct-principal
   (personhood) atom on each contribution in the release rule. Comment at
   `releaseConsensus`.
2. _Pseudonym linkability._ The `authored-by` label and the commit name the
   contributor's core identity, which anyone who reads the pool space can see.
   Principled CFC would sign with an intermediate key chained from the per-goal
   pseudonym, have the server attest it, and label with the pseudonym. Comment
   at `submitContribution`. The release makes this worse than it looks: it is
   exact and live, so a released rule's count moves with the very commit that
   adds a contributor holding it, and that commit is signed by the contributor's
   identity. Anyone who reads the pool space can see which principal's commit
   moved a released rule's count, and so that they hold it. A principled release
   would also need to decouple when counts move from when contributions land
   (batched or noised counts).

**Not cuts, but worth Berni's eye:**

- `thresholdCenter` and `jitter` are ordinary inputs until the first
  contribution copies them into the seal, which only `submitContribution`
  writes. Before that, whoever can write the inputs chooses them. A principled
  version would fix the threshold into the policy when the pool is made.
- The keyed offset is computed in pattern code from a secret any runtime that
  runs the pool can read. That is the platform limit the lo-fi inductor README
  names: labels are enforced by the client. Concretely, the jitter hides nothing
  from a contributor with a modified client: every contributor's runtime reads
  the seal (the submit handler copies it from the first contribution), so it can
  compute every rule's exact threshold. It hides the thresholds only from
  readers who run unmodified clients.
- The secret comes from the sandbox's `Math.random`, the randomness the pattern
  guide gives handlers, which is not documented as cryptographically secure; a
  generator that is not can be predicted from its earlier outputs. A principled
  version would mint the secret from a secure source. Given the point above,
  this matters only against someone who cannot read the seal but sees other
  outputs of the same generator.
- A withdrawn pseudonym can be taken. Withdrawing removes the principal's entry,
  and with it their hold on the pseudonym, so another principal who knows it
  (from raw access to the pool space, since contributions are confidential) can
  contribute under it, and the original owner's inductor, which keeps its
  pseudonym, is then refused when it publishes again. Holding the pseudonym
  after a withdraw would mean keeping an entry, an empty one, labelled
  `authored-by` the withdrawn principal, so withdrawing would no longer remove
  every trace of them from the pool. We left that choice open rather than trade
  one for the other.

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
4. **A `MaxConfidentiality` ceiling that names a `PolicyOf` atom refuses every
   write.** The pool should put `MaxConfidentiality<…, [PolicyOf<poolRules>]>`
   on each stored contribution and rule, so that a contribution carrying any
   clause beyond the policy's is refused in its contributor's submit rather than
   stored, where it would make every release that reads it confidential and so
   silently stop `consensus` being public. With the ceiling in place, honest
   submissions are refused too ("maxConfidentiality failed at /"). The cause, as
   far as we can tell: `runtime/runner/src/cfc/prepare.ts` reads the ceiling
   from the schema as written (`ifc?.maxConfidentiality`), with the `PolicyOf`
   atom's `{ __ctOwningSpace: true }` placeholder, while the stored label's atom
   names the owning space, resolved by `resolvePolicyOfConfidentiality` on the
   way in; so the two never compare equal. Resolving the ceiling the same way
   (verified in a scratch copy) lets honest submissions through. Filed as
   top/3207. Until then the pool has no ceiling. Today the gap is narrow: an
   event's payload is delivered unlabelled (top/3175), so a submission cannot
   bring its sender's clauses in; a labelled `thresholdCenter` or `jitter`,
   copied into the seal, is the path left.
5. **A store's ceiling binds only a writer that repeats it** (top/3219). A
   handler that types a `MaxConfidentiality<…, []>` store as plain
   `Writable<string>` writes a confidential value into it. The earlier probes
   typed their stores that way, and wrote arrays of objects, which top/3205
   refuses whatever they hold, so their refusals proved nothing and the release
   they showed landing was unchecked. The probes now type every destination with
   its ceiling, and one plain-typed probe asserts the leak as it stands, to flip
   when the runtime is fixed.
6. **The witnessed release is refused** (top/3226). An exchange rule whose
   `inputWitness` names a handler that wrote what its event carried, and read
   nothing confidential, does not match, so a public store refuses the honest
   release; the same rule naming a handler that read a confidential value
   matches. `submitContribution` is the first kind for the first contribution at
   least, so `consensus` is not public under an enforced ceiling today. The
   multi-user test asserts the refusal, to flip when the runtime is fixed.
