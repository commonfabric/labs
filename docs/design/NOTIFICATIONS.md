# Common Tools Notification System Design

> **Status**: Draft v4
> **Date**: 2026-01-09
> **Branch**: `feat/notifications-system`
> **Depends on**: Fabric URL Structure (charm identity), Annotations System

---

## Executive Summary

This document describes the design for a notification system in Common Tools. The system enables patterns to notify users about content requiring attention, with an inbox pattern aggregating notifications across all spaces.

**Core Philosophy** (inspired by Android):
- Notifications are **persistent information layers**, not ephemeral alerts
- Notifications are a **TODO list** of pending attention, not an interrupt stream
- **User agency is paramount** - users control their attention budget
- **High integrity** - clicking always shows current, live content
- **Two state machines** - notification state and content seen state are separate
- **Simple by default** - convention over configuration, annotations-ready for multi-user
- **Charm × Channel control** - users can mute by charm, by channel, or both

---

## The Two State Machines Model

This is the foundational insight of the design, derived from Android's 15-year evolution.

### Why Two State Machines?

In Android, there's a clear separation:
1. **Content state** (e.g., "is this email read?") - owned by the app, synced across devices
2. **Notification state** (e.g., "is this notification dismissed?") - owned by the OS, per-device

When you read an email on your phone:
- Gmail marks the *email* as read (app state, shared)
- Android dismisses the *notification* (OS state, local)
- Your tablet's notification also clears (because Gmail syncs read state)

**The notification system doesn't own "read" state. The app owns it. The notification system observes it.**

### State Machine 1: Content Seen State (Source-Owned)

This is the *semantic* state - "has this user seen this content?"

```
CONTENT SEEN STATE (per-user, owned by source app or user's projection)

  ┌──────────┐                      ┌──────────┐
  │  UNSEEN  │ ────────────────────►│   SEEN   │
  └──────────┘   user views content └──────────┘
                 in source app
```

Where this state lives:
- **Today (single-user)**: `seen: boolean` on the source cell
- **Future (multi-user)**: User's annotation in their projection space

### State Machine 2: Notification State (Inbox-Owned)

This is the *attention management* state - "what should I do with this notification?"

```
NOTIFICATION STATE (per-user, owned by inbox)

                                        ┌───────────┐
                                        │  SNOOZED  │
                                        │ (returns  │
                                        │  later)   │
                                        └─────┬─────┘
                                              │ timer expires
                                              ▼
┌──────────┐   user glances    ┌──────────┐   user dismisses   ┌───────────┐
│  ACTIVE  │ ─────────────────►│ NOTICED  │ ──────────────────►│ DISMISSED │
│(new,loud)│                   │(seen in  │                    │(archived) │
└──────────┘                   │ inbox)   │                    └───────────┘
     │                         └──────────┘                          ▲
     │                               │                               │
     │                               │ user snoozes                  │
     │                               ▼                               │
     │                         ┌───────────┐                         │
     │                         │  SNOOZED  │                         │
     │                         └───────────┘                         │
     │                                                               │
     └─────────────── user dismisses directly ───────────────────────┘
```

### Independence of the Two Machines

The two state machines are **linked but independent**:

| Action | Content State | Notification State |
|--------|---------------|-------------------|
| User dismisses notification | Unchanged | → DISMISSED |
| User views content in app | → SEEN | Can auto-transition or stay |
| User snoozes notification | Unchanged | → SNOOZED |
| Content marked seen elsewhere | → SEEN | Inbox observes, can react |

This independence enables:
- Dismiss notification without viewing content ✓
- View content without dismissing notification ✓
- View content → auto-dismiss notification ✓ (reactive, optional)
- Snooze notification for later ✓

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SHELL LAYER                                     │
│  ┌──────────────┐  ┌──────────────────┐  ┌──────────────────────────────┐   │
│  │ HeaderView   │  │ NotificationBell │  │ NotificationDropdown         │   │
│  │              │──│ (badge count)    │──│ (entry list, actions)        │   │
│  └──────────────┘  └──────────────────┘  └──────────────────────────────┘   │
│         │                   │                        │                       │
│         └───────────────────┼────────────────────────┘                       │
│                             │                                                │
│                    ┌────────▼────────┐                                       │
│                    │ InboxController │ ← wish('#inbox')                      │
│                    └────────┬────────┘                                       │
└─────────────────────────────┼───────────────────────────────────────────────┘
                              │
┌─────────────────────────────┼───────────────────────────────────────────────┐
│                      RUNTIME LAYER                                           │
│                              │                                               │
│  ┌───────────────────────────▼───────────────────────────────────────────┐  │
│  │                     HOME SPACE (User's DID)                            │  │
│  │                                                                        │  │
│  │  ┌──────────────────────────────────────────────────────────────────┐ │  │
│  │  │  INBOX PATTERN (tagged #inbox)                                    │ │  │
│  │  │                                                                   │ │  │
│  │  │  entries[]          - Notification state (ACTIVE/NOTICED/etc)    │ │  │
│  │  │  unseenCount        - Computed: active entries with unseen content│ │  │
│  │  │  send: Stream       - Handler adds entries, validates            │ │  │
│  │  │                                                                   │ │  │
│  │  │  Observes content seen state via annotations or source fields    │ │  │
│  │  └──────────────────────────────────────────────────────────────────┘ │  │
│  │                                                                        │  │
│  │  ┌──────────────────────────────────────────────────────────────────┐ │  │
│  │  │  ANNOTATIONS (temporary shim → future: projection space)         │ │  │
│  │  │                                                                   │ │  │
│  │  │  { source: ref, seen: true, seenAt: Date }                       │ │  │
│  │  └──────────────────────────────────────────────────────────────────┘ │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│               │ Cross-space refs (NormalizedLink)                            │
│               ▼                                                              │
│  ┌────────────────────────────┐  ┌────────────────────────────────┐         │
│  │ SOURCE SPACE A (single)    │  │ SOURCE SPACE B (multi-user)    │         │
│  │ ┌────────────────────────┐ │  │ ┌────────────────────────────┐ │         │
│  │ │ Todo Cell              │ │  │ │ Message Cell               │ │         │
│  │ │ { task, seen: bool }   │ │  │ │ { content, author }        │ │         │
│  │ │                        │ │  │ │ // NO seen field!          │ │         │
│  │ │ Single-user: seen here │ │  │ │ // seen via annotation     │ │         │
│  │ └────────────────────────┘ │  │ └────────────────────────────┘ │         │
│  └────────────────────────────┘  └────────────────────────────────┘         │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Core Data Model

### Inbox Entry (Notification State)

```typescript
interface InboxEntry {
  id: string;                    // Unique entry ID
  ref: NormalizedLink;           // Cross-space reference to source
  addedAt: Date;

  // Notification state (inbox-owned)
  state: 'active' | 'noticed' | 'dismissed' | 'snoozed';
  snoozedUntil?: Date;
  expiresAt?: Date;              // Optional: auto-dismiss after this time

  // Charm identity (injected by runtime, not user-supplied)
  charmId: string;               // did:charm:... - stable, content-addressed
  charmSlug: string;             // Current human-readable slug
  charmName: string;             // Current display name

  // Channel (folksonomy coordination)
  channelId: string;             // e.g., "messages", "reminders", "default"

  // Grouping (orthogonal to channels)
  groupKey: GroupKey;            // For visual batching

  // Cached data for display/offline
  cachedName?: string;           // Last known [NAME] of content
  cachedPreview?: string;        // Optional preview text
}
```

**Key insight**: `charmId` is the stable identity from Fabric's URL system. It's a content-addressed DID that survives renames. Rules keyed on `charmId` remain valid even when the charm is renamed from "Slack Sync" to "Slack Integration".

### Notification Payload (for sending)

```typescript
interface NotificationPayload {
  ref: NormalizedLink;           // Reference to content cell

  // Channel (optional, defaults to 'default')
  channel?: string;              // Channel ID for folksonomy coordination
  channelName?: string;          // Human-readable name (for new channels)
  channelImportance?: ChannelImportance;  // Suggested importance

  // Grouping (optional)
  group?: string | null;         // Explicit group key (null = singleton)
  groupTitle?: string;           // Human-readable group name

  // Lifecycle (optional)
  expiresAt?: Date;              // Auto-dismiss after this time

  // Note: charmId, charmSlug, charmName are injected by runtime
  // Patterns cannot spoof their identity
}
```

Patterns just send a reference and optional metadata. Identity is injected.

### Inbox Pattern Interface

```typescript
interface InboxInterface {
  // State
  entries: Cell<InboxEntry[]>;

  // Computed (reactive)
  activeCount: Cell<number>;     // Entries in 'active' state
  unseenCount: Cell<number>;     // Active entries with unseen content

  // Actions
  send: Stream<NotificationPayload>;       // Add notification
  dismiss: Stream<{ id: string }>;         // Archive notification
  snooze: Stream<{ id: string; until: Date }>;
  markNoticed: Stream<{ id: string }>;     // User saw it in inbox
  markSeen: Stream<{ ref: NormalizedLink }>;  // Write annotation
}
```

---

## The notify() API

`notify()` is a built-in function available in pattern scope. It captures the current charm's identity from runtime context:

```typescript
// Built-in - available in all patterns
notify({ ref: todoItem });

// With channel
notify({
  ref: message,
  channel: 'messages',
  channelImportance: 'high',
});

// With expiry
notify({
  ref: eventReminder,
  channel: 'reminders',
  expiresAt: event.startTime,  // Auto-dismiss when event starts
});
```

### How It Works Internally

```typescript
// Runtime implementation (not user-visible)
function notify(payload: NotificationPayload): void {
  const runtime = getRuntime();
  const context = runtime.getCurrentCharmContext();

  runtime.inbox.send({
    ...payload,
    // Identity injected from runtime context - cannot be spoofed
    charmId: context.charmId,      // did:charm:ve3r...
    charmSlug: context.slug,        // "team-chat"
    charmName: context.name,        // "Team Chat"
  });
}
```

**Key properties:**
- Synchronous (no async/await needed)
- Identity is injected by runtime (patterns can't lie about who they are)
- Channel defaults to `'default'` if not specified
- Deduplication by ref (same content = same notification)

---

## Annotations-First Design

### The Vision

The system is designed for a multi-user future where users have **projection spaces** - personal spaces where they annotate shared content. When you see a message in a shared chat, you write `{ seen: true }` to *your* projection space, not the shared message.

This means:
- Your "seen" state is private to you
- You don't need write access to shared content
- Multi-user notifications work naturally

### How markSeen() Works

```typescript
// User marks content as seen
function markSeen(ref: NormalizedLink): void {
  // Writes annotation to user's projection space
  annotate(ref, { seen: true, seenAt: new Date() });
}
```

### How Inbox Checks Seen State

The inbox uses convention-over-configuration to determine if content has been seen:

```typescript
function isContentSeen(ref: NormalizedLink): boolean {
  // 1. Check annotation first (preferred, works for multi-user)
  const annotation = getAnnotation<{ seen?: boolean }>(ref);
  if (annotation?.seen === true) return true;

  // 2. Fall back to source field (backward compat for single-user)
  const content = $(ref);
  if (content?.seen === true) return true;

  // 3. Neither - manual dismiss only
  return false;
}
```

This ordering means:
- **Multi-user patterns**: Use annotations, seen state is per-user and private
- **Single-user patterns**: Can use simple `seen: boolean` on source, just works
- **Neither**: User must manually dismiss notification

### The Temporary Shim

Annotations infrastructure doesn't exist yet. Until it ships, we use a **shim** that stores pseudo-annotations in home space:

```typescript
// packages/common/src/annotations-shim.ts
// TEMPORARY: Remove when real annotations ship

const ANNOTATIONS_CELL_KEY = '#annotations-shim';

export function annotate<T>(ref: NormalizedLink, data: T): void {
  const annotations = getAnnotationsCell();
  const key = normalizedLinkToKey(ref);
  annotations[key] = { ...annotations[key], ...data };
}

export function getAnnotation<T>(ref: NormalizedLink): T | undefined {
  const annotations = getAnnotationsCell();
  const key = normalizedLinkToKey(ref);
  return annotations[key] as T | undefined;
}
```

When real annotations ship:
1. Delete `annotations-shim.ts`
2. Update imports to use real `@commontools/annotations`
3. Pattern code stays **exactly the same**

---

## Content Seen State: Two Approaches

### Approach 1: Single-User (Simple)

For patterns with one user, put `seen` on the source cell:

```typescript
// patterns/todo-list.tsx
interface TodoItem {
  title: string;
  done: boolean;
  seen: boolean;  // Simple and direct
}

// When item created, notify
handler(onNewItem, (item) => {
  notify({ ref: item });
});

// When user views, mark seen (notification auto-clears via isContentSeen)
function onItemViewed(item: TodoItem) {
  item.seen = true;
}
```

The inbox's `isContentSeen()` finds `content.seen === true` and auto-clears.

### Approach 2: Multi-User (Annotations)

For multi-user patterns, use annotations:

```typescript
// patterns/chat.tsx
interface Message {
  content: string;
  author: DID;
  timestamp: Date;
  // NO seen field - that's per-user private state
}

// Notify recipient
handler(onNewMessage, async (message, { recipient }) => {
  await notifyUser(recipient, { ref: message });
});

// Chat UI writes annotation when message scrolls into view
function onMessageVisible(message: Message) {
  annotate(message, { seen: true, seenAt: new Date() });
}
```

The inbox's `isContentSeen()` finds the annotation and auto-clears.

---

## Multi-User Architecture Detail

```
┌─────────────────────────────────────────────────────────────────────┐
│                        SHARED SPACE (Chat)                           │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  Message Cell (msg-123)                                      │    │
│  │  {                                                           │    │
│  │    id: "msg-123",                                           │    │
│  │    content: "Hello team!",                                  │    │
│  │    author: did:alice,                                       │    │
│  │    timestamp: "2026-01-09T10:00:00Z"                        │    │
│  │    // NO seen field - multi-user!                           │    │
│  │  }                                                           │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
          │                              │
          │ Alice's view                 │ Bob's view
          ▼                              ▼
┌─────────────────────────┐    ┌─────────────────────────┐
│ ALICE'S HOME SPACE      │    │ BOB'S HOME SPACE        │
│                         │    │                         │
│ ┌─────────────────────┐ │    │ ┌─────────────────────┐ │
│ │ Annotations:        │ │    │ │ Annotations:        │ │
│ │                     │ │    │ │                     │ │
│ │ msg-123: {          │ │    │ │ msg-123: {          │ │
│ │   seen: true,       │ │    │ │   seen: false       │ │
│ │   seenAt: 10:30     │ │    │ │ }                   │ │
│ │ }                   │ │    │ │                     │ │
│ └─────────────────────┘ │    │ └─────────────────────┘ │
│                         │    │                         │
│ ┌─────────────────────┐ │    │ ┌─────────────────────┐ │
│ │ Inbox Entry:        │ │    │ │ Inbox Entry:        │ │
│ │ {                   │ │    │ │ {                   │ │
│ │   ref: msg-123,     │ │    │ │   ref: msg-123,     │ │
│ │   state: DISMISSED  │ │    │ │   state: ACTIVE     │ │
│ │ }                   │ │    │ │ }                   │ │
│ └─────────────────────┘ │    │ └─────────────────────┘ │
└─────────────────────────┘    └─────────────────────────┘

Alice has seen and dismissed.     Bob hasn't seen yet.
Her annotation: seen: true        His annotation: seen: false
Her notification: DISMISSED       His notification: ACTIVE
```

### Why Annotations Over `seenBy` on Source?

| Concern | `seenBy` on Source | Annotations |
|---------|-------------------|-------------|
| Privacy | Everyone sees who read | Only you know |
| Permissions | Need write access to shared content | Only write to your space |
| Scalability | O(users) per message | O(1) per user |
| Separation | Content knows about notifications | Content is pure content |

---

## Key Design Decisions

### 1. References, Not Copies

The inbox stores **pointers** to source content, not copies. This ensures:
- Clicking notification shows **current** content (high integrity)
- Source updates propagate automatically (reactivity)
- No data duplication or drift

### 2. Convention Over Configuration

No `seenStrategy` field. The inbox checks:
1. Annotations first (preferred)
2. Source `seen` field (backward compat)
3. Neither = manual dismiss only

This makes the common case trivial and the multi-user case automatic.

### 3. Inbox Observes, Doesn't Own, Content Seen State

The inbox *reactively observes* content seen state but doesn't own it. This matches Android's model where the notification system responds to app state changes.

### 4. Inbox in Home Space

The inbox pattern lives in the user's home space. This ensures:
- Notifications aggregate across ALL spaces
- User always has access to their inbox
- Annotations also live here

### 5. Trivially Simple notify()

```typescript
const inbox = await wish('#inbox');
inbox.send({ ref: myCell });
```

No configuration, no options, no magic.

### 6. Deduplication by Reference

Same `space + cell` combination = one notification. The existing entry's state is preserved (not reset to 'active').

---

## Android-Inspired Design Principles

From deep research on Android's 15-year notification evolution:

1. **Notifications are information layers, not interruptions**
   - They exist alongside user activity, not against it

2. **Persistence signals pending status**
   - Notifications remain until explicitly resolved (TODO list model)

3. **User agency is paramount**
   - Apps propose, users decide; granular control (channels)

4. **Attention is finite currency**
   - Every notification spends from a limited budget; priority matters

5. **Interruption is a spectrum**
   - Badge icon → inbox drawer → heads-up → OS notification

6. **Actions enable in-place resolution**
   - Mark noticed, dismiss, snooze without navigation

7. **Grouping manages cognitive load**
   - Batch related notifications; one semantic event = one interruption

8. **Human communication is special**
   - Conversations deserve elevated treatment

9. **Notification state != content state**
   - Two independent state machines, linked but separate

10. **The system observes, apps own semantics**
    - Notification system doesn't define "read" - apps do

---

## Shell Integration

### Bell Icon in Header

```typescript
// packages/shell/src/views/HeaderView.ts
<notification-bell
  .count=${this.inboxController.unseenCount}
  @click=${() => this.openInbox()}
/>
```

The `unseenCount` is computed:
```typescript
// Active notifications where content is not yet seen
unseenCount = entries
  .filter(e => e.state === 'active')
  .filter(e => !isContentSeen(e.ref))
  .length;
```

### Inbox Actions

| Action | Notification State Change | Content State Change |
|--------|--------------------------|---------------------|
| Open inbox | entries → 'noticed' | None |
| Click entry | Navigate to source | App may mark seen |
| Swipe dismiss | entry → 'dismissed' | None |
| Snooze | entry → 'snoozed' | None |
| View content in app | None (observed) | → seen (by app or annotation) |

### Tauri OS Notifications (Phase 2)

Background service watches inbox cell, triggers native notifications for new 'active' entries.

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Source cell deleted | Show tombstone in inbox, user can dismiss |
| Access revoked | Same as deletion |
| Duplicate notify() | Dedupe by ref, keep existing entry state |
| Rapid-fire notifications | Batch UI updates, rate-limit OS notifications |
| Content marked seen before notification | Inbox observes, shows as already seen |
| User on multiple devices | Inbox syncs (home space), annotations sync |
| Very old notifications | No auto-expiry (user's TODO list) |

---

## Time Reactivity

Time-based features (expiry, snooze) require reactive time primitives.

### The `#now` Primitive

Patterns can access reactive time via `wish('#now')`:

```typescript
// In inbox pattern
const now = wish('#now', { interval: 1000 });  // Updates every second

// Expiry becomes a simple computed
const nonExpiredEntries = computed(() => {
  const t = now.get();
  return entries.filter(e => !e.expiresAt || e.expiresAt > t);
});

// Snooze unfreeze is also reactive
const activeEntries = computed(() => {
  const t = now.get();
  return nonExpiredEntries.get().map(e => {
    if (e.state === 'snoozed' && e.snoozedUntil && e.snoozedUntil <= t) {
      return { ...e, state: 'active', snoozedUntil: undefined };
    }
    return e;
  });
});
```

### Background Snooze (Tauri)

When app is closed, snooze relies on OS-level scheduled notifications:

```typescript
// When user snoozes
handler(snooze, async ({ id, until }, ctx) => {
  updateEntry(id, { state: 'snoozed', snoozedUntil: until });

  // Schedule OS notification for wake-up (Tauri)
  await tauriScheduleNotification({
    id: `snooze-${id}`,
    at: until,
    title: entry.charmName,
    body: entry.cachedName || 'Snoozed reminder',
  });
});
```

See `TAURI_NOTIFICATION_PROJECTION.md` for details.

---

## User Control: Charm × Channel

Users need granular control over notifications. The system provides two-dimensional filtering:

```
                     Channels
                 messages  reminders  background
              ┌──────────┬──────────┬──────────┐
Charms   Chat │ ●        │          │          │
              ├──────────┼──────────┼──────────┤
        Email │ ●        │ ●        │ ●        │
              ├──────────┼──────────┼──────────┤
         Todo │          │ ●        │          │
              └──────────┴──────────┴──────────┘
```

Every notification lives at a `(charmId, channelId)` coordinate.

### Notification Rules

```typescript
interface NotificationRule {
  // Matching (both support wildcards)
  charmId: string;       // Charm DID or '*'
  channel: string;       // Channel ID or '*'

  // Settings (override channel defaults)
  importance?: ChannelImportance;
  sound?: boolean;
  osNotification?: boolean;
  showInInbox?: boolean;  // false = complete mute
}
```

### Rule Examples

```typescript
// Mute all background notifications (any charm)
{ charmId: '*', channel: 'background', showInInbox: false }

// Mute everything from a specific charm
{ charmId: 'did:charm:spammy...', channel: '*', showInInbox: false }

// Mute just Slack's messages (keep Email's messages)
{ charmId: 'did:charm:slack...', channel: 'messages', showInInbox: false }

// Make one charm always urgent
{ charmId: 'did:charm:alerts...', channel: '*', importance: 'urgent' }
```

### Rule Specificity

When multiple rules match, most specific wins:

| Specificity | Pattern | Example |
|-------------|---------|---------|
| 2 (highest) | `charmId:channel` | `did:charm:abc:messages` |
| 1 | `charmId:*` or `*:channel` | `did:charm:abc:*` |
| 0 (lowest) | `*:*` | Global default |

If two rules have the same specificity, the one defined later wins.

### Settings UI

```
Notification Settings
═══════════════════════════════════════════════════════

Channels (shared across charms)
─────────────────────────────────────────────────────
messages        High   🔊 🔔   [Used by: Chat, Email, Slack]
reminders       Urgent 🔊 🔔   [Used by: Todo, Calendar]
background      Min    🔇 ─    [Used by: Email, Sync]

Charm Overrides
─────────────────────────────────────────────────────
Slack Integration   [Muted entirely]              [Remove]
Critical Alerts     [Always urgent]               [Remove]

[+ Add override]
```

The UI shows human-readable charm names, but rules key on stable charm DIDs. When a charm is renamed, the rule continues to work.

---

## Implementation Phases

### Phase 1: MVP (Single-User Focus)
- Inbox pattern with entries cell and send stream
- `notify()` built-in with charm identity injection
- `isContentSeen()` checking source `seen` field
- Annotations shim (stores in home space cell)
- Shell bell icon with badge
- Basic inbox UI (list, navigate, dismiss)
- Notification states: active, dismissed
- Default channel only

### Phase 2: Full State Machine + Channels
- Notification states: noticed, snoozed
- `markSeen()` writes annotation via shim
- Channel system with folksonomy coordination
- Charm × channel user rules
- Grouping by source/channel
- `#now` reactive primitive for time-based features
- Expiry support

### Phase 3: Tauri Integration
- Tauri OS notifications as projection
- Scheduled notifications for background snooze
- Badge count sync
- Deep linking from OS notifications

### Phase 4: Real Annotations + Multi-User
- Delete annotations shim
- Real projection space annotations
- Full multi-user seen state
- Cross-device sync of annotations

---

## References

### Related Design Documents
- [NOTIFICATIONS_CHANNELS.md](./NOTIFICATIONS_CHANNELS.md) - Channel system with folksonomy coordination
- [NOTIFICATIONS_GROUPING.md](./NOTIFICATIONS_GROUPING.md) - Notification grouping and batching
- [TAURI_NOTIFICATION_PROJECTION.md](./TAURI_NOTIFICATION_PROJECTION.md) - Tauri OS notification integration
- [NOTIFICATIONS_DEEP_LINKING.md](./NOTIFICATIONS_DEEP_LINKING.md) - Navigation and action buttons
- [ANNOTATIONS.md](./ANNOTATIONS.md) - General-purpose annotation system

### External References
- [Android Notification Design Philosophy](https://developer.android.com/develop/ui/views/notifications)
- [Material Design Notifications](https://m3.material.io/foundations/content-design/notifications)
- [Fabric URL Structure PRD](../../Downloads/Fabric%20URL%20Structure%20-%20Product%20Requirements%20Document.md) - Charm identity model
- Common Tools Roadmap: Multi-User Scopes, Annotations
