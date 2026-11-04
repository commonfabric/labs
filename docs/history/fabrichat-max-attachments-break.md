---
status: historical
created: 2026-10-23
archived: 2026-10-23
reason: "Record of the deliberate contract break taken when a FabriChat room's policy gained an optional `maxAttachments`, which narrows the policy schema a manager's stored request outcomes carry, and strands nothing."
---

# FabriChat: a room's policy states how many attachments a message may have

A FabriChat message can attach files of its space's store, and a room allows
at most `maxAttachments` of them on one message. The room states that number
in its policy (`ChatRoomPolicy`, `packages/patterns/fabrichat/schemas.tsx`),
beside its other implementation-defined settings, so a room can come to allow
a different number. The key is optional: a policy without it means 10, so
every policy stored before the key existed still states its room correctly.

## What the gate reports

Against thirteen of the manager's recorded baselines, from
`20261011T221322Z-ESDR30hfSt52JJjG` through
`20261022T220213Z-LlstD45te1meAfuA`, the pattern-update proof reports
`argument.requests.*: a schema alternative accepted previously is not
accepted by the candidate`. A manager's request outcomes link the rooms they
made, and through a room's `about` its policy, so the policy's schema is part
of the manager's argument.

The policy's schema declares no `additionalProperties`, so before the change
it accepted any value under a `maxAttachments` key, and now it accepts only a
number there. That is the narrowing the proof finds. A comparison of every
definition in the manager's argument schema, between the newest of those
baselines and the candidate, finds `ChatRoomPolicy` the only one that differs,
and the new optional property the only difference in it.

## Why it strands nothing

No policy anything stores holds a `maxAttachments` key: a room's policy is
written from `FABRICHAT_POLICY` when the room is made, and nothing else
writes one. So no stored record is refused by the narrowed schema, and every
manager and room adopts the new source.

## The alternative

The cap could have been fixed in the contract instead, at 10 for every room,
which breaks nothing. @danfuzz chose the policy key, so that the cap is a
room's setting like its others, and moving it into the policy later would
have taken this same break.
