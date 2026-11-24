# Read one Topic by address

Part of `skills/topics/SKILL.md`, which is the map. This is the detail on
reading a Topic through `cf` directly. `deno task -q topics show` gives every
field a reader usually wants without it, from the client's local copy.

Survey the board with `deno task -q topics search`, not with a `cf cell get` of
the board's `index`. The index is computed: reading it runs the board in the
CLI's runtime, which reads every Topic and leaves one commit per Topic behind,
on every read.

Take a Topic's address from `deno task -q topics show` unchanged as `TOPIC`;
canonical references compose directly into later commands. The space prefix
appears only when the reference's space differs from the command's target space,
so never reconstruct or edit the emitted address.

That rule is about writing an address. Reading one has a counterpart: a Topic
answers to more than one address, so two that differ as strings can name the
same Topic. The `$link` a `mention` edge carries need not be the address the
`deno task -q topics show` command prints for the Topic it points at. Resolve
each address and compare what comes back rather than comparing the addresses,
and compare on something a separate document would not share — `createdAt`, or
the comment thread — since a title alone can be duplicated. An address you do
not recognise on an edge is not evidence the edge is wrong.

Read one Topic's durable input before changing it:

```bash
deno task cf cell get --cell "$TOPIC" title --input
deno task cf cell get --cell "$TOPIC" body --input
deno task cf cell get --cell "$TOPIC" comments --input \
  --select sentAt,author.kind,author.name,body
deno task cf cell get --cell "$TOPIC" links --input \
  --select kind,url,label,addedAt,addedBy.kind,addedBy.name
```

Use exact-field or range `--filter` predicates to narrow arrays, then project
with `--select`. Do not combine an address marker with `--filter`: filtering
changes positions, so a surviving row cannot carry its original address.

Input reads are the durable source of truth. Use `--step` for computed results
such as a Topic's `commentCount`, `lastActivityAt`, `mentions`, or
`referencedBy`.
