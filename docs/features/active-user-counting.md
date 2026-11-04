# Counting Active Users

What signal the server offers for counting active people, and the assumption any
such count rests on.

## Identities Are Not People

The home space DID and the identity DID are the same value, so home spaces and
identities are one-to-one by construction. That equality is described in
[`docs/common/conventions/HOME_SPACE.md`](../common/conventions/HOME_SPACE.md).

An identity is a keypair, not a person. There are no accounts, so the system has
no way to know that two identities belong to the same human, or that one
identity is driven by several humans or by automation. Counting people therefore
assumes that one identity DID stands for one human. That assumption is a
deliberate approximation, not something the system enforces, and it is wrong in
three known ways:

- **One human, several identities.** The browser derives its identity with
  `Identity.fromMnemonic()`, while `cf id derive` uses
  `Identity.fromPassphrase()`, so the same input yields different DIDs. A second
  browser profile, a passkey on another device, or a fresh `cf id new` key each
  mint another identity. Each one adds to a count of people.
- **Several actors, one identity.** One key imported into the browser, the CLI,
  a FUSE mount, and a browser-driving agent is the recommended local workflow,
  and all of those actors count as a single identity. The publicly derivable
  `implicit trust` identity collapses every caller that derives it into one
  principal. See [`shared-identity.md`](shared-identity.md).
- **Principals that are not people.** The toolshed server identity, the DIDs
  listed in `MEMORY_SERVICE_DIDS`, and background services act as principals in
  the same way a user does. Exclude them explicitly when counting people.

A count of distinct identity DIDs measures active identities. Treat it as a
proxy for active people that is only as good as the assumption above.

## How The Server Learns The Identity DID

The memory server does not have to derive or look up the home space DID, because
the identity DID already is the home space DID.

When a client opens a memory session it sends a signed `session.open`
invocation. The server verifies the signature and returns the issuer DID, which
becomes the session's `principal` (`runtime/memory/v2/server.ts`,
`openSession`). The principal is held on the session state and is fixed for the
life of the session: resuming a session under a different principal is rejected
(`runtime/memory/v2/session-registry.ts`, `SessionRegistry.open`). The value is
established by signature verification, so it is not something a client can
assert on its own.

## The Available Signal

Tracing produces nothing unless `OTEL_ENABLED` is set. It defaults to false
(`runtime/toolshed/env.ts`), and both the tracer provider and the HTTP
middleware are gated on it (`runtime/toolshed/lib/otel.ts`,
`runtime/toolshed/lib/create-app.ts`). While it is unset the tracer is a no-op
and none of the spans below exist, so enabling it on a deployment is a
precondition for counting anything there.

Two memory spans carry the session principal as a `user.did` attribute,
alongside `space.did`:

- `memory.transact`, on every write.
- `memory.subscriber.sync`, on session resume and on write-driven fanout.

Both spans are exported through the OTLP collector
(`runtime/toolshed/lib/otel.ts`). Privileged first-party HTTP routes also
record the verified caller: the auth middleware stores it on the Hono context as
`verifiedUserDid` and sets the same `user.did` span attribute
(`runtime/toolshed/middlewares/first-party-http-auth.ts`). Most other HTTP
routes are unauthenticated and carry no user attribution at all.

## The Signal Does Not Cover Readers

`syncSessionForConnection` is reached from two places. `openSession` calls it
only when the session is resumed rather than freshly opened. `refreshDirty`
calls it from the fanout path, which runs after a commit has made the space
dirty. Opening a session emits no span of its own, and `watchSet`, `watchAdd`,
and query handling emit none either.

An identity is therefore attributed only when it writes, when it resumes a
session, or when it is connected to a space that somebody else writes to. A
session that opens fresh, reads a quiet space, and leaves emits no `user.did` at
all. A count of distinct `user.did` per day is a count of identities that wrote
or were present for someone else's write, and it undercounts readers by a margin
that depends on how much writing happened. A quiet day can report zero while
real people were present.

Attributing readers needs instrumentation that does not exist yet. The natural
place for it is `session.open`, which is where an identity is verified and where
the intent to be active is expressed.

## Properties Of The Signal

- **Trace sampling changes the meaning of the count.** `OTEL_TRACES_SAMPLER`
  defaults to `always_on` with `OTEL_TRACES_SAMPLER_ARG` of `1.0`
  (`runtime/toolshed/env.ts`), and nothing in the repository overrides them, so
  a deployment samples everything unless its environment says otherwise. Head
  sampling below 1.0 does not scale a distinct count the way it scales a volume
  metric, because an identity whose few spans are all dropped leaves the count
  entirely, and the loss cannot be corrected afterwards. `samplerFromEnv` falls
  back to `always_on` for an unknown sampler name and to a ratio of 1 for a
  malformed argument (`runtime/toolshed/lib/otel-sampler.ts`), so the count
  degrades only through a deliberate, valid ratio sampler.
- **Readers are missing entirely.** See the section above. This is the largest
  known error in the count, and unlike the others its size is not knowable from
  the count itself.
- **Sessions with the `"*"` principal are omitted.** The attribute is set only
  for a concrete principal.
- **Span retention bounds the lookback.** Traces are a rolling window rather
  than a record, and the retention period is a property of the trace store
  rather than of this repository. History beyond that window exists only if
  something aggregates and stores it as it goes.

## Traces Are A Poor Substrate For This Number

Three of the properties above have the same root: the count is derived from
traces, and traces are built for debugging rather than for record-keeping. They
are sampled for cost, they exist only where instrumentation happened to be
placed, and they are deleted on a retention schedule that no commit governs.

A count that has to be correct, complete, and durable wants a signal with the
opposite properties: emitted once per session open, never sampled away, and
aggregated into storage that outlives the trace window. Adding a span at
`session.open` fixes the coverage gap on its own, but it leaves the count riding
on sampling and retention. Treat trace-derived counting as a way to learn the
shape of the number, not as the mechanism to keep reporting it.
