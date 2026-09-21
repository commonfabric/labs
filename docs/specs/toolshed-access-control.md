# Toolshed Access Control

## Current Model

Toolshed has public routes, browser shell routes, storage routes, external
callback routes, and local privileged HTTP routes.

This document covers local privileged HTTP routes. These routes let a caller use
server-held authority. That authority may be provider API keys, local runtime
authority, toolshed service storage, or a sandbox command runner.

First-party local callers authenticate with the same user DID key that the shell
and runtime use for the logged-in user. The caller attaches a request proof. The
server verifies the proof before it starts privileged work. The verified DID is
stored on the Hono context as `verifiedUserDid` so handlers can log it and use it
for later moderation and audit work.

## Protected Now

These routes require a first-party HTTP request proof:

- `POST /api/agent-tools/web-search`
- `POST /api/agent-tools/web-read`
- `POST /api/sandbox/exec`
- `POST /api/ingest-channels/{mint,list,rotate,revoke}`
- `POST /api/inbox/{enable,status,send,list,get,acknowledge}`

The first three were selected because first-party code calls them through the
fetch builtins, and each route spends server-held or local runtime authority.
`web-search` uses the AI gateway. `web-read` uses the Jina key. `sandbox/exec`
uses the sandbox service to run commands.

The ingest-channel control plane is different in kind, and is the first route
family to close the authorization half of the gap described below. It does not
merely authenticate the caller: it takes the verified DID and requires an
explicit `OWNER` grant for it in the target space's ACL document before minting
anything (`packages/toolshed/lib/space-authority.ts`). It is called by `cf
ingest`, not by a fetch builtin, so its paths are deliberately **not** in
`PROTECTED_TOOLSHED_FIRST_PARTY_ROUTES` — adding them would let any pattern mint
a channel with the user's authority and read the one-time token back, which
needs the `cf-secret-viewer` treatment webhooks use. All four verbs are POST so
that remains possible later. See
`docs/features/self-serve-ingest-channels.md`.

The protected routes do not expose wildcard CORS. Same-origin shell calls do not
need CORS. Cross-origin callers must not get a credentialed wildcard surface for
these routes.

The [DID inbox](../features/did-inboxes.md) routes authenticate each sender and
restrict private reads and acknowledgments to the recipient signer. They are
not in the pattern fetch signer allowlist.

## Request Proof Format

The implementation uses a CommonFabric-specific first-party request proof. It
does not use the RFC 9421 header names or vocabulary. This keeps the local
format separate from a future RFC 9421 implementation.

The custom headers are:

- `CF-Request-Auth`
- `CF-Request-Proof`
- `CF-Request-Body-SHA256`, when the request has a body
- `CF-User-DID`

The request proof covers:

- HTTP method
- HTTP authority
- Path, including the query string
- `CF-Request-Body-SHA256`, when the request has a body
- `CF-User-DID`
- Issue time, valid-until time, proof DID, and proof kind

The `CF-Request-Auth` header includes `issued-at`, `valid-until`, `proof-did`,
and `proof-kind`. The `proof-did` value is the verified DID key. The
`CF-User-DID` header must match that key and is covered by the proof.
`CF-Request-Proof` and `CF-Request-Body-SHA256` use unpadded base64url values.

Requests expire quickly. The verifier rejects expired proofs, proofs issued too
far in the future, and proofs with an excessive lifetime.

## First-Party Caller Behavior

The runtime adds request proofs only to narrow fetch-builtin requests:

- the resolved URL must target the runtime API origin
- the route path must be one of the protected local routes
- the method must be `POST`

The runtime replaces caller-supplied proof headers for protected routes. It does
not add user request proofs to arbitrary external requests, even when the path
looks like a toolshed route.

## Deferred Routes

These routes are privileged but are not changed in this pass:

- AI routes under `/api/ai/*`. They use provider keys or gateway authority.
  They have broader caller shapes than the three local fetch-builtin tools. They
  should get the same kind of caller authentication once their browser and
  service caller model is written down.
- Webhook admin routes such as create, list, and delete. They write toolshed
  service storage. External webhook ingest is separate because it authenticates
  with a webhook bearer secret and has a different caller model. The ingest
  channel control plane above is the worked example of what these should adopt:
  request proof for authentication, space ACL for authorization.
- Integration admin routes that create, exchange, refresh, or remove tokens.
  OAuth callbacks are separate because the identity provider calls them. Login,
  refresh, logout, and token exchange routes need a focused design that binds
  the user DID to the target auth cell.
- Memory WebSocket `session.open`. It already has its own DID-key verification
  path. This change intentionally does not modify that protocol.

## Remaining Gaps

- There is no replay cache. The request proof is not trying to prevent replay
  of captured HTTP messages. Toolshed expects TLS to keep an attacker from
  observing and replaying a request on the wire. If a complete valid request is
  obtained some other way, it can be replayed until the proof expires. Short
  expiration and method, authority, path, query, DID, and body binding limit
  where that captured request can be used. A route whose response MINTS a
  credential needs more than that, because a replay would hand the replayer a
  live token that outlives the proof window: `/api/ingest-channels/mint` and
  `/rotate` therefore take a caller-supplied `requestId`, persisted beside the
  registration, and answer a repeat with 409 and no secret. Any future
  credential-minting route needs the same treatment.
- A verified proof proves control of the DID key. It does not prove that the
  caller is code shipped by the shell. Toolshed does not yet have a server-side
  logged-in user registry or DID allowlist for these local HTTP routes.
- The deferred privileged routes remain unauthenticated unless they already have
  a route-specific mechanism.
- Authentication identifies the caller. For most routes it still does not
  authorize which user DID may operate on which sandbox, auth cell, or service
  record. The ingest-channel control plane is the exception and the pattern to
  copy: it resolves authorization against the space ACL document, so its
  strength is inherited from the memory layer rather than asserted locally, and
  it tightens automatically as the ACL model tightens.
- This does not add new URL allowlists or destination filtering. Existing SSRF
  defenses stay in their current route handlers.

## Attack Vectors Covered

- A caller without a valid proof cannot start protected privileged work.
- A proof cannot be reused across another protected route because the path is
  covered by the proof.
- A proof cannot be reused across another host because the authority is covered
  by the proof.
- A body cannot be changed after the proof is attached because
  `CF-Request-Body-SHA256` is verified and covered by the proof when a body is
  present.
- A caller-supplied user DID header is not trusted unless it is covered by a
  valid proof from the same DID key.
