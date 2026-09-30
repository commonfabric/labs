# Chapter 10 — Identity, Authorization, and Isolation

Two trust problems run through everything so far. *Who* is writing to a
space — across browsers, CLIs, and servers, with no accounts database
anywhere in the design? And how can the platform run *user-authored
programs* against real user data? This chapter covers both: cryptographic
identity, session authorization, and the layered sandboxing of pattern
code. Code: `packages/identity`, the auth hooks in `packages/toolshed` and
`packages/memory`, and `packages/iframe-sandbox`.

## Identity: keypairs all the way down

There are no usernames or server-side accounts. An identity *is* an Ed25519
keypair, named by its public key as a DID:
`did:key:z6Mk...` (`packages/identity/src/identity.ts`). Everything that
acts or is acted upon — users, services, spaces — is a DID.

Two derivation tricks give the system its shape:

- **Passphrase derivation.** `Identity.fromPassphrase(s)` hashes a string
  into a keypair deterministically.
- **Hierarchical derivation.** `identity.derive(name)` deterministically
  derives a child keypair from a parent and a label.

A **space DID** is just `someIdentity.derive(spaceName).did()`. No
registration step, no central registry: knowing the derivation inputs *is*
knowing the space. Dev environments lean on this hard: named dev spaces
derive from a well-known passphrase, which is why two local setups agree on
what `did:key:...` a space name means. The same trick defines the **shared
dev identity** `cf id derive "implicit trust"` — the DID the local toolshed
itself runs as in dev mode. Because it comes from a public string, *everyone*
who derives it gets the identical keypair. That is a convenience on your own
localhost (CLI, browser, and server can all act as one admin identity) and a
footgun anywhere shared: derive or browser-import it against a server other
people use and you all become the *same* principal — seeing and overwriting
each other's `PerUser` data. Use a unique `id new` key for your own identity;
reserve `implicit trust` for deliberately acting as a local dev server's
operator. See `docs/features/shared-identity.md`.

## Passkeys: the browser login

The shell never asks for a password and never stores a private key on a
server. Login (`packages/identity/src/pass-key.ts`):

1. `navigator.credentials.create()` makes a WebAuthn **passkey** (resident
   key, e.g. in iCloud Keychain or a security key), requesting the **PRF
   extension**.
2. The PRF extension lets the authenticator evaluate a pseudo-random
   function; its 32-byte output becomes the seed for the user's root
   Ed25519 key (`Identity.fromRaw(seed)`).
3. The root identity is cached in IndexedDB (`common-key-store`) for the
   session; user spaces are `derive()`d from it.

So the user's "account" is reconstructible from their passkey alone, on any
device, with the actual signing key never leaving the authenticator's
control path. The CLI does the equivalent with a key file (`cf id derive`,
`CF_IDENTITY`).

## Authorizing the connection

How does the server know a WebSocket client may touch a space? In the
current (v2) protocol, authorization happens at **session open**
(`packages/runner/src/storage/v2-remote-session.ts`,
`packages/toolshed/routes/storage/memory.ts`):

1. The client receives `sessionOpen.audience` and a one-time
   `sessionOpen.challenge` from the server's `hello.ok`.
2. The client builds a `session.open` invocation and signs its hash with the
   user's key. The signed invocation includes:
   - `iss`: the user DID
   - `cmd`: `"session.open"`
   - `sub`: the space DID
   - `aud`: the server DID from `sessionOpen.audience`
   - `challenge`: the challenge value from `sessionOpen.challenge`
   - `iat` and `exp`: the signed time window
   - `args.protocol` and `args.session`: the protocol and session descriptor
3. The server verifies the signature against the issuer DID. It also verifies
   that the signed invocation matches this session-open request, the advertised
   audience, the current connection challenge, and the allowed time window.
   That prevents replay onto another server or onto a later connection.
4. The issuer becomes the session's pinned **principal**: reopening the
   session as someone else fails, a stolen stale token is revoked, and —
   importantly — the principal is what keys the `user:`/`session:` scope
   partitions from Chapter 9. `PerUser` isolation is cryptographic
   identity, enforced in the storage engine.

## Authorization: per-space ACLs

Beyond authentication, per-space **ACLs** are wired into the v2 server itself.
A space can carry an ACL document (addressed by the wire entity id
`of:<space DID>`; types in `packages/memory/acl.ts`, managed by the runner's
`ACLManager` and surfaced as `cf acl`) granting READ/WRITE/OWNER capabilities.
The server evaluates them per message — session-open, queries, and watches need
READ; `transact` needs WRITE; writing the ACL itself needs OWNER. A fresh space
is read-only until its space identity (or a configured service DID) writes a
valid ACL with at least one concrete OWNER. Named-space bootstrap uses a
temporary space-identity session to write the genesis ACL, then remounts as
that user: the document a caller registered beside the space key
(`registerSpaceIdentity(identity, { genesisAcl })`, so a space can be born
with exactly that ACL), else the rollout default of the active user as OWNER
plus `"*"`
WRITE. Home spaces use the
same identity for both roles and remain private by claiming
`{ [space]: "OWNER" }`, including an ACL-less legacy home.

As a temporary pre-launch compatibility rule, a populated space that has never
had an ACL is authenticated-public READ/WRITE but never OWNER. A malformed,
ownerless, or retracted ACL fails closed. ACL replacement must be a whole,
space-scoped document and may not remove the last concrete owner. Enforcement
is a deployment dial (`MEMORY_ACL_MODE`: `off`/`observe`/`enforce`) that
defaults to `enforce`; `enforce` additionally revokes live sessions that lose
access. Operators can still select `observe` or `off` explicitly. Structural
ACL validity and fresh-space genesis remain hard invariants in `observe` mode.

## Reading and changing a space's ACL

That bootstrap default has a consequence worth stating plainly: **a newly
created named space is world-writable, not private.** The `"*": "WRITE"` grant
is a literal entry in its ACL document, and `cf acl ls` shows it:

```bash
cf acl ls --identity ./my.key --api-url https://api.example.com --space my-space
```

That prints a bordered `DID` / `CAPABILITY` table (or `No ACL entries found.`
if the space has no ACL yet). For a space you just created it is two rows: your
own DID with `OWNER`, and `*` with `WRITE`. Grant and revoke are the other two
subcommands (`packages/cli/commands/acl.ts`):

```bash
# Grant, or change an existing grant. Capability is READ, WRITE, or OWNER.
cf acl set did:key:z6Mkk... WRITE --space my-space

# Revoke one identity — but while `*` is still present this revokes nothing;
# see the caveat below.
cf acl remove did:key:z6Mkk... --space my-space

# Drop the bootstrap wildcard — this is what makes the space private.
cf acl remove ANYONE --space my-space
```

**Drop the wildcard first, or the per-identity commands do not mean what they
look like.** The server resolves a principal's capability as *its own entry if
it has one, otherwise the wildcard's* (`#resolveCapability` in
`packages/memory/v2/server.ts`: `acl[principal] ?? acl["*"]`). While
`"*": "WRITE"` is in the ACL, that fallback is WRITE, and it produces two
counter-intuitive results:

- `cf acl remove <did>` **revokes nothing.** It deletes that identity's
  explicit entry, which drops them onto the wildcard's WRITE. `cf acl ls` will
  stop listing them and they will keep writing.
- `cf acl set <did> READ` is a **downgrade, not a grant.** An explicit entry
  shadows the wildcard, so a principal who had WRITE via `*` ends up with only
  READ. (`cf acl set <did> WRITE` changes nothing today, but is a durable grant
  that survives removing the wildcard.)

So the order that works is `cf acl remove ANYONE` first, then grant each
identity what it should have. Until the wildcard is gone, treat the space as
world-writable regardless of what the per-identity rows say.

`--identity` and `--api-url` fall back to `CF_IDENTITY` and `CF_API_URL`;
`--space` takes a space name or a DID and has no environment fallback. `ANYONE`
is the CLI spelling of the `"*"` wildcard, so the shell does not glob-expand it
before the CLI sees it — `cf acl ls` still prints the raw `*`.

All three commands act as the identity in the key file, and writing the ACL
needs OWNER, so you can only administer a space you own. Two guardrails come
from the server rather than the CLI: it refuses any mutation that would leave
the space with no concrete (non-`"*"`) OWNER, so this is not a way to lock
yourself out; and it requires an ACL change to arrive as a single
whole-document replacement, which is why `ACLManager` writes the entire ACL on
every grant. That rule and the genesis rule are catalogued as INV-12 and INV-13
in [`docs/specs/memory-v2/09-invariants.md`](../specs/memory-v2/09-invariants.md).

## Running untrusted code: three rings

Patterns are arbitrary user (often LLM-written) code operating on private
data. The containment is layered:

**Ring 1 — the compiler (Chapter 7).** Validation stages reject hostile or
unworkable constructs; emitted module-scope functions are frozen; every
handler/lift carries a schema that *declares* what it reads and writes. The
schema is a capability manifest: the runtime passes a handler exactly the
cells its context schema names — with write handles only where the schema
says `asCell` — rather than ambient access to the space.

**Ring 2 — SES.** Compiled pattern code executes inside SES (Secure
ECMAScript) compartments: hardened intrinsics, no ambient authority.
Nondeterminism and timing channels are denied at the platform layer, so the
ambient clock and entropy intrinsics — `Date.now()`, no-argument
`new Date()`, and `Math.random()` — are gated rather than freely available.
Inside a handler the runtime allows them (the clock coarsened to one-second
resolution, entropy passed through); in a `lift`/`computed` or at pattern-body
level they throw a `TimeCapabilityError`. Authored code calls these built-ins
directly; the former `safeDateNow()`/`nonPrivateRandom()` helpers that used to
wrap them are now removed. To read a live clock reactively in a computed, use
the `#now` wish. `fetch()` follows the same rule: it works only inside a
handler (elsewhere it throws), and its completion is coarsened to one-second
resolution so a network round trip cannot serve as a fine clock.

**Ring 3 — the iframe sandbox.** For fully untrusted rendered content,
`packages/iframe-sandbox` adds a process-level browser boundary with a
clever double-iframe construction: an **outer** iframe loaded via `srcdoc`
carries a strict Content-Security-Policy meta tag
(`default-src 'none'`, no form posts, no child frames, connections limited
to the host); per the CSP spec, a nested `srcdoc` document *must inherit*
those policies — so the **inner** iframe, which holds the guest code,
cannot shed them. The guest gets no direct data access at all: reads,
writes, and subscriptions cross the boundary as a postMessage IPC protocol
mediated by the host (`src/ipc.ts`), which applies policy per request. The
package README is candid that exfiltration hardening (e.g. covert channels
via permitted fetches) is ongoing work.

**Beyond the rings — Contextual Flow Control (CFC).** The rings bound what
untrusted code *can do*; CFC (`packages/runner/src/cfc/`) tracks what data
it *touched*. Every value can carry a label: **integrity atoms** recording
who or what vouches for it (`PolicyCertified`, `InjectionSafe`,
`LlmDerived`, `ExternalIngest`, ...) and **confidentiality clauses**
(conjunctive normal form, including author-written disjunctions) saying who
may observe it. The runtime derives a conservative flow join per
transaction — LLM output is stamped `LlmDerived` at the store boundary;
data arriving over vouched channels (OAuth, Plaid, the ingest endpoint of
Chapter 11) gets a runtime-minted, unforgeable `ExternalIngest` provenance
mark — and can refuse operations that would launder a label or fall below a
required-integrity floor (e.g. tool inputs that demand certified data).
Deployments dial it along four independent axes — enforcement mode
(`disabled`/`observe`/`enforce-explicit`/`enforce-strict`), flow-label
persistence (`off`/`observe`/`persist`), the write floor, and trigger-read
gating; the shell today runs `enforce-strict` with flow labels at
`persist`. The verified-source `$implRef` machinery (Chapter 7) is what
ties labels to the exact code that produced a value. Specs live in
`docs/specs/cfc-*.md`; demo patterns in `packages/patterns/cfc-*`.

The rings compose with the data layer: even code that breaks ergonomics
rules still acts *as* its session's principal, inside one space's replica,
through schema-bounded handles, with every commit journaled in the
append-only history of Chapter 9 — and, with CFC, with the provenance of
what it read and wrote labeled. Damage is scoped and auditable by
construction.

---

**Next:** [Chapter 11 — The deployed system](11-deployed-system.md): all
the layers assembled into the thing users actually run.
