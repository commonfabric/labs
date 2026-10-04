# Reviewed intents

An application that acts outside the fabric under a user's name, by sending a
message, an email or a post, and later by making a payment or carrying out an
agent's approved action, needs one fact it can check at the moment it acts:
this user, by a real gesture on a surface the runtime drew, released exactly
these parameters to exactly these destinations, recently, once. The spec calls
that a consumed single-use intent (§6.4.3 `IntentOnce`, §7.5.2) whose
parameters are the ones rendered at the gesture (§3.8.1), whose destination
carries integrity (§3.8.4), and which is verified again when the effect happens
(§8.10.7). The CFC author ruled (@seefeldb, 2026-10-01) that for a send the
gesture is the release, and that a short intent lasts ten minutes.

A pattern cannot produce that fact. A surface that requires a trusted gesture
is named by markup the pattern writes; what the user saw and what the handler
writes are tied together only by the pattern's own code; and nothing about the
gesture is persisted. A reviewed intent is that fact, minted by the runtime: a
record written under a builtin identity no pattern can take, which the acting
application verifies before it acts.

The host module is `packages/runner/src/cfc/reviewed-intent.ts`, exported to
hosts as `@commonfabric/runner/cfc/reviewed-intent` and absent from pattern
imports, the same arrangement as
[reviewed snapshot copies](cfc-persisted-declassification.md#31-reviewed-snapshot-copies)
and [sealed custody](cfc-custody-seal.md). It shares its review helpers with
both in `packages/runner/src/cfc/host-review.ts`. The cases are in
`packages/runner/test/cfc/reviewed-intent.test.ts`.

## What is built

The runner operation is built: the descriptor, prepare and commit, the record,
the receipt, the consent registry, and the check a consumer runs on a record.
The `cf-reviewed-intent` component, which draws the surface and makes the
gesture, and the runtime-client calls that connect it to this operation are not
built yet; they are the next change. The operation's commit accepts only the
gesture mark that host transport attaches, so nothing reaches it until then.

That change must bind each trusted click to the surface it was made on and to
that surface's consent. The operation's commit accepts any trusted gesture
marked `ReviewedIntent` for any consent the host holds, so the host transport
is what keeps a click on one surface from committing another surface's
preview.

## The descriptor

The application that acts on records (the consumer) publishes a descriptor in a
cell, and a pattern binds that cell. For a messaging consumer:

```json
{
  "operation": "send-message",
  "endpointName": "Example Messenger",
  "consumer": "example-messenger",
  "parameters": {
    "to": {
      "kind": "destinations",
      "min": 1,
      "max": 1,
      "integrity": [
        {
          "type": "https://commonfabric.org/cfc/atom/TransformedBy",
          "identity": { "kind": "builtin", "builtinId": "address-book" }
        }
      ]
    },
    "body": { "kind": "text", "maxLength": 4000 }
  },
  "windowMs": 600000,
  "maxAttempts": 1
}
```

- `operation` is what a record authorizes, `endpointName` is how the surface
  names the way the intent is carried, and `consumer` names the application that
  acts on records.
- `parameters` are the only keys a record carries. A key is a name that starts
  with a letter and holds letters, digits and underscores. A `destinations`
  parameter takes between `min` and `max` destination cells the pattern binds,
  and `integrity` is a nonempty list of atom patterns each destination's
  integrity must satisfy together, as one conjunction whose variables are shared
  across the patterns. An optional `space` names the space every destination
  must be in; absent, it is the subject's home space. Each destinations
  parameter states its own rules, since a payee and a funding source need
  different ones. A `text` parameter is text the actor enters on the surface, at
  most `maxLength` (zero or more) Unicode code points, counted as JSON Schema
  counts them.
- `windowMs` is how long after the gesture a record stays good. A record takes
  the smaller of this and ten minutes.
- `maxAttempts` bounds the delivery attempts a consumer makes on one record.

The example requires that the address book's builtin wrote the destination in
the subject's home space, and that nothing has written it since: the
`TransformedBy` the runtime derives names the one identity that wrote a value,
and another writer takes it away.

Every member is required, and the descriptor, each parameter, and each kind are
refused if they carry a member this build does not know. A member it does not
know could be a limit it would fail to enforce, so the operation refuses rather
than read the descriptor without it. The descriptor is how the format grows
without version numbers: a new parameter (`cc`, an attachment) is a new key the
descriptor declares, a new kind is a new `kind`, a surface that cannot show a
declared key refuses to prepare, and a consumer refuses a record carrying a key
its own descriptor does not declare. `parseReviewedIntentDescriptor` reads a
descriptor by these rules, for a host and for a consumer checking the one it
publishes.

Each destination integrity pattern must be `TransformedBy` with a literal
`identity` of kind `builtin` and a literal `builtinId`, and nothing beside them
but an optional `inputWitness`, whose own fields may hold variables. Every
other pattern is refused when the descriptor is read: a plain string atom, any
writer's or a verified writer's `TransformedBy` (a pattern's own handler mints
one on every write after a labeled read), a builtin id left open, and
`PolicyCertified`, which survives every combination, so a pattern that reads
only a certified value and writes a constant carries it.

What such a pattern guarantees is narrower than "a trusted source": the value at
the destination was written, as itself or within a value written whole, by a
transaction under the named builtin's identity, and nothing has written at,
above, or below it since. It says nothing about whose data the builtin wrote,
which is why each destination must also be in the declared space; that answers
whose data it is only when the consumer trusts every writer of that space, since
anyone who can write the space can run the same builtin there. Nor does it say
what decided the builtin's inputs. Prepare and verification refuse a builtin
whose inputs a pattern decides when the runtime can tell: one its module
registry holds, which pattern code invokes with inputs it chooses (`ifElse`,
`map`, `fetchText`, `llm`, and the rest), a host operation that copies a value a
pattern chose (the snapshot copy, the custody seal, and the reviewed intent
itself), and the compile cache, which writes what `compileAndRun` compiled from
source a pattern can supply. A builtin the runtime does not know is taken at the
descriptor's word, so a descriptor's author names a builtin whose writes no
pattern steers, as an address book's import from a channel the user connected
is.

A record carries the descriptor's digest as `endpoint`
(`reviewedIntentEndpoint`), and its parameters' digest as `payloadDigest`. A
consumer verifies a record through the runner's `verifyReviewedIntentRecord`,
which computes and compares both, so the two digests are internal to the runner
and not a format another process reproduces. If a consumer outside the process
ever needs them, fixing their encoding is a later format decision for the
data-model codec's owner. The operation does not check who wrote the descriptor:
a consumer acts only on records whose `endpoint` is the digest of the descriptor
it publishes, so a descriptor a pattern wrote, with a weaker integrity
requirement or a misleading `endpointName`, yields records no consumer acts on.

## The operation

`prepareReviewedIntent(bindings)` takes the cells a pattern binds: the
`descriptor`, the cells for each declared parameter that takes cells
(`parameters`, by key; a `destinations` parameter takes its destinations), and
a `result` cell that receives the committed record's link. Under the
authenticated acting principal it:

- refuses an actor that is not an authenticated DID, cells from different
  runtimes, and a runtime that does not enforce CFC or does not persist flow
  labels, which could write only records that never verify;
- reads the descriptor and refuses one this build cannot show;
- refuses a descriptor naming a builtin whose writes a pattern decides, as
  [The descriptor](#the-descriptor) lists;
- refuses cells bound for a parameter the descriptor does not declare as
  taking cells, and a number of destinations outside `min` and `max`;
- refuses a destination whose cell resolves outside the space its parameter
  names, or the subject's home space when it names none;
- reads each destination where its cell resolves, as stored. What the surface
  shows of a destination is that stored value and nothing else, never a string
  the pattern supplies. A value holding a link is refused rather than followed,
  because the destination's integrity covers its own document and not one it
  links to; so is an absent or `null` value;
- takes each destination's integrity from the `derived` label entries at or
  above its path, and requires it to satisfy the parameter's patterns. Only
  the runtime writes a `derived` entry, and its `TransformedBy` is taken away
  when another writer writes at, above, or below it. A declared label says what
  a location's values carry by schema, not who wrote the value there, so it
  does not count, on the destination or on an ancestor. A destination keeps the
  atoms that satisfied the patterns, one per pattern under the first binding of
  their variables that satisfies them all, and the location its cell resolved
  to;
- checks the host's read ceiling, or else `User(actor)`, over everything it
  read. The surface shows what it shows outside the render policy, so this is
  the only gate on what it may show;
- resolves where a write to `result` lands, refuses a target inside a reviewed
  intent, and prepares the record's link write there in a transaction it
  discards, refusing a target whose writer claim would refuse it;
- returns a frozen preview, with a one-use consent bound to the preview, the
  reads, and the actor.

The preview carries the actor, the descriptor's `operation`, `endpointName`,
`consumer` and digest, each declared parameter by key with its `kind` (a
`destinations` parameter with its destinations as the record will carry them,
a `text` parameter with the `maxLength` of the field the surface draws), the
effective window, and `maxAttempts`. The consent is an opaque object verified
against a private registry; a host holds it while the surface is open.

`commitReviewedIntent(consent, event, input)` commits. It spends the consent
first, so a consent is good for one attempt, successful or not. It accepts only
a renderer-trusted DOM event whose `provenance.ui.pattern` is `ReviewedIntent`.
`input` holds, by key, the text for every declared `text` parameter and nothing
else, each within its `maxLength`. The commit then reads everything again and
refuses a review whose actor, descriptor, destinations, or result target
changed. The record's transaction compares each read the second inspection made
against what it reads itself, through verifier reads that keep their conflict
checks without carrying a label into the record, so the destinations reviewed
are the destinations written.

## What a commit writes

A transaction writes one space, and the result cell may be in another space
than the actor's home space, so the commit writes in three transactions:

1. **A receipt in the actor's home space**, `{record, payloadDigest, at}`,
   where `record` is the record's document id. A receipt whose record is absent
   records a commit that failed after it. The user's trail survives a pattern
   unlinking the record.
2. **The record in the actor's home space**, at an address derived from its
   `idempotencyKey`.
3. **The record's link into the result cell's write target**, which must be the
   target the actor reviewed. The link is an ordinary write under no
   implementation identity, so a pattern leaves its result cell open to that
   write; prepare refuses one whose writer claim would refuse it.

The record:

| Member | Value |
| --- | --- |
| `operation`, `consumer`, `maxAttempts` | the descriptor's |
| `endpoint` | the descriptor's digest |
| `subject` | the actor's DID; the record lives in the subject's home space |
| `parameters` | each `destinations` parameter as a list of `{address, integrity, source}`, each `text` parameter as the text entered |
| `payloadDigest` | the digest of `parameters` |
| `idempotencyKey` | a random value unique to the consent |
| `at` | when the commit wrote the record, in milliseconds since the epoch |
| `exp` | `at` plus the smaller of `windowMs` and ten minutes |
| `evidence` | informational; today `{component: "cf-reviewed-intent"}` |

A destination's `source` is `{space, id, scope, path}`, where its cell
resolved, so a consumer can resolve it again. Scope is part of it because
scoped documents share an id.

The record's top-level members are a closed set that a reader must understand.
A new constraint arrives through the descriptor, which the consumer wrote, and
not as a new member a reader could ignore. `evidence` alone is open: a reader
ignores members of it that it does not know, and nothing relies on what it
holds.

`idempotencyKey` is random because the host transport carries no durable event
identity to derive one from. It is minted at prepare, so a commit's identity is
fixed before the gesture, and the record's and the receipt's addresses derive
from it, so no other code can address either before the commit writes them.

The record carries no opaque application payload: an application's own routing
data stays in its own cells, joined to the record by the link.

The record and the receipt declare the confidentiality the preview's reads
consumed, joined with `User(actor)`, so each is readable by the actor and by
nobody the destinations' labels exclude. Both are `writeAuthorizedBy` the
builtin identity `cfc-reviewed-intent`.

### Attribution, and documents written once

The record leans on two properties of the runtime that no primitive states
directly.

**A builtin's stamp needs a labeled read.** A `TransformedBy` atom is minted
only over a nonempty flow join, so a builtin's transaction that reads nothing
labeled writes nothing stamped. The custody seal reads an anchor it wrote for
this reason ([attribution](cfc-custody-seal.md#attribution)). The record's
transaction reads the receipt, its one labeled read, whose label always holds
`User(actor)`, and so stamps every location it writes with
`TransformedBy{builtin cfc-reviewed-intent}`, the root included. That, rather
than any wish to have a receipt for every record, is why the receipt is
written first. The receipt is at an address the builtin created a transaction
earlier, so no other code can occupy it first.

**A document is written once only by convention.** Nothing makes a document
immutable after its first write; what keeps a record as written is its address,
which no other code can predict, and its writer claim, which refuses any other
writer. A writer claim governs the location it is declared at and not the
locations below it, so the record repeats its claim on every member and on
every member of `evidence`, and stores `parameters` as JSON text with sorted
keys: one leaf, which the claim covers whole and which a consumer compares byte
for byte. The text also keeps the destinations in the record's one document. A
write through a cell made inside a builder frame, which a host's cells are
since every runtime pushes a default frame, stores a plain object inside an
array as a document of its own, which the record's root stamp would not cover.
The commit marks both documents create-only, which the storage commit enforces
only under `experimental.commitPreconditions`. Neither a write-once nor a
create-only primitive is part of the spec yet; the custody seal names the
same open question for which instance a room shows.

A runtime that does not persist flow labels mints no stamp, so prepare refuses
one. The commit also checks the record it wrote the way a consumer would before
writing the link, so a record without the stamp is never linked, and every
record a pattern receives verifies.

## Verifying a record

`verifyReviewedIntentRecord(record, descriptor, tx?)` is the check a consumer
runs before it acts, with its own descriptor. `record` may be the record or a
cell linking to it, such as the pattern's result cell. The check, in full:

1. the cell resolves to the root of a document, not a location inside one;
2. that root has a label-map entry of origin `derived` whose integrity carries
   the bare atom `TransformedBy{builtin cfc-reviewed-intent}`;
3. the record has exactly the top-level members above, `evidence` is a record,
   and the `parameters` text parses to a record of text and destination lists
   whose digest is `payloadDigest`;
4. the document is in the home space of the record's `subject`;
5. the descriptor names no builtin whose writes a pattern decides, as
   [The descriptor](#the-descriptor) lists;
6. the record is one the descriptor would have produced: its `endpoint` is the
   descriptor's digest, its `operation`, `consumer` and `maxAttempts` are the
   descriptor's, its window is within the descriptor's, and its parameters are
   exactly the declared keys, each of its kind and within its bounds;
7. each destination's `source.space` is the space its parameter declares, or
   the record's `subject` when it declares none, and its integrity satisfies
   its parameter's patterns.

Only the runtime mints a `derived` entry, and only a transaction under the
builtin's identity mints that atom, so pattern code cannot write a record that
passes. A stored `writeAuthorizedBy` naming the builtin is not evidence: a
pattern's own initialization can declare one on a cell it creates. A copy a
pattern writes carries the pattern's own `TransformedBy`, and an atom a pattern
declares in its schema is not persisted. Reads happen in `tx` when one is
given, so a consumer's transaction conflicts with a change to the record.

The check covers authorship, integrity, and agreement with the descriptor. At
action time the consumer also:

1. checks that the descriptor it passed is its current one, and that `subject`
   is the principal it acts as;
2. sends exactly the parameters the verified record holds, whose digest the
   check compared;
3. resolves each destination's `source` itself, in the space the check
   confirmed, and refuses if what it finds differs from `parameters` (it never
   substitutes);
4. checks the window by `exp`, and by its own first sight of the record;
5. keys its ledger on `idempotencyKey` or the record's id, not on the cell it
   found the record through: any number of links, in any of the pattern's
   cells, can reach one record;
6. claims the §6.5.3 attempt cell before acting, which an at-most-once
   actuator requires, and refuses an attempt or consumption cell it did not
   write itself. Their addresses are derivable from the record, so other code
   can create them first, as it can a custody box; the custody seal's check
   that a box's root carries its own stamp (`rootWrittenByBuiltin`) is the
   discipline to follow;
7. after the actuator confirms, claims consumption (§6.5.2) and writes the
   §6 sent record ([egress records](cfc-persisted-declassification.md#6-egress-records--irrevocability-made-honest)),
   and only then clears its outbox entry;
8. records a refused outcome for anything it cannot verify, never sending or
   repairing it, and records an ambiguous outcome as unknown, never retrying
   it.

The pattern decides whether a record reaches the consumer, when within its
window, and in what order with others: it can leave the link unwritten, unlink
it, or hold it back, and can show the actor that a message was sent while
suppressing it. A receipt therefore means that the actor released the
parameters, not that anything was sent; what was sent is what the consumer's
sent records say.

## What this does not cover

- **Who made the gesture.** A renderer-trusted event shows that the browser
  delivered a click, not that a person made it: accessibility actions, debug
  click routes, and an agent driving the interface are indistinguishable from
  a hand. This holds for snapshot copies and custody seals as well. The renderer
  and runtime are trusted, patterns are not, and other holders of the user's
  key are out of scope. A native attestation can sit beside `evidence` later.
- **What was rendered at the gesture.** §3.8.1 binds an intent's parameters to
  the rendered state (`renderRef`, `snapshotDigest`). The record binds them to
  the preview the host received, not to what reached the screen.
- **Which surface a click was on.** The operation trusts the host transport to
  pair a click with its own surface's consent; see [What is built](#what-is-built).
- **A runtime that enforces nothing.** A runtime that runs patterns over the
  subject's home space with writer claims unenforced and flow labels not
  persisted can rewrite a committed record, and the stamp survives the write,
  since only a persisted flow label takes a carried stamp away. The guarantee
  holds while every runtime that runs patterns over the subject's home space
  enforces writer claims or persists flow labels. Snapshot copies and custody
  seals rest on the same condition.
- **Retry after a failure.** The consent is in memory and spent by its first
  commit, so a commit that fails, or a host that goes away, needs a new review.
- **A record whose link failed.** The record and its receipt exist, and the
  result cell does not name it, so no consumer finds it. A receipt can so name
  a record that never landed, or one no consumer ever saw; it records a release,
  not a delivery.
- **Long intents.** An intent that outlives the window needs a visible,
  cancellable outbox (§6.4.4), which is not built.
- **The surface's layout.** Whether the surface confirms in a top-layer modal
  dialog, as `cf-share-snapshot` and `cf-custody-seal` do, or inline, where a
  pattern can clip, scale, fade, or cover what it shows, is open, and is the
  component's decision rather than this operation's.

## Open questions for the CFC author

The spec change this proposes, and these questions, get their entry in
[`cfc-spec-changes.md`](cfc-spec-changes.md) in a follow-up change.

1. May a first version ship with destination integrity that a deployment
   chooses the atom for, so that consent to the destination is display-only
   until address books carry robust integrity, or must §3.8.4 integrity be
   strict from the start? The operation enforces whatever builtin's stamp the
   descriptor names, among the builtins it does not know a pattern steers.
2. Ten minutes exceeds §6.4.4's short-intent bound, and §6.4.4 requires a long
   intent to be shown and cancellable. Does the ruling waive both, and does
   removing a record from an outbox count as cancelling it?
3. §8.10.7 treats an attempt marker with no sent record as known not sent. For
   an at-most-once actuator that fails after sending and before recording, that
   outcome is unknown. Should the spec say so?
4. Should the record carry `IntentOnce`'s `audience` field as such?
5. The runner's future-work list places the §6.5 attempt and consumption ledger
   and send-sink destination binding in the runner; this design places them in
   the consumer. Which is right?
6. [SC-53](cfc-spec-changes.md) names `UserSurfaceInput` as what a reader
   consults for a gesture. This design keeps `UserSurfaceInput` for an entered
   value and uses the record for the gesture's authority. Is that split right?
