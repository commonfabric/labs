---
status: historical
created: 2026-09-23
archived: 2026-09-23
reason: "Record of the deliberate contract break taken when the profile and scoped group chats' Send verb stopped declaring an empty closed event."
---

# Group chats: the Send verb's event opens

`profile-group-chat/main.tsx` and both variants of `scoped-group-chat/`
declared their Send verb as `handler<SendEvent, …>` (`SendMessageEvent` in the
scoped chat), with the event type `Record<PropertyKey, never>`: an empty object
with `additionalProperties: false`. Each wires that verb straight to its Send
button, as `<cf-button onClick={send}>`.

This is the break [`roster-join-event-opened.md`](roster-join-event-opened.md)
records for the profile rosters' Join verb, found again in three more
patterns. The runner refuses a payload with any undeclared field against a
closed event schema, and a rendered click delivers the serialized DOM event,
which always carries `type`. So every Send from the button failed with
"additional property type" before the handler ran, and no message could be
sent from the page. Seen on 2026-09-23 in a local deployment of the profile
chat. Nothing caught it earlier: the profile chat has no tests, and the scoped
chat's tests never send.

## Why this could not be done compatibly

The handler reads nothing from its event, so the declaration is `void`, as it
was for the roster Join verb. The roster record measured the alternatives and
found that none passes both the runner's gate and the compatibility proof, and
nothing about the event differs here. `void` is a different recorded contract
for the stream, and the proof reports `result.sendMessage: asCell changed`
against every baseline recorded with the closed shape.

So the break is taken. Nothing held state under the old declaration: the stream
carried no data, and no piece could have sent a message through it.

## What is accepted

- `profile-group-chat/main.tsx` over `20260729T022742Z-VIR19UFKyKrauX_B`,
  path `result.sendMessage`.
- `scoped-group-chat/main-plain-inputs.tsx` over
  `20260729T022742Z-Z-pkp9K1p6P_byR_` and `20260909T184756Z-M530BSuyTtIuZ_9J`,
  path `result.sendMessage`.
- `scoped-group-chat/main-with-writable-inputs.tsx` over
  `20260729T022742Z-_XyScfA2QEj14JnS` and `20260909T184756Z-NMt89YDsQnt_urES`,
  path `result.sendMessage`.

`packages/patterns/rendered-click-streams.test.ts` reads each stream's compiled
event schema and fails when it is closed, for these three patterns and the two
rosters.
