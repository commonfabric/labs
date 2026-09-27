---
status: historical
created: 2026-09-27
archived: 2026-09-27
reason: "Review record: what adversarial review of the own-patch echo elision found before it landed, what changed because of it, and what the elision is worth."
---

# Adversarial review of the own-patch echo elision

[The elision of a writer's own patch echo](2026-09-26-own-patch-echo-elision.md)
measured what the echo cost and removed it where the writer provably rebuilds
the document. Before it landed, five reviews each argued one case against it:
that it breaks intended semantics, that it is a hack to be regretted, that it
can diverge, that its value is overstated, and — over the changes the first
four prompted — that those changes left holes of their own. This records what
they found, what changed, and what they could not break. Where the earlier
record describes the mechanism, its names and conditions are those of the
branch before review: the declared base became `replayBaseSeq`, and the
capability `patchReplayVersion`, below.

## What was found, and what changed

- **A retracted base.** A document a watch change retracted from the session
  between an exact commit and its flush, and a second commit linked back in
  within that flush, was elided although the session no longer held the base,
  and nothing sent it again. Reproduced against the server. The elision now
  also requires the snapshot of the document the server last sent the
  session, or left out of its frame, to be at the declared base.
- **Patch semantics across builds.** Eliding the echo removes the correction
  every own patch commit used to carry, and a client's replay equals the
  server's only while both apply patches the same way. Clients deploy apart
  from servers, and what `applyPatch()` produces had changed at least four
  times in the preceding five months. What applying a patch produces became a
  version, `PATCH_SEMANTICS_VERSION`, recorded against a corpus of every
  operation kind and the `valueEqual()` cases it decides, and tied to that
  record by a released fingerprint.
- **The version, checked on one side only.** The first version check was the
  client's, when it built a commit, and the server ignored the version the
  client advertised, so a commit resent to a server of a new version after a
  restart would still have been elided. The server now records the version
  each connection's client advertises, copies it to the session at every open,
  and reports an exact base only at its own version.
- **No lever and no signal.** Nothing could switch the elision off short of
  switching off every own-write echo, and nothing counted it.
  `CF_MEMORY_PATCH_REPLAY=off` delivers every own patch head from the server's
  next flush, including heads committed before the switch;
  `ct.memory.sync.own_patch_heads` counts own patch heads by exactness and
  elision; and a replica logs `exact-base-replay-refused` at error level when
  operations the server applied over its declared base do not apply there. A
  replay that applies and differs from the server's result is not detectable on
  the client, which is what the version guards against.
- **Key order.** The flag claiming the promoted value was the server's
  document exactly was false in key order: the codec delivers keys in
  canonical order, and a replay keeps the order its own operations inserted
  them in, including inside object values a patch carries. The flag claims
  equality as a value, which is what the elision needs.
- **A base equal to the commit's own seq.** Within one commit, a second patch
  of a document lands on the head the first wrote, at the commit's seq; a
  declared base equal to that seq matched. A base now has to be below the
  commit's seq.

The contract these add up to is INV-15 in
[the invariants chapter](../../../specs/memory-v2/09-invariants.md).

## What it is worth

A second A/B at 10,752 string entries put the gap at 220 to 314 ms per round,
larger than the earlier record's, but part of that is the differential's value
comparison against the echo, which the separate whole-document-passes change
removes with no protocol change. Timed stage by stage, the echo's own share is
the server's encode and the client's decode and freeze: about 26 to 60 ms per
commit for string values and about 250 ms for link values. Its clearest
beneficiary is a writer that rewrites a large link map in sequence and awaits
each commit, such as a daemon's index. A writer whose commits are still pending
when the next is built names no base, and in a simulation of unawaited commits
50 to 200 ms apart one patch in ten named one.

## What the reviews could not break

- The engine's comparison: it is made inside the apply, against the head
  before the commit, and excludes a stamped or transformed operation, a
  delegated one, and one on a branch other than the default.
- The codec round trip: `-0`, `NaN`, infinities, array holes, `undefined`,
  errors, maps and sets survive it, so an equal base and equal operations give
  an equal document.
- Conflicts and admission: the declared base is read only by the comparison,
  and no commit is refused or admitted because of it.
- Holdings: an exact promotion is not declared on reconnect, so a reconnect
  re-delivers the document and heals a replica whose replay went wrong.
- Other sessions: the elision applies only to the committing session's own
  frame.

## What is left

- A patch built while an earlier own patch of the same document is still
  pending names no base, which is most edits from a writer that does not await
  its commits, and the first patch after an own `set` names none either.
- The transact response to an own `set` carries the whole document back.
- The arrival wake of the speculation overlay does not fire for an exact
  promotion, as it does not for an own `set` promotion.
- A change to what an operation produces also changes how the server rebuilds
  documents already stored, which no version number re-delivers to a client
  holding them.
