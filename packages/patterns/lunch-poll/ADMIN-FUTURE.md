# Admin: future direction (CFC integrity)

## Current implementation

The first user to join stores their shared profile cell in the per-space `host`
pointer. `isAdmin` and every host-gated handler compare that cell with the
viewer's profile using `equals()`. Any joined participant can deliberately take
the seat through `claimHost`.

This is enforced at the pattern level — a determined caller can invoke a handler
with inputs they control, and profile-cell equality is not a kernel
authorization boundary. The scheduler's OCC/retry behavior makes concurrent seat
changes converge, but it does not make the host role unforgeable.

## Target direction

Authority should be modeled via **CFC integrity claims** rather than runtime
equality checks. The reference implementation landed in **PR
[#3358](https://github.com/commonfabric/labs/pull/3358) "Add CFC group chat demo
and authorship fixes"** by Berni (merged 2026-05-19), which introduces the
primitives:

```ts
// New in @commonfabric/api/cfc.ts (PR #3358):
type RepresentsCurrentUser<T> = Cfc<T, {
  addIntegrity: [
    { kind: "represents-principal"; subject: { __ctCurrentPrincipal: true } },
  ];
}>;
type AuthoredByCurrentUser<T> = Cfc<T, {
  addIntegrity: [
    { kind: "authored-by"; subject: { __ctCurrentPrincipal: true } },
  ];
}>;
```

The PR also fixes the runner so nested CFC labels survive array-item persistence
— required for "every item in a per-space list carries its own integrity claim."

## Canonical reference

`packages/patterns/cfc-group-chat-demo/` is the worked example. The shape that
translates to lunch-poll:

```ts
// Per-user pointer to my profile in the space-scoped directory.
// (The group-chat demo and scoped-user-directory verify this idiom.)
myProfile: PerUser<{ profile?: ProfileCell }>;

// The profile value carries "represents me" — the runtime checks
// the current principal against this when reading.
type TrustedProfile = RepresentsCurrentUser<
  TrustedActionWrite<ChatProfile, ...>
>;

// Each item in the per-space list carries an authorship claim that's
// verified at render time. No manual requiredIntegrity plumbing needed —
// render policy auto-infers it from the author cell type.
type TrustedSentChatMessage = AuthoredByCurrentUser<
  TrustedActionWrite<SentChatMessage<ProfileCell>, ...>
>;
```

UI rendering uses a component like `VerifiedChatBubble({ message })` which
transparently verifies the integrity claim before showing trusted content.

## Translation for lunch-poll

When the wiring lands, the lunch-poll equivalents would be roughly:

- `users: PerSpace<TrustedProfile[]>` — directory entries carry
  `RepresentsCurrentUser` and a `TrustedActionWrite` constraint on the
  profile-save handler.
- `votes: PerSpace<AuthoredByCurrentUser<Vote>[]>` — each vote is
  signed-by-construction; spoofing another user's vote is rejected at the kernel
  before persistence.
- `options: PerSpace<...>` — write-gate this on an admin integrity claim. Exact
  shape TBD; likely a separate `IsAdmin` integrity claim added to the admin's
  profile on first-join, and `RequiresIntegrity<...,
  ["IsAdmin"]>` on the
  options/votes-reset write paths.
- The pattern-level profile-cell comparison becomes UX-only — hide the admin UI
  when the viewer doesn't carry the claim, while the write authorization moves
  to the kernel.

## Path forward

Keep profile-cell equality for joined/host presentation and ordinary UX. Move
the actual security boundary to CFC labels on the write paths, with
`cfc-group-chat-demo` as the reference for the exact API shape. The retired
`adminName` surface is not part of that transition.

## Cross-references

- [PR #3358](https://github.com/commonfabric/labs/pull/3358) — the enabling
  work. `packages/patterns/cfc-group-chat-demo/trusted.tsx` is the most
  condensed reference for the layered type shape.
- [`packages/patterns/scoped-user-directory/`](../scoped-user-directory/) —
  verified that the per-user-pointer-into-per-space-directory idiom works; this
  is the structural baseline that PR #3358's chat demo also uses (just with
  CFC-typed value wrappers).
- [`docs/history/development/scoped-cells-field-notes.md`](../../../docs/history/development/scoped-cells-field-notes.md)
  — session notes from the original lunch-poll build, including the OCC + retry
  guarantees the current admin-claim flow relies on.
