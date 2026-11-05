---
status: historical
created: 2026-09-23
archived: 2026-09-23
reason: "Record of the deliberate contract break taken when the group chat demo's everyone-is-admin flag started carrying the write claim its type had declared all along."
---

# Group chat demo: the everyone-is-admin flag keeps its write claim

`packages/patterns/cfc-group-chat-demo/trusted.tsx` declares the flag that
makes every participant an admin as a union of two branches:

```ts
// Shown for illustration only.
export type ChatEveryoneAdminFlag =
  | RequiresIntegrity<
    AddIntegrity<
      TrustedActionWrite<
        true,
        typeof commitTrustedAdminToggle,
        typeof TRUSTED_GROUP_CHAT_SET_ADMIN_ACTION,
        typeof TRUSTED_GROUP_CHAT_ADMIN_SURFACE
      >,
      readonly [typeof GROUP_CHAT_ADMIN_INTEGRITY]
    >,
    readonly [typeof GROUP_CHAT_ADMIN_INTEGRITY]
  >
  | TrustedActionWrite<
    false,
    typeof commitTrustedAdminToggle,
    typeof TRUSTED_GROUP_CHAT_SET_ADMIN_ACTION,
    typeof TRUSTED_GROUP_CHAT_ADMIN_SURFACE
  >;
```

Both branches say that only `commitTrustedAdminToggle` may write the value.
The recorded contracts carried that `writeAuthorizedBy` claim on the `false`
branch only. The schema generator formats this union member from its type. Its
reference node remains in the generation context, but a canonical CFC alias
reached through the type carries no argument nodes in its resolved-alias
record. The formatter therefore passed no node to the alias's payload.
`RequiresIntegrity` and `AddIntegrity` lowered their literal labels from the
type, but the `TrustedActionWrite` in their payload could not read its
`typeof commitTrustedAdminToggle` binding from a type, so the claim was dropped,
while its UI contract survived. `ChatAdminList` and `SharedRoomList` have the
same nesting and kept their claims, because they are reached through their own
alias names, whose declarations supply the nodes.

Reading the payload from the reference's own argument nodes, as the labels
already were, puts the claim on the `true` branch. The compatibility proof
reads the added claim as "a schema alternative accepted previously is not
accepted by the candidate": a value written as `true` by a writer other than
`commitTrustedAdminToggle` satisfied the recorded contracts and does not
satisfy the new one. The proof blames `adminRegistry.everyoneIsAdmin` against
the newer of the two contracts that carry the flag, and `adminRegistry` as a
whole against the older one, whose registry it does not descend.

## Why this could not be done compatibly

The only compatible alternative is to keep emitting the flag without the claim,
which leaves the demo's most permissive setting writable by any writer despite
its declaration, and leaves the generator dropping a nested `WriteAuthorizedBy`
whenever a canonical wrapper reached through its type fails to pass its
reference's payload argument onward.
`commitTrustedAdminToggle` is the only writer of the admin registry in the
pattern, so no write the pattern makes is refused. The pattern is a demo, and
its author agreed to the break.

## What is accepted

`cfc-group-chat-demo/main.tsx` over `20260922T020444Z-IRoEgfpuUdf-xwvE`, paths
`argument.adminRegistry.everyoneIsAdmin` and
`result.adminRegistry.everyoneIsAdmin`; and over
`20260918T041802Z-YAJU948xc_bQwY0H`, paths `argument.adminRegistry` and
`result.adminRegistry`.
