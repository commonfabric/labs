---
status: historical
created: 2026-09-23
archived: 2026-09-23
reason: "Record of the deliberate contract break taken when the group chat demo's everyone-is-admin flag started carrying the writer restriction its declaration had always named."
---

# Group chat demo: the everyone-is-admin flag keeps its writer

`packages/patterns/cfc-group-chat-demo/trusted.tsx` declares the flag that
makes every participant an admin as a union written in place:

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

Both arms name `commitTrustedAdminToggle` as the only writer.
`cfc-group-chat-demo/main.tsx` takes the admin registry holding the flag as
an argument and republishes it as a result.

The recorded contracts carried that writer on the `false` arm only. A
canonical CFC alias written in place, such as the `RequiresIntegrity` around
the `true` arm, reached the lowering with no argument nodes, so the payload it
wraps was formatted from its type alone. The writer of a `WriteAuthorizedBy`
or `TrustedActionWrite` is named only in syntax, by the `typeof` binding, and
a type does not carry it. The `true` arm therefore took its `uiContract`,
`addIntegrity` and `requiredIntegrity` labels and lost its `writeAuthorizedBy`,
with no diagnostic. Setting the flag to `true` was gated by the admin
integrity requirement alone rather than also by the one handler its author
named.

The lowering now hands an in-place canonical alias's payload the arguments
written on its reference, so the `true` arm carries `writeAuthorizedBy`
naming `commitTrustedAdminToggle` in every schema that describes the flag.
The compatibility proof reads that as "a schema alternative accepted
previously is not accepted by the candidate": a `true` written by any other
writer satisfied the recorded contract and does not satisfy the new one.
Against the earlier baseline the proof blames the admin registry holding the
flag; against the later one it blames the flag itself.

## Why this could not be done compatibly

The only compatible alternative is to keep emitting the `true` arm without
its writer, which keeps the lowering dropping writer claims silently wherever
a canonical alias is written in place, and keeps a field its author
restricted writable by other code. The restriction is the point of the
declaration. The pattern is a demo; a piece whose flag was set to `true` by
another writer is an accepted casualty, and the flag's own handler still
writes it.

## What is accepted

`cfc-group-chat-demo/main.tsx` over `20260918T041802Z-YAJU948xc_bQwY0H`,
paths `argument.adminRegistry` and `result.adminRegistry`, and over
`20260922T020444Z-IRoEgfpuUdf-xwvE`, paths
`argument.adminRegistry.everyoneIsAdmin` and
`result.adminRegistry.everyoneIsAdmin`.
