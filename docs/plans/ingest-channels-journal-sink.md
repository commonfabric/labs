# Ingest Channels and the Journal Sink

*A minted, bearer-authed inbound endpoint whose payload can be durably accumulated as a provenance-marked, append-only record log — the generic capability behind webhooks, the location beacon, and any DID-less external source.*

**Status:** proposed · **the memory ACL default is now `enforce`; Estuary must configure operator DID `did:key:z6MkjUMJxa2ra9wfFjXY1CcbxGrxGGrwSWV7bKsD7Kb5vNqq` in `MEMORY_SERVICE_DIDS` (or provision per-space grants) before relying on cross-space ingest** · **Updated:** 2026-07-10

Builds directly on the landed vouched-ingest primitive (labs #4392): the
runtime-minted `ExternalIngest` mark + `custodyIngest`. See the
[vouched-ingest channel mint design](../features/vouched-ingest-channel-mint.md) for
the split-mint seam this stands on.

---

## Why

An outside source with no runtime of its own — a phone location beacon, a GitHub webhook, an OAuth refresh, a wearable, an inbound-mail gateway — needs to durably deposit data into your fabric while your laptop is closed. Today every version of this is half-built and inconsistent:

- **Webhooks** take the POST but `sendToStream`-**dispatch** it (a transient event; `cell.ts:1235` queues a scheduler event and notifies in-memory listeners — it never persists a readable history). Consumers that want the *history* of what arrived have nothing to read.
- **OAuth and Plaid** each hand-rolled a durable write, now unified onto `custodyIngest` — but by direct library calls, not a general inbound endpoint.
- **Nothing** that arrives over any of these paths is marked as having come from outside — once it lands it is indistinguishable from data your own patterns wrote.

The forcing case is the **ambient-context location beacon**: the phone posts location points over HTTP because it has no runtime, and an agent reading your data must be able to tell "a third party sent this over the phone" apart from "I computed this myself." But the *need* is general — it is "durably ingest a sequence of externally-sourced records, with attached provenance, addressable by consumers as an accumulated log."

The missing piece is one generic capability. We already have the trust primitive (`ExternalIngest` + `custodyIngest`); what's missing is the **inbound endpoint that mints a durable, marked log** and a name for it that isn't tied to any one source.

## The shape — what you mint

You mint an **ingest channel**: a bearer-authed inbound HTTP endpoint bound to a target cell you provide (in your own space). It reuses the webhook *token* machinery — the registry in the toolshed service space, id + secret generation, SHA-256 hash, timing-safe verify with the dummy-hash timing-oracle guard (`webhooks.handlers.ts`, `webhooks.utils.ts`).

The **lifecycle** is its own, and deliberately not webhooks': `mint`/`list`/`rotate`/`revoke` on the `/api/ingest-channels` prefix, authenticated by a first-party request proof and authorized against the target space's ACL. Revocation is a soft disable rather than webhooks' hard delete, because a registration here records who was authorized to write provenance-marked data into a user's space — that record has to survive. See [self-serve-ingest-channels.md](../features/self-serve-ingest-channels.md).

An ingest channel has a **sink** — where an inbound POST lands.

## Sinks: `stream` vs `journal`

| | `stream` (today's webhook) | `journal` (new) |
|---|---|---|
| Write | `sendToStream` → `.send()` | `custodyIngest.update` append |
| Semantics | transient event dispatch to handlers | durable, append-only record log |
| Readable history | no (fire-and-react) | yes (an accumulated array cell) |
| Provenance mark | none | `ExternalIngest`, minted per POST |
| Good for | "notify me when X arrives" | "keep the marked history of what arrived" |

`stream` and `journal` are genuinely different artifacts — a CF `stream` does not accumulate a readable history, so "just read the stream" is not an option for a consumer that needs the trail. `journal` is **additive**: existing `stream` consumers are untouched, so this is a non-breaking way to also deliver the long-deferred webhook provenance retrofit.

## The `journal` sink — how it works

One inbound POST → exactly one governed durable write:

```
custodyIngest.update(targetCell, current => [...(current ?? []), ...records], channel)
```

- `custodyIngest.update` (`custody-ingest.ts:169-180`) runs its mutate **inside** `editWithRetry`, re-reading the current array on every retry — no lost update under concurrent POSTs.
- It mints one `ExternalIngest` mark per POST, bound to the digest of the written value, anchored at the target cell root (works for array appends, which diff element-wise and never touch the array path itself).
- The mark records `{ channel, audience, receivedAt, valueDigest }`; `channel` = the target cell's space, `audience` = a fixed source string. `receivedAt` is operator wall-clock captured before the write (never from the payload).
- The sink does **no deduplication** — it appends. Idempotency is a consumer/read-side concern (see [Cross-repo contract](#cross-repo-contract-loom-read-side)).

**Partitioning is a client concern, not server logic.** For a high-volume trail (Berni's steer: "array-push isn't the right abstraction for a large continuous trail"), the caller addresses a **leaf** under the channel's registered base cell — e.g. one cell per UTC day. The client (which knows each record's timestamp) names the leaf; a batch spanning a partition boundary is split client-side into one POST per leaf. The server never parses payload fields to route. The leaf is **validated** (fixed charset / pattern, no traversal, strictly confined to the registered base path and space) — see [Security](#security-model--the-create-authorization-gap).

## Location is a consumer — zero labs-side location code

The location beacon is *not* a feature in labs. It is an ingest channel with a `journal` sink:

1. A `journal` ingest channel is registered, its target base a cell in the user's location space.
2. The iOS beacon batches `location.point` records and POSTs each UTC day's batch to that day's leaf (`.../<YYYY-MM-DD>`), one POST per day.
3. The `journal` sink durably appends the lean points, marked, into the day cell.
4. loom's read side wraps the lean points into `loom.source-record.v1` envelopes **on read** and dedups on `point_id`.

Nothing named "location", "trail", or any loom schema lives in labs.

## Layering — labs stores lean, loom wraps on read

labs stores the **lean** records value-for-value as parsed from the wire (zero labs-added fields; values round-trip through JSON unchanged — e.g. lat/lng decimal strings stay strings). This is *value-preserving after JSON parse*, **not raw-byte-identical**: the handler parses JSON and the provenance digest is over the JSON serialization, not the request bytes (binding the raw bytes is a future hardening). The `loom.source-record.v1` envelope — its `recordId` convention, `canonical_json`, and `versionId` — stays entirely in loom, on its read/import side, which already owns that schema and its Python hashing. This keeps the dependency direction correct (labs is upstream of loom; loom vendors labs) and deletes the TS↔Python `canonical_json` parity burden entirely.

Provenance at rest is the runtime-minted `ExternalIngest` mark — stronger and fabric-native — not the envelope.

## What's reused vs. new (minimized surface)

**Reused verbatim (zero new runtime primitives):**
- `custodyIngest.update` — the entire write path.
- The webhook bearer-auth flow: Bearer-present→401, registration lookup→502-on-storage-error, missing/disabled→dummy-hash-equalized verify→401, timing-safe verify→401 (`webhooks.handlers.ts:106-135`).
- The service-space registry: get/save/delete + per-space index, keyed by `identity.did()` (`webhooks.utils.ts`).
- The caller-cell resolution idiom (`getCellFromLink → asSchema → sync → synced`) and the `VouchedChannel` shape (OAuth precedent, `oauth2-common.utils.ts`).

**Genuinely new, and small:**
- A `sink: "stream" | "journal"` field on the channel registration and one write-branch on ingest.
- Validated **leaf-addressing**: a POST names a sub-path leaf appended to the registered base (charset/pattern-checked, traversal-guarded, confined to base+space).
- The `journal` write itself (one `custodyIngest.update` per POST).

## Naming

- **ingest channel** — the capability. Aligns with the existing vocabulary: the mark is `ExternalIngest`, the primitive `custodyIngest`, the mark records a `channel`, and the umbrella proposal is "vouched ingest channel." Replaces both "webhook" and any "location endpoint" as the umbrella concept.
- **`journal`** — the durable sink. Chosen over "trail" (a location-domain leak from "location trail") and over "log" (which collides with the toolshed's pervasive logger vocabulary). "journal" carries the right connotation — durable, ordered, append-only, integrity-flavored.
- **`stream`** kept for the existing dispatch sink; it accurately names what it is.

## Security model & the create-authorization gap

- **Blast radius is the registered target.** A channel's bearer token can only write within its registered base cell + space (plus a validated leaf under it) — the same blast radius as a webhook today.
- **The mark cannot be forged.** The payload is written under the ordinary member identity and gated (`gateRuntimeMintedIntegrity` strips any smuggled `ExternalIngest`); the trusted mark comes only from the runtime's builtin mint step. Sandboxed pattern code cannot mint it.
- **~~Open gap~~ — confused-deputy on create. CLOSED.** Creation was unauthed with a self-asserted `createdBy`, inherited from webhooks. Harmless-ish for a `stream` webhook; **not** acceptable for a `journal` sink, which writes *provenance-marked* data into a caller-named user space — anyone reaching create could register a channel targeting *another* user's space and get legitimately-minted marks written there. `journal`-sink creation now requires a verified caller principal plus an explicit `OWNER` grant for that DID on the target space's ACL; see decision 2 below and [self-serve-ingest-channels.md](../features/self-serve-ingest-channels.md). The `stream` sink still creates through the webhook route and inherits the old behavior.
- **Honest limit.** The toolshed runtime is `as: identity` and sees plaintext; the split-mint protects the *mark*, not the *bytes*. Estuary now holds and appends over plaintext record data as an operator-trusted process; a signer-key compromise is a cross-user breach + the ability to write marked fabricated records. Document in the custody/data-flow docs; treat the signer key as high-value.

## The cross-space commit gate (blocker A) — resolved: buildable now, latent dependency later

"No laptop in the write path" requires the toolshed operator identity to `merkle-causal-commit` into the **user's** space. An investigation settled this (high confidence, from code + config):

**Buildable with operator authority configured.** Memory-layer write authorization is governed by `MEMORY_ACL_MODE`, which now **defaults to `enforce`**. An explicit `off` override preserves the historical bypass, but it is no longer the unset behavior. The toolshed operator therefore needs `MEMORY_SERVICE_DIDS` authority (or a per-space grant) to commit into a user's space over the same `editWithRetry → transact` path webhooks already use (`sendToStream`, `webhooks.utils.ts:230-240`) and that `custodyIngest` rides (`custody-ingest.ts:79,83`). This is the **memory ACL**, distinct from CFC enforcement (`cfcEnforcementMode`), which enforces integrity/confidentiality *labels*, not space ownership — the mark mints fine regardless.

**Dependency on operator authority.** Under the default enforcement mode, the journal sink is **rejected** unless the operator DID is in `MEMORY_SERVICE_DIDS` (implicit cross-space OWNER) or the user's space carries an explicit ACL grant. Missing ACL on populated legacy data is temporarily authenticated-public READ/WRITE, but newly created spaces require an ACL genesis before any ordinary write; a service DID may perform that initialization but may not bypass it with data. `observe` mode still permits ordinary capability shortfalls on valid existing ACLs, while fresh-space genesis and ACL validity remain hard invariants.

**Two caveats.** (1) The webhook precedent is weaker than it looks: loom currently derives all identities from a shared "common user" passphrase (`link-foreign-cells.ts:107`), so "cross-space" there is degenerate — the off-mode path is proven, but authorization across *genuinely distinct* principals is not. (2) There is **zero** cross-space test coverage (`custody-ingest.test.ts:36` writes to `signer.did()` only, via `StorageManager.emulate` with no ACL layer) — a regression would pass CI silently, so the journal sink's tests must exercise a foreign-space write.

**Pre-flip ops snapshot (2026-07-02).** Estuary's `MEMORY_ACL_MODE` was unset under the former `off` default and `MEMORY_SERVICE_DIDS` was empty; the Estuary toolshed operator DID is `did:key:z6MkjUMJxa2ra9wfFjXY1CcbxGrxGGrwSWV7bKsD7Kb5vNqq`. **Deployment checklist under the new default:** add that operator DID to `MEMORY_SERVICE_DIDS` (or provision equivalent per-space grants), and preferably run an explicit `observe` canary while grepping `wouldDeny` for it — otherwise hosted ingest into newly ACL-protected user spaces fails.

## Cross-repo contract (loom read side)

The seam requires these changes on loom's side (Workstream A/D-read):

1. **Wrap on read, in memory.** `readStableCellValue` → `build_location_record(point, install_id)` per lean point, fed to the resolver directly; **do not** materialize into the local `SqliteSourceStore`.
2. **Delete plan invariant 2** (TS↔Python `canonical_json` parity + the lat/lng float pin); resolve open question #6 as "wrap on loom import side." `versionId` is Python-only.
3. **Tri-state read seam** (for the absent/empty/has-points honesty rule): labs guarantees a day cell exists only after the first real point (never pre-created empty), so cell-resolves-to-`undefined` = ABSENT ("never captured"), value-is-`[]` = EMPTY ("no signal at T"). The resolver must distinguish them (today it collapses both → unknown).
4. **`install_id` join** comes from the channel registration at read time, never from the lean point; a missing `install_id` is a hard error in production, not a `local-dev` fallback.
5. **Dedup on read** — the `journal` sink appends; `point_id` idempotency is loom's on import.
6. **Day-cell addressing** — day = UTC date of `point.ts` (`YYYY-MM-DD`); one point → one cell; midnight-spanning batches split client-side (one POST per UTC day). The read helper enumerates the same day cells.
7. **Cell-id derivation (load-bearing).** A partition cell is `runtime.getCell(userSpace, "${causePrefix}/${partition}", schema)`; its document id is `of:` + the fabric `fid1` hash of the causal reference built from the cause string `${causePrefix}/${partition}` (e.g. cause `location/2026-07-01` → `of:fid1:d7_RmD4fNpTUheithVm0Q1Vha0Rn32c06qA_hOHE8x8`). loom's reader must compute the **same** id to read the cell — it should reuse the shared fabric hasher, not reimplement `fid1` in Python, since a byte-level mismatch silently orphans the read path. A golden-id test (`ingest.utils.test.ts`) pins this so any hash-format drift fails CI loudly. Both `causePrefix` and `partition` are constrained to a single clean segment (`^[A-Za-z0-9._-]{1,64}$`, never `.`/`..`) so the two sides derive identical ids.

## Open decisions

1. **Packaging** — a generically-named `POST /api/ingest` carrying `sink: "stream" | "journal"` (recommended; `/api/webhooks` misdescribes the general capability) vs. extending the webhook route in place. Either way the auth/registry helpers are shared. *Still open for the `stream` sink.*
2. ~~**Journal-creation auth**~~ — **RESOLVED.** Creation requires a real caller principal (a first-party request proof) *and* an explicit `OWNER` grant for that DID on the target space's ACL. See [self-serve-ingest-channels.md](../features/self-serve-ingest-channels.md). The control plane is a separate prefix, `/api/ingest-channels`, so the data plane's wildcard CORS never covers it.

## Acceptance / test plan

- **Laptop-out-of-the-loop:** with any user runtime stopped, a `curl` POST to the endpoint durably appends, verified by reading the cell from a *different* host.
- **Absent ≠ empty:** a never-written day cell reads back as `undefined` (ABSENT), not `[]`; the create path writes no day cell.
- **Mark present (hard gate):** after ingest the appended records carry the `ExternalIngest` mark; fail the build if absent.
- **Payload purity:** records at rest deep-equal the POSTed body with no labs-added fields.
- **Auth contract:** identical 401 body across missing-token / missing-registration / wrong-token, so nothing a guesser can reach distinguishes them. A *correct* token (current or the one most recently rotated away from) presented to a disabled, revoked or expired channel is the one deliberate exception: an actionable 403 "re-pair this device", unreachable without proof-of-possession. Storage-error → 502 (not 401); resolve/commit failure → 502.
- **Hostile leaf:** `../`, empty, malformed → 400, no write.
- **Concurrency:** concurrent POSTs to the same day cell all land (no lost update); retry-exhaustion returns a loud retryable error, never a silent 200.

## Alternatives considered & rejected

- **A dedicated `routes/location/` route** (a 14-agent workflow's initial pick) — bakes location/loom concepts into labs and duplicates the webhook auth/registry. Rejected: nothing is irreducibly location-specific once per-day and dedup move to the client/reader.
- **Extend webhooks with an overloaded `cellLink`** (a "namespace prefix" for trails vs "fixed leaf" for streams) — flagged by security + cross-repo review as a write-scope/provenance-anchor hazard (`remove`'s `extractSpaceFromCellLink` mis-resolves). Rejected in favor of a uniform target + a separate validated leaf.
- **Build the `loom.source-record.v1` envelope at write time in labs** — inverts the labs→loom dependency and imposes TS↔Python hash parity. Rejected: loom wraps on read.
- **Call the durable sink `stream`** — a CF `stream` is transient dispatch with no readable history (`cell.ts:1235`); conflating them would mislead consumers.

## Out of scope

- Per-service identities / owner-granted, revocable access (the deferred grant/delegation work).
- Ingest where the runtime never sees the raw bytes (Estuary is operator-trusted v1).
- Per-record (vs per-POST) provenance attestation — would need `custodyIngest.append` (N marks); a future fork.
- Retention/GC of old journal partitions (a future generic trail-management concern).
- **Intra-partition size cap.** `appendToJournal` does `[...current, ...records]` with no per-partition ceiling, and `custodyIngest.update` re-serializes the whole value each write, so sustained appends to one partition are O(N²) and grow unbounded within per-POST limits. Confined to the token holder's own space and bounded in practice by per-day partitioning (one UTC day of genuine traffic); a cheap element-count backstop is a tracked follow-up, not v1.
- **Extracting the shared bearer-auth crypto + registry.** (Still deferred: self-serve create landed without merging the registries, since the two stored-hash encodings must be format-tagged or migrated first — see the fast-follow below.) `verifyIngestSecret`, `randomBase62`, and the service-space registry are copied from `webhooks.utils.ts` (the proven path). A `lib/ingest-registry.ts` extraction shared by both routes is the fast-follow that avoids drift — deferred with the self-serve create work to keep this PR from churning shipped, re-vendored webhook code.

## Fast-follows (tracked, post-v1)

From the branch critique's P2 list — deliberately NOT in this PR; each has a named trigger:

- **Extract shared bearer-secret crypto** into `lib/channel-secret.ts` — *trigger: the next PR touching either route.* Webhooks keep their async hex `sha256`, ingest its sync base64url; the two stored-hash encodings must be format-tagged or migrated before any registry merge. (Same item as the shared-crypto bullet in Out of scope.)
- **Per-partition element-count backstop** (~50k) inside the `custodyIngest.update` closure, mapped to a loud 413 — *trigger: before any always-on beacon ships.* Never re-partition server-side. (Same item as the intra-partition size cap in Out of scope.)
- ~~**Revocation**~~ — **DONE**, and better than the planned `--disable` flag: `POST /api/ingest-channels/revoke` (`cf ingest revoke`) flips `enabled: false` and records `revoked: {at, by}` as an audit record rather than deleting. Rotation is `cf ingest rotate`.
- **Test gaps** (opportunistic): a `>1 MB` `app.request` asserting the 413 bodyLimit body; a second-append test pinning mark coalescing per (path, origin) (`prepare.ts`); dedup the `ingestMarks` test helper into shared support.
- **Per-install rate limiting** (429) on the *data plane* — loom's `plan.md` Workstream-D step 3 specifies it; ingest still has only the body cap + `MAX_BATCH`. The *control* plane is now rate-limited (`packages/toolshed/lib/rate-limit.ts`, keyed by client address — a DID-keyed bucket is useless since DIDs are free to generate). Still deferred for ingest itself.
- **Provisioning identity footgun** — the script writes into the service space of whatever identity its `.env` yields; a mismatch provisions into the wrong space and every POST 401s with no diagnostic. Add a usage note: run with the same `.env`/identity as the target toolshed.
- **Idempotency / replay guidance for generic consumers** (Wilk) — the journal sink does no server-side dedup, so a retried POST re-appends. Document the read-side idempotency contract (dedup on a stable record key — loom's `point_id`) so a generic, non-location consumer knows replay handling is its responsibility.
