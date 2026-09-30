# Self-Serve Ingest Channels

*Minting an ingest channel is a user action — "let my own device write into my own space." Today it is an operator action. This closes the create-authorization gap named in [ingest-channels-journal-sink.md](../plans/ingest-channels-journal-sink.md) §"Security model & the create-authorization gap".*

**Status:** implemented (this branch), gated OFF by default —
`INGEST_SELF_SERVE_ENABLED` · **Updated:** 2026-08-04 · **Depends on:** the landed `journal` sink (labs #4446) and first-party HTTP request proofs (`docs/specs/toolshed-access-control.md`)

---

## Why

The only way to mint an ingest channel is `deno task provision-ingest-channel`,
run on the deployed host with the toolshed's private identity
(`packages/toolshed/scripts/provision-ingest-channel.ts`). Every user onboarding
a device is an admin ticket to whoever holds the Ansible vault password. That
does not scale past a handful of people, and it blocks the iOS location beacon's
first-run experience entirely.

There is also a sharper, quieter problem. `MEMORY_ACL_MODE` now defaults to
`enforce` (`packages/toolshed/env.ts:230`) and ingest writes into the *user's*
space under the *operator's* identity. If the operator DID is neither in
`MEMORY_SERVICE_DIDS` nor granted per-space, POSTs **return 200 while nothing
commits** — indistinguishable from a typo'd space DID. A channel can be born
dead and look healthy. Fixing that is worth more than the self-serve endpoint.

## The constraint that produced today's design

`ingest.index.ts` deliberately mounts only `POST /api/ingest/:id`. An unauthed
create taking a caller-supplied target space is a confused-deputy write
primitive: anyone could register a channel targeting another user's space and
get legitimately-minted `ExternalIngest` marks written there. Two facts make
this harder than it looks:

1. **First-party HTTP auth authenticates but does not authorize.**
   `verifyFirstPartyHttpRequest` (`packages/runner/src/toolshed-http-auth.ts:350`)
   is a real Ed25519 proof over method + authority + path + body hash + user DID
   + freshness. It proves control of a `did:key` and nothing more.
   `first-party-http-auth.ts:19` carries `TODO(auth): Check that the verified
   DID is authorized…`, and `verifiedUserDid` is read in exactly four places,
   **all logging**.
2. **A space DID is not a credential.** Loom derives space DIDs from a shared
   passphrase. Naming a space proves nothing about controlling it.

## Options evaluated

### Option A (as briefed) — nonce write-back proof-of-control — **rejected**

Server issues a nonce + cell cause; caller writes it into that cell in the
target space; server reads it back.

**It proves the wrong predicate.** The round-trip demonstrates *write*
capability. Non-home spaces genesis as the document the caller registered
beside the space key, else the fallback
`{ [activeUser]: "OWNER", "*": "WRITE" }` (`packages/runner/src/storage/v2.ts`, the
`bootstrapAcl` selection in `#createInitializedSession`; the fallback shape is
`defaultGenesisAcl` over `DEFAULT_GENESIS_GRANTS`)
— and the ingest path registers none, so it gets the fallback — described
upstream as "the rollout default until ACL management has a UI"
(`docs/specs/memory-v2/04-protocol.md:742-748`). So on a genesis'd data space,
*every* authenticated principal — anyone who can generate a keypair — already
holds WRITE and passes the nonce challenge. The ceremony authorizes precisely
the party it exists to exclude.

Secondary costs: server-side nonce state with expiry, a two-phase protocol for a
device meant to be dumb, and a scratch write into the user's space —
uncomfortably close to the load-bearing "absent ≠ empty" invariant loom's read
side depends on (`ingest-channels-journal-sink.md:120`).

### Option B — registration lives in the user's own space — **rejected, but for a narrower reason than expected**

Genuinely attractive: much smaller, self-serve by construction, no new
privileged endpoint. Its defense — "reading a registration from a caller-named
space grants nothing without the matching token" — is correct **about the read**
and fails **on the write**.

The registration carries `secretHash`, the target `space`, and `causePrefix`.
Option B stores it at an address whose integrity is exactly the write-ACL of the
space it sits in. On a genesis'd data space with `"*": "WRITE"`, an attacker
writes their *own* registration with their *own* `secretHash` into the victim's
space, then POSTs with the token they chose. The server verifies a hash the
attacker authored and durably appends marked records. Confused deputy, restored
through a different door.

This is not fixable by reading more carefully: **there is no per-document write
attribution**. `packages/runner/src/cfc/grants.ts:64-73` states that grants
hosted in shared spaces "need per-document write-attribution verification —
future work on its own track." The server cannot ask "was this written by the
space's owner?"

*Correction worth recording:* a user's **home/identity** space genesises as
`{ [signer]: "OWNER" }` with **no wildcard** (the home arm of that same
`bootstrapAcl` selection), so Option B is
sound *for home spaces specifically*. It is unsound for the named data spaces
the location beacon actually targets. Option B becomes generally sound exactly
when the wildcard goes away — but a create primitive whose safety depends on a
documented-temporary rollout crutch being removed later is backwards. The
security property should get stronger as the platform tightens, never start
invalid.

Lesser objections: it changes the ingest wire (the POST must carry the space),
breaking the shipped client contract and the derived-id property, and
`cf:ingest:index` stops being an operator-auditable list of what the deployment
has minted.

### Option A′ (recommended) — authenticated create + a narrow ACL **OWNER** check

Get a cryptographically verified caller DID from `requireFirstPartyHttpAuth()`,
then authorize against the record that already governs the space — its ACL
document at `of:<space DID>` (`packages/memory/v2/server.ts:267`).

```ts
// Shown for illustration only.
// packages/toolshed/lib/space-authority.ts
const acl = await new ACLManager(runtime, space).get();
if (acl?.[callerDid] !== "OWNER") return forbidden();
```

**A narrow, explicit grant — deliberately not `spaceReaderRole`.**
`packages/runner/src/cfc/space-membership.ts:55` is the canonical membership
oracle, and it is the right shape, but it is scoped to the §4.9.3 *render* fit
and folds in three implicit-owner branches that are correct there and wrong
here: `principal === space`, `serviceDids.includes(principal)`, and a wildcard
fallback (`acl[principal] ?? acl["*"]`, `:66`). That last one matters: on an ACL
of `{alice:"OWNER", "*":"OWNER"}` — reachable via `cf acl set ANYONE OWNER` —
`spaceReaderRole` returns `"owner"` for *everyone*. Over-admitting is tolerable
when the consequence is rendering a value to someone who could already read the
space; it is not tolerable when the consequence is minting durable write
authority. So: a narrow predicate, in a toolshed seam, with its own tests.

**Why this is the elegant fit and not merely the safe one**

- **Zero new trust machinery.** No nonce cache, no new proof format, no new
  trust root — one existing authority record, one narrow predicate. The
  `TODO(auth)` at `first-party-http-auth.ts:19` gets its first real answer, and
  it is *resource-scoped* rather than a global env allowlist, which is the right
  shape for that TODO.
- **Security tightens with the ACL; LIVENESS does not — state both.** The
  entitlement check gets stronger as grants narrow, with no code change. The
  operator's ability to *deliver* moves the other way: with
  `MEMORY_SERVICE_DIDS` unset, the operator can write a named space only via
  the temporary genesis wildcard `"*": "WRITE"`. When ACL management gets a UI
  and users narrow their grants, new mints will 409 and — worse — channels
  minted earlier will return 200 while committing nothing, which is exactly the
  "born dead, looks healthy" failure this change exists to remove. Putting the
  operator DID in `MEMORY_SERVICE_DIDS` is therefore not optional hardening; it
  is the precondition for this feature to keep working. Home spaces already
  require it today (they genesis with no wildcard).
- **The resource is the space, not the minting key.** Rotate/revoke/list
  authorize against the registration's **stored** space, never a caller-supplied
  one and never against `createdBy`. Control follows the space through key
  rotation and multi-owner spaces.
- **It is the shape the runtime is already heading toward.**
  `packages/api/cfc.ts:66-71` already describes the `ExternalIngest` mark as "an
  owner-granted, revocable append authority held by an outside service." This
  makes the registration literally that. When CFC grant records
  (`audience`/`expiresAt`/`revoked`, `docs/specs/cfc-persisted-declassification.md:63-75`)
  extend from read-side declassification to write authority, the registration
  migrates into that envelope and the ACL check becomes a capability check —
  same seam, same shape.

## Decisions taken

Four forks were resolved explicitly rather than by default:

1. **The 401 equalization is relaxed, narrowly.** A *cryptographically correct*
   token for a revoked/rotated/expired channel now gets a distinguishable 403
   "re-pair this device". Every case a guesser can reach keeps the equalized
   401 and the dummy-hash compare. Rationale: under self-serve, rotation is
   routine, and a beacon offline across one otherwise cannot tell "re-pair me"
   from "the server is broken" — it drops its buffer or retries forever.
2. **The deployment precondition below is documented, not enforced by a flag.**
3. **`requestId` is required** on mint, rotate, AND revoke (see Hardening §1).
4. **The control plane's paths are NOT added to
   `PROTECTED_TOOLSHED_FIRST_PARTY_ROUTES`.** That list is the in-runtime
   signer's allowlist; adding these would let any pattern mint a channel with
   the user's authority and read the one-time token back. Webhooks solve the
   equivalent problem with `cf-secret-viewer`, and that is the prerequisite for
   an in-pattern client. All four verbs are POST so it stays possible.

## Deployment precondition — state it, don't bury it

**Self-serve mint is exactly as strong as space-key custody, and no stronger.**

The memory server grants implicit `OWNER` when `principal === space`, before
reading the ACL at all (`packages/memory/v2/server.ts:1044-1049`). ACL mutation
requires OWNER (`:2061-2065`), and on an already-valid ACL the only constraints
are shape plus "at least one concrete OWNER survives" (`:1184-1213`,
`packages/memory/acl.ts:28-32`). So anyone who can sign **as a space DID** can
write `{ attacker: "OWNER" }` into that space — and may drop the real owner in
the same commit — after which they pass the narrow predicate as a legitimate,
explicit owner.

On a deployment where space DIDs derive from a public passphrase, that is
everyone. This is a known, intentional, temporary platform property, not a
regression introduced here — but minting creates a **durable capability that
outlives the ACL state that authorized it**, so it deserves a stated
precondition rather than a testing footnote:

> Self-serve minting is safe only on deployments where space keys are not
> derivable from public inputs. Where they are, the mint endpoint inherits a
> space-takeover primitive.

This is **enforced, not just documented**: the control plane is mounted only
when `INGEST_SELF_SERVE_ENABLED` is set, and the default is off. A tripwire
proving the weakness still exists is not a substitute for the gate — the
tripwire tells you when the repair lands, while the gate is what stops durable
credentials being issued before it. Credentials issued under the old trust
condition are not retracted by the repair, so the order is: repair custody,
sweep ACLs, retire existing channels (`deno task retire-ingest-channels`), then
enable.

Consequently the acceptance criterion "refused when naming a space you don't
control" must be tested against a space with a **concrete, non-derived** owner,
or the test proves nothing.

## Surface

A **separate prefix**, `/api/ingest-channels` — not a sub-path of
`/api/ingest/*`. Three reasons, all concrete:

1. `/api/ingest/*` carries `cors({ origin: "*" })` (`ingest.index.ts:18-26`).
   Mounting a credentialed control plane under a wildcard-CORS prefix violates a
   written invariant: "The protected routes do not expose wildcard CORS"
   (`docs/specs/toolshed-access-control.md:31-33`).
2. `POST /api/ingest/channels` collides with `POST /api/ingest/:id` at the
   router.
3. Data plane and control plane should not share middleware. Keep the two
   prefixes as separate **literal** strings — a future `/api/ingest*` would
   silently merge them.

**All verbs are POST**, including list and revoke. This is not aesthetics: the
in-runtime signer is a hardcoded, POST-only path allowlist
(`PROTECTED_TOOLSHED_FIRST_PARTY_ROUTES`, `toolshed-http-auth.ts:37-41`,
enforced at `:64-70`), so a `GET` or `DELETE` is unsignable by any in-pattern
caller, ever. POST-only keeps the door open for a shell/pattern client later.

| Verb | Purpose |
|---|---|
| `POST /api/ingest-channels/mint` | mint (or rotate-in-place); returns the token **once** |
| `POST /api/ingest-channels/list` | the caller's own channels; never returns `secretHash` |
| `POST /api/ingest-channels/rotate` | new token, same id and target |
| `POST /api/ingest-channels/revoke` | flips `enabled: false` |

*Correction found while testing:* not mounting `cors()` here does **not** yield
an absent `access-control-allow-origin`. `routes/static` and `routes/shell`
register `cors({ origin: "*" })` on `"*"` / `"/*"`, and since every router is
mounted at `app.route("/", …)` those apply app-wide — every toolshed route,
including the three already-protected ones, answers with
`access-control-allow-origin: *`. What actually blocks a cross-origin POST is
that the preflight replies `access-control-allow-methods: GET,OPTIONS`. Worth
knowing before anyone relies on the spec's "protected routes do not expose
wildcard CORS" as a response-header property; it is true of what those routers
*mount*, not of what they *answer*.

`bodyLimit` (a few KB) mounts **before** the auth middleware: signature
verification buffers the whole body (`toolshed-http-auth.ts:118-124`) *before*
`verifier.verify` runs (`:379-405`), so an unauthenticated attacker can
otherwise force arbitrary allocation with a garbage signature.

### Client

`cf ingest mint|ls|rotate|revoke`, alongside `cf acl`. `cf ingest rotate <id>`
mints a new token for a channel the caller owns, leaving the channel and its
grants in place — the spelling for a token that leaked or aged, where revoking
would take the channel down with it. The CLI is the only client that can sign
today — the shell cannot sign at all (zero references to `toolshed-http-auth`
across `packages/shell`, `packages/lib-shell`, `packages/runtime-client`), and
the in-pattern `fetch` builtin is bound to the three-entry allowlist above.

**This is a real limitation, stated plainly:** CLI signing needs a plaintext
PKCS#8 key file on disk (`packages/cli/lib/identity.ts:33-37`), while a shell
user's key lives behind a passkey. So v1 self-serve is a power-user path. It
still meets the goal — a user with their own identity key needs no operator —
and it is strictly better than an Ansible-vault ticket. The pleasant path (a
`cf-ingest-channel` component mirroring `cf-webhook`'s `cf-secret-viewer`
reveal, `packages/ui/src/v2/components/cf-webhook/cf-webhook.ts:116-124`, plus a
QR the beacon scans) is the natural follow-on, and POST-only verbs are what keep
it reachable.

## Fail loudly at create — the highest-value item

One ACL read answers both questions: *is the caller entitled?* and *can this
deployment actually deliver?*

The naive form does not work. `storageManager.synced()` **deliberately does not
throw** on authorization denial — "a denied cross-space link must stay a silent
absent read" (`v2.ts:2290-2303`) — so `ACLManager.get()` returns `null`
identically for "never genesis'd" and "the operator was denied the read". The
primitive that distinguishes them is `storageManager.authorizationError(space)`
(`v2.ts:1281`), which returns the server's own verdict.

Three genuinely distinct outcomes:

| Condition | Result |
|---|---|
| operator denied on the space | 409 naming the operator DID and the `MEMORY_SERVICE_DIDS` fix |
| ACL absent (pre-genesis space) | 409 "space has no ACL; initialize it first" |
| ACL present, operator lacks WRITE | 409 naming the required grant |

All three are revealed **only after** the caller has proven OWNER — at which
point the detail is theirs by right (see "Error shapes" below).

## Hardening the endpoint creates

Four hazards that this change introduces or amplifies, each with its fix:

1. **Replay mints a live credential.** There is no replay cache on first-party
   proofs; TLS is the assumed defense
   (`docs/specs/toolshed-access-control.md:94-110`). On the three routes
   protected today, a replay re-runs an action. On `mint`/`rotate`, a replay
   **returns a fresh live token to whoever replays the bytes**, converting a
   ≤300s window into permanent append authority — and silently killing the
   victim's live beacon token. *Fix:* a caller-supplied random `requestId`,
   persisted beside the registration; a repeat is a 409 no-op that returns no
   secret. Durable, no in-memory cache, no timer.

   In every case the id is consumed in the **same transaction** as the write it
   guards. Claiming it beforehand burns the id whenever the write then fails,
   which turns the idempotency key into the one thing that does not survive the
   failure it exists to make retryable.

   **Revoke needs more than an id, and this is worth being precise about.** A
   request id proves only "this exact request was already *delivered*", so it
   does nothing for a request that is captured and **withheld**. An id that
   was never spent looks perfectly fresh, so the request stays a live weapon
   for the rest of the proof window and lands on whatever credential exists
   when it is finally let through. The realistic shape is not exotic: swallow
   the owner's revoke, let them conclude it failed and retry (a fresh id), let
   them re-pair the device — then deliver the original. The newly paired device
   dies.

   So revoke also requires **`expectedRevision`**: the generation the caller
   looked at, read from `list`, part of the signed body, and enforced as the
   optimistic precondition on the write. A withheld request names a generation
   that no longer exists, so it is refused. This is what makes revoke
   credential-bound rather than merely at-most-once; the request id remains for
   the delivered-and-replayed case. The cost is that `cf ingest revoke` reads
   before it writes, and that a channel which moved in between produces a
   conflict the caller must re-issue against — which is the correct outcome,
   since the thing being revoked would not be the thing that was seen.

   Revoking an **already-revoked** channel keeps the original revocation and
   its attribution, but still goes through the write transaction rather than
   short-circuiting on the registration read. A read-only fast path would
   decide "already revoked" from a snapshot, and a re-mint landing between that
   read and the answer would leave it reporting success while a freshly minted
   credential is live. Only the transaction's own read decides.

   That write advances the revision even though nothing else changes. At a
   *stable* revision one captured request's precondition never stops matching,
   so a single captured request could be replayed for unlimited 200-returning
   durable transactions. Advancing it means a repeat must go read the new
   generation — which bounds what a *replay* can do, not what an authenticated
   owner can do. An owner willing to re-list between calls can still drive one
   write per round trip; that is ordinary authenticated write traffic, bounded
   by the rate limiter, and it grows no new documents.

   That read defaults to the caller's own channels, so revoking a channel
   minted by *someone else* against a space you own — the case
   revocation-by-current-owner exists for — needs `cf ingest revoke --space`,
   which looks it up in the space's list instead.
2. **Existence oracle.** "Deployment does not host this space" and "you are not
   the owner" must be **one indistinguishable 403**. Otherwise, combined with
   derivable space DIDs, a dictionary of space names enumerates the deployment's
   entire inventory.
3. **List is an amplification primitive.** A flat `cf:ingest:index` forces the
   handler to read every registration and every foreign ACL; each
   `ACLManager.get()` awaits `synced()`, which is a **global barrier over every
   mounted provider** (`v2.ts:1265-1271`) — and `processIngest` awaits it three
   times per POST (`ingest.utils.ts:201, 235, 285`). One authenticated list call
   would degrade ingest latency for every real beacon. *Fix:* a per-owner index
   `cf:ingest:by-owner:<callerDid>` written at mint, so list is O(the caller's
   own channels), reads no foreign ACL, and mounts no foreign space. Keep the
   global index for operator audit only.
4. **Unbounded provider growth.** `#providers` is populated on first access and
   cleared only on full dispose (`v2.ts:1042`, `:1244`). Authorizing an
   arbitrary caller-named space mounts a replica. *Fix:* refuse spaces the
   deployment does not already host **before** mounting anything — folded into
   the same 403 as hazard 2. Plus per-IP limiting on mint; a token bucket keyed
   by caller DID is useless, since DIDs are free to generate.

## Registration shape — get the durable fields right now

`IngestRegistration` (`ingest.utils.ts:43-63`) gains, in this change:

```ts
// Shown as interface or class members.
owner: string;                        // the VERIFIED minting DID (today `createdBy` records the operator's own DID — useless)
expiresAt?: string;                   // enforced in processIngest, not merely stored
revoked?: { at: string; by: string }; // an audit record, not a deletion
```

These are the exact envelope fields of `CfcGrant`
(`docs/specs/cfc-persisted-declassification.md:63-75`), which is real code
(`packages/runner/src/cfc/grants.ts`) — but not usable as-is here, since grant
writes require a trusted builtin identity and `space === owner`
(`grants.ts:411-421`), which the toolshed operator cannot satisfy on a user's
behalf. Adopting the *shape* now means the eventual migration is a lookup swap
rather than a data migration over production records.

`expiresAt` must be **enforced** in `processIngest`, not just stored — a field
that exists and is never consulted is worse than no field.

Revocation is a **soft disable**, diverging from webhooks' hard delete
(`webhooks.utils.ts:154-157`). Justified: a webhook registration is dispatch
config; an ingest registration is the only record of who was authorized to write
provenance-marked data into a user's space. Destroying it destroys the audit
trail.

The ingest path answers a disabled channel by what the caller proved, not by the
channel's state. A wrong or unknown token gets the equalized 401, identical to
an unknown channel — a guesser learns nothing. A *cryptographically correct*
current or previous token on a channel that is disabled, revoked or expired gets
an actionable **403 "re-pair this device"**, because reaching that answer already
required proof-of-possession, so it reveals nothing a guesser could use. Without
it the device on the single most likely path to that state cannot tell "my
credential was retired" from "the server is down", and has to choose between
dropping its buffer and retrying forever.

`space` is pinned to `^did:key:z[1-9A-HJ-NP-Za-km-z]+$` in the create path. The
repository-wide `isDID` answers only whether a string is a DID, so it admits
newlines and case variants after the prefix,
and that same string feeds the hosted-space check, the ACL key, the `\n`-joined
id derivation, and the on-disk `.sqlite` filename
(`packages/memory/.../storage-path.ts:69`) — on a case-insensitive filesystem,
two case-variant DIDs open the same engine while deriving different channel ids.

`installId` stays constrained by `isValidSegment` (`ingest.utils.ts:38-41`).
Under self-serve it becomes caller-supplied and lands in the mark's `audience`,
where the charset is the *only* thing preventing impersonation of the token-less
integration audiences `did:web:commonfabric.org#oauth2`
(`oauth2-common.utils.ts:165`) and `#plaid`. The regex is unchanged — it already
excludes `:` and `#` — but its comment is upgraded from "NOT a security
boundary" to name this as a deliberate one. The value format is **not** changed:
`installId` is loom's cross-repo join key.

## Invariants preserved exactly

Token `ingsec_` + 32 base62 via rejection sampling; `secretHash` only at rest;
shown once; timing-safe non-early-exit verify; equalized 401 across
missing/unknown/disabled/wrong-token with the dummy-hash compare; body parsed
only after auth; storage errors → 502 never 401; channel id stays derived
`sha256(space + "\n" + installId)` and non-secret; records stored verbatim in
per-UTC-day partition cells `<causePrefix>/<YYYY-MM-DD>`, no server-added
fields, no server-side dedup; a day cell is never pre-created (absent ≠ empty).

One addition to the data plane, because verbatim storage turned out to have a
hole: a record containing a **link sigil** is rejected with 400. Records are
opaque JSON, but opaque is not inert — the runtime decides on *write* whether a
value is a link, so `{"/": {"link@1": …}}` was not stored as text, it was stored
as a live reference. That is a non-null, non-array object, which was the whole
record contract, so nothing else caught it. It broke three guarantees at once:
the journal stopped being append-only (a link's target can change afterwards, so
a historical record mutates with no ingest touching it), the ExternalIngest mark
attested to a digest of the sigil rather than to anything a reader resolves
through it, and the record could address a document the channel was never
authorized to write. The check uses the runtime's own `isLink` predicate rather
than matching the envelope locally, so it cannot drift from what the writer
interprets, and it rejects rather than strips — silently rewriting a record
would break verbatim storage from the other side.

The cross-repo contract in `ingest-channels-journal-sink.md` §"Cross-repo
contract" is untouched: the data plane `POST /api/ingest/:id` does not change.

## Attacks considered and confirmed *not* to work

Recorded so a future reader does not re-litigate them:

- **Wildcard escalation.** A principal holding only `"*": "WRITE"` cannot mutate
  the ACL: ACL-touching commits require OWNER (`server.ts:2061-2065`), and
  `commitTouchesAclDoc` (`:269-277`) catches retract, so "retract then
  re-genesis" is blocked.
- **Pre-genesis race.** On a never-created ACL only `principal === space` or a
  configured service DID may initialize (`server.ts:1214-1223`);
  `MEMORY_SERVICE_DIDS` defaults to `""`. The temporary-public compatibility row
  grants at most WRITE, never OWNER (`:1055-1059`).
- **Channel-id squatting / collision.** The id derives server-side from the
  space the caller was just authorized for, so ids live in per-space namespaces;
  SHA-256 preimage is infeasible.
- **`\n` delimiter injection.** A collision needs a newline in `installId`,
  which `isValidSegment` excludes. (`space` is pinned separately above for
  defense in depth.)
- **Malformed-ACL DoS.** `ACLManager.get()` throws on malformed/ownerless, but
  every ACL write is validated (`server.ts:1207-1213`), so an attacker cannot
  push a victim into that state. Map the throw to a distinct 409 so it is not
  confused with a storage fault.

## Retiring a population when the trust conditions change

A minted token is a durable append capability that outlives the conditions
which authorized it. The forcing case is the deployment precondition above:
until space keys stop deriving from a public passphrase, anyone who knew a
space *name* could sign as that space, grant themselves `OWNER`, and mint
entirely legitimately. Fixing the derivation stops new abuse and **retracts
nothing already issued**.

Two designs were considered and rejected before the one that shipped:

- **A mandatory TTL as the retirement mechanism** — letting the legacy
  population age out on its own instead of retiring it. Rejected: it makes the
  cutover take as long as the longest credential, and the operator never learns
  when it is done. Credentials *are* finite-lived (see below), but expiry
  bounds an individual token; it is not how a population is retired.
- **A trust epoch** stamped on every registration and compared on every POST.
  Declarative and atomic — and it buys that with a field, an env var, and a
  hot-path branch that live in the runtime forever to serve a single event.
  Rejected for the same reason, one level up: the cost is permanent, the need
  is not.

**What shipped instead is nothing.** Revocation already has exactly the
required shape — fail-closed (the data plane refuses a revoked channel even
with a valid token), loud (a correct token gets an actionable 403 telling the
device to re-pair, and the refusal is logged), and non-destructive (the
registration survives as an audit record). Retiring a population is therefore
just "revoke all of it": `deno task retire-ingest-channels --reason <why>`,
dry-run by default. Re-minting is the manual conversion — an owner runs `cf
ingest mint` again, which re-authorizes under the new conditions and clears the
revocation while preserving its history.

Known trade-off, stated rather than discovered: this is imperative, so it is
not atomic. A channel minted between the run and the cutover is missed. The
script is idempotent, so re-run it — or take the control plane down for the
migration — and confirm with `deno task audit-ingest-channels`.

**How anyone remembers to do this.** A procedure in a document is not a
mechanism. The trigger is a tripwire test —
`packages/toolshed/routes/ingest-channels/space-key-derivation-tripwire.test.ts`
— which asserts that the weakness is **still present**: that two different
users derive the same key for one space name, and that the space key is
reconstructible from repo constants alone. Fixing the derivation therefore
*breaks the build*, and the failure message is the procedure below.

The reminder is deliberately hard to silence, because the realistic threat is
not malice but a mechanical fix — an agent (or a hurrying human) repairing a
red assertion without reading why it is red:

- **There is no expectation to edit.** The test does not compare an expected
  value; it throws explicitly when the weakness is gone, so there is nothing to
  "update" and no comparison to invert.
- **The file leads with a STOP block** addressed to whoever just saw it fail,
  stating that making it pass is the one wrong move.
- **`deno task check-tripwires` re-derives the same condition independently**,
  in a different task family, wired into CI next to `check-skill-facts`. It
  also fails if the test file is deleted, has lost its sentinel (gutted), or
  has been `.ignore`d. Silencing the obligation therefore means neutering two
  things in two places in one diff a reviewer can see.
- **`tasks/check-tripwires.test.ts`** guards the guard: a typo'd manifest path
  would otherwise let the check report "intact" vacuously.

All five paths were verified by deliberately breaking each one: weakness fixed,
file deleted, sentinel removed, test skipped, and the healthy case.

**Procedure when space keys are fixed:**
0. `deno task audit-ingest-channels --repair-indexes --recover <record>` —
   only needed on a deployment that provisioned channels *before* this change,
   and only once. See "Recovering a channel the index never learned about"
   below for what `<record>` is and why the step exists.
1. `deno task audit-ingest-channels` — record the current population.
2. `deno task retire-ingest-channels --reason space-key-derivation-fix`
   (dry run), then again with `--confirm`.
3. Sweep the space ACLs for concrete `OWNER` grants nobody can account for.
   **Revocation retires tokens; it does not remove a self-granted ACL entry**,
   and that entry is what would let an attacker simply mint again the next day.
   This step is not optional.
4. `deno task audit-ingest-channels` — confirm nothing is left active.

### Recovering a channel the index never learned about

Before this change the audit-index write was best-effort and its failure was
swallowed (`ingest.utils.ts` on `main`: "A failure here must NOT fail
provisioning"). So a channel can exist that is live, appends into a user's
space, and appears in no index at all. Its space's owner cannot see it, and
therefore cannot revoke it — and neither a retirement sweep nor
`--repair-indexes` would find it, because both walk the very index it is
missing from. Repairing an index by enumerating that same index only ever
confirms what is already there.

The source of truth is not the index and it is not a scan of the service space:
the memory layer exposes no space-wide enumeration, and reaching into its
SQLite internals from an operator script would couple the Operation layer to
Foundation internals that are actively changing. It does not need to be either.
A channel id is `channelId(space, installId)` — derived, not random — and
`provision-ingest-channel.ts` is the only thing that ever created one, from
arguments the operator chose. **The operator's own provisioning record is the
source of truth**, and probing it is exact: an id either resolves to a
registration or it does not.

`--recover <file>` takes that record as `<space-did> <install-id>` per line
(`#` comments and blank lines ignored), visits each derived id alongside the
index, and — with `--repair-indexes` — reindexes any that resolve. After it
runs once, the channel is in the index and every later audit finds it without
the record.

Nothing minted from this change onward can join that population: indexing is
now mandatory and lands in the same transaction as the registration, so there
is no longer a write whose failure can be swallowed.

## One transaction per lifecycle write

A mint, rotate or revoke consumes a request id, checks a version precondition,
updates three indexes and writes the registration. All of it happens inside one
`editWithRetry`, and every check runs before any write within it.

Both halves matter. Claiming the request id in a separate earlier transaction
spends it even when the write then fails, which makes the idempotency key the
one thing that does not survive the failure it exists to make retryable — an
honest retry with the same id would be refused for a mint that never happened.
And because `editWithRetry` commits whatever the closure did, a write followed
by an early return still lands, so a check placed after a write is not a check
at all.

A read-only pre-check still rejects an obvious replay before a secret is
generated. It is advisory: the authoritative decision is the one inside the
transaction.

## Abuse bounds are a deployment responsibility

The in-process token bucket is a backstop, not the budget. It is per-process, so
a multi-instance deployment multiplies it, and its LRU hands an evicted key a
fresh bucket — which makes key churn a reset primitive. Enforce the real
deployment-wide budget at trusted ingress (the reverse proxy or CDN), and set
`RATE_LIMIT_TRUST_FORWARDED_FOR` only when such a proxy is actually in front.

When it is set, the key is the **rightmost** `X-Forwarded-For` entry. A proxy
appends the address it saw to whatever the request already carried, so every
entry to the left of it is client-authored: keying on the leftmost lets a caller
send a different value each request and draw a fresh full bucket every time,
which is the limiter not existing. The rightmost is the only entry the client
could not choose. This assumes exactly one trusted proxy appends — behind a
chain of N, count in by the number of trusted hops instead.

**`revoke` has its own bucket.** These limiters run ahead of authentication and
are keyed by address, so anything that drains the shared bucket also refuses
revokes — and under the misconfiguration above (a real proxy with the flag off)
every caller collapses onto one bucket, so one client's minting would refuse
everyone else's revokes. Minting and rotating are safe to refuse because nothing
bad happens when they do not run; revoke is the verb where refusing *is* the bad
outcome. Same asymmetry the claim-store-full path answers from the other side.

Durable bookkeeping is bounded rather than unbounded, on four axes:

- **Request claims** are compacted into one cell per owner, pruned to the proof
  replay window, and capped. Full means refuse, not evict: dropping the oldest
  entry would discard the very claim that proves a replay.
- **The owner index** holds LIVE ids only. Revoking removes the id, so its
  length *is* the owner's live-channel count — which is what makes "revoke some
  before minting more" a remedy that actually frees something, and what lets the
  cap be read straight off the index. That length being load-bearing is the
  whole reason it is pruned.
- **The space index** keeps revoked ids, deliberately, because nothing reads its
  length and something does read its contents: it is the only listing a revoked
  channel appears in, and `revoke` cannot proceed without the generation that
  listing publishes. Bounded by the per-space lifetime quota below, which counts
  exactly the ids that can land in it.
- **The live-channel cap** is enforced inside the transaction that updates that
  index, not from a read before it. A count taken beforehand is advisory: a
  burst of concurrent mints all read the same under-cap number and all commit.
- **The audit inventory** is never pruned either, and unlike the space index it
  is deployment-wide — a revoked
  channel stays in it on purpose, because that is what a trust-condition sweep
  enumerates. So it is the one that cannot be a single array: it is sharded by
  UTC month (mirroring the data plane's per-day partition cells) behind a shard
  directory bounded by calendar time rather than by traffic. The pre-sharding
  flat index is still read, so nothing provisioned before sharding goes
  missing.

Backing all of it are **two lifetime quotas, per owner and per space**. Everything a mint
writes outlives revocation deliberately — the registration cell so a retired
token can be told apart from an unknown one, the audit entry so the sweep can
still find it — so mint → revoke → mint frees a live slot but frees no storage.
Liveness was never the right bound on state one authenticated user can create.
Each is a monotone counter, not a list: the thing bounding unbounded growth must
not itself be an unbounded array. Both are generous (runaway stops, not product
limits), neither is refunded by revoking, and their refusals say so rather than
sending the user round a loop that cannot succeed.

**Why two.** A per-owner quota bounds a *keypair*, and keypairs are free. One
person with one space can grant `OWNER` to as many fresh DIDs as they like and
spend a new allowance from each — and every new DID also mints its own
permanent `by-owner`, `lifetime` and `requests` cells, so the mechanism
introduced to bound growth would itself be an unbounded cell family in the same
dimension. The rate limiter does not backstop this either: it is keyed by client
address, and this document already names key churn as a reset primitive for it.

The space is what a caller cannot mint for free *within this feature's reach*: a
channel must name a space the caller holds a recorded `OWNER` grant on. Metering
the space closes key churn, and closes the per-key cell family with it, since a
refused mint writes nothing at all. Creating unlimited *spaces* remains an axis —
but every space is already a memory store the deployment hosts, so that is the
deployment's admission control, not this feature's.

**Both** meters charge **acquisition**, not creation — every ownership change,
plus every creation. For the owner meter that is because taking over a revoked
channel adds a channel to the acquirer without creating one, and a meter read as
a record of what an identity holds must not sit at zero while it holds three.

For the space meter it is what makes the bound real at all. A fresh key refused
a new channel can revoke an existing one and re-mint it instead: it acquires a
channel, and mints its own permanent `by-owner`, `lifetime` and `requests`
cells, while a creation-only space meter never moves. Key churn would route
straight around the bound built to stop it.

## Known limits

- **A revoked channel is visible only in the space-scoped list, not your own.**
  The OWNER index holds live ids only, because its length is load-bearing —
  it *is* the live count the per-owner cap reads — so `cf ingest ls` without
  `--space` shows live channels only. The space index keeps revoked ids (no cap
  reads it, and the per-space lifetime quota bounds it), so
  `cf ingest ls --space <did>` shows the full trail, and `cf ingest revoke`
  needs `--space` to reach an already-revoked channel.

  This is not cosmetic: `revoke` requires the channel's current generation and
  `list` is the only place a generation is published, so a channel that is
  unlistable is also un-revocable — every later revoke answers 409 telling the
  caller to list something that will never appear. Pruning both indexes on
  revoke created exactly that dead end. The revoke response now also returns
  the new `revision`, so revoking twice in a row needs no lookup at all.
- **The 403 denial is opaque by design, which makes support harder, not
  easier.** Five states collapse into one message. The most common real cause is
  a legitimate owner signing with the wrong key — a passkey shell login owns the
  space with a key the CLI does not hold, and there is no `cf id from-passkey`.
  The message therefore carries generic, constant advice (check `cf acl ls`
  against `cf id did`) that leaks nothing. It does not remove the need to read
  `logDetail` server-side for the other four states.
- **A storage fault during the ACL read reads as a denial.**
  `authorizeSpaceOwner` fails closed on anything it cannot resolve, so a broken
  or unreachable store makes `mint` answer "not authorized for that space"
  rather than 502. Safe, and the wrong sentence: someone debugging an outage
  will be told they lack a grant they in fact hold. Every other verb reaches
  storage outside that guard and does return 502.
- **TOCTOU: the ACL is checked at mint, and the token outlives a later grant
  removal.** Two things bound the window rather than close it. Every credential
  carries an expiry — `ttlDays` is optional on the wire but never absent at
  rest, so there is no path to an unbounded token. And revocation is reachable
  by the party entitled to it: `cf ingest ls --space <space>` lists every
  channel targeting a space the caller currently owns, whoever minted it, so an
  owner can find and revoke a channel minted by someone whose grant has since
  been removed.

  Binding data-plane acceptance to the current ACL on every POST would close
  the window instead of bounding it. A lazy re-check on the per-POST last-seen
  bump would do it at no hot-path cost; it is not taken here because it also
  means a user narrowing their own ACL stops their own beacon, which deserves a
  deliberate decision rather than arriving as a side effect.
- **Marks cannot name the channel that produced them.** `custodyIngest` is
  passed `{ channel: registration.space, audience: registration.installId }`
  (`ingest.utils.ts:286-289`), while `VouchedChannel.channel` is documented as
  "the ingest channel — its dedicated space DID"
  (`packages/toolshed/lib/custody-ingest.ts:38-40`). Channels are distinguishable
  by `audience`, so this is not fatal — but "which records arrived under the
  token I just revoked?" is unanswerable for a revoked-then-recreated channel
  reusing an `installId`. Recording the channel id on the mark is the fix; it
  changes a cross-repo provenance field and so is **not** taken unilaterally
  here.
- **Vouching authority is downgraded.** "Vouched" today means an operator ran a
  script on the deployed host. After this it means some DID that held OWNER on
  some space asked for one. The mark does not change; what it attests does.
  Downstream consumers should decide deliberately whether to keep trusting it
  uniformly.
- **No replay cache** on first-party proofs generally; TLS is the assumed
  defense. Mitigated for these endpoints by the `requestId` above.
- **The operator runtime still sees plaintext.** Unchanged.

## Test plan — as built

The central security property was **not testable in the existing harness**:
`ingest.utils.test.ts` uses `StorageManager.emulate`, whose server is built with
no `acl` option, so `#aclMode()` is `"off"` and nothing is authorized. This
change therefore adds `packages/toolshed/lib/test-support/memory-acl.ts` — a
real memory-v2 server with `acl: { mode: "enforce" }` over a loopback transport,
plus arbitrary-shape ACL genesis as the space identity.

Everything below runs against that fixture, with a **concrete, non-derived**
space owner:

- Mint refused for a space where the caller is not an explicit OWNER.
- A wildcard `"*": "WRITE"` stranger refused; a wildcard `"*": "OWNER"` stranger
  refused (the case that rules out reusing `spaceReaderRole`).
- "Not hosted" and "not owner" return byte-identical 403s; an unknown channel id
  answers identically to an unowned one.
- Rotate and revoke refused from a non-owner, with the owner's token still
  working afterwards (the IDOR invariant).
- Mint refused with an actionable 409 when the operator cannot write the space;
  all three sub-cases distinguished, and only after the OWNER check.
- Replayed mint/rotate returns 409 and no secret, and leaves the live token
  working.
- `secretHash` never appears in any response body.
- An `installId` that would impersonate an integration audience is rejected.
- POST points land in the right day cell; existing suite green.
- List returns only the caller's channels, never `secretHash`, and reads no
  foreign ACL.
- Rotate invalidates the old token; a device still holding it gets the 403
  re-pair signal (matching the recorded superseded hash), while a merely wrong
  token still gets the equalized 401.
- Revoke makes subsequent POSTs 403; re-minting a revoked channel yields a token
  that actually works, and the revocation survives in `revocations`.
- `expiresAt` in the past → 403; an unparseable `expiresAt` also → 403 (fails
  closed).
- Taking over a channel owned by another principal is refused; an absurd
  `ttlDays` is clamped rather than throwing; requestIds are scoped per caller.
