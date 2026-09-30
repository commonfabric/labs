# Designing verbs so they can change

This document records how verbs are designed so that changing them later is
possible: what a verb promises, what an author may change about one, what a
holder of a piece writes down, and what the tooling does about it. It is
written for the whole team, not only pattern authors — the argument avoids
shorthand so a reader outside this part of the system can still check it.

## The vocabulary, briefly

A **pattern** is a program someone writes. A **piece** is a running copy of
that pattern that holds real data — a specific notebook, a specific board.

A **verb** is a named action a pattern offers to the outside world: `addItem`,
`setLabel`, `archive`. Verbs are not the only way in — a caller with write
permission can also set a piece's fields directly, as the UI's editing
controls, `cf cell set`, and the filesystem mount all do. A piece's
interface is its fields and its verbs together, the way an object's interface
is its public fields and its methods. This document is about the verb half,
where the design questions are; fields go through the same update gate, and
the accept-more and provide-more rules below are field rules.

The **shape** of a pattern is the runtime's record of what it accepts, what
it provides, and which of its fields are verbs. A build step — the
**transformer** — derives it automatically from the TypeScript types the
author wrote.

Patterns are **updated in place**: new code is pushed onto pieces that
already exist and already hold data, and it has to keep working for
everything that was already talking to the old code.

## The problem

When a pattern is updated, the runtime compares the old shape to the new one
and **refuses the update** if the new shape would break something relying on
the old one. Two rules drive that comparison, in opposite directions:

- What a pattern **accepts**, it may accept more of, never less. Accepting
  less breaks whoever was sending the thing you dropped.
- What a pattern **provides**, it may provide more of, never less. Providing
  less breaks whoever was reading the thing you dropped.

Sound in principle. Measured against the current runtime — not inferred —
here is what it does to a verb's author:

| Change to a verb | Result |
| --- | --- |
| Add a verb | allowed |
| Add a verb to a type another pattern stores | **refused** |
| Remove or rename a verb | refused |
| Mark a verb `@deprecated` | allowed, and it disappears from listings |
| Turn a verb into data, or data into a verb | refused |
| Add an optional field to a verb's input | allowed |
| Add a required field to a verb's input | refused, unless the field carries a valid default |
| Make a field of a verb's input optional | allowed |
| Remove or retype a field of a verb's input | refused |
| Change anything about a verb's **output** | allowed, and nothing checks it |

Two rows are bad outcomes, and they pull in opposite directions.

**Ordinary changes are refused.** If a board keeps a list of notes and you
add one new action to notes, updating the board is refused outright:

```
argument.notes[].append: newly required argument field has no default
```

Nothing is wrong with that change — it adds an action and takes nothing
away. It is refused because of how verbs are declared, not because of what
the change does.

**Required-ness of a verb's input is settled** ([#5663]). It reads as the
argument side's rule, stated in the result comparison's direction, because a
verb's event is an argument in every respect but where it is declared. Adding
a newly required field is refused unless the field carries a valid default,
which fills a missing field in a present event object. An entirely absent
event payload stays absent. The default may be one the field
already carried or one the candidate introduces, and a default that changes
value is accepted as it is of an argument: a stream marker is cell metadata,
and cell metadata is default-stable ([#7166]) — it does not constrain the
value beneath it, so it withdraws no permission to introduce or change a
default there. Relaxing a field to optional is allowed for the same reason it
is allowed of an argument: every call already written still sent it, so every
one still validates.

**A verb's output is not checked at all.** The shape records a verb's input
and discards its output, so renaming a field of what a verb hands back
passes every check and breaks callers silently. The deferral is narrower
than "recording outputs": what would commit to a format **Fabric-types** —
the planned design stream that gives verbs declared, checkable result types
in the shape — is expected to replace is recording an output *in the durable
shape*. Recording one at all is already done. A verb's declared result
travels on `module.resultSchema`, a module field that enters no durable
schema and that no baseline under `packages/patterns/baselines/` records,
which is what made that road passable while the durable one was not; and it
is resolvable per deployed piece, because `cf piece verbs` publishes it as a
row's `outputSchema` and `cf piece call <verb> --help` publishes it for a
single verb (`listPieceCallables`, `declaredVerbResults` and
`withDeclaredResult`, `packages/cli/lib/piece.ts`). What is still deferred is
the durable record and the comparison it would feed: nothing holds one
deploy's output beside the next, so output changes are governed by convention
alone.

The same gate also governs the *holder* — what a pattern may change about
what it demands from the pieces it stores — where the first outcome above
arrives from the other side:

| Change a holder makes to its own demand | Result |
| --- | --- |
| Demand a new optional field or verb | allowed |
| Demand a new required field that carries a default | allowed |
| Demand a new **required verb** | **refused** |
| Stop demanding a field or verb it no longer uses | allowed |

The refusal comes from `packages/piece/src/schema-compatibility.ts`: raising
a demand hits `newly required argument field has no default`, and a verb is
a stream, which cannot carry a default, so a newly required verb is the same
refusal arriving from the other direction.

Giving a demand up is narrowing, and the gate reads it as narrowing. A field
the pattern stopped reading leaves a writer's value unread rather than
breaking a reader, so the argument side drops named fields freely; what it
still proves is that the candidate can hold the value the piece already
carries, which a closed candidate object fails as `source field is rejected
by the target object`. The result side preserves every named field it
published.

Stated plainly, because much of the design rests on it: **a deployed
holder's demands can be given up freely, and added only where an existing
piece still meets them** — optional, or a required field whose default fills
it in, which a verb cannot be, having no default to carry. What is already
demanded is kept or dropped whole, never tightened. (The provider side is
looser on that axis: a pattern may add a newly
required field to its own *result*, because the new code materializes it
when it runs. A demand has no such escape — the piece it points at already
exists.)

Behind both outcomes is the fact that makes this hard: **pieces
persist.** Each carries the interface it was created with while the code
around it moves on. Sooner or later some caller holds a piece older than the
interface it wants, and no declaration style makes that impossible.

The callers are not alike, and the difference matters throughout:

- **Probing callers** — the CLI, the UI, an agent — ask a piece what it has
  before acting. They bind late; a missing verb costs a listing lookup, not
  a crash.
- **Compiled callers** — TypeScript in one pattern calling a verb on another
  piece — bind when the code is written. They are what an interface promise
  exists for.
- **Stored references** — a board holding a list of notes — are bindings
  that persist: what a pattern demands of the pieces it stores is written
  into its own shape and outlives everyone's code. The hardest case, and
  where the refusal above comes from.

## What a solution must satisfy

Six requirements, each load-bearing in the design that follows.

1. **Serve both populations, without charging both the same price.** Most
   patterns are one-offs — somebody worked with a model for an afternoon and
   now has a thing. That author will never read a compatibility rule, so the
   default rules must be applied by tooling rather than learned. Some
   patterns are long-lived and shared, depended on by people the author has
   never met; the complete machinery must exist for them. One substrate
   serves both: the deliberate path adds to the simple one, never
   contradicts it.

2. **Prefer the simple rule to the precise one.** Most code around these
   patterns is written by models, including inexpensive ones, and an
   elaborate rule is one more thing to get subtly wrong while nobody is
   watching.

3. **Keep the interface a promise.** Code that holds an object leans on its
   interface without checking. Take that away and every caller turns
   defensive — if this method exists use it, otherwise try that one,
   otherwise fall back. Agents can cope with such code; people maintaining
   it are miserable.

4. **Put the uncertainty in one place.** Old pieces make uncertainty
   unavoidable, but it can be placed. The livable designs concentrate it at
   the moment a caller first takes hold of a piece — establish what it is
   holding once, and work against what that established from then on. The
   miserable designs spread it across every call site.

5. **Hold across authors.** Patterns by one party will depend on contracts
   offered by another's. Those contracts cannot be made unbreakable — an
   owner may break their own pattern — so what the substrate owes a consumer
   is the means to judge instead: contracts stated clearly, breakage made
   visible, and both attributable to whoever is responsible. If a stranger
   can break the shape your mechanism depends on *and* you could neither see
   it coming nor tell whose doing it was, the rational move is to fork —
   forfeiting exactly the composition the substrate exists for.

6. **Reach what is already deployed.** The pieces and holders that exist
   today are the ones with real data. A design reachable only by patterns
   not yet written has to say how the installed base gets there.

## The design

### Verbs are promises, and names are stable

A verb is declared as something a piece definitely has, not something it may
have. Code that holds a piece and calls a verb writes no check: the
declaration says the verb is there, and the compiler agrees.

Names are stable by default. The gate refuses a shape that removes or renames
a verb — the one rule in today's gate genuinely protecting callers, and it
stays — so a verb does not vanish by accident. The ordinary way to retire one
is to add its replacement and mark the old one `@deprecated`, which hides it
from listings while keeping it callable. A verb whose contract must change
incompatibly gets a new name, spelled `append_v2`, introduced when the second
generation actually appears.

What this is not is an invariant. A pattern's owner may deliberately break
their own pattern — retire a verb for real, change what one means — and the
design permits it. Requiring permanent compatibility would tax every author
forever to serve the cases that never arise, and it would not survive contact
with an author who has good reason to move on. So a break is made deliberate,
visible, and attributable rather than impossible, which is what the tooling
below is for. Removing a deprecated verb outright is a break of exactly this
kind, taken when call counting says nobody calls it — which makes
accumulation a choice rather than a sentence.

What a caller holds is therefore a commitment rather than a guarantee, and
its strength is a property of whoever wrote the pattern. Reputation is the
discipline, as it is for anyone else running a service other people build on,
and it is why the tooling below aims at making breakage legible rather than
at preventing it.

This is the floor. Everything below stands on it.

### A holder demands only what it uses

When one pattern stores another, it writes down what it *uses*, not what the
other pattern *is*: the fields it reads or writes, the verbs it calls, the
reference itself. A board that keeps notes but never appends to them does
not mention `append`.

The refusal that motivated this document then disappears at its root. Adding
`append` to notes no longer changes the board's shape, because the board
never demanded `append`. Nobody's promise weakens: a holder that *does* call
a verb declares it, and holds a checked contract for exactly what it
declared.

The principle is old — declare what you need, not what they are — and it is
how Go interfaces work: declared by the consumer, satisfied by shape, best
kept tiny. TypeScript already types pattern code structurally at compile
time; the difference is that a demand is durable, written into the holder's
shape and proved again at link time against a provider that evolves
independently. The runtime already proves that a stored link satisfies the
shape its holder demands. What is new is that holder-side types are
*demands*, written that way on purpose, and that the tooling says so.

Two honest costs. An author now writes two kinds of type — a pattern's own
full truth, and its demands on others — and a demand is a real contract that
must stay as small as it claims. And shape carries no meaning; small demands
keep that gap harmless, and closing it properly is what names and versions
are for.

### Named, versioned interfaces are where this goes

An interface here is a named set of field and verb contracts, carrying a
version, separate from any one pattern: "Notes, version 2" is a
first-class thing. A pattern declares which interfaces it provides —
usually several, none of them the whole of its shape — and consumers
declare the minimum version they accept. Binding checks once, and the caller
works against the version it bound to rather than re-checking at every call
— which places the uncertainty without pretending the provider can never
move. The name is what shape cannot be: a claim about meaning. Declaring
"Notes v2" says `append` does what Notes means by it, which no structural
demand can say.

Who defines one is worth pinning down, because it is the consumer who
knows what it needs — and that knowledge stays where it is: the structural
demand remains the default. A named interface is not an enumeration of
consumers' subsets; it is a
promise the provider opts into: the contract it commits to keeping stable
and meaningful. The definition itself can come from either side, because
an interface is separate from any pattern — a consumer, a community, or a
provider may coin one, and providers adopt it by declaring they provide
it. Go's `io.Reader` is the exhibit: defined once, owned by neither side,
satisfied everywhere. Nor is the boundary guesswork here: demands are
recorded, so a provider factors its interfaces from the clusters consumers
actually demand. The demands are the evidence, the interface is the
crystallization — that is the build order, not only a composition — and
the registry is what carries it past the visibility horizon.

Interface versions layer over new verb names; they do not replace them. A
piece's shape is one namespace, so when two generations coexist on one
piece the incompatible verb still lives under a fresh name — `append`
beside `append_v2`. The interface version is the name a consumer binds
against, and it maps to whichever spelling its generation carries: the
suffix is bookkeeping inside the piece, the version is the contract outside
it. Consumers reason in versions; pieces store names.

This is what satisfies the across-authors requirement: a name and a version
are what let one author rely on another's contract and know when it has
moved. It is also the most machinery of anything here — an identity, a
registry, a place in the shape, the member-to-field mapping the layering
above implies, and a compatibility rule of its own, where what a version
bump means and how a declared minimum resolves against what a piece
provides are both still to be designed. Fabric-types is the natural
vehicle, the work is a design stream of its own (see
[the longer arc](#the-longer-arc)), and everything else in this document
stands as the interim until it lands.

### A maybe is resolved once, at binding

A published interface may carry optional members, because a piece deployed
under an earlier generation genuinely lacks the later generation's verbs.
Absence there is a fact about the piece, not a hedge — an interface handed
to consumers covers every generation still running, even where the pattern's
own declaration marks the member required.

What an optional member does not license is a maybe at every call site. A
caller resolves it **once, when it takes hold of the piece** — into a real
fallback or a real failure — and holds a promise from then on:

```tsx
// Shown at module scope.
declare const activityLog: { logEvent?: Stream<{ text: string }> };

// Never this: when the verb is absent, nothing happens and nothing says so.
activityLog.logEvent?.send({ text: "started" });

// Resolve once, into something callable or a failure someone can act on.
const logEvent = activityLog.logEvent;
if (logEvent === undefined) {
  throw new Error("activity log predates logEvent; Notes v2 required");
}
logEvent.send({ text: "started" });
```

The first form defers the maybe to every call site and fails silently — in
a test, a real failure becomes a pass. The second turns absence into
something a person can act on; a real fallback resolves it just as well.
What is not acceptable is nothing.

And when a caller cannot proceed without the member at all, an optional is
the wrong tool. The answer is an interface version the caller requires:
"this needs Notes v2, and the piece provides v1" is a failure someone can
act on; a skipped `send` is not.

### A verb's output changes by getting a new name

Nothing checks outputs, so a convention has to do the work: **a change to
what a verb hands back is treated exactly like a rename, and gets a new verb
name.** Adding to an output is safe; changing or removing anything in one is
not, and no gate catches it. This costs nothing to adopt and is the only
protection available until Fabric-types records outputs in the shape — at
which point the convention is replaced by a check.

### A true break is a migration in place

Some changes are genuinely incompatible, and no declaration discipline makes
them compatible. What handles them is a **migration**: the same piece,
updated in place to the new shape, its stored data transformed by migration
code — work a model can do, and the useful form is generated migration
logic, not per-piece hand-holding. Nothing structural stands in the way. The
update path already applies new source to an existing piece while keeping
its identity and its state, and the gate that refuses an incompatible shape
is our own check, with an all-or-nothing bypass
(`dangerouslyAllowIncompatibleSchema`) that exists today. What is missing is
the machinery that makes the break safe rather than nuclear: the scoped
acknowledgment and blast-radius report under tooling, and the upgrade
mechanisms of [the longer arc](#the-longer-arc). A migration still breaks
callers whose expectations no longer hold; the blast-radius report is what
makes that breakage enumerable and answerable rather than silent. The one
measured failure on this path is the rollout window — an update once left
old and new versions writing to the same space at 96% of commits — which
is why [space-clone rehearsal](../development/space-clone-rehearsal.md)
precedes any update against real data.

The default is still to stay compatible. Most patterns are updated by models
that will cheerfully jump through hoops to avoid a break, and a compatible
update needs none of this machinery. Deploying the successor as a *new*
pattern instead is considered and set aside below.

## How the design holds up

Cross what a provider might do to its interface against what a holder wrote
down, and read the cells. Five kinds of demand are reachable: embedding the
provider's whole **Output** type (today's default), a narrow demand naming
**fields only**, one naming a **required verb**, one naming an **optional
verb**, and a **versioned** interface demand. Probing callers are omitted —
they bind late and survive every *evolution* row, which is what the table
scores. What late binding does not survive is an enumeration defect, so a
probing caller is only as good as the listing it probes: a name the listing
never proposes is indistinguishable to that caller from one that was
deprecated or retired. `cf piece verbs` therefore draws its candidates from
the piece's stored surface and its compiled graph rather than from the
pattern's declared result type, and a verb the type omits is listed on the
same terms as one it names. Two residual gaps are the probing caller's to
know about, and [the CLI verb guide](../common/verbs/over-the-cli.md) states
both: a listing reporting `incomplete` is a lower bound, and a handler whose
stored schema carries no stream marker is callable without ever being listed.
Absence is evidence of retirement only on a listing that reports neither.

| Provider evolution | Full Output | Fields only | Req. verb | Opt. verb | Versioned |
| --- | --- | --- | --- | --- | --- |
| Add a verb | **holder refused** | ok | ok | ok | ok |
| Add an optional field | ok | ok | ok | ok | ok |
| Add a required field carrying a default | ok | ok | ok | ok | ok |
| Widen a verb's input with an optional field | ok | ok | ok | ok | ok |
| Require more of a verb's input | **breaks at call** | **breaks at call** | **breaks at call** | **breaks at call** | **breaks at call** |
| Change a verb's output | **breaks at call** | **breaks at call** | **breaks at call** | **breaks at call** | **breaks at call** |
| Rename or remove a verb | provider refused | provider refused | provider refused | provider refused | provider refused |
| Retire: add the replacement, deprecate the old | **holder refused** | ok | ok | ok | ok |

"Holder refused" means the gate stops the *holder's* next update: nothing
breaks at runtime, but the holder is stuck. "Breaks at call" means every
gate passes and the failure arrives when someone calls the verb. "Provider
refused" means the gate stops the provider by default — an owner may
deliberately override it, forfeiting what the row protects.

Four things fall out of it.

**Every refusal lives in one column.** The whole cost of today's default is
the Full Output column, and both of its refusals are the same event — a
provider adding an action. That is the argument for holder-side demands, and
why the mechanical check belongs where embedding happens.

**Two rows are red everywhere, for different reasons.** A verb's output is
not in the shape, so no gate can see an output change until Fabric-types
records one; only the naming convention above stands in front of it. A
verb's input *is* in the shape — that row is red only while [#5663] stays
open, and a version bump would move its failure from call time to bind
time. The Versioned column is scored as today's behavior throughout: what
a bump means is still undesigned, so its cells are contingent.

**The optional-verb and versioned columns are identical.** So the choice
between them is not about what can evolve but about what a reader can tell.
`BackwardsCompatibleProfile` in `packages/patterns/system/profile-home.tsx`
is the exhibit: a `PartialBy` over the full Output that records its vintages
in a comment, because the type cannot say them, plus a hand-maintained
instruction to add every future stream to the list. The optionality *is* a
version boundary with its name erased; versioning names the vintage, and
moves the maybe from every seam to bind time.

**The columns are not reachable from one another.** A deployed holder cannot
move rightward — every such move raises a demand, which the holder table
refuses, and escalating a versioned demand from v1 to v2 is the same event. So
the design is complete for holders that do not exist yet and — until scoped
acknowledgment and migration exist — inert for every holder already
deployed: requirement 6 unmet, and both mechanisms on the critical path for
adoption.

The table scores breakage only. Two requirements it cannot see: simplicity
(requirement 2) is met the way requirement 1 demands — the machinery here
belongs to the deliberate path, and the tooling below exists so the default
author never meets it; across-authors (requirement 5) is carried by the
blast-radius horizon under tooling, where a registry is what makes a
foreign author's demands discoverable at all.

## What the tooling does

The rules above are only as good as the number of authors who never have to
learn them. These are the mechanisms that carry them.

### The rule is about embedding, not exporting

A pattern's output type has to be **exported** — TypeScript cannot otherwise
name the factory's return type, which
[composition](../common/patterns/composition.md) requires. Export is not the
vector anyway: the refusal reproduces in a single file with no imports, when
a board stores `NoteOutput[]` declared in the same module.

The enforceable joint is **embedding**: a holder does not put another
pattern's Output type into its own schema; it declares the fields and verbs
it uses, usually a title and a single verb. The transformer already has the
resolved type at every `pattern<I, O>` call, so it can check this where it
happens — including aliases that sound narrow and are not, where a name like
`EventPiece` turns out to be a whole Output. Embedding stays right in one
case: the holder genuinely means "that interface, with those required
verbs." The other reason it happens — the type is large and restating it is
redundant — is practical rather than principled, and worth designing away.

`skills/pattern-critic/SKILL.md` already asks for this direction under
"oversized cross-pattern contracts" (critique-guide category 17): prefer a
consumer-owned minimal structural type over the full pattern schema and over
`Pick`/`Omit` coupling. What a critique cannot do is enforce the rule or
record which demands exist, which is what everything below needs.

### Demands are recorded as demands

Today a holder's demand is indistinguishable from its own state — the
refusal path `argument.notes[].append` *is* the demand subtree, unmarked.
That single gap is why the impact report below cannot count anything, and
why a deliberate break can only be acknowledged by turning the whole gate
off. Marking demands is the substrate the rest of the tooling stands on.

[#5746] prototypes both halves: a `Demand<T>` marker whose stamp rides the
referencing node — a shared definition stays neutral; each use site declares
its own demand-ness — and an advisory warning when a contract embeds a
foreign Output type, with self-reference still legal and `@sharedContract`
opting a genuine protocol type out.

Adopting narrow demands across already-deployed patterns is a holder
dropping what it stopped needing, which the gate accepts on its own. Where
the holder republishes the demanded type, the same narrowing reaches its
result, and that side still refuses — so those adoptions ride the scoped
acknowledgment below rather than a quiet edit.

### Authoring time shows the blast radius

Compatibility is discovered today by having an update refused. The same
comparison the gate runs can run before anything deploys — and, because
holders record what they demand, it can report what a change would hit:

```
This update breaks 14 recorded consumer contracts across 6 patterns:
- 9 are owned by you
- 3 appear automatically adaptable
- 2 belong to other authors

Choose: revise the change, generate migrations or adapters, or proceed and
mark affected consumers incompatible.
```

This is what lets nobody classify a pattern's permanence up front: its
dependencies say whether it is a one-off or a load-bearing contract, and the
report is where they say it. Compatibility stays the default; an intentional
break stays possible with impact and recourse visible. Generated migrations
and adapters — applied eagerly, or lazily when a piece is next touched — are
the recourse this grows into.

The count has a horizon, and the report has to name it. References cross
spaces — a stored link carries its target's space (`NormalizedFullLink`,
`packages/runner/src/link-types.ts`) — and links are one-directional,
recorded in the holder's space, with no reverse index anywhere. So the
report enumerates in rings: the workspace's recorded demands, completely;
spaces the deployment can read, by scan; and beyond that nothing, because a
consumer in a space nobody here can read is invisible in principle. That
invisible ring is also the sharpest argument for versioned interfaces: a
registry consumers declare against is the only mechanism that makes foreign
demands discoverable at all.

### A break is acknowledged one at a time

The only override today turns the entire gate off, so accepting one
deliberate break silences every other protection. A break should be
acknowledgeable by name — this field, this verb, this consumer. That
**scoped acknowledgment** is what "proceed and mark affected consumers
incompatible" needs underneath it, what the demand migration above rides on,
and what eventually lets a dead verb be removed rather than hidden.

Because a break is permitted rather than prevented, this is also where one
becomes a record. The acknowledgment is the moment what broke is known
precisely, and the only place that information exists before it is lost.
Whether making that record is obligatory — and what an obligation would mean
in practice — is for whoever builds it to settle.

### Verb calls are counted

Retirement policy is guesswork without usage data; deprecation windows work
in other systems because usage is observable. The planned invocation-record
work is the natural place for this to ride, and that work —
[retention and CFC execution provenance](retention-and-provenance.md) — is
**gated on a CFC review that has not happened**, with nothing behind the gate
started. So call-count-driven retirement is not near-term at any price: its
carrier waits on a review rather than on a queue position.

Counting also sees past the blast-radius horizon: a call executes against the
provider's piece, in the provider's space, so invocation records catch the
cross-space and third-party callers no static enumeration can reach. The two
signals are complementary and both partial — enumeration sees recorded
demands within its horizon, dormant holders included; counting sees live
callers beyond it, and misses anyone who has not called lately.

## The longer arc

The pressure behind this document does not go away: pieces live a long time,
carry their interface with them, and the code around them keeps changing.
Other systems have faced exactly this and converged on the same small set of
mechanisms — none of them by making the interface uncertain. They kept the
promise, versioned it, and built machinery for old and new to live side by
side. Four mechanisms recur; this is an open design stream.

**1. Interfaces carry versions, and consumers name the minimum they
accept.** COM froze `IFoo` and published `IFoo2` beside it; OSGi imports at
"version 1.2 or newer"; Kubernetes serves several API versions at once. The
named-interfaces section above is this mechanism, scheduled.

**2. Compatibility has declared boundaries, and breaking one is a
decision.** Semver's major version is a choice, never a side effect of an
edit; Avro publishes rules authors design against, where ours are
discovered at refusal time. Scoped acknowledgment is this mechanism's seed.

**3. Upgrades are per-piece, and every piece has an upgrade policy.** Erlang
runs at most two versions of a module and migrates each process
individually; Orleans routes each call to a host compatible with that
actor's version; upgradeable smart contracts record who may upgrade as
state. We ran the unmanaged experiment ourselves: a board update left old
and new pattern versions writing to the same space, and the write storm
measured 96% of all commits there. Coexistence without management is a
failure mode we have met, not a hypothesis.

**4. Upgrades can run code.** Sooner or later a new shape needs data the
old shape did not store. Erlang's state-transform callbacks, Common Lisp's
instances migrating when next touched, Rails migrations and event-sourcing
upcasters are all this mechanism; systems with many small stateful things
mostly chose lazy over eager — the fork the migration-in-place path
inherits.

Two of the rules the gate enforces were derived by measurement against our
own runtime and turned out to be classical results: "a published interface
only grows" is COM's frozen interfaces and protobuf's permanent field
numbers — here it is a default an owner may leave rather than a law, but the
shape is theirs — and "a newly required input breaks callers" is so well
established that proto3 removed `required` from the language. The rest of
this map is worth reading before we draw more of it ourselves.

## Considered and set aside

**All verbs optional, as the default.** The cheapest evolution — adding a
verb is then always allowed, anywhere — at the cost of a maybe at every
call site, permanently: an interface whose every member is optional is not
a contract but a suggestion, which fails the promise requirement. The 8
cross-piece verb call sites in shipped patterns and the 396 across the
tests would each become a possibly-absent value whose obvious rewrite,
`instance.verb?.send(...)`, skips silently. Where absence is a real state,
the design already admits an optional member, resolved once at binding.

**Versioning every verb from day one.** Spelling the first generation
`append_v1` taxes every verb forever to serve the few that ever get a
second. The suffix appears when the second generation does.

**Redeploying a new pattern to escape a true break.** It forks the piece's
identity: every stored reference keeps pointing at the old piece, with no
forwarding mechanism, and the two populations coexist unmanaged.
Everything it offers
arrives better in place: migration handles the shape, versioned interfaces
the callers, upgrade policy the rollout. What remains — a genuinely new
pattern, a move across spaces — is creation, not evolution.

## What is not settled here

One question is open by design, and it is the one the cross product exposes:
**how a deployed holder moves.** Required-verb demands and versioned demands
are reachable when a holder is written and not afterwards, so every adoption
path that raises a demand runs through a scoped acknowledgment or a
migration that rewrites holders. Which carries it decides how much of this
design applies to what is already running.

One direction belongs in that conversation, recorded as intent rather than
mechanism: **the provider tells holders how to move.** A pattern that
breaks its interface knows what changed and what it expects holders to do
about it, and it can ship that with the new generation — prose for a
person, a recipe for a tool. Where it lives matters most: askable of the
piece itself, so an agent watching a holding piece's errors can ask the
held piece for upgrade instructions and decide whether to apply them. The
channel exists — the shape already lifts deprecation out of JSDoc into
listings — and it carries a standing precondition, because that channel is
the listing surface: instructions served over a surface that drops their
subject arrive incomplete, so whatever carries them must ride an enumeration
no narrower than the piece's stored surface and its compiled graph, and must
propagate that enumeration's own report of when it fell short rather than
serving a quietly shortened set. Scoped acknowledgment is the natural place
to ask for the instructions themselves: a deliberate break proceeds when it
says what those it breaks should do instead.

The anchors are the systems that permit breakage and manage it rather than
forbid it. Kubernetes deprecates an API, keeps serving it for a published
number of releases, then removes it. Chrome measures how much of the web
uses a feature, announces an intent to remove, publishes the migration path,
and removes it anyway — usage data and the ecosystem's reaction are the
check, not a rule against removing. Both leave anyone who ignored the notice
broken, and both are judged on how well they gave it.

This is a partial answer, and worth saying so. Instructions help a holder
that is watched, maintained, or agent-tended, and do nothing for one whose
author has moved on. They are the difference between a break that can be
recovered from and one that cannot, which is worth a great deal and is not
the same thing as safety.

Five smaller calls belong to whoever does the work:

- Whether the embedding rule warns, lints, or fails, and in what order those
  arrive; [#5746] starts at advisory on purpose.
- How wide the baseline reset has to be once narrow demands land (the
  recorded shapes under `packages/patterns/baselines/` that updates are
  checked against), and how it is sequenced against the append-only
  baselines gate.
- Where an interim output check runs before Fabric-types, and what it does
  on a mismatch. Availability is not the question: a verb's declared result
  resolves from a deployed piece's compiled graph and from a candidate's, so
  a comparison has both of its sides. `setPattern`
  (`packages/piece/src/ops/piece-controller.ts`) loads the deployed pattern
  and compiles the candidate before it asserts compatibility, so both graphs
  are in hand at that point. What is **not** established is what comparing
  them costs there, or what a graph compiled before `module.resultSchema`
  existed offers to compare against — so the site (`setsrc`, a pre-deploy
  report, a lint) and the response (refuse, warn, record) are both open, and
  none of them should be priced as cheap before that is measured.
- Whether a version bump is author-declared or derived from the shape diff;
  the Versioned column's red rows depend on the answer.
- When the `Demand<T>` marker grows interface and version fields: the
  growth is free — annotation values are never compared across updates —
  but only until a binding check reads them, at which point the key stops
  being annotation-neutral. A real design step, not an extension — and a
  two-registry one. [#5746] adds `demand` to `ANNOTATION_KEYS`
  (`packages/piece/src/schema-compatibility.ts`), and item 2 of
  [the verbs implementation plan](verbs-implementation.md) derives the
  projection reader's *tolerated* keys from that same set, so a key
  reclassified out of it lands in projection's *refused* tier by default and
  starts rejecting reads that carry it. Whoever reclassifies `demand`
  changes both registries deliberately, which is what keeping them siblings
  rather than one list is for.

[#5663]: https://github.com/commonfabric/labs/issues/5663
[#5746]: https://github.com/commonfabric/labs/pull/5746
[#7166]: https://github.com/commonfabric/labs/pull/7166
