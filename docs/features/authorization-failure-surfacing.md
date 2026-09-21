# Surfacing authorization failures from storage sync

An authorization failure — a client and server disagreeing over an
`EXPERIMENTAL_*` option that trips the ACL, an audience mismatch, or a plain ACL
denial — must reach a caller waiting on storage sync as a real, typed error
rather than a silent absent read or an endless wait. Getting there spans three
layers: the memory protocol classifies the failure, the memory client acts on
that classification during reconnect, the runner storage layer records it per
space, and the callers that reach a particular space surface it. This document
describes how the pieces fit.

## The classification: recoverable versus permanent

The pivot is telling apart an authorization failure a retry can heal from one it
never will. A `session.open` is denied for one of two kinds of reason:

- **Recoverable (retriable).** The connection-challenge and invocation-freshness
  anti-replay checks: an expired, already-used, or mismatched challenge, or a
  stale signed `exp`. Each reconnect runs a fresh `hello` that issues a new
  challenge, so these do not recur — a token-refresh window or a challenge race
  heals on the next attempt.
- **Permanent.** An audience or protocol mismatch, a malformed invocation, or an
  ACL capability shortfall (the principal lacks `READ`, a malformed or ownerless
  ACL, a genesis requirement). The same configuration or ACL state produces the
  same denial every time.

The server marks the recoverable subset with `retriable: true` on the
`AuthorizationError` response (see
[`../specs/memory-v2/04-protocol.md`](../specs/memory-v2/04-protocol.md)); every
other authorization failure is permanent. The marker rides the wire so the
client classifies without parsing error messages. A server that sends no marker
is read as permanent — the safe default for an authorization decision.

## Memory client: terminate rather than loop

`packages/memory/v2/client.ts` acts on the classification during reconnect:

- A **permanent** authorization denial reopening a session terminates just that
  session with the real error, the same way a `session/revoked` does: its
  outstanding commits and caught-up waiters reject with it, and its next watch
  or transact rethrows it. This holds for a denial anywhere in the reopen — the
  `session.open` itself or the watch re-establishment a fresh (non-resumed)
  reopen issues. Sessions for other spaces on the same client keep running: a
  denial on one space is not a client-wide failure.
- A **retriable** authorization race and every transport-level disconnect retry,
  so a transient blip or a fresh-challenge race heals.
- A **server that cannot take declared holdings** (no `sessionHoldings` in its
  hello) terminates a session whose consumer installed a holdings provider, the
  same per-session way: the declaration is what makes skipping the older
  delivery paths safe, so restoring without it would silently reintroduce the
  elision those paths permit (04-protocol.md §4.1.1). A session with no provider
  restores on the declaration-less paths as ever.
- A **permanent protocol-flag mismatch at `hello`** — the peers disagree on a
  data-model wire contract, so no session can open at all — stops the whole
  reconnect loop and is remembered, so every request on that
  fundamentally-incompatible transport fails fast with the real error.

The reconnect loop therefore has no unbounded retry-on-anything path: a
permanent failure ends it (per session for an authorization denial, client-wide
for a handshake mismatch), and only recoverable and transport-level conditions
retry.

`SpaceSession.subscribeAccessLoss` also delivers an authoritative
`AuthorizationError` immediately when an established session loses access. An
`unauthorized` revocation carries that error. A `taken-over` revocation closes
with `SessionRevokedError` and does not emit access loss. Normal close,
disconnect, protocol failure, and a recoverable challenge race do not emit it
either. A late subscriber receives the retained authorization verdict until the
session is replaced successfully.

`StorageManager.subscribeSpaceAccessChange` observes both a new authoritative
denial and its clearance after a successful authorized reopen. Renderers use
this notification to restore retained cells after an explicit regrant and
session replacement. `subscribeSpaceAccessLoss` remains loss-only.

## Runner storage: record it per space, keep the barrier silent

`packages/runner/src/storage/v2.ts` preserves the failure and exposes it without
changing what the sync barrier does:

- `toPullError` keeps a real `AuthorizationError` — its name, message, and the
  `retriable` marker — rather than flattening it to a `ConnectionError`.
  `PullError` admits `AuthorizationError`.
- Each replica holds its current authorization status: a permanent
  (non-retriable) `AuthorizationError` from a watch refresh is remembered, and a
  successful refresh clears it. A transient connection error or a retriable race
  leaves it unchanged, so a blip neither masks nor manufactures a denial.
- `synced()` resolves quietly on a denial, and a per-doc `sync()` reads the doc
  as absent. This is deliberate: a denied read collapses to a silent absent
  value, so a denied CROSS-SPACE link — a pattern that reads data in a space the
  viewer cannot access — does not fail the reader. The global sync barrier
  aggregates every open space, so rejecting there would fail a whole runtime
  settle on one incidental unauthorized link.
- `StorageManager.authorizationError(space)` returns the remembered, throwable
  error for a SPECIFIC space, or undefined when it is authorized. A caller that
  must reach a particular space reads this after `synced()` and surfaces it
  deliberately, so the denial is scoped to the space the caller asked for and
  never leaks onto an unrelated cross-space read.

The storage provider exposes `subscribeSpaceAccessLoss` and `spaceAccessError`
for consumers of already-rendered cells. An authoritative session loss updates
the affected space immediately, without waiting for another document watch. An
explicit successful session replacement after a new grant clears the old
verdict. The runtime client forwards `spaceaccesslost` with the affected space;
it does not send the server's diagnostic error text to the UI.

The worker renderer subscribes at cell boundaries. Revoking a foreign target
removes that target's content and event handlers while retaining the authorized
Loom root and sibling panels. Revoking the root removes its rendered content.
Subscription teardown also cancels pending render callbacks so they cannot
restore a removed subtree. Transient transport errors preserve the mounted
content and do not masquerade as revoked authority.

## CLI: surface the denial for the space it was asked to reach

The CLI reads `storageManager.authorizationError(space)` for the one space it
operates on and throws the real `AuthorizationError` when it is set, at three
places, and none uses a wall-clock guard. They differ in what establishes the
verdict first:

- `loadPieces` authenticates the space session when the connection opens
  (`ensureSpaceSession()`), then checks. It does not sync the space cell: by
  default the space record stays unread until an operation addresses it, so a
  denial surfaces from the session open itself. A caller that passes
  `deferSpaceCellSync: false` gets the older eager `synced()` before the same
  check.
- The ACL operations check after the ACL read or write, since that access is
  what pulls the space and records the verdict.
- The headless wish read checks after its own space's sync, and reads only that
  space, so a denied cross-space profile load stays the expected "no profile
  yet" absent read.

The `newPiece` 60-second bound is unrelated and remains. That hang is a
scheduler `idle()` park in `getResult(piece).pull()` waiting for a pattern to
quiesce — a different mechanism this signal does not cover.

## Connecting a controller: one check for every client that opens a space

`PiecesController.initialize` builds a client runtime over a deployed API and
returns a controller for one space. It opens that space's session, reads
`storageManager.authorizationError(space)`, and throws what it finds, so a
caller reaching a space this way does not write the check itself. The FUSE
mount, the agent harness's Fabric session, and the integration suites'
controllers all connect through it.

## Scope and trade-offs

The reconnect classification governs reconnection for **every** memory client —
shell, toolshed, the background piece service, and the CLI — not only the CLI. A
permanent authorization failure terminates with a typed error, and the holder is
expected to surface or recover from that error.

Two properties follow from terminating rather than looping:

- **No in-process auto-heal after a later grant.** A terminated session does not
  reopen on its own, so a holder that wants to pick up an ACL granted moments
  later recreates the session (or the storage manager). Retrying a denied reopen
  until an administrator acts is the retry-loop the engineering principles
  forbid; the CLI reports the error and exits. A genuinely transient or
  recoverable condition — a token-refresh window, a challenge race, every
  transport blip — still heals, because it is classified retriable.
- **A wedged-but-reachable backend still waits.** With no wall-clock guard, a
  backend that completes the handshake but then never answers the authenticated
  sync (and never closes the transport) leaves `synced()` waiting with no event
  to terminate it — the same liveness gap the builtins and the scheduler share,
  not specific to authorization. A backend that is simply down is caught
  earlier: the CLI's `healthCheck()` probe fails first. A wall-clock bound here
  would again fail a legitimately slow but healthy sync, so the liveness signal
  belongs in the transport layer.
