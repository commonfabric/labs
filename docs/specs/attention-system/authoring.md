# Posting notices from a pattern — the author's guide

Companion to [`README.md`](./README.md); the pattern-author's view of the
attention system. Section references (§n) refer to the main spec. Code is
illustrative shape, not compiled API.

## Rule zero: you probably don't have to do anything

If your pattern produces artifacts — a packing list, a research doc, a game
state — **you already participate without writing a line**. You write your
cells like always; the runtime versions every entity; the user's seen-state
and the steward's watchers (§5, §5.1) do the rest. When your pattern (or an
agent driving it) updates an artifact while the user is away, they get an
unseen dot and a line in "while you were away" — what changed, by whom,
since they looked.

This is the deliberate inversion of every notification API you've used:
there is no `notify()` call you can forget. Your artifact *is* the signal.

## When you have a genuine claim: post a candidate

Sometimes there's no artifact, or the event deserves more than a dot. The
posting surface is a **stream returned by a handler** (§6.1b) — you wish or
are handed an endpoint, and `.send()` a `NoticeCandidate`:

```text
post.send({
  subject: message,            // cell link to the truth
  kind: "group-chat",
  title: "Ana",
  body: "running late, start without me",
  actor: anaDid,
  threadKey: `conv:${conversationId}`,
  postureHint: "heads-up",     // a REQUEST, nothing more
})
```

The endpoint's handler appends your candidate to the right durable list —
the **shared space's notice list** for space-wide notices (the default:
post once, never enumerate recipients, each member's steward routes for
its own user), or a **profile inbox** for directed notices (mentions, DMs
— a profile is the only addressable identity another user has; §6.1). The
stream is transport; the handler owns durability; you never touch anyone's
ledger.

What to internalize about the envelope:

- **`postureHint` is advisory.** You're stating what your event deserves
  *within your world*; the user's steward assigns the real posture under
  their policies (§7). Request honestly: users who keep dismissing your
  notices unopened teach their stewards to clamp you down — visibly, in a
  learned-policy record they can read (§7). Your loudness budget is
  reputation, spent in public.
- **You cannot reach `interrupt`. Ever.** No field you control gets you
  there (§4.2's raise-authority tiers). If your pattern legitimately deals
  in time-critical events, *propose a policy* and let the user grant the
  floor.
- **You don't pick your `id`.** Notice identity is steward-derived from
  your verified provenance; you cannot collide with another source's
  notifications, and nobody can collide with yours.
- **`kind` is sticky.** First-seen kind binds to your verified identity;
  renaming yourself doesn't shed clamps, and kind buys no loudness
  (defaults key on verified facts, §4.2).
- **There are quotas** at intake, per verified writer (§6.1, §10.2). A
  flood reaches your reputation, not the user.

## Disposed stays disposed; new news is a new notice

The lifecycle contract (§4.4) is deliberately simple, and the switch is
the envelope's `eventKey` field. Re-posting with the same `eventKey` (or
none) **coalesces**: the delivered notice updates in place — content,
`expiresAt`, `progress` — always silently (§9.3). It never resurrects: a
dismissed claim stays dismissed. When something genuinely new happens,
post a **new `eventKey` in the same `threadKey`** — thread displacement
(§6.4) retires your older claim (displacement is scoped to your own
verified identity — you can't retire anyone else's, and nobody can retire
yours), and the fresh notice alerts (once) if its rung warrants.

So the canonical agent-run shape:

```text
post.send({ threadKey: `run:${runId}`, eventKey: "started",
            title: "Looking into your flight…",
            postureHint: "silent", progress: {done: 0}, ... })
// ...progress ticks: same eventKey ("started"), silent coalesce...
post.send({ threadKey: `run:${runId}`, eventKey: "result",
            title: "Rebooking drafted — needs your OK",
            attachment: draftCell, postureHint: "review",
            actions: [{key: "approve", label: "Approve", replyTo: myInbox},
                      {key: "deny",    label: "Deny",    replyTo: myInbox}] })
```

The second post displaces the first automatically. One run = one
`threadKey` = one visible claim, however many artifacts you touched.

## Retraction: report moot, don't track state

Your notice disappears without your help when the user handles it — opening
it is terminal, and dispositions sync across devices. For satisfaction that
doesn't go through the notice (the user read the conversation in your UI;
the trip ended), supply a **watcher** (§5.1): steward-run logic, part of
your pattern's contract, that observes your source state and reports the
claim moot — the steward retracts with a system disposition. If you supply
none, the built-in **seen watcher** covers you: once the user focus-opens
your notice's subject anywhere, the claim clears everywhere. Do not build
your own retract plumbing.

## Actions: close the loop in your own space

`actions` render as buttons (with inline text when `input: "text"`) on
every surface down to the lockscreen. When the user acts, the notice goes
terminal and `{key, input?, noticeId, at}` is appended to your `replyTo`
cell **in your space, under the user's ordinary session authority** — the
same authority they'd have acting in your UI. Requirements: `replyTo` must
be a **durable array cell, never a Stream** (stream payloads don't persist,
§4.5), and treat arriving replies as *requests*, not facts (a tray can be
stale, §9.3).

## Proposing policies: how you earn loudness

Ship suggested policies with your pattern — "library due dates →
`heads-up` three days before" — at the *moment of intent* (setup, listing
time), through the trusted adopt flow. Adoption is the write; unadopted
proposals do nothing (§7). This is your only path above the ceiling, and
it's a good one: a user who says yes has granted you a legible, revocable
floor. Two blessed idioms: the **emergency pack** (interrupt floors on
verified identities, §7) and the **deadline ladder** (embargoed `notBefore`
rungs in one thread, §7).

## Multi-user: post once, contribute rather than enumerate

In a shared space, post **one** space-wide candidate per event. Every
member's steward routes it independently — `interrupt` for whoever floored
your thread, `suppress` for whoever muted it — and you cannot know which;
per-viewer routing is structurally none of your business. Directed notices
(mentions, DMs) go to the mentioned member's *profile* inbox. If your
pattern wants social attention features ("2 of 5 have seen the plan",
"Bea's handling it"), build them the roster way: members' runtimes
contribute their own seen marks and disclosed dispositions into `PerSpace`
state under the space's disclosure policy (§8) — there is no "who has seen
this" primitive to call, and absence of a member's marks means nothing
you're entitled to interpret.

## What you can't do, in one list

Write any ledger (CFC-gated to the steward). Raise posture. Forge or
collide ids. Shed reputation by renaming. Re-alert via coalesce.
Resurrect a disposed notice. Read other users' attention state, policies,
or whether you've been muted. You *can* render your own clearly-attributed
local view of your own events any way you like — the canonical surfaces
just won't amplify it.

The mental model: **write good artifacts, post honest claims, thread your
work, put a reply cell out for actions, supply a watcher for your kind,
and propose — never grab — the loudness you think you deserve.** The
system's promise back: your quiet work stays findable, your new news is
never suppressed by stale dismissals (it's a new notice), and if the user
wants you loud, nothing stands in their way of saying so.
