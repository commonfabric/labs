# The key of the event a handler handles

A handler can run more than once for one event. A commit that loses a conflict
is retried with the same event, and under server execution the client runs the
handler as a speculative echo before the serving runtime runs it for real.
Anything the handler makes up with `Math.random()` comes out different on each
of those runs, so a request id minted that way cannot tell a retry from a new
request, and a record it names is written at one address by the echo and at
another by the served run.

`eventKey()`, exported to patterns through the `commonfabric` module, returns a
string that is the same on every run of one event. It is distinct per durable
event id, actor and stream, and so different for every other event except one
that re-admits the same id, which the section on re-admission below covers. A
handler uses it as an idempotence key, or as the id of what the event creates. This document says what the key is derived from, what changes
it, how far it can be trusted, and why it is available only in a handler.

"Handler" here means any event handler a pattern defines, `action()` included.

## What it is

Each event has a durable event id, minted by the runtime when the event is sent
and carried unchanged by every run of that event
([events, §1](../specs/server-side-execution/events.md#1-the-event-as-data)).
The event key is derived from it:

```text
"evk:" + hashStringOf({ actor, event, stream })
```

- `event` is the durable event id.
- `actor` is the principal the handler acts for, as
  `Runtime.actingPrincipalFor()` decides it: the runtime's own user on a
  client, and the acting user stamped on the run's wave context on a serving
  runtime. [The principal a handler acts for](current-principal.md) covers
  where that comes from.
- `stream` is the link of the stream the handler is registered on: its id,
  path, scope and space.

`deriveEventKey()` in `packages/runner/src/scheduler/event-identity.ts` computes
it, once per handler run, when the runner pushes the handler's frame
(`packages/runner/src/runner.ts`), beside the frozen event time the handler's
clock reads. `eventKey()` (`packages/runner/src/builder/event-key.ts`) returns
what that frame holds.

## What changes it

The key is the same for:

- every run of one event on one runtime, a conflict retry among them;
- the client's echo of an event and the serving runtime's run of it, which see
  the same event id, the same actor and the same stream;
- two runtimes in two processes, given the same three inputs, because the hash
  is a content hash.

It differs for:

- a second gesture, which is a new event with a new id;
- an Attention Retry, which appends a new event marked `retryOf` the original
  ([events, §5](../specs/server-side-execution/events.md)). The original never
  ran, so the retry is a new request, not a second run of the old one;
- one event id reaching two streams;
- one event id sent by two actors.

### Re-admission of the same id

A stream refuses an append whose event id matches an entry it has not yet
handled, but once its watermark has passed that entry, the same id is admitted
again as a new entry. Sent by the same actor to the same stream, that entry
derives the same key as the first one, and so do the ids of the cells its
handler creates, which derive from the raw event id.

A handler that keys a record on `eventKey()` therefore finds, on a re-admitted
event, the record the first handling made. For an idempotence key that is the
point: the re-admission reads as the repeat it is. For a record address it
means the address is not guaranteed fresh. Create the record only if it is
absent, and never overwrite one found there as though the event were new.

### A handler called directly

A handler called directly, with no dispatched event behind it, has no durable
id. It gets a fresh random one, the same one the handler frame's cause uses, and
so a key that no other run shares.

## Why the actor and the stream are in it

The durable event id is readable by anyone who can read the stream, and once a
stream has handled an event, the same id can be appended to it again as a new
event. If the key were the id alone, a principal who copied another's id could
make a handler see the victim's key, and find the victim's request already
recorded, or answer for it. With the actor bound in, a copied id yields a key
of the copier's own.

The stream is bound in for the reason `scopeCallerEventId()`, beside
`deriveEventKey()`, binds it: two handlers that receive one id, whether a caller reused an
invocation id across two verbs or a cascade reaches both, are two events to
those handlers.

A served run that no principal sent binds `null` as its actor. The hash is
type-tagged, so `null` equals no DID. In particular it is not the serving
runtime's own identity: that identity is not the actor of such a run, just as
`currentPrincipal()` returns `undefined` there rather than naming it.

The cells a handler creates, and the address of its receipt, derive from the
raw event id and the handler's bindings, not from the event key, so the actor
does not reach them.

## How far it can be trusted

The key is unlabeled runtime output, and it carries no trust. It says that one
event is one event, and nothing more: not who sent it, and not that a person
asked for anything. Those are `currentPrincipal()` and a trusted gesture.

- Nothing in the event's payload reaches the derivation. A payload field named
  `eventKey`, `eventId` or `firedAt` changes nothing.
- On a client, the client's own runtime computes it, and a modified client can
  make its echo compute anything. A served run computes it from the event id
  the store holds and the actor the memory server stamped, which a client does
  not choose.

Publishing a key reveals nothing about the event beyond its identity. The raw id
can carry a transaction's random key and a send counter, or a caller's hashed
session, and the hash hides both.

## Why only in a handler

`eventKey()` throws in a pattern body, a `computed()`, and a `lift()`. None of
them runs because of an event, so none has an event to name, and a value that
differed per run would make a reactive computation non-idempotent, which is why
`Math.random()` throws there too.

## Tests

`packages/runner/test/event-key.test.ts` covers the key in handlers the
scheduler dispatches — derived from the dispatched id whatever the payload
names, distinct across two events and across two streams, and stable across a
conflict retry — and across runtimes: the same on two runtimes for the same
inputs, different for another actor sending the same id, and bound to no
principal on a served run with no actor. It also covers a handler called
directly, and each kind of frame the function refuses. The `eventKey()` case in
`packages/runner/test/executor-events-down.test.ts` sends an event through the
live serving loop and compares the client echo's key with the served run's. The
derivation itself is covered in
`packages/runner/test/scheduler-event-identity.test.ts`.
