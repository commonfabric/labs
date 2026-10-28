---
status: historical
created: 2026-10-28
archived: 2026-10-28
reason: "Contract and scope decisions for the proposed integration of PR 8235 into main."
---

# FabriChat: integrating independent behavior

PR 8235 proposes a small set of independent FabriChat behaviors on the
upstream room and manager implementation. Dan directed the integration to
accept settled specification decisions, preserve meaningful behavior, and
remove unnecessary support changes outside FabriChat. This records the
proposed merge's decisions; it does not assert that the PR has merged.

## Implementation boundary

The proposed room uses upstream's pushed messages and reactions, in-place
edits, handler-recorded times, split thread and quote links, per-user views,
and session-scoped composer drafts. Message-act refusals throw, and delivery
relies on the runtime's once-per-event guarantee. The room keeps no private
request ledger, timestamp reservations, activity log, or message versions.
Manager discovery, membership, creation, offers, placement, and rendering
follow the upstream contracts.

The independent behavior is authenticated authorship. Message editing and
deletion, author-authorized obliteration, and reaction removal compare the
authenticated actor with the record's `authored-by` attestation. Selecting
another person's profile does not grant their rights, and an author does not
lose those rights by selecting another resolved profile. Editing, deletion,
and reactions retain the resolved-profile requirement; obliteration needs no
readable profile when the actor has the required author or moderation rights.
The room's policy continues to govern owner moderation.

Display rights use the selected profile's owner through `profileOwnerOf()`,
including its name-chain ownership check. This retains upstream's protection
against treating a stale or ambiguous profile claim as ownership. The runtime
exposes the authenticated principal only inside handlers, so choosing another
person's attested profile can still offer a control the handler refuses.
Reaction addition and tallying remain profile-based. These limits are stated
in the room specification and README rather than hidden behind a claim that
profile selection proves actor identity.

The standalone `fabrichat/main.tsx` starter exposes an existing social space's
conversation through its Loom root's `chatRoom` and `setChatRoom` interface.
Starting a conversation is a reviewed gesture, and membership belongs to the
enclosing space. The default app does not instantiate another starter.

The proposed integration includes focused author-identity regressions and
invited-member cross-runtime assertions. It carries no independent runtime or
UI support patch. The live implementation contract is
documented in `packages/patterns/fabrichat/README.md` and
`docs/specs/fabrichat/FabriChatRoom.md`.

## Contract boundary

The standalone starter establishes its current room-based contract. The simple
example that previously occupied `fabrichat/main.tsx` and its baselines were
retired on `main` by commit `4d098c6818` (#8412). Reusing that path does not
restore the example's input shape, direct message and reaction outputs, or
migration obligations. The proposed starter provides no automatic translation
of old example messages into protocol records and invents no author
attestations.

This PR adds two snapshots: one for the current starter contract and one for
the current room contract, both recorded on October 28. Neither has an
accepted-break exemption, so the next change is checked against each normally.
Obsolete intermediate branch contracts and the retired example's snapshots
are not part of this integration.

Every baseline in current `main` remains intact. The accepted-break registry
matches `main` exactly: this integration adds no compatibility exception or
required-pattern override.
