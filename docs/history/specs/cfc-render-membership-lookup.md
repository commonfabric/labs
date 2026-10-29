---
status: historical
created: 2026-07-07
archived: 2026-07-08
reason: "Design record; all four implementation stages landed."
---

# CFC render membership lookup (§4.9.3) — design

**Status:** implemented (stages 1–4, this branch). Follow-up to Epic H3b (PR
#4572, merged). Replaces the H3b render resolver's static `memberSpaces`
heuristic with a verified per-space membership lookup, so cross-space
`Space(...)` labels resolve for principals who genuinely read the space — never
from a cell's mere local residency.

**Implementation map (all four stages landed):**

- **Stage 1 — capability resolver:** `spaceReaderRole` in
  [space-membership.ts](../../../runtime/runner/src/cfc/space-membership.ts),
  tested in `packages/runner/test/cfc-space-membership.test.ts`.
- **Stage 2 — provider + per-label discovery:**
  `createRuntimeSpaceMembershipProvider` (sync `readerRole` + change-only
  `subscribe`) in the same file, and `spaceAtomIdsInConfidentiality` +
  per-label mint in
  [render-ceiling.ts](../../../runtime/runner/src/cfc/render-ceiling.ts), tested
  in `cfc-space-membership.test.ts` and `cfc-render-ceiling.test.ts`.
- **Stage 3 — wiring:** `renderConfidentialityResolverFor` /
  `renderMembershipProviderFor` in
  [runtime-processor.ts](../../../packages/runtime-client/backends/runtime-processor.ts),
  tested in `runtime-processor.test.ts`.
- **Stage 4 — reactive re-render:** the worker
  [reconciler](../../../runtime/html/src/worker/reconciler.ts) subscribes a gated
  `Space(X)` cell to X's ACL doc within its cancel group and re-evaluates the
  gate on change (`renderCellChild`), tested in
  `packages/html/test/worker-reconciler-cfc-render-policy.test.ts`. Reused the
  reconciler's existing `.sink` + `useCancelGroup` machinery — no
  core-reactivity change was needed.

The design below is retained as the record of intent; the spec/Lean obligations
in §7–§8 remain outgoing follow-ups.

## 1. Problem

H3b's render ceiling resolves a `Space(X)` confidentiality atom to
`User(actingUser)` when the acting user holds `HasRole(actingUser, X, reader)`
(spec §4.3.3 SpaceReaderAccess). H3b mints that `HasRole` fact only from a
static `memberSpaces` set, currently the acting user's own identity space +
the session workspace ([runtime-processor.ts `renderConfidentialityResolverFor`](../../../packages/runtime-client/backends/runtime-processor.ts)).
Any other space fails closed (over-blocks). The residual: a real §4.9.3
`lookupMembership(space, actingUser)` so cross-space content the user actually
reads renders.

The soundness invariant (H3b commit `4fc05f800`, and the adversarial-review
finding behind it): **residency is not read authority.** Under the default
`MEMORY_ACL_MODE="off"` a runtime can sync a space's bytes without the acting
user being an authorized reader, so the lookup must read the space's declared
membership, never infer it from the fact that a cell is locally resident.

## 2. What already exists (do not rebuild)

- **The authority record.** One ACL document per space, entity id
  `of:${space}` (== the space DID), value
  `ACL = { [DID | "*"]: "READ" | "WRITE" | "OWNER" }`
  ([memory/interface.ts], helpers `isACL` / `isCapable` / `ANYONE_USER` in
  [memory/acl.ts]). Server resolution
  ([server.ts `#resolveCapability`](../../../runtime/memory/v2/server.ts)):
  implicit `OWNER` if `principal === space` or a service DID; else
  `acl[principal] ?? acl["*"] ?? null`; missing/malformed → `null` (fail
  closed). Capability order `READ(0) < WRITE(1) < OWNER(2)`.
- **A client reader.** [`ACLManager`](../../../runtime/runner/src/acl-manager.ts)
  already reads that doc from the worker via
  `getCellFromLink({ id: spaceDid, path: [], space: spaceDid })` (its `.get()`
  is async — awaits `sync()`).
- **A sync-read + background-sync primitive.**
  [`Cell.get()`](../../../runtime/runner/src/cell.ts) reads the local value
  synchronously and, when not yet synced, kicks a background sync
  (`if (!this.synced) this.sync(); // No await`).
- **The exchange rule.** `space-reader-access-display` in
  [render-ceiling.ts](../../../runtime/runner/src/cfc/render-ceiling.ts)
  (`Space($s)` + `HasRole($p,$s,reader)` under a display boundary → add
  `User($p)`), formalized as `exchangeSpaceReader` in
  `~/src/specs/cfc/formal/Cfc/Exchange.lean`.
- **`HasRole` is runtime-mint-only** (`RUNTIME_MINTED_INTEGRITY_ATOM_TYPES`,
  prepare.ts) — patterns cannot forge it. Only the verified *source* is
  missing; no new atom, rule, or mint-gate change is needed.

**No reverse index exists.** Membership is per-`(principal, space)` checkable
only — matching the spec's `lookupMembership(space, user)` point query. So the
resolver must discover candidate spaces from the *label being rendered*, not
enumerate a member set.

## 3. Design

### 3.1 Capability resolver (runner)

New `packages/runner/src/cfc/space-membership.ts`:

```ts
// Shown for illustration only.
import { type ACL, type Capability, isACL, isCapable, ANYONE_USER }
  from "@commonfabric/memory/acl";

/** A principal's role in a space, or null if none (fail-closed). */
export type SpaceRole = "owner" | "writer" | "reader";

/** Mirror of the server's #resolveCapability, client-side (spec §3.6.2). */
export const spaceReaderRole = (
  acl: ACL | undefined,          // the space's ACL doc value (undefined = not read)
  space: string,
  principal: string,
  serviceDids: readonly string[] = [],
): SpaceRole | null => {
  // Implicit OWNER: you own your own identity space; service principals.
  if (principal === space || serviceDids.includes(principal)) return "owner";
  if (!isACL(acl)) return null;                       // missing/malformed → fail closed
  const cap = (acl as Record<string, Capability | undefined>)[principal] ??
    (acl as Record<string, Capability | undefined>)[ANYONE_USER];
  if (cap === undefined) return null;
  if (!isCapable(cap, "READ")) return null;           // WRITE/OWNER imply READ
  return capToRole(cap);                              // READ→reader, WRITE→writer, OWNER→owner
};
```

Reusing `@commonfabric/memory/acl` keeps the client check byte-identical to the
server's authority decision — the two must never drift.

### 3.2 Membership provider

The resolver needs a *synchronous* membership answer at render time (the render
fit runs inside a `cell.sink` callback). The provider gives a sync snapshot
plus a subscription for reactive re-render:

```ts
// Shown for illustration only.
export interface SpaceMembershipProvider {
  /** Sync role snapshot for (principal, space) from the local replica; null =
   *  not-yet-known-or-not-a-member (both fail closed). Kicks a background sync
   *  when the ACL doc is absent, so a later reactive tick can upgrade. */
  readerRole(space: string): SpaceRole | null;
  /** Subscribe to a space's ACL doc; `onChange` fires when it syncs/changes,
   *  so a gated render re-evaluates. Returns a cancel. */
  subscribe(space: string, onChange: () => void): Cancel;
}
```

Backed by the runtime: `readerRole(space)` reads the space-DID cell
(`getCellFromLink({ id: space, path: [], space })`) via `Cell.get()` (sync +
background-sync kick), runs `spaceReaderRole`, and memoizes per
`(space, principal)` (mirroring the server's `#aclCapabilities` cache),
invalidated on the ACL cell's change. `subscribe` is `aclCell.sink(onChange)`.

### 3.3 Per-label candidate discovery

The render resolver already receives the cell's confidentiality label. Change
`createRenderConfidentialityResolver` from a static `memberSpaces` list to a
per-label mint:

1. Extract the `Space(id)` atoms present in the label's clauses (including
   inside `anyOf` — §4.3.4 multi-binding gives one access path per role held).
2. For each, `provider.readerRole(id)`; when `!== null`, mint
   `cfcAtom.hasRole(actingPrincipal, id, "reader")` (a reader-or-higher role
   satisfies the reader guard — `isCapable` already collapsed the ranks).
3. Feed the minted facts as `integrity` to `evaluateExchangeRules` exactly as
   today. Own-space + session-space stay a fast path (no ACL read: own space is
   implicit OWNER; the session space was gated by `session.open`).

This also yields §4.9.4 (per-user content in a shared space) for free: a value
carrying both `Space(Team)` and `PersonalSpace(User)` gets an independent
verified fact per space; both must resolve for the value to fit.

### 3.4 The async→sync / reactive bridge (the hard part)

The fit is synchronous; the ACL read may need a sync. Two stages:

- **Stage 1 (sound, self-contained):** `readerRole` does a sync `Cell.get()` of
  the ACL doc. If present + grants READ → resolve. If absent → mint nothing
  (fail closed → over-block) **and** the `.get()` has kicked a background sync.
  This is always sound (declared authority or nothing; never residency).
- **Stage 2 (precision):** when the reconciler gates a `Space(X)`-labeled cell
  through the resolver, it also `subscribe`s to X's ACL doc within the cell's
  existing `useCancelGroup`, re-rendering when the ACL syncs/changes. This
  upgrades the Stage-1 over-block to an eventual admit without a
  core-reactivity change — it reuses the reconciler's `.sink` + cancel-group
  machinery. (Implement Stage 1 first; land Stage 2 behind the same flag.)

### 3.5 Wiring

`renderConfidentialityResolverFor(runtime, identity, ceiling, sessionSpace)`
builds a `SpaceMembershipProvider` from the runtime (it already has
`storageManager` + acting principal + `serviceDids` if configured) and passes
it to `createRenderConfidentialityResolver`. The own-space + session-space
fast path stays as verified facts (they need no ACL read).

## 4. Soundness & the ACL-mode coupling

Reading the ACL doc is the *authority* check (not residency). Its trust tracks
`MEMORY_ACL_MODE`:

- `enforce` — the ACL is authoritative; the server rejects non-reader
  session.open/query, and revokes on change. The render lookup is exact.
- `observe` — the ACL is evaluated + diagnosed but not enforced; the render
  lookup reads the same declared record (creator-seeded ownership), giving
  correct precision ahead of enforcement.
- `off` (today's default) — declared-but-unenforced. The render lookup still
  reads the ACL doc (creator-seeded OWNER, OWNER-gated writes) — strictly
  better than residency, but only as strong as the deployment's posture.

State this coupling in the docstring: the render gate's cross-space guarantee
is exactly as strong as `MEMORY_ACL_MODE`. This argues for advancing the ACL
rollout (`off → observe → enforce`) alongside the render-ceiling dogfood.

Fail-closed everywhere: missing/malformed ACL, unsynced doc, or unknown
principal → no `HasRole` fact → `Space(X)` stays outside the ceiling → blocked.

## 5. Staged implementation plan

1. **Capability resolver** — `space-membership.ts` `spaceReaderRole` (pure) +
   unit tests over ACL fixtures (own space, service DID, reader/writer/owner,
   ANYONE, missing, malformed).
2. **Provider + per-label discovery** — the runtime-backed provider (sync read
   + memo) and the label→Space-atoms extraction; refactor
   `createRenderConfidentialityResolver` to mint per-label from the provider
   (keep static `memberSpaces` as an accepted fast-path input for tests/own +
   session space). Runner unit tests: a Space label resolves iff the fixture
   ACL grants the acting principal READ+; residency (an unsynced/absent ACL)
   stays blocked.
3. **Wiring** — `renderConfidentialityResolverFor` builds the provider; keep
   own/session fast path. runtime-processor helper test.
4. **Stage-2 reactive re-render** — reconciler subscribes gated `Space(X)`
   cells to X's ACL doc; re-render on change. html reconciler test: a cell
   blocked before its ACL syncs renders after the ACL grants READ.

Each stage is independently landable; Stage 1–3 deliver the sound lookup,
Stage 4 the precision upgrade.

## 6. Test plan

- `packages/runner/test/cfc-space-membership.test.ts` — `spaceReaderRole`
  truth table; provider sync-read + fail-closed on absent ACL; per-label mint
  (multiple Space atoms → per-space facts; §4.9.4 conjunctive).
- `packages/runner/test/cfc-render-ceiling.test.ts` — extend: a Space label
  resolves through a provider-supplied reader role; residency (no ACL) blocks.
- `packages/runtime-client/backends/runtime-processor.test.ts` — the helper
  builds a provider-backed resolver; own space resolves, an ACL-granted space
  resolves, an ACL-denied space blocks.
- `packages/html/test/worker-reconciler-cfc-render-policy.test.ts` — Stage 2:
  re-render on ACL sync/change.

## 7. Spec updates (`~/src/specs/cfc`)

- **§4.9.3** — replace the `lookupMembership` black box with the concrete
  ACL-doc-backed lookup: membership is the per-space ACL record
  (`{ principal → capability }`, implicit owner for own space + service
  principals, `"*"` for public), `HasRole(user, space, role)` minted iff
  `isCapable(acl[user] ?? acl["*"], READ)`; fail-closed on absent/malformed;
  no reverse index (per-`(principal, space)` point query).
- **§18** — a `CfcTrustedRenderProfile` sub-section for the render membership
  lookup: sync-snapshot-from-replica + reactive upgrade, and the explicit
  coupling of its guarantee to the deployment ACL mode.
- **§15** — register `AddMemberIntent` as an atom (it appears only as a §3.6.3
  exchange-rule guard today) with its params (`newUser`, `role`) and minter,
  or note it as an intent consumed by the membership-mutation path.
- **cfc-spec-changes.md** — track the above as an outgoing PR to
  `commontoolsinc/specs`.

## 8. Formal proof obligations (Lean4, `~/src/specs/cfc/formal`)

Build on the existing `Cfc/Access.lean` (`Principal`, `canAccess`) and
`Cfc/Exchange.lean` (`exchangeSpaceReader`, `hasSpaceReaderRoleB`). Add a
membership/ACL model + the soundness theorem that the lookup only ever admits a
`Space(X)` clause to a *verified reader*:

- **Model.** `Capability := READ | WRITE | OWNER` with `isCapable`; `ACL := DID
  → Option Capability` (plus `"*"`); `readerOf (acl) (space) (p) : Prop` :=
  implicit-owner ∨ `isCapable (acl p ?? acl "*") READ`. `roleFacts (acl)
  (acting) (space) : IntegLabel` mints `HasRole(acting, space, reader)` iff
  `readerOf acl space acting`, else `[]`.
- **T1 (soundness — no residency admission).** For the render evaluation
  `exchangeSpaceReader acting boundary (label with avail := roleFacts acl
  acting …)`: if the rewrite adds `User(acting)` to a `Space(X)` clause, then
  `readerOf acl X acting`. I.e. the resolver never admits a space the ACL does
  not grant — the residency-independence property the H3b review demanded,
  proved rather than asserted.
- **T2 (completeness — verified readers do resolve).** If `readerOf acl X
  acting`, then `Space(X)` (as the sole clause) is admitted to `Principal {
  atoms := [User acting] }` after the rewrite — i.e. the lookup does not
  over-block a genuine reader.
- **T3 (§4.9.4 conjunctive cross-space).** A label `{ Space(Team) ∧
  PersonalSpace(User) }` is admitted to `acting` iff `readerOf acl Team acting
  ∧ readerOf acl (PersonalSpace User) acting`.

All theorems must `lake build` clean under `leanprover/lean4:v4.26.0`. Prefer
reusing `satisfies_mono_atoms` / `canAccessConf_*` from `Access.lean`.

## 9. Open questions

- **Refresh cadence.** Stage 1 memoizes per session; Stage 2's subscription
  invalidates on ACL change. Is per-mount subscription enough, or does a
  long-lived render need the provider to own the subscriptions? (Lean into the
  reconciler cancel-group ownership.)
- **Service DIDs client-side.** The server has `MEMORY_SERVICE_DIDS`; the
  worker resolver needs the same list to grant implicit OWNER to service
  principals. Thread it through `InitializationData`, or omit (services rarely
  render). Default: omit; document.
- **Cross-space ACL availability.** Reading X's ACL requires X's ACL doc to be
  syncable by the worker. Under `enforce` this itself needs READ on X (fine —
  a reader can read the ACL). Under `off` it syncs freely. Confirm the ACL doc
  is world-readable-within-the-space (it is: same space, READ-gated).
