---
status: historical
created: 2026-10-23
archived: 2026-10-23
reason: "Why one FabriChat room in about a dozen lost its creator's first message under server execution: the serving runtime's event auto-load started the room's nested core on its own, so the send handler read a profile no action derived and refused the event, and the refusal was sealed as its consequence. The loop-off arm never lost one in 48 rooms. The fix starts the pieces a stream owner's inputs come from first."
---

# A served room's lost first message

The chat probe's rooms stalled one in about a dozen with the serving loop on:
a member's wait for the room's joins timed out because the room never
received its creator's first message
([chat record](2026-10-23-served-chat-burst-per-session-rows.md)). This
record says which runtime consumed that message, why, and what changed.

## How it was measured

`probe-chat-flag.ts`, kept out of the tree like the earlier probes, runs
eight rooms one after another. Each has four members who join, the creator
first by sending the room's first message, then each sends twelve messages.
Its watchdog dumps the serving loop's state 30 s and 60 s into a wait that
has not ended and stops the run. The hunts ran on a four-core container
from a scratch worktree at `cbd29a21a` with probes in the scheduler, the
serving loop and the wish builtin, printing each served event's drain,
preflight reads, re-arms and stamp, and each wish action's registration.

## The loop-off arm does not lose it

| Arm | Rooms | Stalls |
| --- | --- | --- |
| serving loop in the worker, view-scoped replication on, store read-through off | 87 | 7 |
| serving loop off | 48 | 0 |

At the first arm's rate, 48 rooms would have shown no stall about one time
in fifty.

## What the room's serving runtime did

In both stalls the probes covered, the room's own serving runtime is the
one that consumed the message. The run that stalled in its first room
(`hunt13`) is the cleaner of the two:

1. The creator's client set the room up, and its four wishes registered
   together: the room's `#profile`, `#default` and `#chatManager`, and the
   `#default` of the core the room nests (`FabriChatRoomCore`).
2. The serving loop drained the creator's send. Nothing had started the
   room in the serving runtime yet, so no handler was registered for the
   send's stream, and the drain's auto-load started the piece that owns the
   stream. One wish registered: the core's `#default`.
3. The send's preflight read 24 addresses, where a delivered send reads 30.
   Through the core's argument it reached the `#profile` wish's output, and
   no action in the runtime writes that document, so the invalid-upstream
   pass and the transient-demander re-arm had nothing to run. The only wish
   the runtime knew of had never run.
4. The handler ran and refused: "Your profile hasn't loaded yet." A
   handler's throw is its event's consequence (events.md §5), so the entry
   was sealed with that error and the message was gone.
5. The room's own three wishes registered afterwards, once the room itself
   started.

`hunt14` stalled in its eighth room with the same sequence: the four wishes
together, one alone, the preflight finding that one wish never run, the
refusal, then the other three.

## Why the auto-load started the core alone

The serving pass drains events ahead of the demanded-structure load, and
leaves a handler-less event to start its own piece: the auto-load follows
the stream document's `result` backlinks to the result that owns it and
starts that. A stream a nested pattern defines belongs to the nested
instance, whose result document carries its own pattern pointer, so the
walk ends there. Started on its own, the nested instance runs its handlers
against inputs its enclosing instance derives, and the enclosing instance is
not running. With the loop off the creator's own runtime runs the room it
opened, so the core never runs without it.

## The fix

Two changes, and the served test below stays red with either alone.

- **The auto-load starts what the stream's owner reads from first.**
  `ensurePieceRunningVerdict` takes `startInputSources`, which the event
  path passes. Before starting the owning piece, it reads the piece's
  stored argument, follows each top-level link's `result` backlinks to the
  piece that owns the linked document, and starts those pieces first,
  recursively. A nested instance's argument links into the instance
  enclosing it, so the enclosing instance starts and its graph sets the
  nested one up as its child, as when a client opens the room. The
  auto-load then leaves the nested instance there instead of starting it
  again, which would give it a lifetime of its own.
- **A handler carries its piece's demand-root chain.** A served event's
  actor is a transient demander of the pieces its handler's identity
  names, and that identity named only the handler's own instance, while
  the nodes of the same instance carry the chain of pieces that
  instantiated it. With the chain on the handler too, the actor demands
  the enclosing instance's nodes, so its per-user derivations run for the
  actor before the handler reads them, whether or not anyone watches the
  piece.

Two tests pin it, each red before:

- `ensure-piece-running-input-sources.test.ts`: a second session takes an
  event on a nested stream after the input the enclosing instance derives
  from changed with nothing running. The handler read the stale value, 2,
  before the change and the current one, 10, after it.
- `executor-fan-out.test.ts`: a served event from an actor who watches
  nothing, on a nested pattern's stream, whose handler refuses while the
  enclosing pattern's per-user `echo` has no value. Before, the entry was
  sealed with the handler's refusal, as the room's was. After, it is
  consequenced clean and the actor's `saved` holds `saved:echo:A`.

## Measured after the fix

The same probe, from worktrees holding no runtime probes:

| Code | Store read-through | Rooms | Stalls |
| --- | --- | ---: | ---: |
| `6d32c59bc`, without its tests | off, the hunts' arm | 16 | 0 |
| `6d32c59bc`, without its tests | on | 8 | 0 |
| `78320a68a` | off, the hunts' arm | 40 | 0 |
| `78320a68a` | on | 40 | 0 |

At the hunts' rate of 7 in 87, the 56 rooms on their arm would all have
come out clean about one time in a hundred. The hunts before the fix ran with
runtime probes in their worktree, and these ran without them. A stall also
came without them before the fix: one of four send-burst benchmark runs at
`b21ced957` timed out waiting for the room's rows, though that benchmark cannot
say which wait it was ([chat record](2026-10-23-served-chat-burst-per-session-rows.md),
"Stalls"). `78320a68a` carries the fix with `main` merged in after it.

## What remains

- **A nested piece opened by itself.** A client that opens a nested
  instance directly demands it through the serving loop's structure load,
  which still starts it alone; its enclosing instance runs only if
  something demands that too. The event path is the only one changed
  here.
- **Inputs the walk does not see.** The input-source walk follows the
  top-level fields of the owner's stored argument. An instance whose
  inputs are all literals, or all links inside a field, is not connected
  to its enclosing instance this way, and its auto-load starts it alone
  as before.
