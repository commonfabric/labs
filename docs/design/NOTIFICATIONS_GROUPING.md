# Notification Grouping System Design

> **Status**: Draft v1
> **Date**: 2026-01-09
> **Depends on**: `NOTIFICATIONS.md`

---

## Executive Summary

This document specifies the notification grouping system for Common Tools. Grouping reduces cognitive load by batching related notifications while maintaining the "one semantic event = one interruption" principle from the Android model.

**Core insight**: Grouping is primarily a **storage concern with UI implications**, not purely a UI concern. Groups need stable identities for dismissal semantics and cross-session persistence.

---

## Design Principles

1. **One semantic event = one interruption**: 10 messages arriving = 1 sound, not 10
2. **User agency preserved**: Users can expand, collapse, dismiss individually or as group
3. **High integrity**: Group summaries always reflect current content
4. **Convention over configuration**: Automatic grouping works by default; explicit grouping for control
5. **Progressive disclosure**: Summary first, details on demand

---

## Part 1: Grouping Key Design

### Question: How do we decide what groups together?

### Answer: Hierarchical grouping with explicit override

Notifications group by a **groupKey** derived from a hierarchy of signals:

```
GROUPING KEY RESOLUTION (highest to lowest priority)

1. Explicit group     → notify({ ref, group: "chat-room-123" })
2. Source space       → Automatic: all notifications from same space
3. No grouping        → Each notification standalone (legacy behavior)
```

### 1.1 Explicit Grouping (Highest Priority)

Patterns can specify an explicit group:

```typescript
// Pattern explicitly groups by conversation
notify({
  ref: message,
  group: `conversation:${conversationId}`,
  groupTitle: "Team Chat",        // Optional: human-readable group name
  groupIcon: "chat",              // Optional: icon for collapsed view
});
```

**Use cases**:
- Chat: Group by conversation, not by space
- Todos: Group by project, not by space
- Alerts: Group by severity level

### 1.2 Automatic Space Grouping (Default)

If no explicit `group` is provided, notifications group by source space:

```typescript
// These automatically group together (same space)
notify({ ref: todoA });  // space: did:space:abc
notify({ ref: todoB });  // space: did:space:abc

// Inbox shows: "2 items from Todo List"
```

**Why space is a good default**:
- Natural boundary for related content
- User mental model: "stuff from that app"
- Requires no pattern changes

### 1.3 Singleton Notifications

For notifications that should never group:

```typescript
notify({
  ref: urgentAlert,
  group: null,  // Explicit: never group this
});
```

### GroupKey Type Definition

```typescript
type GroupKey = string | null;

// Computed at send time
function computeGroupKey(payload: NotificationPayload): GroupKey {
  // Explicit group takes precedence
  if (payload.group !== undefined) {
    return payload.group;  // null means singleton
  }

  // Default: group by source space
  return `space:${payload.ref.space}`;
}
```

---

## Part 2: Data Model

### Question: How does grouping affect InboxEntry?

### Answer: Groups are first-class entities alongside entries

Grouping affects storage. We introduce a `NotificationGroup` entity that exists alongside entries.

### 2.1 Updated InboxEntry

```typescript
interface InboxEntry {
  id: string;                    // Unique entry ID
  ref: NormalizedLink;           // Cross-space reference to source
  addedAt: Date;

  // Notification state (inbox-owned)
  state: 'active' | 'noticed' | 'dismissed' | 'snoozed';
  snoozedUntil?: Date;

  // Grouping
  groupKey: GroupKey;            // Which group this belongs to (null = singleton)

  // Cached data for display/offline
  cachedName?: string;
  sourceSpace?: string;
}
```

### 2.2 New NotificationGroup Entity

```typescript
interface NotificationGroup {
  groupKey: string;              // The grouping key (never null for groups)

  // Display metadata (from first notification or pattern)
  title?: string;                // "Team Chat", "Todo List"
  icon?: string;                 // Icon for collapsed view

  // Computed at render (not stored)
  // entries: InboxEntry[];      // Derived from entries.filter(e => e.groupKey === groupKey)
  // activeCount: number;        // Derived
  // unseenCount: number;        // Derived

  // Group-level state
  expanded: boolean;             // Is this group currently expanded?
  lastActivityAt: Date;          // For sorting groups
}
```

### 2.3 Inbox Pattern Interface (Updated)

```typescript
interface InboxInterface {
  // State
  entries: Cell<InboxEntry[]>;
  groups: Cell<NotificationGroup[]>;    // NEW

  // Computed (reactive)
  activeCount: Cell<number>;
  unseenCount: Cell<number>;
  groupedView: Cell<GroupedNotification[]>;  // NEW: for UI rendering

  // Actions
  send: Stream<NotificationPayload>;
  dismiss: Stream<{ id: string }>;
  dismissGroup: Stream<{ groupKey: string }>;  // NEW
  snooze: Stream<{ id: string; until: Date }>;
  markNoticed: Stream<{ id: string }>;
  markSeen: Stream<{ ref: NormalizedLink }>;
  toggleGroupExpanded: Stream<{ groupKey: string }>;  // NEW
}
```

### 2.4 Computed GroupedNotification (for UI)

```typescript
interface GroupedNotification {
  type: 'group' | 'singleton';

  // For groups
  group?: NotificationGroup;
  entries?: InboxEntry[];        // Entries in this group
  activeCount?: number;
  unseenCount?: number;

  // For singletons
  entry?: InboxEntry;

  // Sorting
  lastActivityAt: Date;
}
```

### Why Storage, Not Pure UI Computation?

1. **Stable group identity**: Groups need IDs for dismissal, expansion state
2. **Persistence**: Expansion state should survive session/reload
3. **Efficiency**: Don't recompute grouping on every render
4. **Metadata**: Group titles/icons need storage

---

## Part 3: Summary Content

### Question: When showing "4 new messages from Chat", where does the text come from?

### Answer: Convention-based with pattern override

### 3.1 Summary Text Generation

```typescript
function generateGroupSummary(group: NotificationGroup, entries: InboxEntry[]): string {
  const activeEntries = entries.filter(e => e.state === 'active');
  const count = activeEntries.length;

  if (count === 0) return '';

  // 1. Pattern-provided title takes precedence
  if (group.title) {
    return `${count} new from ${group.title}`;
  }

  // 2. Fall back to source space name
  const spaceName = getSpaceDisplayName(group.groupKey);
  if (spaceName) {
    return `${count} new from ${spaceName}`;
  }

  // 3. Generic fallback
  return `${count} new notifications`;
}
```

### 3.2 Where Components Come From

| Component | Source | Example |
|-----------|--------|---------|
| Count | `entries.filter(active).length` | "4" |
| "new" | Hardcoded (localized) | "new" |
| "from" | Hardcoded (localized) | "from" |
| Group name | `group.title` OR space `[NAME]` | "Chat" |

### 3.3 Group Title Sources

Priority order for group title:

1. **Explicit in notify()**: `notify({ group: "x", groupTitle: "Team Chat" })`
2. **First entry's cached name**: If all entries from same pattern
3. **Space display name**: `[NAME]` annotation on source space
4. **Group key**: Last resort, e.g., "space:did:space:abc..."

### 3.4 What's the Summary Entry's `ref`?

The group summary is **not** an InboxEntry. It's a computed UI element. However, clicking it needs a destination:

```typescript
interface GroupedNotification {
  type: 'group';

  // Click behavior
  clickAction:
    | { type: 'expand' }           // Default: expand the group
    | { type: 'navigate'; ref: NormalizedLink }  // Go to space/pattern
  ;
}
```

**Default behavior**: Clicking a collapsed group expands it.

**Optional**: Pattern can specify a "view all" destination:

```typescript
notify({
  ref: message,
  group: "chat:room-123",
  groupViewAllRef: chatRoomRef,  // "View all" goes here
});
```

---

## Part 4: Dismissal Semantics

### Question: When user dismisses a group, what happens?

### Answer: Group dismissal dismisses all entries in the group

### 4.1 Dismissal Behaviors

| Action | Effect |
|--------|--------|
| Dismiss single entry | Only that entry → `dismissed` |
| Dismiss expanded group header | All entries in group → `dismissed` |
| Dismiss collapsed group | All entries in group → `dismissed` |
| Swipe single entry in expanded group | Only that entry → `dismissed` |

### 4.2 Implementation

```typescript
handler(dismissGroup, ({ groupKey }, context) => {
  const entries = context.entries.get();
  const updated = entries.map(entry =>
    entry.groupKey === groupKey
      ? { ...entry, state: 'dismissed' }
      : entry
  );
  context.entries.set(updated);
});
```

### 4.3 Partial Dismissal

Users can expand a group and dismiss individual entries:

```
┌─────────────────────────────────────────────┐
│ Team Chat (4 new)                      [×]  │  ← Dismiss all 4
├─────────────────────────────────────────────┤
│ ├ Alice: Meeting at 3pm               [×]   │  ← Dismiss just this
│ ├ Bob: On my way                      [×]   │
│ ├ Carol: Running late                 [×]   │
│ └ Dave: See you there                 [×]   │
└─────────────────────────────────────────────┘
```

### 4.4 Content Seen State (Unchanged)

Dismissing a group does **NOT** mark content as seen. Per the two-state-machine model:

- **Notification state** (inbox-owned): → `dismissed`
- **Content seen state** (source-owned): → unchanged

User can dismiss without viewing content. This is intentional.

---

## Part 5: Expansion State

### Question: Is expansion state persisted? Per-session or durable?

### Answer: Durable persistence with smart defaults

### 5.1 Expansion State Storage

```typescript
interface NotificationGroup {
  groupKey: string;
  expanded: boolean;        // Persisted with group
  // ...
}
```

**Persistence**: Expansion state is stored in the `groups` cell and syncs with home space.

### 5.2 Default Expansion Behavior

| Scenario | Default Expansion |
|----------|------------------|
| New group (first notification) | Collapsed |
| Group with 1 entry | Auto-expanded (no point in collapsing) |
| Group with 2+ entries | Collapsed |
| User explicitly toggles | Persisted |

### 5.3 UX Interactions

```typescript
// Toggle expansion
handler(toggleGroupExpanded, ({ groupKey }, context) => {
  const groups = context.groups.get();
  const updated = groups.map(g =>
    g.groupKey === groupKey
      ? { ...g, expanded: !g.expanded }
      : g
  );
  context.groups.set(updated);
});
```

### 5.4 Expansion UI

```
COLLAPSED:
┌─────────────────────────────────────────────┐
│ ▶ Team Chat (4 new)                    [×]  │
└─────────────────────────────────────────────┘

EXPANDED:
┌─────────────────────────────────────────────┐
│ ▼ Team Chat (4 new)                    [×]  │
├─────────────────────────────────────────────┤
│   Alice: Meeting at 3pm               [×]   │
│   Bob: On my way                      [×]   │
│   Carol: Running late                 [×]   │
│   Dave: See you there                 [×]   │
└─────────────────────────────────────────────┘
```

### 5.5 Auto-Collapse on New Activity

**Optional behavior** (configurable): When a new notification arrives in a group, auto-collapse the group to surface the summary. This prevents users from missing new items in an already-expanded group.

```typescript
// In send handler
if (existingGroup && existingGroup.expanded) {
  // Option A: Keep expanded, but highlight new entry
  // Option B: Collapse to show updated summary
  existingGroup.expanded = false;  // Option B
}
```

**Recommendation**: Start with Option A (keep expanded), add Option B as user preference.

---

## Part 6: Sound and Interruption

### Question: When 10 notifications arrive in 1 second, how many sounds/OS notifications?

### Answer: One per group, rate-limited

### 6.1 Interruption Rules

```typescript
interface InterruptionConfig {
  // Sound
  soundDebounceMs: 500;          // Max 1 sound per 500ms per group

  // OS notification
  osNotificationDebounceMs: 2000;  // Max 1 OS notification per 2s per group
  osNotificationEnabled: boolean;   // User preference

  // Heads-up (in-app overlay)
  headsUpDebounceMs: 1000;
}
```

### 6.2 Sound Behavior

| Scenario | Sounds |
|----------|--------|
| 1 notification | 1 sound |
| 10 notifications, same group, <500ms | 1 sound |
| 10 notifications, same group, over 5s | Multiple sounds (one per 500ms window) |
| 10 notifications, 5 different groups, <500ms | 5 sounds (one per group) |

### 6.3 OS Notification Grouping

For Tauri OS notifications (Phase 2):

```typescript
// OS notifications use native grouping when available
function sendOSNotification(entry: InboxEntry, group: NotificationGroup | null) {
  if (group) {
    // Grouped OS notification
    Notification.requestPermission().then(() => {
      new Notification(group.title || 'Common Tools', {
        body: generateGroupSummary(group, getEntriesForGroup(group)),
        tag: group.groupKey,  // Same tag = replace previous
        renotify: true,       // Still alert even when replacing
      });
    });
  } else {
    // Singleton OS notification
    new Notification(entry.cachedName || 'Notification', {
      body: '...',
      tag: entry.id,
    });
  }
}
```

**Key insight**: Using `tag` with the group key means rapid notifications replace each other, showing only the latest summary.

### 6.4 Badge Count

Badge count is the **total unseen across all entries**, not groups:

```typescript
// Badge = total unseen entries (not groups)
const unseenCount = entries
  .filter(e => e.state === 'active')
  .filter(e => !isContentSeen(e.ref))
  .length;

// Shown: 🔔 7  (not "3 groups")
```

**Rationale**: Badge answers "how many things need attention?" not "how many sources have activity?"

---

## Part 7: Interaction with Seen State

### Question: If 4 messages are grouped, and user views 2, what happens?

### Answer: Partial seen state within groups

### 7.1 Seen State is Per-Entry

Each entry's seen state is independent:

```
Group: Team Chat (4 new, 2 unseen)
├ Alice: Meeting at 3pm        [SEEN - dimmed]
├ Bob: On my way              [UNSEEN - bold]
├ Carol: Running late         [SEEN - dimmed]
└ Dave: See you there         [UNSEEN - bold]
```

### 7.2 Group Summary Reflects Unseen Count

```typescript
function formatGroupHeader(group: NotificationGroup, entries: InboxEntry[]): string {
  const activeEntries = entries.filter(e => e.state === 'active');
  const unseenEntries = activeEntries.filter(e => !isContentSeen(e.ref));

  if (unseenEntries.length === 0) {
    // All seen
    return `${group.title} (${activeEntries.length})`;
  } else if (unseenEntries.length === activeEntries.length) {
    // None seen
    return `${group.title} (${activeEntries.length} new)`;
  } else {
    // Partial
    return `${group.title} (${unseenEntries.length} unseen of ${activeEntries.length})`;
  }
}
```

### 7.3 No Group Splitting

We do **not** split groups into seen/unseen subgroups. This would:
- Fragment the UI
- Break mental model ("these came from Chat")
- Complicate dismissal

Instead: visual differentiation within the group (bold/dim).

### 7.4 Auto-Dismiss When All Seen

**Optional behavior**: When all entries in a group are seen (via viewing content), auto-dismiss the group.

```typescript
// Reactive: watch for all-seen condition
effect(() => {
  for (const group of groups.get()) {
    const entries = getEntriesForGroup(group.groupKey);
    const activeEntries = entries.filter(e => e.state === 'active');
    const allSeen = activeEntries.every(e => isContentSeen(e.ref));

    if (allSeen && activeEntries.length > 0) {
      // Auto-dismiss group (or just visually de-emphasize)
      dismissGroup({ groupKey: group.groupKey });
    }
  }
});
```

**Recommendation**: Start with manual dismiss only. Add auto-dismiss as user preference.

---

## Part 8: Notify API Changes

### Updated NotificationPayload

```typescript
interface NotificationPayload {
  ref: NormalizedLink;           // Required: reference to content cell

  // Grouping (all optional)
  group?: string | null;         // Explicit group key (null = singleton)
  groupTitle?: string;           // Human-readable group name
  groupIcon?: string;            // Icon for group header
  groupViewAllRef?: NormalizedLink;  // "View all" destination
}
```

### Backward Compatibility

Existing `notify({ ref })` calls continue to work:
- `group` defaults to `space:${ref.space}` (automatic space grouping)
- No changes required for existing patterns

### Examples

```typescript
// Basic (auto-groups by space)
notify({ ref: todoItem });

// Explicit conversation grouping
notify({
  ref: message,
  group: `conversation:${conversationId}`,
  groupTitle: "Team Chat",
});

// Singleton (never groups)
notify({
  ref: urgentAlert,
  group: null,
});

// With "view all" destination
notify({
  ref: orderUpdate,
  group: `orders`,
  groupTitle: "Recent Orders",
  groupViewAllRef: ordersListRef,
});
```

---

## Part 9: Implementation Phases

### Phase 2A: MVP Grouping (Recommended First)

**Goal**: Automatic space-based grouping with basic UX

1. Add `groupKey` field to InboxEntry
2. Add `groups` cell to Inbox pattern
3. Compute `groupedView` for UI
4. Implement expand/collapse UX
5. Implement group dismissal
6. Sound debouncing per group

**Data model changes**:
- InboxEntry: add `groupKey: string` (defaults to `space:${ref.space}`)
- New: NotificationGroup entity
- New: groups cell in Inbox pattern

**API changes**: None (backward compatible)

### Phase 2B: Explicit Grouping

**Goal**: Pattern control over grouping

1. Accept `group`, `groupTitle`, `groupIcon` in notify()
2. Update group metadata on notification arrival
3. Implement `group: null` for singletons

### Phase 2C: Polished UX

**Goal**: Production-ready grouping experience

1. OS notification grouping (Tauri)
2. Auto-collapse on new activity (optional)
3. "View all" navigation
4. Animation for expand/collapse
5. Partial seen state visualization

### Future: Advanced Grouping

- Time-window grouping ("today", "yesterday", "older")
- Smart grouping suggestions
- User-defined group rules
- Cross-space pattern-type grouping

---

## Part 10: Examples

### Example 1: Chat Application

```typescript
// Chat pattern sends notification for each message
handler(onNewMessage, (message, { conversationId, conversationName }) => {
  notify({
    ref: message,
    group: `conversation:${conversationId}`,
    groupTitle: conversationName,
    groupIcon: "chat",
  });
});
```

**User sees**:
```
┌─────────────────────────────────────────────┐
│ ▶ Team Chat (4 new)                    [×]  │
└─────────────────────────────────────────────┘
```

**Expanded**:
```
┌─────────────────────────────────────────────┐
│ ▼ Team Chat (4 new)                    [×]  │
├─────────────────────────────────────────────┤
│   Alice: Meeting at 3pm               [×]   │
│   Bob: On my way                      [×]   │
│   Carol: Running late                 [×]   │
│   Dave: See you there                 [×]   │
└─────────────────────────────────────────────┘
```

### Example 2: Todo List (Automatic Grouping)

```typescript
// Todo pattern uses default space grouping
handler(onTodoCreated, (todo) => {
  notify({ ref: todo });  // Groups by space automatically
});
```

**User sees**:
```
┌─────────────────────────────────────────────┐
│ ▶ Work Tasks (3 new)                   [×]  │  ← Space name
└─────────────────────────────────────────────┘
```

### Example 3: Critical Alert (Singleton)

```typescript
// System alert that should never group
notify({
  ref: criticalError,
  group: null,  // Explicit singleton
});
```

**User sees**:
```
┌─────────────────────────────────────────────┐
│ ⚠️ Server Error: Database connection...  [×] │  ← Standalone
└─────────────────────────────────────────────┘
┌─────────────────────────────────────────────┐
│ ▶ Team Chat (4 new)                    [×]  │
└─────────────────────────────────────────────┘
```

### Example 4: Multiple Conversations

```typescript
// Different conversations = different groups
notify({ ref: msg1, group: "conversation:alice", groupTitle: "Alice" });
notify({ ref: msg2, group: "conversation:bob", groupTitle: "Bob" });
notify({ ref: msg3, group: "conversation:alice", groupTitle: "Alice" });
```

**User sees**:
```
┌─────────────────────────────────────────────┐
│ ▶ Alice (2 new)                        [×]  │
└─────────────────────────────────────────────┘
┌─────────────────────────────────────────────┐
│ ▶ Bob (1 new)                          [×]  │
└─────────────────────────────────────────────┘
```

---

## Appendix A: Android Comparison

| Feature | Android | Common Tools |
|---------|---------|--------------|
| Grouping key | Package + group string | Space + explicit group |
| Summary notification | Required for 4+ | Computed automatically |
| Expand/collapse | Native UI | Custom implementation |
| Group dismissal | All or individual | All or individual |
| Sound bundling | 1 per group | 1 per group (debounced) |
| Badge count | Per-app | Total unseen |

---

## Appendix B: Open Questions

1. **Group persistence**: Should empty groups be garbage-collected?
   - **Recommendation**: Yes, after all entries dismissed

2. **Group ordering**: By most recent activity or alphabetical?
   - **Recommendation**: Most recent activity (matches inbox sort)

3. **Max entries per group**: Should we limit visible entries?
   - **Recommendation**: No limit, but consider virtualization for large groups

4. **Cross-device sync**: Does expansion state sync?
   - **Recommendation**: Yes, it's in home space

5. **Group merge**: What if two groups should become one?
   - **Recommendation**: Out of scope for MVP; explicit groups are stable

---

## References

- [NOTIFICATIONS.md](./NOTIFICATIONS.md) - Core notification system design
- [NOTIFICATIONS_PRD.md](./NOTIFICATIONS_PRD.md) - Product requirements
- [Android Notification Grouping](https://developer.android.com/develop/ui/views/notifications/group)
- [email-inbox-threading.pattern.ts](../../packages/generated-patterns/integration/patterns/email-inbox-threading.pattern.ts) - Threading example
