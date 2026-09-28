# Realm-Crossing Encoding for Fabric Values

This document specifies the wire format used to carry `FabricValue`s between
realms over a structured-clone transport — `structuredClone()` and
`postMessage()`, and a durable store one realm writes for a later one to read
— including the outer envelope and its marker, the tagged form, per-type
encodings, the ownership contract on decode, and what the format refuses.

## Status

Draft formal spec — the realm-crossing counterpart to
[3-json-encoding.md](./3-json-encoding.md).

---

## 1. Overview

This format is built around one kind of boundary: a **self-dealing** one,
internal to a runtime, where whatever encodes a value is what decodes it and
no other party reads what passes between. Nothing crossing such a boundary is
owed interoperability, which is what lets the format be as narrow as it is.

Worker IPC is the case it was written for: a value constructed, handed to a
transport that clones it, decoded on the far side, and discarded. A durable
store that a runtime writes and later reads back is the same boundary with
time in it, on the conditions Section 1.2 states, and is the reason the format
states its requirements of a transport rather than of a mechanism. A value
that crosses to another party, or that must be read through a transport not
meeting Section 1.1, uses the JSON encoding.

Time is what the two instances do not share, and Section 1.2 turns on the
difference. Section 1.1 is what a transport must preserve; Section 2.4 is
what the format declines to offer, namely a payload readable by a build other
than the one that wrote it. Worker IPC closes the gap so completely that the
second never arises. A durable store meets Section 1.1 in full while leaving
the gap unbounded, so its two ends need not be the same build — which is what
Section 1.2's conditions are about, and why a value that must outlive the
build that wrote it belongs in the JSON encoding.

The two formats divide along what their transports carry. JSON reaches a
`string`, so every type JavaScript has and JSON lacks — `bigint`, `undefined`,
the special numbers, bytes — is written out as tagged text, and a `/`-prefixed
key in user data has to be escaped clear of the tags. Structured cloning
carries all of those but `symbol`, and carries them with their types intact, so
most of a value passes through untouched and tagging is reserved for what
genuinely needs it.

Tagging is not the same question as what the transport can carry, and the two
should not be conflated. A `FabricRegExp` is tagged here even though cloning
carries a native `RegExp` perfectly well, because it is a class instance and
reconstructing one is a codec's job under any format.

### 1.1 Transport Requirements

A transport carrying this format must:

1. **Preserve the types this format emits**: `null`, `undefined`, `boolean`,
   `number` (including `-0`, `NaN` and `±Infinity`), `bigint`, `string`,
   `ArrayBuffer`, `CryptoKey`, arrays, and plain objects. A `CryptoKey` must
   arrive with its algorithm, its key type, and its extractability unchanged.
2. **Preserve a sparse array's length and its absent indices**, so that a hole
   crosses as a hole (Section 3.2).
3. **Preserve object reference identity, in both directions.** One object
   referenced from many positions must arrive as one object referenced from
   many positions; and two distinct objects must arrive distinct, however
   equal they look.

The third is load-bearing rather than incidental: Section 2 rests on it
entirely, and on *both* of its halves. A transport that deep-copied naively,
reproducing each reference as a fresh object, would leave a decoder unable to
recognize any tagged form. A transport that interned or deduplicated equal
subtrees would do the opposite and worse: a payload's own array that happened
to equal the marker would be merged with it, and that data would decode as a
tagged form.

**Both failures are silent.** Neither produces a refusal — the first decodes
every tagged form as a plain three-element array, and the second decodes
ordinary data as a tagged value. A transport is therefore something to verify
against this contract before use, not something to try and see.

The structured clone algorithm provides all three.

### 1.2 Self-Dealing Storage

Storage is the self-dealing boundary with time in it: a runtime writes a
value to a durable store and reads it back later, with no other party in it.
`IndexedDB` is the case in hand. What it supplies is Section 1.1, by the same
mechanism worker IPC does — that store serializes with the structured clone
algorithm, so what satisfies those requirements for `postMessage()` satisfies
them here — and Section 1.1 is the whole of what a medium can supply. Whether
a given *use* of that store is self-dealing is a separate question, settled by
the conditions below.

What the time costs is Section 2.4. A durable payload can outlive the build
that wrote it, so a reader must expect that refusal rather than treat it as
unreachable. Three conditions follow, and a use meeting all three stays within
this boundary:

1. **The stored value must be reconstructible from something the store does
   not hold.** This is the condition that decides the question, because it is
   what makes a version bump a cache flush rather than data loss. A use whose
   store holds the only copy of anything is outside this boundary, whatever
   else is true of it, and a medium meeting Section 1.1 does not soften it.
2. **A reader must treat a refused payload as absent**, rather than report it
   as an error. A version bump refuses every stored payload at once, which is
   an expected path and has to be written as one.
3. **A reader must decode strictly.** A lenient decode yields a
   `ProblematicValue` at the root, which is worse here than a miss: it is a
   result that reads as one.

A `CryptoKey` is what this admits that no other format could carry, and
Section 1.1 is also what makes storing one safe: extractability arrives
unchanged, so a key held as a handle is still a handle when it comes back, and
its material was never written down to begin with.

None of this obliges a store to be durable in fact. A browser evicts what it
likes, and a reader built for the refusal in condition 2 is already built for
that.

## 2. The Outer Envelope and the Marker

An encoded value is a two-element array:

```
[marker, tree]
```

`marker` is an object created by the encoder, and `tree` is the walked value.
The same `marker` object appears at slot zero of every tagged form within
`tree` (Section 3).

### 2.1 Detection

A decoder takes the marker from slot zero of the outer envelope and recognizes
every tagged form beneath it by **object identity** — `===` against that
object. Nothing about a tagged form's *shape* distinguishes it from an array the
payload built for itself, and nothing is meant to: an encoded tree contains
ordinary arrays and ordinary objects, and identity alone separates the
encoder's from the payload's.

This is what lets the format do without escaping entirely, where JSON needs
`/quote`, `/object`, and a reserved-key rule (`3-json-encoding.md` Sections 6
and 9). There is no reserved key, no reserved shape, and no user data that
needs rewriting before it reaches the wire.

### 2.2 The Marker

The marker **must be an object**. Identity comparison on a primitive is value
equality, so a primitive marker would be reproducible by any payload holding
the same one, and would mark nothing.

The marker **must be minted per encode call**, and **the encoder must not
retain or reuse one**. It outlives the call inside the outer envelope, which is
the point; what it must not do is survive *in the encoder*, available to a
later call. Two facts together are what make both forms unforgeable from within
a payload:

- It is **younger than the value**. It is created after the value exists, so
  nothing already assembled can hold a reference to it — whatever its author
  has seen of some earlier encoding.
- It is **confined**. It never leaves the encoder until the call returns,
  living only in encoder-private state and in the tagged forms the walk is
  building.

For a value that satisfies the fabric contract, age alone settles it: a
`FabricPlainObject`'s own properties are enumerable data properties, an
accessor-backed one causing rejection (Section 1.5 of
[1-fabric-values.md](./1-fabric-values.md)), so its contents are all in
existence before the walk starts, and none of them can be the marker. **The
confinement requirement is what makes the argument hold without resting on
that.** An encoder is handed values by callers, not by the type system; a value
carrying live code — an accessor that runs mid-walk, after the marker exists —
is outside the model, and confinement means such a value still has nowhere to
read the marker from. It is stated as a requirement rather than left to
inertness because a rule that fails open on out-of-model input is not worth
much.

A marker held across calls fails the first of these. A value may legitimately
contain a subtree of some *earlier* encoding — the code that assembled it is
entitled to whatever it has seen — and a copy-on-write walk carries such a
subtree through unchanged, into a data position. A long-lived marker sitting
there would be read as a tagged form, and user data would decode as a tagged
value.

The marker must itself be an encodable `FabricValue`, for that same reason: a
value holding an earlier call's marker has to encode without complaint, being
ordinary data.

### 2.3 What the Marker Is Not

The marker is **not a secret and not authentication**. Whatever asks for an
encoding is trusted with the result, and whatever receives a payload is trusted
to read it. A hostile peer builds its own marker and forges freely — exactly as
it could always send any tagged value it liked, under any format.

What the marker rules out is *confusion within a payload this encoder
produced*, which is the escaping problem and the whole of what it is for.

### 2.4 Version

The marker is a one-element array holding the version identifier:

```
["fvr1"]
```

`fvr1` is *fabric value, realm encoding, version 1*, in the manner of JSON's
`fvj1:` prefix. Recognition never reads any of it — identity does all the work
— so within the walk the contents serve only to be legible in a debugger.

An encoder freezes the marker it mints, which is an invariant of the sending
side and not a property of the wire: structured cloning reproduces value and
structure, not property descriptors, so the marker a decoder adopts is an
ordinary mutable array. Nothing downstream depends on it being otherwise. A
decoder identifies a marker by shape, version and object identity, and a
conforming one must not require a frozen marker on arrival.

**A decoder must refuse an outer envelope whose marker is not a one-element
array holding the version it implements**, and it performs that check before
adopting the marker. This is the format's answer to a boundary it does not
otherwise control: `postMessage()` spans tabs, windows and frames, any of which
could pair two different deployments, and a payload written by a build the
decoder does not understand is refused rather than walked.

The check earns little across worker IPC, where both ends are the same build
and the marker always matches. It costs one comparison, and it is what makes
adoption safe to state as a rule: without it a decoder takes an arbitrary
object as its marker, every tagged form beneath goes unrecognized, and a
foreign tree decodes as ordinary data instead of being refused.

On a self-dealing store (Section 1.2) it earns everything, and is the whole of
what that use rests on. There a mismatch is expected rather than exceptional:
a payload written before a version bump is refused on the first read after it,
and a reader takes that refusal as a miss. This format offers no reading of an
earlier version's payload and no decoder is obliged to attempt one, which is
why Section 1.2 admits only stores whose contents can be rebuilt.

## 3. Type Encodings

### 3.1 Self-Representing Types

Carried by the transport as themselves, with no tag:

`null`, `undefined`, `boolean`, `number` (including `-0`, `NaN`, and
`±Infinity`), `bigint`, `string`.

Where JSON must tag four of the seven primitive types, this format tags one.
`symbol` is the exception — the transport refuses it outright — so it crosses
under a tag like any other value a transport cannot carry directly.

### 3.2 Plain Containers

Arrays and plain objects are carried directly.

- **Array holes need no representation.** Cloning preserves a sparse array's
  length and its absent indices, so a hole crosses as a hole. There is no
  counterpart to JSON's `/hole` run-length form. **A walk that rebuilds a
  sparse array must leave its holes absent**, on both sides: writing
  `undefined` into them would satisfy the transport requirement in Section 1.1
  and still deliver present-`undefined` where the sender had absence, which
  this system distinguishes. Length is preserved with them, a trailing hole
  having nothing else to record it.
- **Keys are visited in their own order**, not sorted. JSON sorts to make its
  text canonical, which is what lets an encoding be hashed and compared as
  bytes; nothing here is compared that way, and sorting would force a rebuild
  of every object.
- **A `/`-prefixed key is ordinary.** This format reserves no key.

`__proto__` and `constructor` are nonetheless refused on both sides, and that is
a limit of this implementation rather than of the format. The two are refused
for different reasons: `__proto__` cannot be rebuilt by the assignment this
implementation copies records with, while `constructor` copies faithfully and is
refused because boundaries further on drop it. Section 4 of `3-json-encoding.md`
gives the fuller account, which is about the host and so holds for either
format. Like every rule in this section, the refusal applies to a plain
container the walk *traverses*; Section 3.3 says which values those are.

### 3.3 The Tagged Form

A value that a codec claims is encoded as a three-element array:

```
[marker, tag, state]
```

`tag` is the wire type tag (`3-json-encoding.md` Section 2 defines the
`<Type>@<Version>` syntax, which is shared). `state` is the codec's encoded
state — final for a terminal codec, and itself walked for a nonterminal one.

**A terminal state is opaque, and that bounds every other rule here.** The walk
hands it to its codec without descending, so nothing inside one is traversed
and nothing inside one is validated except by the codec itself, reading the
fields it knows (Section 7.1). The reserved-key rule of Section 3.2, the cycle
rule of Section 4, and the refusals of Section 6 all describe values the walk
reaches; none of them reaches into a terminal state. A `Hash@1` state carrying
a `constructor` key or a reference back to itself therefore decodes, because
its codec reads `tag` and `hash` and never looks.

This is what terminality buys and what it costs. A codec that wants its state
examined declares itself nonterminal, and then every rule here applies to that
state, because the walk goes through it.

Three positional slots rather than a record keyed by the tag, because an
array is the cheapest shape the transport carries: no hash table, and a tag
string that is the codec's own constant rather than a key built per tagged
form.

### 3.4 Standard Type Encodings

| Type | Tag | State |
|---|---|---|
| `FabricBytes` | `Bytes@1` | `ArrayBuffer` |
| `FabricHash` | `Hash@1` | `{ tag: string, hash: ArrayBuffer }` |
| `FabricEpochDay` | `EpochDay@1` | `bigint` |
| `FabricEpochNsec` | `EpochNsec@1` | `bigint` |
| `FabricKeyPair` | `KeyPair@1` | `{ algorithm: string, publicKey: ArrayBuffer, privateKey: ArrayBuffer }`, or `{ publicKey: CryptoKey, privateKey: CryptoKey }` |
| `FabricRegExp` | `RegExp@1` | `{ source, flags, flavor }` |
| `FabricUnavailable` | `Unavailable@1` | `{ reason }`, or for reason `error` `{ reason, errorKind }` or `{ reason, errorKind, errorMessage }` |
| `symbol` | `Symbol@1` | `string` (the registry key) |

Bytes travel as a bare `ArrayBuffer` rather than as a view onto one, that being
what `postMessage()` can *transfer*: a caller assembling a transfer list finds
the transferable object in the tree rather than having to reach through a view
and reason about its offset. Both byte-carrying types do this. A bare
`Uint8Array` is therefore not a form this format emits.

Four of these differ from their JSON counterparts in kind rather than in
spelling, which is most of the reason this format exists, and they differ along
two axes.

`FabricBytes` carries bytes as bytes, where JSON must represent them as
base64url text. `FabricRegExp` and `FabricUnavailable` are terminal here and
nonterminal under JSON — concrete proof that terminality belongs to the pair
(class, format) rather than to the class. `FabricHash` differs on **both** axes
at once: terminal here and nonterminal under JSON, and carrying its hash as a
bare `ArrayBuffer` where JSON carries base64url text.

`FabricKeyPair` differs from the others in that its state depends on the value
rather than only on its class. A pair holding key material encodes to two
`ArrayBuffer`s beside the algorithm name; a pair holding `CryptoKey` handles
encodes to those keys themselves, and carries no algorithm, each key naming its
own. A decoder tells the two apart by the type in the key slots.

That second state is the reason this format admits `CryptoKey` at all. A
non-extractable key's material is reachable through no synchronous call and, by
construction, through no call whatever, so a format that writes bytes down
cannot represent one: the JSON encoding refuses a pair in that state (Section 3
of [3-json-encoding.md](./3-json-encoding.md), under `KeyPair@1`) and its hash
is undefined (Section 4.17 of [2-hash-byte-format.md](./2-hash-byte-format.md)).
Here the key crosses as itself, which is what the transport requirement in
Section 1.1 asks for.

Types binding a format-neutral codec — `FabricError`, `UnknownValue`,
`ProblematicValue`, and every `FabricInstance` — encode the same way under both
formats, their state being `FabricValue`s all the way down.

## 4. Cycles and Shared References

Per Section 1.6 of [1-fabric-values.md](./1-fabric-values.md), an engine must
state what it does about each. This format:

- **Refuses cycles**, in both directions, wherever the walk goes — which is not
  into a terminal codec's state (Section 3.3).
- **Preserves a shared reference exactly where nothing beneath it needed
  encoding.**

Neither answer comes from the transport, which would carry either faithfully;
both come from the walk.

The two directions refuse a cycle differently, for the reason they differ
everywhere else. Encoding **raises**: the value is a local caller's, and a
cycle in it is that caller's bug. Decoding **reports**, settled against the
engine's leniency: cloning delivers a cycle faithfully, so one can arrive even
though no conforming encoder emits one — which makes it a malformation like any
other, and something to report rather than to raise on a caller who did nothing
wrong (Section 7.1).

Sharing is preserved by copy-on-write rather than by a memo. A subtree needing
no encoding is returned by identity, so every position that held the one object
still holds it. Where a shared subtree *does* need encoding, each position
rebuilds it independently, and the encoding holds two equal objects where the
value held one — structure a receiver cannot distinguish from two that were
always distinct.

## 5. Ownership

The two directions divide the memory they are handed in opposite ways, and
each is easy to get wrong in a way nothing reports.

### 5.1 Encoding

**An encoded tree shares structure with the value it was built from, and the
encoder freezes none of it.** Copy-on-write is what makes that so: a subtree
needing no encoding *is* that subtree rather than a reconstruction of it, which
is the same mechanism Section 4 credits with preserving shared references. An
instance's encoded state is a snapshot (Section 2.4 of `1-fabric-values.md`),
so what the tree shares is the value's plain containers and whatever its
instances hold by reference.

So a value must not be mutated after it is encoded. A caller that does so
changes the encoded tree, and over a transport that clones on send, changes
what arrives — with nothing raising, because nothing has gone wrong as far as
either side can see. Encode last, or encode a value nothing else is holding.

Only the outer envelope is new on every call. It and the marker are two
allocations; nothing beneath them is rebuilt unless it needed encoding.

### 5.2 Decoding

**A caller cedes the tree to `decode()`.** The decoder retains what it likes of
it, and **a decoded tree carries no guarantee of being usable again**. This is
a promise withheld rather than a prohibition imposed: nothing detects a second
decode or sets out to defeat one, and whether a given tree survives depends
entirely on what it happened to carry. A caller that reuses one is relying on
the shape of its own data, not on anything stated here.

Two retentions are deliberate:

1. A subtree needing no decoding is returned by identity rather than rebuilt.
2. A byte-carrying value **takes over** the `ArrayBuffer` it arrived in rather
   than copying it.

**Every container a decode returns is frozen**, retained and rebuilt alike.
Stating it of the result rather than of what is retained is deliberate: an
implementation that rebuilt everything would retain nothing, and a rule phrased
around retention would then oblige it to freeze nothing and let it hand back
mutable values. Which containers a caller sees returned by identity therefore
varies with what needed decoding; whether any of them is mutable does not.

An engine constructed with `mutable` as `true` (`1-fabric-values.md` Section
2.9) freezes none of them instead, and copies a container that needed no
decoding when it arrived frozen, that being the one way to hand it back
mutable. A frozen container can arrive only from a decode in the realm that
built the tree, since cloning produces none.

An `ArrayBuffer` cannot be frozen, which is what makes ceding it a requirement
rather than a courtesy: sole ownership is the only available defense for a
value that promises its bytes are immutable.

**A failed decode consumes the tree as thoroughly as a successful one.** A
refusal can arrive after the walk has already detached a buffer and frozen part
of what it reached, so the guarantee is no better for a call that raised. In
particular, answering a strict refusal by re-running the same tree through a
lenient decoder does not work: the second run finds the bytes gone and reports
a `ProblematicValue` where they had been. Choose the disposition before
decoding, not after.

**A tree carrying bytes is the case where the guarantee definitely fails.**
Taking a buffer over detaches it, so a second decode of such a tree cannot
reconstruct what the first did, and the attempt is settled against leniency
like every other refusal in Section 6: a strict decode raises, and a lenient
one yields a `ProblematicValue` where the bytes would have been. A byte-free
tree happens to survive a second decode today, which is a fact about this
encoding's containers rather than a promise to build on.

On the boundary this format exists for, none of this costs a caller anything —
the tree is the receiver's own clone of a value it will not be handed again,
which is the whole reason the copy can be elided. A caller wanting two readings
of one payload keeps the value it decoded, not the tree it decoded from.

A self-dealing store (Section 1.2) satisfies this the same way and for the
same reason: a read deserializes afresh, so what it hands back is the reader's
own and reading twice means reading the store twice.

## 6. Refusals

A conforming decoder refuses, reporting each as a malformation settled against
leniency:

- An outer envelope that is not a two-element array, or whose slot zero is not
  a one-element array holding the decoder's own version, per Section 2.4.
- A `symbol` or a function found in an untagged position. The transport carries
  neither, so neither can arrive across the boundary — but a decoder is
  callable in the realm that built its argument, and what the format never
  emits is refused wherever it is found.
- Any other value the transport carries but this format never emits: a bare
  `Uint8Array` or `DataView`, a bare `ArrayBuffer` outside a tagged state, a
  `Date`, a `Map`, a `Set`, or any other class instance. `ArrayBuffer` is worth
  naming: it is the one such type this format's own value union contains, and
  it is legitimate only as the state under a byte-carrying tag.
- A key this runtime reserves, per Section 3.2, in a plain container it
  traverses.
- A tag that is not syntactically a tag, per Section 9 of
  [3-json-encoding.md](./3-json-encoding.md), whose tag syntax this format
  shares.
- A cycle, per Section 4, among the values it traverses.

A tag that is *syntactically* a tag but that no codec claims is not a refusal:
it becomes an `UnknownValue` and round-trips, exactly as under JSON
(`3-json-encoding.md` Section 8).

## 7. Codec Engine Responsibilities

The realm codec engine is responsible for:

- Minting a marker per `encode()` call, per Section 2.2, and building the
  outer envelope around the walked tree.
- Adopting the marker from the outer envelope's slot zero on decode, after
  validating that envelope's shape and the marker's version per Section 2.4 —
  the one place the decoder takes instruction from the data it is reading.
- Owning recursion and tag-wrapping around the shallow per-type codecs, as the
  JSON engine does (`3-json-encoding.md` Section 7): tags come from
  `codec.tagForValue(value)` on encode, and decode routes each tag to its
  registered codec.
- Re-wrapping unknown types using the per-instance `wireTypeTag` preserved in
  `UnknownValue`, and constructing `UnknownValue` for tags with no registered
  codec.
- Settling a codec's rejection according to leniency, identically to JSON.

There is no escaping step and no stringify step, both of which the JSON engine
carries.

### 7.1 Codec State Validation

**This boundary is not a trust boundary.** Both sides are assumed to run this
same implementation, so what a peer sends is what this format's encoder emits.
A payload is not adversarial input, and Section 2.3 says the same of the marker
from the other direction: it is not authentication, and nothing here defends
against a peer that means harm.

What a peer may be is a **different build**. That is what codec validation is
for.

A codec **validates the state it is handed and rejects what it will not
accept**, rather than coercing it: a `Bytes@1` whose state is a string, a
`Hash@1` whose `tag` is not a string, a `Symbol@1` whose state is not a string
— each is a malformation, settled against leniency like any other, and never a
value built from whatever arrived. Such a state means the two ends disagree
about the type, which is a version difference or a bug, and either way is
something to report rather than to guess at.

This is a requirement rather than an observation. An implementation that
coerced instead would satisfy every other claim in this document while
producing values a sender never sent.

**Do not guard against shapes the transport cannot deliver.**
`structuredClone()` normalizes what it carries: a plain object arrives with
`Object.prototype` however its original was made, an `Array` subclass arrives as
a plain `Array`, and an accessor arrives as a data property. A check for a
null-prototype record, an exotic array, or a getter-backed index is therefore
unreachable, and reads to a later maintainer as though the boundary defended
against something it does not.

What the transport *does* carry faithfully is an array's extra own properties,
which arrive intact. Nothing here emits one, which is what rules them out --
the assumption at the top of this section, and the one place it does load-
bearing work.

**A field of a codec's state that the codec does not read is ignored, not
refused.** A state is matched by what it must carry, so a record arriving with
more than that decodes as though the extra were absent. Two implementations
would otherwise be free to disagree — one ignoring, one refusing — over data
that cloning carries perfectly well and that a peer can send.

**An absent field is not the same as one present holding `undefined`.** Where a
codec gives a field a default, the default applies to a field that is *absent*;
a field that is present and not of the type the codec requires is a
malformation, `undefined` included. The distinction is worth stating because
this format carries `undefined` directly, so unlike under JSON a peer can send
one on purpose — and defaulting it would silently answer a question the wire
did ask.

`RegExp@1` is the codec this reaches. All three of its fields default: `flavor`
to `es2025`, and `source` and `flags` to the empty string, so `{}` decodes to
an empty `es2025` pattern. That is what lets a narrower encoder omit what it
has nothing to say about. `{ source: undefined }` is refused, being a `source`
that is present and not a string.

`Unavailable@1` has the same distinction on its two optional fields. An absent
`errorKind` is the state of a transient reason and an absent `errorMessage`
that of an error with no stored message; `{ reason: "error", errorKind:
undefined }` and `{ reason: "error", errorKind: "sync", errorMessage:
undefined }` are refused, each being a field that is present and not a string.
