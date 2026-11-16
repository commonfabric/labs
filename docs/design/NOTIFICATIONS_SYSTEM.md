# Notification System Design

> **Status**: Draft v5 — Ready for Review
> **Date**: 2026-01-09
> **Branch**: `feat/notifications-system`

---

## Decisions Needing Your Input

### 1. Charm × Channel for user control?

Every notification has a `(charmId, channelId)` coordinate. Users can mute:
- `*:background` — all background notifications from any charm
- `slack:*` — everything from Slack charm
- `slack:messages` — just Slack's messages, keep Email's messages

**The tradeoff**: Channels are folksonomy (shared namespace). Charms using `channel: 'messages'` share settings by default. The per-charm override is the escape hatch.

**Question**: Is two-dimensional control right, or is per-charm enough?

### 2. Runtime injects charm identity?

`notify()` is a built-in. Runtime injects `charmId` (the DID), `charmSlug`, and `charmName` from execution context. Patterns cannot specify or spoof their identity.

**Question**: Any concerns with this approach?

### 3. Notification state vs content seen state?

Two independent state machines (Android's model):

| State Machine | Owner | States |
|---------------|-------|--------|
| **Notification** | Inbox pattern | active → noticed → dismissed (or snoozed) |
| **Content seen** | Annotations | unseen → seen |

"Noticed" = user saw the notification in inbox. "Seen" = user viewed the actual content.

User can dismiss without viewing (clear inbox, don't mark content seen). User can view content in the source charm, which marks it seen; inbox observes this reactively and can auto-dismiss.

**Question**: Is this separation clear? Any issues with inbox observing annotation changes?

### 4. Scheduled OS notifications for background snooze?

When app is open, snooze uses `wish('#now')` reactively. When app is closed, we schedule an OS notification via Tauri for the wake-up time.

**Question**: Is this the right split? Should Tauri own more?

### 5. What belongs in Phase 1?

Proposed MVP:
- Inbox pattern with entries cell
- `notify()` built-in with charm identity injection
- States: active, dismissed only (no noticed/snoozed yet)
- Default channel only (no user rules yet)
- Annotations shim for seen state
- Basic inbox UI in shell

**Question**: Too much? Too little?

---

## Open Questions

1. **Rate limiting** — Where enforced? Per-charm quotas? What happens when exceeded?

2. **Deleted content** — Notification references content that's deleted or access revoked. Show tombstone? Auto-dismiss?

3. **Rule conflicts** — Two rules match with same specificity. Last-defined wins?

4. **Snooze intervals** — "1 hour", "Tomorrow morning", custom picker?

5. **Notification expiry** — Expired entries transition to dismissed, or just disappear?

6. **Group dismissal** — Dismissing a group dismisses entries user never saw. Intentional?

---

## The Model

### State Transitions

```
NOTIFICATION STATE (inbox-owned):

                    ┌─────────────────────────────────┐
                    │                                 │
                    ▼                                 │
┌────────┐  view in   ┌─────────┐  dismiss   ┌───────────┐
│ ACTIVE │ ─────────► │ NOTICED │ ─────────► │ DISMISSED │
└────────┘  inbox     └─────────┘            └───────────┘
    │                      │                       ▲
    │                      │ snooze                │
    │                      ▼                       │
    │                 ┌─────────┐                  │
    │                 │ SNOOZED │ ─── expires ─────┘
    │                 └─────────┘       │
    │                      ▲            │
    │                      │            ▼
    └──────── snooze ──────┘      back to ACTIVE
    │
    └──────── dismiss directly ──────► DISMISSED


CONTENT SEEN STATE (annotation-owned):

┌────────┐  user views content   ┌──────┐
│ UNSEEN │ ────────────────────► │ SEEN │
└────────┘  (in source charm)    └──────┘
```

Inbox observes content seen state. When content becomes seen, inbox can optionally auto-transition notification from active/noticed → dismissed.

### Data Flow

```
Pattern: notify({ ref, channel: 'messages' })
                    │
                    ▼
Runtime: inject charmId, charmSlug, charmName from context
                    │
                    ▼
Inbox pattern: receive in home space
                    │
                    ├── Apply user rules (is this charmId:channelId muted?)
                    │
                    ├── If muted: discard
                    │
                    ├── If allowed: create InboxEntry
                    │       │
                    │       ├── Update badge count
                    │       ├── Maybe play sound (per channel importance)
                    │       └── Maybe push to Tauri (OS notification)
                    │
                    └── Observe content seen state via annotations
                            │
                            └── When seen: optionally auto-dismiss
```

### Importance Levels

Channels have importance (pattern-suggested, user-overridable):

| Level | Sound | OS Notification | Example |
|-------|-------|-----------------|---------|
| `urgent` | Yes | Heads-up | Alarms, calls |
| `high` | Yes | Yes | Direct messages |
| `default` | Yes | Optional | Most things |
| `low` | No | No | Social updates |
| `min` | No | No | Background sync |

### Grouping

Optional visual batching. Orthogonal to channels.

```typescript
notify({
  ref: message,
  channel: 'messages',        // Controls interruption
  group: `chat:${roomId}`,    // Controls batching
  groupTitle: 'Team Chat',
});
```

- Same group key → batched visually in inbox
- One sound per group arrival
- Dismiss group → dismisses all entries in group

---

## Tauri Integration

**Principle**: Inbox owns all state. Tauri projects to OS.

Tauri commands:
- `showNotification(id, title, body, payload)` — show OS notification
- `cancelNotification(id)` — remove from notification center
- `scheduleNotification(id, at, title, body, payload)` — for background snooze
- `cancelScheduledNotification(id)` — if user dismisses before snooze expires
- `updateBadge(count)` — dock badge

Tauri events (back to frontend):
- `notification-clicked` → navigate to content, mark noticed
- `notification-dismissed` → no-op (OS dismiss ≠ inbox dismiss)

**Key behavior**: Swiping away an OS notification does NOT dismiss it from inbox. User still sees it in inbox dropdown. This matches iOS/Android behavior.

---

## Data Model

```typescript
interface InboxEntry {
  id: string;
  ref: NormalizedLink;
  addedAt: Date;

  // Notification state
  state: 'active' | 'noticed' | 'dismissed' | 'snoozed';
  snoozedUntil?: Date;
  expiresAt?: Date;

  // Charm identity (runtime-injected)
  charmId: string;      // did:charm:... — stable across renames
  charmSlug: string;
  charmName: string;

  // Channel
  channelId: string;

  // Grouping
  groupKey: string | null;

  // Display cache
  cachedName?: string;
  cachedPreview?: string;
}

interface NotificationPayload {
  ref: NormalizedLink;
  channel?: string;              // defaults to 'default'
  channelImportance?: ChannelImportance;
  group?: string | null;         // null = singleton
  groupTitle?: string;
  expiresAt?: Date;
  // charmId, charmSlug, charmName injected by runtime
}

interface NotificationRule {
  charmId: string;    // DID or '*'
  channel: string;    // channel ID or '*'
  showInInbox?: boolean;
  importance?: ChannelImportance;
  sound?: boolean;
}
```

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Content deleted | Show tombstone in inbox, user can dismiss |
| Access revoked | Same as deleted |
| Duplicate notify() for same ref | Dedupe, keep existing entry state |
| Snooze while app closed | Scheduled OS notification fires |
| Content marked seen before notification arrives | Inbox observes, shows as already seen |
| User on multiple devices | Inbox syncs via home space |

---

## Implementation Phases

**Phase 1 (MVP)**: Inbox pattern, `notify()` built-in, active/dismissed states, default channel, annotations shim, basic shell UI.

**Phase 2**: noticed/snoozed states, channel system, charm×channel rules, `#now` for time features.

**Phase 3**: Tauri integration, scheduled notifications, badge sync.

**Phase 4**: Grouping, real annotations, multi-device polish.
