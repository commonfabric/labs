---
status: historical
created: 2026-09-17
archived: 2026-09-17
reason: "Record of the deliberate contract break taken when the group chat demo's admin registry, profile, and room list started carrying the defaults their types had declared all along."
---

# Group chat demo: three declared defaults take effect

`packages/patterns/cfc-group-chat-demo/trusted.tsx` declares three cell
value types of one shape,

```ts
// Shown for illustration only.
export type ChatAdminRegistryValue =
  | ChatAdminRegistryStoredValue
  | Default<EmptyAdminRegistryValue>;
export type ChatAdminRegistryCell = Writable<ChatAdminRegistryValue>;
```

with `EmptyAdminRegistryValue = Record<PropertyKey, never>`; `MyProfileCell`
and `SharedRoomsCell` are built the same way over `MyProfileStoredValue` and
`SharedRoomsStoredValue`. `cfc-group-chat-demo/main.tsx` takes all three as
arguments through scope aliases (`PerSpace<ChatAdminRegistryCell>`,
`PerUser<MyProfileCell>`, `PerSpace<SharedRoomsCell>`) and republishes them as
results. Each declaration says an unset cell reads as `{}`.

The recorded contracts never carried those defaults. The schema generator
reached each type through its scope alias, where the checker has resolved the
`Default` alias into `Stored | Empty | (Empty & { [DEFAULT_MARKER]: Empty })`,
and its recovery of a default from that expanded form selected every
propertyless member as a brand candidate. The plain `Empty` arm has no
properties, so it was a candidate too; it carries no marker, so the recovery
bailed, emitted `anyOf: [Stored, Empty]` with no default, and reported
`schema-default:unresolved` — a warning whose text recommends an empty-object
type, which is what the declaration already used.

Selecting only members that carry the marker fixes that, and the three
argument and result properties of `main.tsx` gain `default: {}` under their
`anyOf`. The compatibility proof reads that as "defaults changed below a
constraint that is not stable under default insertion": a piece holding one
of these cells unset under the recorded contract reads `undefined`, and under
the new one reads `{}`. The proof reports one issue per role, so its finding
names `adminRegistry` alone; removing that property from both sides and
running the proof again surfaces `myProfile`, and then `rooms`, with the same
message against every baseline.

## Why this could not be done compatibly

The only compatible alternatives are to keep emitting the schema without the
default — which keeps the generator wrong for every `Default<EmptyObject>`
reached through a resolved type, and keeps the misleading warning — or to
change the pattern to stop declaring the default it has always meant. Neither
is the schema the pattern's author wrote. The pattern is a demo; the pieces
holding the old shape are accepted casualties, and the readers of these cells
in `trusted.tsx` and `packages/patterns/cfc/admin/mod.ts` go through optional
chaining or `?? {}` on the read value, so an absent value and an empty one
already behave alike.

## What is accepted

`cfc-group-chat-demo/main.tsx` over `20260729T022742Z-piF14M8QDh5pSPw1`,
`20260821T064855Z-7vNcdzNpQKWFJXVr`, and `20260831T222745Z-kIL5Ew24PVUYtyxy`,
paths `argument.adminRegistry`, `result.adminRegistry`, `argument.myProfile`,
`result.myProfile`, `argument.rooms`, and `result.rooms`.
