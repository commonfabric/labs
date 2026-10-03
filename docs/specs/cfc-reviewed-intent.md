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
create-only record, written under a builtin identity no pattern can take, that
the acting application verifies before it acts.

The host module is `packages/runner/src/cfc/reviewed-intent.ts`, exported to
hosts as `@commonfabric/runner/cfc/reviewed-intent` and absent from pattern
imports, the same arrangement as
[reviewed snapshot copies](cfc-persisted-declassification.md#31-reviewed-snapshot-copies)
and [sealed custody](cfc-custody-seal.md). The cases are in
`packages/runner/test/cfc/reviewed-intent.test.ts`.

## What is built

The runner operation is built: the descriptor, prepare and commit, the record,
the receipt, the consent registry, and the check a consumer runs on a record.
The `cf-reviewed-intent` component, which draws the surface and makes the
gesture, and the runtime-client calls that connect it to this operation are not
built yet; they are the next change. The operation's commit accepts only the
gesture mark that host transport attaches, so nothing reaches it until then.

## The descriptor

The application that acts on records (the consumer) publishes a descriptor in a
cell, and a pattern binds that cell. For a messaging consumer:

```json
{
  "operation": "send-message",
  "endpointName": "Example Messenger",
  "consumer": "example-messenger",
  "parameters": {
    "to": { "kind": "destinations", "min": 1, "max": 1 },
    "body": { "kind": "text", "maxLength": 4000 }
  },
  "destinationIntegrity": ["verified-address"],
  "windowMs": 600000,
  "maxAttempts": 1
}
```

- `operation` is what a record authorizes, `endpointName` is how the surface
  names the way the intent is carried, and `consumer` names the application that
  acts on records.
- `parameters` are the only keys a record carries. A `destinations` parameter
  takes between `min` and `max` destination cells the pattern binds. A `text`
  parameter is text the actor enters on the surface, at most `maxLength`
  Unicode code points, counted as JSON Schema counts them.
- `destinationIntegrity` is a list of atom patterns that every destination's
  stored integrity must satisfy together, as one conjunction whose variables
  are shared across the patterns. It must be nonempty when any parameter is of
  kind `destinations`.
- `windowMs` is how long after the gesture a record stays good. A record takes
  the smaller of this and ten minutes.
- `maxAttempts` bounds the delivery attempts a consumer makes on one record.

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

A record carries the descriptor's data-model digest as `endpoint`
(`reviewedIntentEndpoint`). The operation does not check who wrote the
descriptor: a consumer acts only on records whose `endpoint` is the digest of
the descriptor it publishes, so a descriptor a pattern wrote, with a weaker
integrity requirement or a misleading `endpointName`, yields records no
consumer acts on.

## The operation

`prepareReviewedIntent(bindings)` takes the cells a pattern binds: the
`descriptor`, the `destinations` for each declared `destinations` parameter,
and a `result` cell that receives the committed record's link. Under the
authenticated acting principal it:

- refuses an actor that is not an authenticated DID, and cells from different
  runtimes;
- reads the descriptor and refuses one this build cannot show;
- refuses a destination bound for a parameter the descriptor does not declare
  as `destinations`, and a number of destinations outside `min` and `max`;
- reads each destination where its cell resolves, as stored. What the surface
  shows of a destination is that stored value and nothing else, never a string
  the pattern supplies. A value holding a link is refused rather than followed,
  because the destination's integrity covers its own document and not one it
  links to; so is an absent or `null` value;
- requires the integrity stored on the whole of each destination's value, from
  label entries at or above its path other than entries a link carried, to
  satisfy `destinationIntegrity`, and keeps the atoms the patterns name;
- checks the host's read ceiling, or else `User(actor)`, over everything it
  read. The surface shows what it shows outside the render policy, so this is
  the only gate on what it may show;
- resolves where a write to `result` lands, and refuses a target inside a
  reviewed intent;
- returns a frozen preview, with a one-use consent bound to the preview, the
  reads, and the actor.

The preview carries the actor, the descriptor's `operation`, `endpointName`,
`consumer` and digest, each `destinations` parameter as the record will carry
it, each `text` parameter's `maxLength` for the field the surface draws, the
effective window, and `maxAttempts`. The consent is an opaque object verified
against a private registry; a host holds it while the surface is open.

`commitReviewedIntent(consent, event, input)` commits. It spends the consent
first, so a consent is good for one attempt, successful or not. It accepts only
a renderer-trusted DOM event whose `provenance.ui.pattern` is `ReviewedIntent`.
`input.text` must hold the text for every declared `text` parameter and nothing
else, each within its `maxLength`. The commit then reads everything again and
refuses a review whose actor, descriptor, destinations, destination addresses,
or result target changed. The record's transaction compares each read the
second inspection made against what it reads itself, through verifier reads
that keep their conflict checks without carrying a label into the record, so
the destinations reviewed are the destinations written.

## What a commit writes

A transaction writes one space, and the result cell may be in another space
than the actor's home space, so the commit writes in three transactions:

1. **A receipt in the actor's home space**, `{record, payloadDigest, at}`,
   where `record` is the record's document id. It is written first, so no
   record exists without one; a receipt whose record is absent records a
   commit that failed. The user's trail survives a pattern unlinking the
   record.
2. **The record in the actor's home space**, at an address derived from a
   random host event identity, marked create-only.
3. **The record's link into the result cell's write target**, which must be
   the target the actor reviewed. The link is written without the builtin
   identity, so a target in a document that admits only the builtin's writes,
   such as a record or a receipt, refuses it. A record whose link is not
   written is never acted on, and its window runs out.

The record:

| Member | Value |
| --- | --- |
| `operation`, `consumer`, `maxAttempts` | the descriptor's |
| `endpoint` | the descriptor's digest |
| `subject` | the actor's DID; the record lives in the subject's home space |
| `parameters` | each `destinations` parameter as a list of `{address, integrity}`, each `text` parameter as the text entered |
| `payloadDigest` | the data-model digest of `parameters` |
| `idempotencyKey` | unique to the consent, which a consumer keys its attempts on |
| `at` | when the commit wrote the record, in milliseconds since the epoch |
| `exp` | `at` plus the smaller of `windowMs` and ten minutes |
| `evidence` | `{component: "cf-reviewed-intent", event}`, where `event` is the host event identity |

The stored record holds `parameters` as JSON text with sorted keys, a leaf, and
the consumer's check returns it parsed. The runtime stores a plain object
inside an array as a document of its own, so a list of destinations stored as
objects would live in documents the record's root stamp does not cover. Every
other member is a leaf or, for `evidence`, an object of leaves. The record
carries no opaque application payload: an application's own routing data
stays in its own cells, joined to the record by the link.

The record and the receipt declare the confidentiality the preview's reads
consumed, joined with `User(actor)`, so each is readable by the actor and by
nobody the destinations' labels exclude. Both are `writeAuthorizedBy` the
builtin identity `cfc-reviewed-intent`, and the record repeats that claim on
every member and on every member of `evidence`: a writer claim governs the
location it is declared at, not the locations below it.

### Attribution

`TransformedBy` is minted only over a nonempty flow join. The record's
transaction reads the receipt it has just written, its one labeled read, and
the receipt's label always holds `User(actor)`. That read is what stamps every
location the record's transaction writes with
`TransformedBy{builtin cfc-reviewed-intent}`, the root included, the way the
custody seal's anchor stamps a box ([attribution](cfc-custody-seal.md#attribution)).
The receipt is at an unpredictable address the builtin created a transaction
earlier, so unlike an anchor at a derivable address no other code can occupy it
first.

A runtime that does not persist flow labels mints no stamp. The commit checks
the record it wrote the way a consumer would before writing the link, so a
record without the stamp is never linked, and every record a pattern receives
verifies.

## Verifying a record

`verifyReviewedIntentRecord(record, tx?)` is the check a consumer runs before
it acts. `record` may be the record or a cell linking to it, such as the
pattern's result cell. The check, in full:

1. the cell resolves to the root of a document, not a location inside one;
2. that root has a label-map entry of origin `derived` whose integrity carries
   the bare atom `TransformedBy{builtin cfc-reviewed-intent}`;
3. the record has exactly the members above, and its `parameters` text parses
   to a record of text and destination lists whose digest is `payloadDigest`;
4. the document is in the home space of the record's `subject`.

Only the runtime mints a `derived` entry, and only a transaction under the
builtin's identity mints that atom, so pattern code cannot write a record that
passes. A stored `writeAuthorizedBy` naming the builtin is not evidence: a
pattern's own initialization can declare one on a cell it creates. A copy a
pattern writes carries the pattern's own `TransformedBy`, an atom a pattern
declares in its schema is not persisted, and a write into a committed record is
refused by its writer claim at every location. Reads happen in `tx` when one is
given, so a consumer's transaction conflicts with a change to the record.

The check covers authorship and integrity only. At action time the consumer
also:

1. checks that `consumer` is itself, that `endpoint` is the digest of its
   current descriptor, and that `subject` is the principal it acts as;
2. recomputes `payloadDigest` over exactly what it will send, and refuses any
   parameter key its descriptor does not declare;
3. resolves each destination itself and refuses if it differs from
   `parameters` (it never substitutes);
4. checks the window by `exp`, and by its own first sight of the record;
5. claims the §6.5.3 attempt cell before acting, which an at-most-once
   actuator requires;
6. after the actuator confirms, claims consumption (§6.5.2) and writes the
   §6 sent record ([egress records](cfc-persisted-declassification.md#6-egress-records--irrevocability-made-honest)),
   and only then clears its outbox entry;
7. records a refused outcome for anything it cannot verify, never sending or
   repairing it, and records an ambiguous outcome as unknown, never retrying
   it.

## What this does not cover

- **Who made the gesture.** A renderer-trusted event shows that the browser
  delivered a click, not that a person made it: accessibility actions, debug
  click routes, and an agent driving the interface are indistinguishable from
  a hand. This holds for snapshot copies and custody seals as well. The renderer
  and runtime are trusted, patterns are not, and other holders of the user's
  key are out of scope. A native attestation can sit beside `evidence` later.
- **Retry after a failure.** The consent is in memory and spent by its first
  commit, so a commit that fails, or a host that goes away, needs a new review.
- **A record whose link failed.** The record and its receipt exist, the result
  cell does not name it, and no consumer finds it; the trail understates and
  never overstates.
- **Long intents.** An intent that outlives the window needs a visible,
  cancellable outbox (§6.4.4), which is not built.
- **The surface's layout.** Whether the surface confirms in a top-layer modal
  dialog, as `cf-share-snapshot` and `cf-custody-seal` do, or inline, where a
  pattern can clip, scale, fade, or cover what it shows, is open, and is the
  component's decision rather than this operation's.

## Open questions for the CFC author

1. May a first version ship with destination integrity that a deployment
   chooses the atom for, so that consent to the destination is display-only
   until address books carry robust integrity, or must §3.8.4 integrity be
   strict from the start? The operation enforces whatever the descriptor
   declares, either way.
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
