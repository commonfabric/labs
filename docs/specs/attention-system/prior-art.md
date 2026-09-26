# Prior art: the OS notification stacks

Companion to [`README.md`](./README.md) (the attention-system spec); split out
as reviewer background. Section references (§n) refer to the main spec.

This design borrows deliberately from the OS notification systems — and its
strongest claims are about what their architecture *cannot* express — so
reviewers need the minimum shape of those APIs to judge the comparison.
(Deeper per-field mappings live in the adapter sections, §9.3.)

**The shared architecture.** On every platform, an app granted a one-time
binary permission constructs a notification payload — title, body, media,
optional buttons — hands it to the OS, and **chooses its own loudness**.
Delivery to a device where the app isn't running rides a vendor relay
(Apple's APNs, Google's FCM, a browser's push service) to an OS daemon. The
notification is a **snapshot copy**: once posted, it has no live tie to the
data it describes beyond an app-chosen identifier the app can use to replace
or cancel it. Seen/dismissed state is **per-device tray state** — dismissing
on the phone does nothing on the laptop unless the app hand-builds
push-to-cancel sync. The only cross-app arbitration the user gets is a
chronological pile in a tray.

**Android — the most capable, and this spec's behavioral reference:**

- **Channels**: an app declares named notification categories; after
  creation, the *user* controls each channel's importance, sound, and
  lockscreen visibility, and the app can never raise them — only lower.
  This is the germ of this spec's inversion, but only the germ: the app
  still picks every channel's *initial* importance, can mint fresh channels
  freely (resetting defaults), and the user discovers channels reactively,
  buried in settings, usually after being annoyed.
- **Replace/retract**: `notify(id, …)` with the same id replaces the
  delivered notification in place; `cancel(id)` retracts it.
  `setOnlyAlertOnce(true)` — *optionally* — makes re-posts update silently.
  `setTimeoutAfter(ms)` auto-cancels. Groups get a summary notification.
- **Actions + RemoteInput**: buttons and inline text reply on the
  notification itself — act without opening the app; the input is delivered
  back to the app via a broadcast.
- **Lockscreen visibility tiers**: per notification, public / private /
  secret, with an app-supplied redacted `publicVersion` for untrusted
  displays.
- **Ongoing + progress** notifications; full-screen intents for calls and
  alarms; per-channel do-not-disturb bypass flags.
- **Delivery**: FCM wakes the app process; notifications post with the app
  dead and survive reboot.

**iOS:**

- **Interruption levels** — `passive` (no wake), `active` (default),
  `time-sensitive` (breaks through Focus; requires an entitlement),
  `critical` (breaks mute; Apple-granted entitlement, effectively
  medical/safety only). An OS-enforced ceiling on loudness classes — but
  the *app* picks the level per notification, subject only to those gates.
- **Replace** via `UNNotificationRequest.identifier` (local) and
  `apns-collapse-id` (push). Content freezes at delivery — it refreshes
  when the user reopens the shade but never ticks live; genuinely live UI
  is a separate API surface (Live Activities).
- **Notification Service Extension**: a slice of app code runs on receipt
  and may mutate content before display — the platform's hook for
  decrypt-on-device and fetch-on-receive (the shape §9.3's redaction rule
  compiles to).
- **Focus modes**: user-side routing — which apps and which *people* may
  break through — but coarse: app-grain and contact-grain, with no
  conditions, and each app self-reports what a "person" is.

**Web Push**: VAPID-authenticated push to a service worker;
`showNotification` with `tag` for replace and `actions` for buttons;
payloads are encrypted to the subscription, so the browser vendor's relay
cannot read content (alone among the three). The most constrained surface —
which is exactly why it is this spec's envelope floor (§9.3).

**What the architecture structurally cannot do.** These are not missing
features; they are consequences of "emitter-priced snapshot copies delivered
to per-device trays," and they are the holes this design exists to fill:

1. **The emitter prices its own loudness.** Android's channel initial
   importance and iOS's interruption level are chosen by the party with the
   incentive to interrupt. The user's recourse is reactive and blunt:
   per-app or per-channel toggles, discovered after the annoyance.
2. **Permission is binary and app-grain.** Allow-or-deny at first run.
   There is no "this thread, quietly", no "this source, only until I've
   handled one", no conditional grant — unless the app builds its own
   settings screen, which the OS cannot verify it honors.
3. **The notification is a dead copy.** Nothing retracts it when the
   underlying thing is handled elsewhere; read-state doesn't cross devices;
   the email you answered on your laptop still sits on your phone's
   lockscreen. Well-engineered apps simulate liveness with push-to-cancel;
   most don't.
4. **No cross-source arbitration.** The tray is a chronological pile.
   Nothing sees "forty things are competing for this person right now" —
   notification fatigue is unaddressable at the system level because no
   system-level party holds the queue.
5. **No cross-person semantics.** "Someone on the team handled it" and
   "escalate if nobody does" are unexpressible; every paging product is a
   SaaS control plane bolted on top to compensate.
6. **The relay reads the payload** (APNs and FCM; Web Push excepted).
   Confidentiality requires per-app heroics — end-to-end encryption plus
   on-device decrypt in an extension — rather than being a property of the
   flow.
7. **User policy is not data.** The user cannot write, inspect, or port a
   routing rule. What the OS learned about their preferences (if anything)
   is invisible and vendor-locked.

### 3.3 What this design adopts, inverts, and adds

**Adopted — the mechanics that earned their keep** (this spec's ledger stays
"Android-shaped" so adapters compile 1:1):

- Stable-identity replace/retract → `id`, steward-derived (§4.4).
- Only-alert-once → made *unconditional*: alerting rides posture
  transitions, and the emitter cannot opt back into re-buzzing (§9.3).
- Lockscreen visibility tiers → `redacted`, generalized from an app choice
  to CFC label enforcement at the push boundary (§9.3).
- Actions + inline reply → `actions`/`replyTo`, with the broadcast-back
  replaced by an append to a source-space cell under the user's ordinary
  session authority (§4.6) — same UX, radically simpler trust story.
- iOS's interruption-level vocabulary → the posture scale's rungs map onto
  it (and Android channel importance) so OS compilation is a table lookup,
  and the reserved break-glass mapping (§9.3) targets `time-sensitive` /
  `critical` when entitlements land.
- Channels-as-classification → `kind`, but bound to verified source
  identity instead of self-declared (§4.4).

**Inverted — the same levers, moved to the user's side:**

- Android lets the user *lower* a channel after the app priced it; here the
  emitter never prices at all — `postureHint` is advisory, the steward
  assigns, and raising is exclusively user-authored (§4.2). The one lever
  Android proved users understand (per-channel importance) becomes the
  *whole* model rather than the escape hatch.
- Binary app permission becomes per-source, condition-bearing policy data:
  clamps, quiet hours with named exceptions, watches — proposable by
  patterns at the moment of intent, adopted by the user, editable forever
  (§7). Focus modes' "which people break through" becomes a verified-actor
  policy rather than app-self-reported metadata.
- The OS's invisible ML ranking (Android's notification assistant) becomes
  **learned policies**: the same adaptive demotion, materialized as
  records the user can read, edit, and delete (§7).

**Added — expressible here, structurally impossible there:**

- A notice is live-tied to its `subject`: handle the thing *anywhere* and
  the notice retracts *everywhere* — the seen-join (§4.4) gives every
  source the auto-retract behavior only the best-engineered apps simulate,
  cross-device, for free.
- Derived notices: in-fabric changes need no posting at all (§5) — there is
  no "the app forgot to notify" failure mode, and quiet agent work is
  visible at zero notification cost.
- Cross-person semantics as single policy records: collective quiet
  ("acted-by-any demotes for all") and escalation ("nobody in 2h → raise
  for the owner") (§8).
- One canonical, queryable ledger with the OS trays as degraded
  projections — digests, audit, and coverage measurement read the ledger,
  not N device states.

**Inherited, honestly:** dead-device delivery still rides APNs/FCM/Web Push
and their gates — the break-glass ceilings (`time-sensitive`, `critical`,
DND-bypass) are the platforms' to grant, not ours to declare (§9.3), and
push timing is theirs. This design compiles down to the OS stacks; it does
not pretend to replace them.

