# Verbs — implementation plan

Sequences the remaining work on verbs: what a verb declares, what a caller may
ask for, and what comes back. It carries the residue of two implementation
plans whose work is substantially landed, and which are archived as the record
of what each decided:
[the pattern verb contract](../history/plans/pattern-verb-contract-implementation.md)
and
[shaped reads and verb results](../history/plans/shaped-reads-implementation.md).

**The designs are unchanged and are not restated here.**
[The pattern verb contract](pattern-verb-contract.md) says what a verb is.
[Designing verbs so they can change](verb-evolution.md) is the design of record
for how a verb's interface changes once pieces are deployed against it.
[Reading Fabric data](fabric-read-model.md) and the two documents it points at
say how a caller reads. Read those for reasoning; read this for order.

## Why one sequencing plan over two

The two arcs describe genuinely different things — one the producer side, one
the consumer side — and their designs stay apart for that reason. But they meet
at exactly one point, and everything expensive about running them separately has
come from that meeting being implicit.

**The one intersection: whether a verb's declared result reaches the runtime.**
It is the withdrawn result-schema emission, the descriptive receipt schema that
stands in for it, the open proposal to carry a declared result onto
`module.resultSchema`, and the verb listing that wants result schemas before it
is complete. One question, four places.

Three agents rediscovered its consequences independently — the append-only
lesson, the update-gate refusal, and the withdrawal history — each paying full
price. That is what a shared sequence prevents. Ordering is temporal, so it
belongs in one document even when the reasoning belongs in two.

## State

Where every item stands. The sections below carry the detail and are what to
read before picking one up; this is the roll-up, so a driver can see the shape
without reconstructing it.

| Item | Status |
| --- | --- |
| 1. a verb's declared result reaches the runtime | on main (#5501) |
| 6. the read layer | on main, in full |
| 7. session-scoped invocation ids | on main (#5610) |
| 8. descriptive receipt schemas | on main |
| 9a. listing marks | on main (#5309) |
| 10. listing rows carry a handler's declared result | on main (#5629) |
| 9b. closed-world event emission | **ruled against** (#5589); does not land |
| 12. `cf` refuses an undeclared field on a call | on main (#5835) — where the ruling puts this capability |
| 4. `receipt` as a top-level envelope field | on main (#5694) |
| 2. an unrecognized projection key is refused | on main (#5817); design landed (#5753) |
| 3. a rejection propagates up through what holds it | on main (#5701) |
| 5. `cf wish` and `cf exec` take the read options | on main (#5844) |
| 11. a caller may name a reference | on main — envelope #5880; the emitted-address spelling and the protective refusals via the contract ruling (ordering row 14) |

Item 9 is split because its two halves have different fates: the marks landed,
the emission is parked.

These pull requests remain open against this work. They are listed here because
a driver needs to know what is already moving before scheduling anything new.

| PR | What | State |
| --- | --- | --- |
| #5746 | the `Demand<T>` marker and the foreign-output embedding warning, prototyping the demand substrate in [designing verbs so they can change](verb-evolution.md) | open. It edits `packages/ts-transformers/src/transformers/schema-injection.ts`, which is the file item 11's fourth part edits, so the one-file rule queues the two rather than running them in parallel — a driver picking up item 11 schedules against this branch before starting. It also adds `demand` to `ANNOTATION_KEYS` (`packages/piece/src/schema-compatibility.ts`), the set item 2 derives its tolerated tier from |

**Most of the read layer has landed.** #5309, #5459, #5468, #5470, #5497 and
#5500 are on main. #5458 is closed rather than merged because its rename was
folded into #5470's squash; the shared read step it factored out is on main as
`packages/cli/lib/cell-selection.ts`. A reader who goes looking for #5458 should
not conclude the step was dropped.

**The invocation pair and call selection are both on main**, re-landed together
by #5610. `scopeCallerEventId` takes the `{id, session}` pair rather than the id
alone, so two callers choosing the same word — `add-comment-1` is the word two
agents both pick — no longer compute one address and read one receipt. `piece
call` takes `--select` / `--schema` / `--filter` beside it.

**So item 4's precondition holds: a published receipt address has stopped
moving.** That is what item 4 was sequenced after item 7 to wait for, and the
wait is over. What it cost to get there is the merge-race hazard recorded under
"How this is driven" below, which is the part worth carrying forward.

## The decision that was waiting, and the condition it carries

**1. A verb's declared result reaches the runtime.** *(#5501)* Decided — and
the timing framing was confirmed rather than merely tolerated: the durable form
is where this eventually lands, so the only live question was whether to wire it
before then.

The July emission was withdrawn because a keyword in durable schemas and
append-only baselines would hard-commit a shape, and the compatibility rules
built alongside it would have refused its removal. Both objections attach to
where the shape was written. A module field enters no durable schema, so no
baseline records it and the gate has no rule to apply — which is why this road
was open when that one was not.

**The approval is conditional, and the condition binds work that is not built
yet.** It was given as: if it is easy to add now, go for it; but if it creates
more things to chase down, revisit rather than push through.

Both halves satisfy it. The producer is on main (#5501). The consumer, item 10,
is the lookup the condition was aimed at — a handler's module lives in the
compiled graph rather than sitting in reach the way a tool's pattern does — and
it cost one structural match and no change to `callableCommandSpec`'s
signature. The command surface followed: #5680 stopped the help page's false
no-output claim, and #5717 serves the declared result at
`cf piece call <verb> --help` — text and `--json` alike — through the
resolution's `declaredResult` thunk, so the pattern load is priced onto
exactly the callers that ask (help, and a readback bounding a cycle), never
onto an ordinary dispatch.

*What this unblocks.* Items 8 and 10 stop being provisional, and verb discovery
closes — `cf piece verbs` can answer both halves of its question.

*A correction owed to this document.* It priced the decision as "narrower than
first claimed", naming only narrowing on field selection and the pre-call check.
That is right about the value path and omits the command surface: the
derivable default (since landed with the cycle bound, #5740), completion, and
the help page (since closed by #5680 and #5717). A reader weighing the revisit
condition will check it against this pricing, so the pricing needs to be the
honest one.

## Ready to build

Unblocked and independent of the decision above. Item 2 is (M). Item 11 was
listed here as its equal and is no longer: its CLI half reduces to a
documentation correction. What remains of it — whether a rendered address
should declare itself indirect — is answered no in #5760: indirectness is a
property of what a target holds when a reader looks, not of a reference. What
that leaves is provenance, whether an address can say it names a spot rather
than a canonical cell, which is a different question and gates nothing either.

**2. An unrecognized projection key is refused.** *(M)* **On main as #5817.**
The design is the thing to read before picking any of this up. The failure it
removes: two denylists were consulted and every key in neither was accepted and
carried onward. The design is
[projection keys, and the schema a read is handed](../history/plans/projection-key-classification.md),
which carries the tiers, the measured blast radius, and the reasoning; read it
before picking this up. What follows is what a driver needs to sequence the
item.

This is the general form of a failure already fixed twice as instances — a
missing `type` and an untyped `items` root each returned an empty result and
reported nothing.

*A typo widens as readily as it narrows.* Without `type`, a misspelled
`properties` names no container and the position reads as empty. **With `type`
stated, the same misspelling sets `additionalProperties: true` and returns the
whole object** — every field, including the ones the caller deliberately did not
name. Both exit 0. The second is disclosure-shaped and is the stronger
motivation for this item.

*The general rule is bigger than the refusal.* **The projection reader must
never hand the read boundary a schema it did not construct itself.** Refusing
unknown keys does not reach it: `required` is recognized, legal, never reasoned
about by the CLI beyond container inference, and acted on by the runner, so
tolerating it forwards it. #5734 is that failure — an unsatisfiable `required`
empties the whole read at the read boundary, and the command layer then
refuses the empty materialization with a message that names neither `required`
nor the position — and it belongs to this item. The rule its fix
needs already exists one call site over: `selectSourceSchema` derives the
constructed schema's `required` from the *source*, with a comment giving exactly
this reason. **Its filter needs the survival test that comment describes**,
though. As written the filter asks only whether the caller projected the
position, so a property the caller projected under a type its value fails stays
required, is then dropped by traversal, and empties the read — #5734 again,
over a key no caller wrote. Ceasing to carry the caller's `required` without
that does not fix #5734; it relocates it. The design works the rule out, and
the two containers do not answer it alike: a rejected object property is
omitted and the object survives, while a rejected array element voids the
array, so a caller's element type takes down the whole property and everything
that required it.

*Four tiers, not three.* Honored (`type`, `properties`, `items`,
`additionalProperties`, `$link`); **consulted** (`required`, `minProperties`,
`maxProperties`, `minItems`, `maxItems`, `uniqueItems` — read for container
inference, so they change behavior, and the caller's copy goes no further);
tolerated; refused. Calling the consulted tier "tolerated" would be dishonest
about what it does. What stops is the caller's constraint, not the keyword: the
reader keeps deriving `required` from the source schema, and that derivation
must survive the item intact.

*Three things the coupling to the compatibility checker has to respect.*
**Derivation is not one-to-one:** three members of `ANNOTATION_KEYS` —
`default`, `$defs`, `definitions` — are refused by projection on purpose, so
the relation is `ANNOTATION_KEYS` minus a stated exception set, whatever that
set grows to, and a fallback test asserting plain non-refusal of every
annotation key would be red the day it is written. It asserts the exception
relation in both directions instead.
**The validation half must not derive:** the checker's `handled` set is a union
including `allOf`, `if`/`then`/`else`, `patternProperties`, `asCell`, `ifc` and
`scope`, every one of which projection refuses deliberately — so derive the
annotation tier and write the validation tier by hand. **A refusal cannot point
at a lifted schema:** no CLI surface prints the read-side source schema, so
there is nothing to lift. That advice is sound one surface over, for item 12,
where `cf piece verbs --json` carries `inputSchema`. A read-side refusal names
the key, its position, and the accepted vocabulary.

`tier` and `deprecated` are the newest annotation-class keys and the likeliest
to be missing from a set drafted out of the standard JSON Schema vocabulary.
They belong in the tolerated set on day one.

**Deriving the tolerated tier gives you candidates, not a proof that carrying
one is inert.** That proof is owed per key and is discharged against the
runner, not against the checker's registry. `$comment` fails it: the runner
reserves three of its values as control markers, so a caller's `$comment` is
forgeable control flow reaching the read boundary — a projection setting one
on a property drops that property, and one on a source-required property
empties the read the way #5734 does. It is accepted and dropped, alongside `$id`
and `$schema`.

*Measured: nothing in the tree breaks.* Four JSON Schema keywords appear in
keyword position across every `--schema` argument in the repository — `type`,
`properties`, `items`, `$link` — all honored.

*Out of scope:* `--select`, whose grammar is field paths and whose projection
the CLI already builds itself.

*Exit:* an unrecognized key is refused and the message names it; a tolerated
keyword is accepted and ignored; a consulted keyword is read for inference and
the caller's copy goes no further, while the source-derived `required` the
reader builds still reaches the read boundary — asserted against the output
schema itself, which the selector handed to the storage provider is not; a
projection naming a `required` field it does not project reads the fields it
does; a caller's scalar `type` still filters the leaf it is written on, at
depth as well as at an array item; and a source-required array narrowed by a
caller's item type reads its siblings rather than emptying the object, which
the scalar cases do not cover because the array's failure escalates from an
element rather than occurring where the caller wrote it. A command that ran
only because a key was silently dropped now fails loudly, which is the point
rather than a regression.

**3. A rejection propagates up through what holds it.** *(S)* The projection
mask reduces either container whose whole selection rejects — an array whose
items reject, and an object whose every named property rejects — to `false`. A
rejection below a link therefore cascades up to the position holding that link,
which is where a rejecting selector suppresses the fetch, so marking a field
below a link costs the read that document already needed rather than one per
element.

*Exit:* a marked collection is one document read whether the marker sits on the
link or below it.

**4. `receipt` as a top-level envelope field.** *(S)* Published from the
handling receipt link, so a caller holds the address before the outcome exists —
including under `--no-wait`, which returns none today and is therefore a dead
end for collecting work later.

This is also what gives items 8 and 9 a consumer: a receipt's schema is read by
`cf cell get` against the address this publishes, not by the call path.

*Exit:* a detached call returns an address that reads back the outcome it
names.

**5. `cf wish` and `cf exec` take the read options.** *(S each)* The two
remaining arrivals. A vocabulary that works from two starting points and
silently does nothing from the other two teaches a rule that is false half the
time.

Two constraints carry from the design: a wish's selection runs *before* the walk
that strips handles, because a marker needs a live cell to read an address from;
and `exec` already prints its result cell as prose on stderr, in a spelling no
other command accepts, which this is the occasion to make the declared shape.

*A handler reached through `cf exec` had no outcome to shape.* The dispatch
named no invocation, so the handling filed under no receipt and the command
printed nothing at all — a read option there could only ever have answered
nothing, which is the silence this item exists to remove. `cf exec` now mints
an invocation per call, the same pair `resolveInvocationIdentity` mints for a
`cf piece call` that names neither, and prints the Invocation JSON that call
declares. A tool's stdout is unchanged; its result cell's address moves to the
address-argument spelling, which is what removes the third spelling rather than
adding a fourth.

*Exit:* the same cell, reached four ways, renders identically under the same
selection.

**11. A caller may name a reference.** *(M)* **On main** — the envelope
spelling as #5880, the emitted-address spelling and the protective refusals
with row 14. A caller names an existing cell where a verb declares a
reference, and the edge that comes back is the target rather than a copy of
it.

What it removes: a verb whose event declared `Writable<T>` was callable by a
model and by nothing else. `traverseAndCellify`
(`packages/runner/src/builtins/llm-dialog.ts`) resolved `{"@link": …}` into a
live cell before dispatch, so the LLM boundary had a complete round trip while
the CLI rejected the address and the webhook path forwarded it unresolved.

**The refusal that protects it is built beside the emitted spelling.**
Refusing a shape-matching payload needs a reference position identified,
which needs the `asCell` marker — and the marker survives on exactly one
serialized surface: the handler module inside the compiled pattern
(`Pattern.resultSchema` and every link-carried schema are sanitized to stream
markers only). The CLI's dispatch gate reads it there, on the repair path a
shape refusal opens, converts the emitted address into the link envelope, and
refuses the two payloads that could only ever be mistakes at the position.
#5560 carries the original measurements.

*The refusal was drift, not policy, and #5880 removed it.*
`closedWorldEventRejection` (`packages/runner/src/runner.ts`) has always
validated a present event payload with `acceptOpaqueValue` — a link passes
unjudged, because its target cannot be read at dispatch. `verbInputSchemaError`
(`packages/cli/lib/callable.ts`) called the same `validateSchemaValue` without
that option, so the outer gate refused what the inner one accepted. It passes
it now, through `isOpaqueReference`, which additionally requires the envelope's
payload to be a record: `isLink` answers on shape alone and is true of
`{"/": {"link@1": "nope"}}`. The design is
[references as arguments](references-as-arguments.md).

The second obstacle was the CLI's own, and neither the design nor this plan
predicted it: the undeclared-field walk descended INTO the link envelope and
reported `/` as a field the verb does not declare. Neither fix needs to know
which positions declare a reference, which is why the capability landed with no
`asCell` marker and no transformer change.

*Measured: `send()` already resolves a native sigil.* A raw sigil link riding
an event payload reaches the handler as the **resolved target**, not an
envelope — probed against a local toolshed with an `any`-typed event field, so
nothing gated it: the handler saw the target's own properties and read its
`title`. That settles the question
[references as arguments](references-as-arguments.md) flagged untested, and it
means the door is already open under the native spelling. This item names a
capability rather than adding one.

Four parts, three of them landed:

- **Refuse the structural copy.** *Landed.* Correct under any road, needs no
  vocabulary and no gate change, and converts silent corruption into an error.
- **Give the CLI gate the option the dispatch gate already passes.** *Landed
  as #5880.* One argument at one call site — and on the measurement above,
  sufficient on its own for the native sigil spelling, since the gate is the
  only thing between that payload and a `send()` that already resolves it.
  Confirmed since against a declared field rather than the `any` the probe
  used: the edge that lands reads back as the address that was named.
- **Lift resolution to a shared home**, beside `parseLink` and the LLM-friendly
  pair in `packages/runner/src/link-utils.ts`. *Still owed.* The CLI resolves
  the emitted spelling at its own dispatch gate, which serves every caller that
  comes through `cf`; the webhook and ingest paths reach the same handlers
  through no gate at all, and a shared home is what would serve them.
- **Fix event-schema emission.** *Landed as #5964.* The handler-side stream
  schema was a usage summary — `applyCapabilitySummaryToArgument`
  (`packages/ts-transformers/src/transformers/schema-injection.ts`) shrank the
  event parameter to what the body used, so a declared reference field the body
  never read disappeared from the emitted properties and `required`. It now
  serves the authored event, per
  [the input contract](../history/plans/verb-input-contract.md), with the
  usage-derived capability riding the marker rather than the shape.

*The decision inside the item is taken:* resolution at the CLI is
schema-DIRECTED, off the declared contract, so a typo at a reference position
is refused rather than resolved. The runtime's own dispatch gate stays
schema-blind. A shared home for the remaining callers chooses between those
two proven shapes.

*A constraint rather than a decision, and met:* what is accepted inbound
includes the shape a read emits.

*CFC gets a notification, not a ruling* — an existing capability widening from
the user's own model session to external principals.

*Exit, met by #5880:* `cf piece call --piece <root> addPiece
'{"piece": <address>}'` registers the piece. That verb was reachable by
`pieces.add` from inside the runtime and by a model through the dialog builtin,
and by no other caller; a CLI caller now reaches it too, and the edge that comes
back is the target rather than a copy of it.

*Exit, met by row 14:* the same call sending the target's SHAPE rather than
its address is refused — including a copy carrying every field the target
declares, which the published schema alone cannot tell from the real thing —
instead of storing a detached copy and reporting success.

**12. `cf` refuses an undeclared field on a call.** *(S)* **On main as
#5835.** The failure it removes: a payload carrying a field the verb does not
declare was accepted, the field dropped on the way in, and the caller told the
call settled — the silent-strip failure, which is what a caller writing JSON by hand or by
model hits and a TypeScript author never does.

*This is item 2's shape, one surface over.* There a projection key in neither
denylist is accepted and ignored; here an event field the schema does not
declare is accepted and ignored. Both were the CLI declining to refuse what it
cannot honor, and both are fixed by the CLI refusing it — not by a schema
forbidding it, which is the distinction #5589 turns on. They share one
vocabulary for what a refusal says, since a caller meets both through the same
command, and #5850 carried it to the flag door as well.

*The check has a home already.* `verbInputSchemaError`
(`packages/cli/lib/callable.ts`) validates a payload against the verb's declared
event schema before dispatch. What it does not do is treat an undeclared field
as a reason to refuse — and the schema it validates against names exactly the
fields the verb declares, so the comparison needs no new source of truth.

*The refusal is derived from where a field actually goes missing*, not from a
rule about schemas. A position drops what it does not name exactly when it
reaches a `properties` map with no `additionalProperties` beside it — measured
against the read a handler's event goes through, and true of every spelling of
an object-shaped position: a stated `type: "object"`, a bare map, a type union
admitting an object, and a conjunction, whose declared fields are the union
across its members. A position reaching no map at all delivers the whole
payload, so a verb that declares nothing THAT way takes anything; a position
spelling `properties: {}` delivers nothing, so every field written there is
refused. Which spellings describe an object is `schemaIsObjectShaped`'s
question, asked rather than answered a second time. Everywhere else the check
fails open — a disjunction, an `asCell` position below the root, a container the
payload does not match — because a refusal can be retried and a call wrongly
refused cannot be made at all.

*What a caller reads names fewer fields than the TypeScript does.* The emitted
event schema names the fields the handler body READS, so a field declared in
the event interface and never touched is one the runtime would have dropped and
this now refuses. That is the same failure surfacing, and `--help` prints the
same vocabulary the refusal does.

*Exit:* a call naming a field the verb does not declare is refused, the message
names the field, and the invocation id is not spent.

## Landed, and what consumes it

**6. The read layer.** On main in full: the shared read step, address markers
with the deepest-link rule, container inference, the flag split, entity-URI
intake, the `@` suffix, and call selection.

**7. Session-scoped invocation ids.** On main (#5610). It is the one
address-changing commit, and the whole plan is ordered around landing it before
anything publishes a receipt address — so a receipt address now carries
identity and is something a caller can safely be handed. Item 4 depends on
this; nothing else does.

**8. Descriptive receipt schemas.** On main. Plain results only — a verb
returning anything reactive gets none, which is what item 1 decides.

**9. Closed-world event schemas and listing marks.** The listing marks are on
main (#5309). **Closed-world emission is ruled against** and does not land: an
event schema is not to carry `additionalProperties: false`, because absence
already denies a handler an undeclared field, while `false` rejects the whole
event over a field the handler would not have received either way — and it
locks the schema permanently, since the compatibility rules cannot take a
closure back (#5589, and the review on #5307).

*The capability is not refused, only its location.* Refusing a call whose
payload carries a field the verb does not declare is an ergonomic property of
`cf`, not something to enforce in the runtime. In TypeScript the compiler
already says so at authoring time without foreclosing a later field, so what is
missing is the check for callers who never see a type — which is the CLI. That
is item 12.

*Two mechanisms on main are left with nothing to do*, and retiring them is a
question for whoever owns the runtime rather than a step here:
`closedWorldEventRejection` (`packages/runner/src/runner.ts`) is a dispatch gate
no schema can now trigger, and #5302's verb-event-role compatibility rule
governs an open-to-closed transition that will not happen.

**10. Listing rows carry a handler's declared result.** *(S)* `cf piece verbs`
reports an `outputSchema` per row for a handler as well as for a tool, so verb
discovery answers both halves of its question: what a caller may send, and what
it gets back. A tool's result schema rides its callable cell and its branch
just reads it. A handler's rides the node it compiled to, so the listing
resolves the piece's pattern once and matches each handler node's `$event`
input against the result property exposing the same stream — one structural
comparison inside one compiled object. A stream two handler nodes share names
no single result, and a piece whose pattern will not resolve keeps every row
and loses only the schema.

*A terminology collision made this look like more than it is.* A pattern's
**result-schema literal** is where its stream properties live, and the listing
marks are stamped there. A **verb's declared result** is what a handler returns.
The two share the words and nothing else, which is why the listing work and the
declared-result work read as coupled when they are independent. Only this item
joins them.

## Ordering

**A defect this plan's own items caused is not a separate queue.** The items
build a verb surface; the issues below are that surface failing where it is
already built. Sequencing them apart would mean shipping items 4 and 5 onto a
read path known to break after a handler runs, so they are interleaved here and
each step names what it delivers.

Two rules set the order. **One file at a time** — two branches open on one file
is the merge race under "How this is driven", so steps sharing a file are
strictly sequential while separate files run in parallel. **A blocked step never
gates an unblocked one**, which is why everything waiting on a ruling sits in
its own track.

| # | Step | Delivers | After | Why here |
| --- | --- | --- | --- | --- |
| 1 | The doubly-linked tracker fixture and its walkthrough | **on main** (#5639, #5631) — repro for #5577, #5632, #5633, #5637; item 11's subject | — | Five things verify against a piece that holds a back-reference, and none could be demonstrated until one existed. `verb-session-gaps.sh` is where they are asserted, and several of its assertions expect a gap and fail loudly the day it closes — so a capability arriving announces itself instead of quietly turning a check green. The script states its own count; repeating it here only creates a second place to be wrong |
| 2 | A projected read survives a handler | **on main** (#5764) — #5633 | 1 | Breaks call-then-read-shaped, which is the loop items 4, 5, 10 and #5577 all demonstrate against. Diagnose before estimating: if it sits in runner materialization rather than the read path, it moves after step 7 rather than holding the line |
| 3 | Listing rows carry a handler's declared result | **on main** (#5629) — item 10, #5619 | — | The consumer half of item 1 |
| 4 | The forced-stream fallback stops inventing verbs | **on main** (#5683) — #5576, #5662 | 3 | Same file as step 3, which has landed, so this is the front of the queue. It narrows the listing, so sweep the open branches for writers first |
| 5 | The help page stops claiming a verb returns nothing | **on main** (#5680) — #5558, first half | — | `Output: No output on success.` is wrong for a declared verb. Asserting there is no output is worse than saying nothing, and stopping it needs no schema and no decision, which is why it precedes the half that does |
| 5a | An author's prose reaches the caller | **on main** (#5825) — #5637 | 1 | Separate lane — what is missing is not in the CLI. See the measurement below: two of the three symptoms are emitted correctly and lost afterwards, so a fix aimed at the emitter would miss them |
| 6 | Help enumerates what a verb returns | **on main** (#5717) — #5558, second half | 3, 5 | Step 3 builds the declared-result lookup; this is its second consumer, at the call path rather than the listing |
| 7 | A returned piece reads back through its own cycle | **on main** (#5740) — #5577 | 6 | The derived default selection bounds the readback, which is what turns the crash into a result |
| 8 | `receipt` as a top-level envelope field | **on main** (#5694) — item 4 | — | Its precondition is met, it touches the call envelope alone, and it is what gives items 8 and 9 a consumer. Runs beside steps 5-7 |
| 9 | A rejection propagates up through what holds it | **on main** (#5701) — item 3 | — | First of the projection work; the mask's asymmetry is what makes a marked field below a link load every element |
| 10 | Two identical projections stop colliding | **on main** (#5757) — #5523 | 9 | Same file. Reachable the moment anything long-lived reads twice, which the command surface invites |
| 11 | One piece, one address | **decided — they are aliases**; the documentation half is #5754 | — | Measured: the two routes differ because one resolves the link chain and the other renders the link as stored. That is the read model working, not a defect, so the outcome is the statement rather than the fix. What remains is a doc correction and closing #5632 — no code changes, and step 13 is not gated on it |
| 12 | An unrecognized projection key is refused | **on main** (#5817) — item 2 | 9 | The largest remaining step, and the one carrying design surface, since it couples the projection reader to the compatibility checker's annotation keys. Its design is [projection keys, and the schema a read is handed](../history/plans/projection-key-classification.md) |
| 12a | `cf` refuses an undeclared field on a call | **on main** (#5835) — item 12 | — | Same refusal shape as the step above and independent of it, so it can go either side; building them together is what keeps one vocabulary for what a refusal says. Built against #5817's wording rather than its code, since that branch is unmerged |
| 13 | `cf wish` and `cf exec` take the read options | **on main** (#5844) — item 5 | 11, 12 | Last by construction: it spreads the vocabulary to two more starting points, so the vocabulary should have stopped moving — and it now has. No resolving marker is planned, so the grammar step 13 spreads is the grammar that exists |
| 14 | A caller may name a reference | **on main** — item 11, #5560; envelope #5880, emitted spelling and refusals via the contract ruling | — | A caller names an existing cell where a verb declares a reference in either spelling — the link envelope (#5880) or the address exactly as a read emits it — and the edge that lands is the target rather than a copy. The refusals that protect the position are built with it: a string that is no address, and the shape-matching payload that would have **stored a detached copy and reported success**, are both refused naming the position. The reference marker reaches the CLI through the handler module in the compiled pattern — the one serialized surface link sanitization leaves it on — read at the dispatch gate per [the input contract](../history/plans/verb-input-contract.md) |

**`--show-links` is not redundant, and nothing should schedule its removal
yet.** [Verb result selection](verb-result-selection.md) prices it as a stopgap
that in-band rendering makes unnecessary. That is right about *addressing* — a
caller wanting something to compose with reaches for a marker, which is the
shorter road — and wrong about the job the flag has since acquired.

A marker renders the link **as stored**; `--show-links` **resolves** the chain.
`renderedLinkAddress` reshapes the link it is handed and follows nothing, so no
in-band spelling can produce a resolved address at any position. That makes
`--show-links` the only way to resolve a whole result in one pass, and an
in-band address cannot replace what it does not do.

**A caller does not ask for resolution, and the projection grammar is closed.**
Resolution is a fixed point over the locally materialized subgraph — the same
link answers differently as documents load, and `resolveAsCell` fires an
un-awaited sync of its own, so it both depends on and causes loading. That is
the runtime's eventual consistency rather than a defect: a reactive holder
re-runs as data arrives, and interim states are rarely acted on. A marker
offering resolution over it would ship nondeterminism under a name promising
determinism, so none is planned and the vocabulary has stopped moving.

Two things follow, and both belong to #5760 rather than here. A rendered
address does not declare itself indirect, and cannot: replacing a cell's
contents with a link to another cell is an ordinary write, and it turns every
reference that named that cell directly into an indirect one with no holder
changing. `resolveLink` re-probes for the sigil at the address on each
resolution, which is why the answer is read from the target rather than carried
on the reference — a marker would freeze a render-time observation into a value
that outlives it. Provenance is the durable thing an address can carry instead,
and whether it should is the question that survives. And a **non-reactive
reader** is where eventual consistency
stops paying, since `cf` exits before convergence on purpose rather than hold a
committed write hostage to every recomputation it triggered.

Keep `--show-links` meanwhile; retire it when a replacement exists or the need
is confirmed dead. Note that `cf cell get` has never had an equivalent, so
bulk resolution on a *read* is a gap that predates all of this.

**Running beside all of the above.** A caller naming a reference (item 11,
#5560) is landed in both spellings — the sigil resolves through a *declared*
event field, and the emitted address converts to the sigil at the CLI's
dispatch gate. It decided nothing item 1 decides: a declared result makes an
*output* self-describing, and this is what an *input* accepts.

**Where a doc comment actually goes, measured against the compile pipeline.**
Step 5a rests on this, and it is not what either symptom looked like from the
CLI:

| An author writes it on | In the compiled pattern |
| --- | --- |
| a verb (`Stream` property) | **present** — `resultSchema.properties.<verb>.description`, as a sibling of the `$ref` to the event's definition |
| an event field | **present** — `$defs.<Event>.properties.<field>.description` |
| the event interface itself | **absent** |

So only the third is an emission gap. The first two are emitted and lost
between the pattern and the caller: the schema a caller is served is the
resolved form — no `$defs`, no `$ref`, the target inlined — and both
descriptions are absent from it.

*The obvious explanation is not the explanation.* A `description` beside a
`$ref` is ignored under JSON Schema's own semantics, so a resolver that
substitutes the target would drop it. This one does not:
`resolveCfcSchemaRefsUncached` (`packages/runner/src/cfc/schema-refs.ts`)
collects ref-site siblings and merges them over the resolved target on purpose.
That rules out the tidy answer for the verb, and it never explained the event
field, whose description sits inside the `$def` rather than beside the ref.

*A lead, unverified.* `resolveSchema` (`packages/runner/src/schema.ts`) calls
`resolveSchemaRefs(schema)` with one argument, so the document consulted for
`#/$defs/...` defaults to the property schema itself — and a verb property
carries the `$ref` while the `$defs` live at the pattern's result-schema root.
Whoever takes this should confirm or discard that before assuming a single
cause: what is established is only that the emitter is not where two of the
three go missing, so a patch aimed there would close one symptom and leave two.

**Carried alongside, not sequenced.** Two defects that no gate can see, which
is why they are written down rather than left to be met again. A capability
probe that covers nothing (#5534) asserts something it cannot observe, so it
reports green continuously until fixed. And the renderer writes a click count
into `detail` and a cell-ref into `target.value`, both slots patterns declare
with other types (#5589) — closed event schemas were the only thing that ever
compared the two, and ruling against them removed the detector rather than the
mismatch.

## How this is driven

One agent owns this document and the ordering in it. Work is farmed out per
item, not per file, and an item comes back with its own tests rather than a
promise of them.

**This document owns the record as well as the order.** The plans it replaces
are archived, so there is no longer a live plan for an author to strike a done
note into as their work lands; done state belongs in the State table above, and
keeping it current is this document's job rather than each author's. That is
worth stating because the alternative — several sessions editing one shared
plan as their PRs land — is the collision the per-agent split exists to avoid.

Two rules earn their place, both from what went wrong when this was three
plans:

**Two PRs can each be green and still break main together.** CI judges a PR
against a base, so when one branch narrows a type and another still writes to
the old shape, both stay green until they meet. #5469 and #5505 merged
twenty-six seconds apart and #5582 reverted both. Nothing in the checks catches
it; the only thing that does is a driver noticing that two open PRs touch one
vocabulary, and merging them far enough apart that the second rebases onto the
first. The tell is a green PR whose base predates a merge that changed
something it writes to — a rename is the obvious case, but any narrowing
counts.

The cost is worse than a red gate, because the stale field arrives as an
*excess property*, silently dropped rather than rejected. The nine tests #5505
added did not merely fail to compile: they dispatched with no invocation at all
and awaited a receipt that could never arrive. Type-checking is the only gate
that sees an excess property. A `--no-check` suite sees a value that is simply
absent — and the package suites run `--no-check`, so `172 passed | 0 failed`
reads identically either side of this bug and is not evidence about it.

**A test that inspects stored shape is testing the harness, not the runtime.**
A pattern result stores each field as a redirect link into the argument
document, while a unit fixture writes the value inline. So a check reading
`position.stored` succeeds against the fixture and never fires against a real
server. Anything asserting on how a value is *stored*, rather than on what a
read *returns*, wants a live-server case before it is believed.

This is the same shape as the rejected-position defect split out as #5609: the
`boardSchema` fixture declares no `required` while a generated pattern schema
does, so every fixture in that file agreed with the bug and the suite could
only confirm it. It is also the shape that hides in a double: a compiled
pattern is callable, so a double written as a plain object passes a guard that
rejects what the runtime actually hands over, and the suite stays green while
every real listing comes back empty.

Three instances make it a mechanism rather than a run of bad luck, and the
general form is worth more than any of them: **when a double stands in for
something the runtime constructs, check what the runtime constructs.** A
fixture is a claim about the world, and an unchecked one is the cheapest way to
build a test that cannot fail. When a test cannot fail, look at the fixture
first.

**A squash merge invalidates the fork point of everything stacked on it.**
Rebasing a child with `git rebase <new-base>` then replays commits the base
already contains, and the duplicate-commit conflicts look like real ones.
`git rebase --onto <new-base> <the branch's own first commit's parent>` is the
form that works. The cheapest tell that a fork point was wrong: the branch
suddenly touches files it has no business in.

**Archiving a document does not protect it from a rebase.** Git follows the
rename, so a branch that edited the live document applies its edit inside the
frozen copy — with no conflict, which is what makes it dangerous. Three separate
branches did this the day the predecessors were archived, and every one of them
rebased cleanly. After archiving anything, check whether an open branch still
edits it; the edit belongs wherever the live successor keeps that kind of
content, not in the record.

**`deno fmt` does not check anything under `docs/`.** The directory is in the
formatter's exclude list, so a passing `deno fmt --check` after a documentation
edit says nothing about that edit. The gates that do apply are `check-docs` for
code blocks, `check-conflict-markers`, and `docs-links --orphan`. Prose wrapping
is convention here rather than enforcement.

**A shared golden is a coordination point, not a merge conflict.** Two branches
can modify a generated fixture without conflicting textually and still leave it
encoding only one change. Whoever lands second regenerates.

**A keyword is classified before it is emitted.** Adding one to a durable schema
is free and removing one is not, so the classification has to precede the first
emission or the keyword is permanent by accident. This is what withdrew the
July result-schema work, and what #5309 got right by hand.

## What comes after

This plan is exhausted when the sequence above is walked and the issue tail is
empty — the items build the surface, and the tail is that surface failing where
it is already built, so neither alone finishes it. Two arcs are queued behind
it, and naming their triggers here is what keeps them from being dropped when
this document stops being read.

**The command surface** —
[The CLI surface shape](cli-surface-shape.md), already sequenced. Positional
addresses and the top-level names land first, and can start as soon as the read
layer has merged; they touch the same commands, so starting earlier means
resolving the same files twice. Every spelling it retires is dated rather than
conditional: each notice names the day after which the spelling it replaces is
no longer guaranteed.

**Retention and CFC execution provenance** —
[its own plan](retention-and-provenance.md). Gated on a CFC review that has not
happened. Nothing in this plan advances it, and nothing in it blocks this plan.

Whoever drives this document owns that queue, not just this list. A plan that
finishes without naming its successor is how an arc goes quiet with work left
in it.

## The issue tail

Every open defect against this surface, and where it attaches. A defect absent
from a plan is one nobody schedules, which is the whole reason for this table.

| Issue | What | Attaches at |
| --- | --- | --- |
| #5633 | a projected read fails on the SECOND read of the same source and schema; the handler is a red herring | **fixed** by #5764 — a list coordinator owed the setup writes a lost commit discarded, its result container's links among them, and the fix makes those writes a debt rather than a flag. #5706, which is why it reproduced every time, stands |
| #5576 | `cf piece verbs` lists data fields as handlers, so discovery reports what cannot be called | **fixed** by #5683, with #5662 — and the other direction by #5794 |
| #5698 | `cf piece verbs` returns nothing for a piece whose declared result type omits its verbs, though they are callable | the other direction of the same surface, and **fixed** by #5794: the listing enumerates candidates from the compiled graph as well as the result cell, and classifies each one on the stored signal that closed the first direction |
| #5706 | a shaped read permanently writes to the user's space — per-element sub-patterns land at space scope | runner-owned, beside #5633 |
| #5722 | a verb's help shows its usage twice, and shows no way to copy it | found by driving the surface by hand, which no test does |
| #5558 | `cf piece call --help` claims every handler returns nothing, including one that declares a result | **fixed** by #5680 (the false claim) and #5717 (the enumerated fields) |
| #5637 | an author's prose does not reach a caller: on a verb, on an event field, and on the event interface | step 5a — it absorbed #5559, which described one symptom and had its cause backwards |
| #5577 | a verb returning a child piece in a doubly-linked tree crashes readback on a cycle | **fixed** by #5740 |
| #5523 | two identical `cf cell get` projections in one runtime collide on the transform result cell | **fixed** by #5757 |
| #5632 | `--show-links` and a `$link` read return different entity ids for the same piece | step 11 — **working as designed**; closes once #5754 lands the documentation |
| #5498 | `getEntityId()` strips the entity URI scheme, collapsing two kinds to one identity | unscheduled. It rode ordering step 11 while that step was a question about identity; the answer there was that the two routes are aliases by design, which says nothing about a scheme the id itself drops. Independent, and still open |
| #5589 | a click's `detail` and a `cf-select`'s `target.value` reach a handler as types no pattern declares | carried alongside — it belongs to whoever next touches `packages/html`. The ruling that closed item 9b also removed the only thing that ever compared the renderer's output against an author's declared type, so this has no detector left |
| #5560 | an address a call returns cannot be passed back as a verb argument | **fixed** by #5880 (the envelope) and row 14's CLI half (the emitted address, and the refusal for the shape-matching copy that used to store a detached document and report success). Not to be confused with ordering step 11, "one piece, one address", which is #5632 and decided |
| #5534 | a capability probe passes while covering nothing: a dispatch rejection is not a synchronous throw | carried alongside |
| #5685 | no CI job runs any verb integration script, and one of them says it does | **fixed** — `integration.sh` runs both scripts (`verbs-over-the-cli.sh` since #5289, `verb-session-gaps.sh` since #5793), each in a section of its own, `verbs` and `verb-gaps`. The test topology's `cli-core` suite makes a unit of each section, which every full run runs and a pull request runs when it selects it. The arc's honesty checks gate |
| #5663 | the compat checker admits a newly required verb event field, breaking every existing caller | **fixed** — the refusal lives in the `verbEvent` context in `packages/piece/src/schema-compatibility.ts`, which is the set item 2 derives its tolerated tier from; the rule reads `required`, not that set, so the tier is unchanged |
| #5689 | `cf piece call` accepts any name into dispatch; a non-verb fails with no diagnostic | unscheduled. The listing now refuses to offer a non-verb (#5683, #5794); the dispatcher still accepts one |
| #5684 | `cf cell get --select` returns `{}` for a field path that cannot match | unscheduled. Item 2's shape on the concise path, which item 2 puts out of scope — a projection that answers nothing rather than refusing |
| #5686 | design rule 1 says input schemas are closed-world; after the #5589 ruling the runtime does the opposite | unscheduled and unowned. Not settled by [designing verbs so they can change](verb-evolution.md), which says nothing about closed-world inputs — searched, not assumed |
| #5756 | `ensureKeylessPatternIdentity`'s doc comment claims a structural-dedup property the code does not have | runner-owned. Measured: two structurally identical patterns get different keyless identities |
| #5758 | a call's readback traverses the reference graph with no work budget | memory-owned. `maxDepth` and `maxEntities` are in `docs/specs/memory-v2/05-queries.md` and not on the wire |
| #5759 | `Cell.equals()` is cache-dependent | runner-owned. The answer on record is that this is the runtime's eventual consistency rather than a defect — given by @seefeldb in review and reported here rather than cited, so it wants his statement on the issue before either issue closes on that basis. `Cell.equalLinks` is the non-resolving comparison and has no call sites outside its own tests, which is the other half of what a confirmation should settle |
| #5760 | an indirect reference has no contract | runner-owned. A rendered address cannot declare itself indirect: replacing a cell's contents with a link is an ordinary write, so indirectness is a property of what the target holds at read time rather than of the reference. What survives is provenance — whether an address can say it names a spot rather than a canonical cell. The other two answers are @seefeldb's, given in review and reported here rather than cited, so they want his statement on the issue before it closes on that basis |
| #5761 | the projection derivation cannot express conjunction; `allOf` refuses | filed out of item 2 and **relied on by it**: `sourceProvesContainer` refuses to prove a container through `allOf` for this reason |

**Filed against neighboring subsystems, and not sequenced here.** An
unnormalized external piece id upserting twice (#5499), and a create that
drops its navigation (#5530). Each is real and none is about the verb surface;
they are recorded so that reading this plan does not imply they were triaged
away.

## Out of scope

**Retention and CFC execution provenance** — the `AgentActor` mint, its
propagation, metadata confidentiality, and retiring `AgentAuthoredEvent`. Gated
on a CFC review, sized large, and not about verbs: it is a program that was
filed under one. It is sequenced in
[its own plan](retention-and-provenance.md).

**The command surface** —
[The CLI surface shape](cli-surface-shape.md) sequences positional addresses,
the top-level names, deprecation, and the move of each command under the noun
it acts on. Kept apart because it renames rather than adds, so every step of it
can break a caller who learned the current spelling.

**The designs.** Nothing here amends
[the pattern verb contract](pattern-verb-contract.md) or
[Reading Fabric data](fabric-read-model.md). An item that needs a design changed
says so and stops.
