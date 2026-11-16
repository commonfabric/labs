# Counting Active Users

What signal the server offers for counting active people, how it decides which
person a memory session stands for, and what the resulting count can and cannot
tell apart.

## Identities Are Not People

The home space DID and the identity DID are the same value, so home spaces and
identities are one-to-one by construction. That equality is described in
[`docs/common/conventions/HOME_SPACE.md`](../common/conventions/HOME_SPACE.md).

An identity is a keypair, not a person. There are no accounts. The only way the
system learns that two identities belong to the same person is a delegation
from one to the other: a UCAN chain, described in
[`docs/specs/profile-delegation.md`](../specs/profile-delegation.md), that one
identity signs to let another key act under its grant. The server uses that
link, and the other facts it holds about a session, to decide which person the
session stands for. The next section says how.

That decision still rests on the assumption that an identity that nobody linked
to another one stands for one person. The assumption is wrong in three known
ways:

- **One person, several unlinked identities.** The browser derives its identity
  with `Identity.fromMnemonic()`, while `cf id derive` uses
  `Identity.fromPassphrase()`, so the same input yields different DIDs. A second
  browser profile, a passkey on another device, or a fresh `cf id new` key each
  mint another identity. Unless the person delegates from one to another, each
  one counts as a separate person.
- **Several actors, one identity.** One key imported into the browser, the CLI,
  a FUSE mount, and a browser-driving agent is the recommended local workflow,
  and all of those actors count as a single person. The publicly derivable
  `implicit trust` identity collapses every caller that derives it into one
  principal. See [`shared-identity.md`](shared-identity.md).
- **One person delegating to another.** A chain from Alice to Bob's key makes
  the sessions Bob opens with it stand for Alice. Bob's sessions under his own
  grants still stand for Bob, so this changes a daily count only on a day when
  Bob used nothing but Alice's delegation.

## Who A Session Stands For

When a client opens a memory session it sends a signed `session.open`
invocation. The server verifies the signature and returns the issuer DID, which
becomes the session's `principal` (`runtime/memory/v2/server.ts`,
`openSession`). The principal is fixed for the life of the session: resuming a
session under a different principal is rejected
(`runtime/memory/v2/session-registry.ts`, `SessionRegistry.open`). The value is
established by signature verification, so it is not something a client can
assert on its own.

The server decides the person a session stands for from that principal and from
what else the open established (`Server.#decidePerson`):

1. **Some sessions stand for nobody.** These are a serving loop's own sessions
   (`SessionState.servingOwn`), and sessions whose principal is not a person's
   identity, as the third rule defines it. A serving loop's own sessions are
   the sessions from the process that holds the memory server, sessions that
   declare the serving binding to act as a space's owner, and sessions that
   declare that they are not demand, as toolshed's own runtime does. A client
   makes that last declaration about itself, so a client can leave itself out
   of the count.
2. **Every other session stands for the first person's identity along its
   proof chain**, its issuers root first and then its principal. A session
   with no chain stands for its principal. A profile space owns itself and
   delegates to its creator's identity, so a chain from a profile to Alice
   stands for Alice, and so does a chain that continues from Alice to an
   agent's key. A chain from Alice's home space, whose DID is Alice's
   identity, to an agent's key also stands for Alice.
3. **These are not people's identities:** the `*` principal, service principals
   (`MEMORY_SERVICE_DIDS`), delegating principals (the server's own identity
   when server execution is on), and a space's own key on the space it names,
   unless that space is a Home space or has history and no access list. Every
   space's genesis is committed by a session signed with the space's own random
   key, which is then destroyed, and that key is not a person. A Home space's
   DID is its person's identity. A space is a Home space when its access list
   names the space itself `OWNER` and it declares no kind (`Server.#isHome`),
   the same test that refuses to delete one. A space with history and no access
   list predates access lists, and its own key is taken to be its person's.

The decision is made when a session opens, and again for every session on a
space whenever that space's access list changes, so the genesis commit that
makes a space a Home space is attributed to its person.

## The Available Signal

Tracing produces nothing unless `OTEL_ENABLED` is set. It defaults to false
(`runtime/toolshed/env.ts`), and both the tracer provider and the HTTP
middleware are gated on it (`runtime/toolshed/lib/otel.ts`,
`runtime/toolshed/lib/create-app.ts`). While it is unset the tracer is a no-op
and none of the spans below exist, so enabling it on a deployment is a
precondition for counting anything there.

Three memory spans carry the person a session stands for as an `enduser.id`
attribute, alongside `space.did` and the session principal as `user.did`:

- `memory.session.open`, on every admitted open, fresh or resumed;
- `memory.transact`, on every write;
- `memory.subscriber.sync`, on session resume and on write-driven fanout.

A session that stands for no person carries no `enduser.id`, and a session of
the `*` principal carries no `user.did` either. All three spans are exported
through the OTLP collector (`runtime/toolshed/lib/otel.ts`). A count of
distinct `enduser.id` values per day is a count of the people who, that day,
opened a memory session, wrote through one, or were sent an update on one,
readers included. A session held open across midnight with nothing written to
its space the next day appears on the day it opened only.

Privileged first-party HTTP routes also record the verified caller: the auth
middleware stores it on the Hono context as `verifiedUserDid` and sets the
`user.did` span attribute
(`runtime/toolshed/middlewares/first-party-http-auth.ts`). Those routes set no
`enduser.id`. Most other HTTP routes are unauthenticated and carry no user
attribution at all.

## Properties Of The Signal

- **Trace sampling changes the meaning of the count.** `OTEL_TRACES_SAMPLER`
  defaults to `always_on` with `OTEL_TRACES_SAMPLER_ARG` of `1.0`
  (`runtime/toolshed/env.ts`), and nothing in the repository overrides them, so
  a deployment samples everything unless its environment says otherwise. Head
  sampling below 1.0 does not scale a distinct count the way it scales a volume
  metric, because a person whose few spans are all dropped leaves the count
  entirely, and the loss cannot be corrected afterwards. `samplerFromEnv` falls
  back to `always_on` for an unknown sampler name and to a ratio of 1 for a
  malformed argument (`runtime/toolshed/lib/otel-sampler.ts`), so the count
  degrades only through a deliberate, valid ratio sampler.
- **Keys the server is not told about count as people.** An automation key
  that is not a service principal, and does not open its sessions as a serving
  loop, is indistinguishable from a person's key.
- **Span retention bounds the lookback.** Traces are a rolling window rather
  than a record, and the retention period is a property of the trace store
  rather than of this repository. History beyond that window exists only if
  something aggregates and stores it as it goes.

## Traces Are A Poor Substrate For This Number

Two of the properties above have the same root: the count is derived from
traces, and traces are built for debugging rather than for record-keeping. They
are sampled for cost, and they are deleted on a retention schedule that no
commit governs.

A count that has to be correct and durable wants a signal with the opposite
properties: never sampled away, and aggregated into storage that outlives the
trace window. The `memory.session.open` span is emitted once per open, which is
the right granularity for such a signal; feeding it to an aggregate that
outlives traces is the step that remains. Treat trace-derived counting as a way
to learn the shape of the number, not as the mechanism to keep reporting it.
