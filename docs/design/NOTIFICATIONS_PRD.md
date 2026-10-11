# Common Tools Notification System
## Product Requirements Document

> **Status**: Draft
> **Date**: 2026-01-09
> **Branch**: `feat/notifications-system`

---

# Part 1: The Android Model — Why It Works

Before diving into requirements, we must understand the philosophical foundation we're building on. Android's notification system represents 15+ years of iteration serving billions of users. iOS took a different path. We're choosing Android's model deliberately.

---

## The Core Insight: Notifications as TODO List, Not Alert Stream

The fundamental difference between Android and iOS notifications is **persistence philosophy**:

| Aspect | iOS Model | Android Model |
|--------|-----------|---------------|
| Core metaphor | **Ephemeral alert** | **Persistent task queue** |
| Lifecycle | Appear → fade to Notification Center | Persist until explicitly dismissed |
| User mental model | "Something happened" | "Something needs attention" |
| Dismissal meaning | "I saw it" | "I handled it (or chose to ignore)" |
| Default behavior | Auto-clear on unlock | Stay until action taken |

**iOS says**: "Here's what happened while you were away."
**Android says**: "Here's what still needs your attention."

This makes Android notifications function like a **TODO list** — a running inventory of open items. The notification drawer is not a log of past events; it's a queue of pending attention.

### Why TODO > Alert

1. **High Integrity**: Clicking a notification in Android always shows you *current* content, not a stale snapshot. The notification is a live pointer, not a historical record.

2. **User Agency**: You decide when something is "done" — not the system, not the clock. Swipe-to-dismiss is an intentional action meaning "I'm done with this."

3. **Reduced Anxiety**: Nothing silently disappears. If you didn't handle it, it's still there. No fear of missing something because you didn't check fast enough.

4. **Natural Prioritization**: The drawer becomes a triage surface. Urgent things get handled; less urgent things accumulate but remain visible.

### The iOS Failure Mode

iOS's ephemeral model creates specific failure modes:

- **The Vanishing Notification**: You glance at a notification, unlock your phone to deal with it, and... it's gone. Buried in Notification Center, which most users never check.

- **The Stale Banner**: Lock screen shows "New message from Alice" but Alice sent 5 more messages since. The notification is a lie about current state.

- **Notification FOMO**: Users compulsively check phones because notifications might disappear. The system trains anxiety.

- **All-or-Nothing**: You can enable or disable notifications per-app. No granularity. Either you get spammed with marketing OR you miss important alerts.

---

## Android's Three-Layer Attention Model

Android recognizes that **interruption is a spectrum**, not a binary. It presents notifications across three layers with different attention costs:

```
ATTENTION COST
     ▲
     │
HIGH │  ┌─────────────────────────────────────────┐
     │  │ HEADS-UP NOTIFICATION                   │
     │  │ Active interruption. Overlays current   │
     │  │ activity. Reserved for urgent content.  │
     │  │ (calls, alarms, critical messages)      │
     │  └─────────────────────────────────────────┘
     │
MED  │  ┌─────────────────────────────────────────┐
     │  │ NOTIFICATION DRAWER                     │
     │  │ On-demand exploration. User pulls down  │
     │  │ when ready to review. Primary surface   │
     │  │ for reading, acting, dismissing.        │
     │  └─────────────────────────────────────────┘
     │
LOW  │  ┌─────────────────────────────────────────┐
     │  │ STATUS BAR ICON                         │
     │  │ Passive ambient presence. "Something    │
     │  │ exists." Visible during any activity.   │
     │  │ Zero interaction required to inform.    │
     │  └─────────────────────────────────────────┘
     │
     └──────────────────────────────────────────────►
                                            TIME/PERSISTENCE
```

This maps to Common Tools as:

| Android Layer | Common Tools Equivalent |
|---------------|------------------------|
| Status bar icon | Bell badge count |
| Notification drawer | Inbox pattern |
| Heads-up | OS notification (via Tauri) |

The key insight: **match interruption level to urgency**. Most notifications should be low-cost (badge/drawer). Only genuinely urgent content deserves active interruption.

---

## The Two State Machines

Android implicitly maintains **two independent state machines** for each notification:

### State Machine 1: Notification State (OS-owned)

```
┌──────────┐   glance    ┌──────────┐   dismiss   ┌───────────┐
│  POSTED  │ ──────────► │  SEEN    │ ──────────► │ DISMISSED │
└──────────┘             └──────────┘             └───────────┘
     │                        │
     │                        │ snooze
     │                        ▼
     │                   ┌───────────┐
     │                   │  SNOOZED  │ ─── timer ──► (back to POSTED)
     │                   └───────────┘
     │
     └─────────── dismiss directly ──────────────► DISMISSED
```

### State Machine 2: Content State (App-owned)

```
┌──────────┐                      ┌──────────┐
│  UNREAD  │ ────────────────────►│   READ   │
└──────────┘   user views in app  └──────────┘
```

**These are independent but linked.** When Gmail marks an email as read (content state), it tells Android to dismiss the notification (notification state). But you CAN:

- Dismiss notification without reading email (swipe away)
- Read email without dismissing notification (if app doesn't sync)
- Snooze notification (notification state) without affecting email read status (content state)

**This separation is crucial.** The notification system doesn't define what "read" means — apps do. The notification system only manages attention.

---

## User Sovereignty: The Channel Model

Android 8.0 introduced **notification channels** — a philosophical statement about who owns attention.

### The Problem Channels Solve

Before channels, apps had too much power:
- Send any notification at any importance level
- Users could only enable/disable per-app (all or nothing)
- Marketing spam mixed with critical alerts

### How Channels Work

Apps must declare notification types (channels). Users control each channel independently:

```
Gmail App
├── Channel: Primary (importance: HIGH) — user can lower to MEDIUM
├── Channel: Promotions (importance: LOW) — user can DISABLE
├── Channel: Social (importance: MEDIUM) — user can adjust
└── Channel: Updates (importance: LOW) — user can DISABLE

User controls per-channel:
- Importance level (sound, vibrate, silent, hidden)
- Whether to show on lock screen
- Whether to override Do Not Disturb
- Badge behavior
```

**Key rule**: After an app creates a channel, **only users can change its behavior**. The app cannot programmatically increase importance. This is enforced by the OS.

### The Philosophy

> "Apps propose, users decide."

Channels embody **granular consent**. Instead of the iOS binary (all notifications or none from this app), Android recognizes nuanced relationships:

- Want banking transaction alerts but not marketing? ✓
- Want DM notifications but not "someone liked your post"? ✓
- Want shipping updates but not "deals just for you"? ✓

This is **opt-down without opt-out** — users tune their experience without losing genuine value.

---

## Attention as Finite Currency

Android's design treats user attention as **a finite resource that must be allocated wisely**.

### Importance Levels

| Level | Behavior | Attention Cost | Appropriate Use |
|-------|----------|----------------|-----------------|
| URGENT | Sound + heads-up | Very High | Incoming calls, timers, alarms |
| HIGH | Sound + status bar | High | Direct messages from humans |
| DEFAULT | Sound | Medium | Most notifications |
| LOW | Silent | Low | Recommendations, social updates |
| MIN | Silent, minimal presence | Minimal | Weather, background info |

The system asks developers: **"How much of the user's valuable attention should this consume?"**

### Attention Budget Research

Studies cited by Google show:
- Each notification leaves "attention residue" for ~25 minutes
- Batching notifications 3x daily improves mood and productivity
- Users who manage notification settings report higher satisfaction

Android 15's **notification cooldown** automatically reduces volume/vibration for rapid-fire notifications. The system actively protects attention even from well-meaning apps.

---

## Grouping: Cognitive Load Management

When an app sends multiple notifications, Android groups them:

```
┌─────────────────────────────────────────────────┐
│ Messages (4 new)                           ▼    │
├─────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────┐ │
│ │ Alice: Hey, are you free tonight?           │ │
│ └─────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────┐ │
│ │ Bob: Check out this link                    │ │
│ └─────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────┐ │
│ │ Carol: Meeting moved to 3pm                 │ │
│ └─────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────┐ │
│ │ Dave: Thanks!                               │ │
│ └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

### Why Grouping Matters

1. **One semantic event = one interruption**: 4 messages → 1 sound, not 4 sounds
2. **Triage at a glance**: See "4 new messages" without reading each
3. **Batch dismissal**: Clear all or individually
4. **Reduced clutter**: Notification drawer stays manageable

Android 16 will **enforce** grouping — apps that spam ungrouped notifications will have them auto-grouped by the system.

---

## The Snooze Paradigm

Android's snooze feature (introduced Android 8.0) embodies a sophisticated attention model:

> **"Not now" is not "never."**

Instead of forcing users to either:
- Act immediately, OR
- Dismiss and forget

Snooze allows **time-shifted attention**:
- "Remind me in 15 minutes"
- "Remind me in 1 hour"
- "Remind me tomorrow morning"

This acknowledges that:
- Attention is temporally constrained
- Context matters (I'll handle this when I'm at my desk)
- Dismissal has a finality that snooze doesn't

---

## Human Communication is Special

Android 11 introduced **conversation notifications** as a distinct category:

```
┌─────────────────────────────────────────────────┐
│ CONVERSATIONS (priority section)                │
├─────────────────────────────────────────────────┤
│ 👤 Alice (Messages)                             │
│    "Hey, are you coming to dinner?"             │
│    [Reply] [Mark as read]                       │
├─────────────────────────────────────────────────┤
│ 👤 Work Group (Slack)                           │
│    3 new messages                               │
│    [Reply] [Mute]                               │
└─────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────┐
│ OTHER NOTIFICATIONS                             │
├─────────────────────────────────────────────────┤
│ Package shipped · Amazon                        │
│ Package shipped · Amazon                        │
│ Your backup is complete · Google Drive          │
└─────────────────────────────────────────────────┘
```

Conversation notifications:
- Appear in a **priority section** at the top
- Can be promoted to **bubbles** (floating chat heads)
- Support **direct reply** without opening the app
- Must involve actual humans (not broadcasts/bots)

The philosophy: **Person-to-person communication deserves elevated treatment.** It's not just another notification type — it's a fundamentally different attention category.

---

## Summary: Why We're Adopting Android's Model

| Principle | What It Means for Common Tools |
|-----------|-------------------------------|
| **Notifications as TODO list** | Inbox persists until you act; nothing silently disappears |
| **High integrity** | Clicking always shows current content, not stale snapshots |
| **Three-layer attention** | Badge (ambient) → Inbox (on-demand) → OS notification (interrupt) |
| **Two state machines** | Notification state (inbox) ≠ content seen state (source/annotation) |
| **User sovereignty** | Users control importance, channels, timing |
| **Attention as currency** | Priority levels, rate limiting, grouping |
| **Grouping** | Batch related notifications; one event = one interruption |
| **Snooze** | "Not now" ≠ "never"; time-shifted attention |
| **Human communication is special** | Conversations get elevated treatment |

We're not just copying Android's UI. We're adopting its **philosophy**: notifications are a **user-controlled attention management system**, not an app-controlled interrupt mechanism.

---

# Part 2: The Annotations Model — Multi-User Seen State

Before diving into requirements, we need to establish how "seen" state works in a multi-user world.

## Why Annotations Matter

In a single-user world, "seen" is simple: the pattern has a `seen: boolean` field, and the inbox reads it directly. When you view the content, `seen` flips to `true`, and your notification clears.

But what happens when Alice and Bob are both looking at the same shared document?

- Alice views it → `seen = true`
- Bob's notification disappears too (wrong!)

The problem: **the document's seen state is global, but each user's attention is personal.**

## The Solution: Your Seen State Lives in Your Space

The annotations model separates "the content" from "who has seen it":

```
┌─────────────────────────────────────────────────────────────────┐
│  SHARED SPACE (did:space:abc)                                   │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  Document Cell                                              ││
│  │  { title: "Q1 Report", content: "..." }                     ││
│  │  (no seen field - content doesn't know who read it)         ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  ALICE'S PROJECTION SPACE (did:space:alice-projection)          │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  Annotation: { ref: "did:space:abc/doc", seen: true }       ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  BOB'S PROJECTION SPACE (did:space:bob-projection)              │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  Annotation: { ref: "did:space:abc/doc", seen: false }      ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

**The mental model: "Your seen state is yours, stored in your space."**

## Benefits

1. **Privacy**: Others don't see what you've read (no "read receipts" unless you want them)
2. **Independence**: You viewing doesn't clear others' notifications
3. **Ownership**: Your attention metadata travels with you, not with the content
4. **Simplicity**: Patterns don't need multi-user logic; the infrastructure handles it

## How Inbox Uses Annotations

The inbox checks for seen state in a simple priority order:

1. **Check annotations first**: Look for a seen annotation in the user's projection space
2. **Fall back to source.seen**: For backward compatibility with single-user patterns
3. **Default to unseen**: If neither exists, the notification is unseen

This means:
- **Single-user patterns** work with just `seen: boolean` on the source
- **Multi-user patterns** call `markSeen()` which writes an annotation
- **Inbox doesn't care** which approach was used — it just checks both

---

# Part 3: Product Requirements

## Problem Statement

Common Tools currently has no way for patterns to notify users about content requiring attention. Users must manually check each space/pattern to discover new content. This creates:

1. **Missed information**: Important updates go unnoticed
2. **Anxiety**: Users compulsively check, fearing they'll miss something
3. **Poor cross-space awareness**: Activity in one space invisible from another
4. **No background operation feedback**: Long-running tasks complete silently

## User Stories

### US-1: See Notification Count
**As a** Common Tools user
**I want to** see a badge count on the bell icon
**So that** I know if anything needs my attention without opening the inbox

**Acceptance Criteria:**
- Bell icon visible in shell header across all spaces
- Badge shows count of unseen active notifications
- Badge updates reactively as notifications arrive/clear
- Zero count shows no badge (not "0")

### US-2: View Inbox
**As a** Common Tools user
**I want to** click the bell to see my notifications
**So that** I can review what needs attention

**Acceptance Criteria:**
- Clicking bell opens inbox (pattern or dropdown)
- Each notification shows: title, source space, timestamp
- Unseen notifications visually distinguished (bold/highlight)
- Can navigate to source content by clicking notification

### US-3: Automatic Clearing
**As a** Common Tools user
**I want** notifications to clear when I view the content in the app
**So that** my inbox reflects actual pending items, not stale ones

**Acceptance Criteria:**
- Single-user: Pattern has `seen: boolean`, inbox observes it directly
- Multi-user: Pattern calls `markSeen()`, writes annotation to user's projection space
- Inbox checks annotations first, falls back to `source.seen` for compatibility
- Badge count decrements when content is marked seen (by either method)
- Notification moves to "seen" state (remains in inbox but de-emphasized)

### US-4: Manual Dismiss
**As a** Common Tools user
**I want to** swipe/dismiss a notification without viewing the content
**So that** I can clear things I don't care about

**Acceptance Criteria:**
- Swipe or dismiss button removes notification
- Does NOT mark source content as seen
- Dismissed notifications don't reappear (dedupe by ref)

### US-5: Pattern Sends Notification
**As a** pattern developer
**I want to** notify users when something needs their attention
**So that** they discover new content without polling

**Acceptance Criteria:**
- `notify({ ref })` API available in patterns
- Notification appears in user's inbox
- Deduplication prevents spam (same ref = one notification)

### US-6: Snooze Notification
**As a** Common Tools user
**I want to** snooze a notification
**So that** I can deal with it later without dismissing it

**Acceptance Criteria:**
- Snooze action available on notifications
- Duration options: 15min, 1hr, 4hr, tomorrow
- Snoozed notification returns at scheduled time

### US-7: OS Notification (Phase 2)
**As a** Common Tools user on desktop
**I want** urgent notifications to show as OS notifications
**So that** I'm alerted even when the app isn't focused

**Acceptance Criteria:**
- Tauri sends OS notification for high-priority items
- Clicking OS notification opens app and navigates to content
- Rate-limited to prevent spam
- User can disable OS notifications

### US-8: Multi-User Notifications
**As a** user of a collaborative pattern
**I want** my notification state to be independent of other users
**So that** me viewing something doesn't clear others' notifications

**Acceptance Criteria:**
- Each user has their own inbox (in their home space)
- Seen state stored as annotation in user's projection space
- User A viewing content writes annotation to A's space only
- User B's notification remains unseen until B views it
- Inbox checks annotations first, falls back to source.seen

---

## Success Metrics

### Primary Metrics

| Metric | Target | Rationale |
|--------|--------|-----------|
| **Notification integrity** | >99% of clicks show current content | Core value prop |
| **Seen sync latency** | <2s from view to badge update | Reactive experience |
| **Notification delivery rate** | >99.9% | Reliability |

### Secondary Metrics

| Metric | Target | Rationale |
|--------|--------|-----------|
| **Inbox engagement** | >50% of users check inbox weekly | Feature adoption |
| **Dismiss rate** | <30% dismissed without viewing | Notification relevance |
| **OS notification opt-in** | >60% (Phase 2) | OS integration value |

### Anti-Metrics (Don't Optimize)

- **Notification volume**: More isn't better; quality over quantity
- **Click-through rate**: Users shouldn't need to click every notification
- **Time in inbox**: Should be quick triage, not extended engagement

---

## Scope

### Phase 1: MVP with Annotation Shim
- Inbox pattern with entries cell and send stream
- `notify()` helper API (syntactic sugar for `wish('#inbox').send()`)
- Inbox checks annotations first, falls back to `source.seen`
- Temporary annotation shim until full annotations infrastructure exists
- Shell bell icon with badge count
- Basic inbox UI (list, navigate, dismiss)
- Notification states: `active`, `dismissed`
- Single-user works great out of the box

### Phase 2: Full State Machine + OS Notifications
- Notification states: `noticed`, `snoozed`
- Grouping by source/channel
- Tauri OS notifications for urgent items
- Snooze with duration options

### Phase 3: Real Annotations Infrastructure
- Full annotations infrastructure replaces shim
- Per-user projection space integration
- Annotation read/write helpers mature
- Collaborative notification patterns fully supported

### Out of Scope
- Push notifications for web (no service worker)
- Email/SMS fallback
- Notification analytics/tracking
- Search within notifications
- Notification permissions (any pattern can notify)

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Source cell deleted | Show tombstone, user can dismiss |
| Access revoked | Same as deletion |
| Duplicate notify() | Dedupe by ref, keep existing entry |
| Rapid-fire notifications | Batch UI updates, rate-limit OS |
| Content seen before notification | Shows as already seen |
| User on multiple devices | Inbox syncs via home space |
| Very old notifications | No auto-expiry (TODO list model) |

---

## Open Questions

1. **Notification permissions**: Should patterns need permission to notify?
2. **Channels**: Should we implement Android-style channels for filtering?
3. **Swappable inbox**: How does a user replace `inbox.tsx` with their own?
4. **Priority escalation**: If re-sent as urgent, update existing or create new?
5. **Grouping UX**: Show 10 items or "10 new from Chat"?

---

## Technical Architecture

See companion document: `NOTIFICATIONS.md`

Key points:
- Inbox pattern lives in user's home space
- `notify()` is syntactic sugar for `wish('#inbox').send()`
- Cross-space references via NormalizedLink
- Two state machines: notification state (inbox) vs content seen state (source/annotation)
- Inbox checks annotations first, falls back to `source.seen` for backward compatibility
- Temporary annotation shim until full annotations infrastructure exists

---

## Appendix: Android vs iOS Comparison

| Feature | Android | iOS | Common Tools |
|---------|---------|-----|--------------|
| Persistence | Until dismissed | Until unlock | Until dismissed |
| Drawer/Center | Primary surface | Secondary, rarely checked | Primary surface |
| Grouping | Enforced | Optional | Planned |
| Channels | Required, user-controlled | No equivalent | Future |
| Snooze | Built-in | No native support | Phase 2 |
| Direct actions | Reply, archive, etc. | Limited | Future |
| Importance levels | 5 levels | 3 levels | 4 levels |
| State machine | Notification ≠ content state | Conflated | Separate |

---

## References

- [Android Developers: About Notifications](https://developer.android.com/develop/ui/views/notifications)
- [Material Design: Notification Patterns](https://m3.material.io/foundations/content-design/notifications)
- [Android vs iOS Notifications Analysis](https://www.androidauthority.com/android-vs-ios-notifications-926016/)
- [Attention Residue Research](https://www.sciencedirect.com/science/article/abs/pii/S0747563219302596)
