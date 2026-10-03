# Notification Channels System Design

> **Status**: Draft v2
> **Date**: 2026-01-09
> **Depends on**: `NOTIFICATIONS.md`, `NOTIFICATIONS_GROUPING.md`, Fabric URL Structure

---

## Executive Summary

This document specifies the notification channels system for Common Tools, adapted from Android's channel model for a pattern-based reactive runtime. Channels enable **user agency over notification importance** while supporting **folksonomy-based coordination** across charms.

**Core Philosophy**:
- Charms declare channels with suggested importance; users control final settings
- Channels use a folksonomy model: shared names enable cross-charm coordination
- Convention-based coordination; namespacing is opt-in, not mandatory
- Channels are orthogonal to groups: channels control *how* notifications interrupt; groups control *what* batches together
- **Charm × Channel control**: Users can mute by charm, by channel, or any combination

---

## Part 1: Channel Data Model

### 1.1 Channel Definition

```typescript
/**
 * A notification channel defines a category of notifications with
 * user-controllable importance and delivery settings.
 */
interface Channel {
  // Identity
  id: string;                       // Unique channel identifier (e.g., "messages", "reminders")

  // Display
  name: string;                     // Human-readable name ("Messages", "Reminders")
  description?: string;             // Explains what this channel is for

  // Importance (pattern-suggested, user-overridable)
  importance: ChannelImportance;    // See below

  // Delivery settings (all user-overridable)
  sound: boolean;                   // Play sound on notification
  osNotification: boolean;          // Show OS-level notification (Tauri)
  showInInbox: boolean;             // Show in inbox at all (false = complete mute)

  // Metadata
  declaredBy: ChannelDeclaration[]; // Which patterns declared this channel
  createdAt: Date;
  userModified: boolean;            // Has user changed settings from defaults?
}

/**
 * Importance levels (adapted from Android)
 */
type ChannelImportance =
  | 'urgent'    // Heads-up + sound + OS notification (calls, alarms)
  | 'high'      // Sound + prominent in inbox (direct messages)
  | 'default'   // Sound, normal treatment (most notifications)
  | 'low'       // Silent, normal in inbox (social updates)
  | 'min';      // Silent, de-emphasized (weather, background info)

/**
 * Record of a charm declaring a channel
 */
interface ChannelDeclaration {
  charmId: string;                  // Charm DID (did:charm:...) - stable identity
  charmSlug?: string;               // Current human-readable slug
  charmName?: string;               // Current display name
  declaredAt: Date;
  suggestedImportance: ChannelImportance;  // What the charm suggested
}
```

### 1.2 Importance Level Behaviors

| Level | Sound | OS Notification | Inbox Treatment | Use Case |
|-------|-------|-----------------|-----------------|----------|
| `urgent` | Yes | Heads-up + sound | Prominent, top of list | Incoming calls, timers, alarms |
| `high` | Yes | Yes | Highlighted | Direct messages from humans |
| `default` | Yes | Optional | Normal | Most notifications |
| `low` | No | No | Normal | Social updates, recommendations |
| `min` | No | No | De-emphasized (smaller, dimmed) | Weather, background sync info |

### 1.3 Default Channel

Every notification needs a channel. If unspecified, notifications use the **default channel**:

```typescript
const DEFAULT_CHANNEL: Channel = {
  id: 'default',
  name: 'General',
  description: 'Notifications without a specific channel',
  importance: 'default',
  sound: true,
  osNotification: false,
  showInInbox: true,
  declaredBy: [],
  createdAt: new Date(0),  // System channel
  userModified: false,
};
```

---

## Part 2: Channel Declaration

### 2.1 Runtime Declaration via notify()

Channels are declared at runtime in the notify() payload:

```typescript
interface NotificationPayload {
  ref: NormalizedLink;

  // Existing grouping fields
  group?: string | null;
  groupTitle?: string;

  // Channel fields
  channel?: string;                  // Channel ID (defaults to 'default')
  channelName?: string;              // Human-readable name (for new channels)
  channelDescription?: string;       // What this channel is for
  channelImportance?: ChannelImportance;  // Suggested importance
}
```

### 2.2 Auto-Creation Behavior

When a notification specifies a channel that doesn't exist:

```typescript
function ensureChannel(payload: NotificationPayload, patternContext: PatternContext): Channel {
  const channelId = payload.channel || 'default';
  const existing = getChannel(channelId);

  if (existing) {
    // Channel exists - record this pattern as a declarer
    addDeclaration(existing, {
      patternId: patternContext.patternId,
      patternName: patternContext.patternName,
      declaredAt: new Date(),
      suggestedImportance: payload.channelImportance || 'default',
    });
    return existing;
  }

  // Create new channel with pattern's suggested settings
  const newChannel: Channel = {
    id: channelId,
    name: payload.channelName || humanize(channelId),
    description: payload.channelDescription,
    importance: payload.channelImportance || 'default',
    sound: importanceHasSound(payload.channelImportance || 'default'),
    osNotification: importanceHasOSNotification(payload.channelImportance || 'default'),
    showInInbox: true,
    declaredBy: [{
      patternId: patternContext.patternId,
      patternName: patternContext.patternName,
      declaredAt: new Date(),
      suggestedImportance: payload.channelImportance || 'default',
    }],
    createdAt: new Date(),
    userModified: false,
  };

  saveChannel(newChannel);
  return newChannel;
}
```

### 2.3 Examples

```typescript
// Basic: uses default channel
notify({ ref: todoItem });

// Explicit channel (auto-creates if needed)
notify({
  ref: message,
  channel: 'messages',
  channelName: 'Messages',
  channelDescription: 'Direct messages from other users',
  channelImportance: 'high',
});

// Low-importance updates
notify({
  ref: syncResult,
  channel: 'background-sync',
  channelName: 'Background Sync',
  channelImportance: 'min',
});
```

---

## Part 3: Channel Registry

### 3.1 Storage Location

Channels are stored in the **user's home space**:

```typescript
interface ChannelRegistry {
  channels: Cell<Channel[]>;

  // Actions
  updateChannel: Stream<Partial<Channel> & { id: string }>;
  deleteChannel: Stream<{ id: string }>;
}
```

### 3.2 Federated Model

The channel system uses a **federated model**:

1. **Patterns declare** channel defaults (name, suggested importance)
2. **Home space stores** the canonical channel with any user overrides
3. **User changes override** pattern suggestions

**Key rule**: Once `userModified: true`, pattern-suggested importance is ignored.

---

## Part 4: User Channel Settings

### 4.1 What Users Can Control

| Setting | Type | Description | Default |
|---------|------|-------------|---------|
| `importance` | enum | Overall urgency level | From pattern |
| `sound` | boolean | Play sound | Derived from importance |
| `osNotification` | boolean | Show OS notification | Derived from importance |
| `showInInbox` | boolean | Appear in inbox at all | `true` |

### 4.2 Complete Mute

Setting `showInInbox: false` is a **complete mute**:
- Notification is discarded immediately
- No inbox entry created
- No badge count impact

### 4.3 Importance Override Restrictions

Following Android's model, patterns **cannot programmatically increase importance** after channel creation. Users are in control.

---

## Part 5: Folksonomy Coordination

### 5.1 The Folksonomy Model

Channels use a **folksonomy** (folk taxonomy) model:
- Channel IDs are free-form strings
- Same ID from different patterns = same channel
- Conventions emerge through use, not enforcement

**Example**: If "Chat App A", "Chat App B", and "Email App" all use `channel: 'messages'`:
- They share user settings
- User mutes "messages" → all three are muted
- This is a **feature**, not a bug

### 5.2 Shared Settings Across Patterns

When multiple patterns declare the same channel:

```typescript
// Chat App
notify({ ref: chatMsg, channel: 'messages', channelImportance: 'high' });

// Email App
notify({ ref: emailMsg, channel: 'messages', channelImportance: 'high' });

// Slack Sync
notify({ ref: slackMsg, channel: 'messages', channelImportance: 'default' });
```

Result:
- One "Messages" channel exists
- All three patterns listed in `declaredBy`
- User settings apply to ALL three
- Settings UI shows "Used by: Chat, Email, Slack Sync"

### 5.3 Namespace Escape Hatch

For patterns that need isolation, use a unique prefix:

```typescript
// Pattern wants isolation: use a unique prefix
notify({
  ref: item,
  channel: 'myapp:internal-updates',  // Will not collide with 'internal-updates'
});
```

**Rationale**: Coordination is the primary value; isolation is the exception. Charms that need isolation can achieve it via naming conventions.

---

## Part 6: Charm × Channel User Control

Folksonomy coordination is powerful, but users need an escape hatch. The **Charm × Channel** model provides two-dimensional control.

### 6.1 The Control Matrix

Every notification lives at a `(charmId, channelId)` coordinate:

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

Users can create rules that match:
- `*:channel` - All charms using this channel
- `charmId:*` - All channels from this charm
- `charmId:channel` - Specific combination

### 6.2 Notification Rules

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

### 6.3 Rule Specificity

When multiple rules match, most specific wins:

| Specificity | Pattern | Example |
|-------------|---------|---------|
| 2 (highest) | `charmId:channel` | `did:charm:abc:messages` |
| 1 | `charmId:*` or `*:channel` | `did:charm:abc:*` |
| 0 (lowest) | `*:*` | Global default |

If two rules have the same specificity, the one defined later wins.

### 6.4 Common Use Cases

```typescript
// Mute all background notifications (any charm)
{ charmId: '*', channel: 'background', showInInbox: false }

// Mute everything from a specific charm
{ charmId: 'did:charm:spammy...', channel: '*', showInInbox: false }

// Mute Slack's messages but keep Email's messages
// (Both use channel: 'messages', but user wants different treatment)
{ charmId: 'did:charm:slack...', channel: 'messages', showInInbox: false }

// Make one charm always urgent regardless of channel
{ charmId: 'did:charm:alerts...', channel: '*', importance: 'urgent' }
```

### 6.5 Charm Identity Stability

Rules key on **charm DID** (`did:charm:...`), not display name. This is crucial:

- Charm DIDs are content-addressed and stable
- Renaming a charm from "Slack Sync" to "Slack Integration" doesn't break rules
- User sees current name in UI, but rules persist across renames

```typescript
// UI shows:
"Slack Integration" [Muted] [Remove]
  (was: Slack Sync)  ← shown if name changed since rule created

// Rule stores:
{ charmId: 'did:charm:bafyabc123...', channel: '*', showInInbox: false }
```

### 6.6 Settings UI

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

[+ Add charm override]
```

---

## Part 7: Interaction with Grouping

### 7.1 Channels and Groups are Orthogonal

| Concept | Controls | Scope |
|---------|----------|-------|
| **Channel** | How notifications interrupt (sound, importance) | Per-user global setting |
| **Group** | What batches together visually | Per-inbox organizational |

**A notification has both a channel AND a group**:

```typescript
notify({
  ref: message,
  // Channel: controls interruption
  channel: 'messages',
  channelImportance: 'high',

  // Group: controls batching
  group: `conversation:${conversationId}`,
  groupTitle: 'Team Chat',
});
```

### 7.2 Sound Behavior

One sound per group arrival (not per entry), using the channel's sound setting.

### 7.3 Channel Filtering (Phase 2+)

The inbox can offer channel filtering:

```typescript
interface InboxFilterState {
  channelFilter?: string[];  // Only show these channels
}

// UI: [All] [Messages] [Reminders] [Background] [+]
```

---

## Part 8: Delivery Decision Flow

### 8.1 How Channel Affects Delivery

```typescript
function processNotification(payload: NotificationPayload, context: Context): void {
  const channel = ensureChannel(payload, context);

  // 1. Complete mute check
  if (!channel.showInInbox) {
    return;  // Silently discard
  }

  // 2. Create inbox entry
  const entry = createEntry(payload, channel.id);
  addToInbox(entry);

  // 3. Sound (respects channel + debouncing)
  if (channel.sound && shouldPlaySound(entry)) {
    playSound();
  }

  // 4. OS notification (respects channel + importance)
  if (channel.osNotification && channel.importance !== 'min') {
    sendOSNotification(entry, channel);
  }

  // 5. Heads-up (only for urgent)
  if (channel.importance === 'urgent') {
    showHeadsUp(entry);
  }
}
```

### 8.2 Importance-Based Behavior Matrix

| Importance | Sound | OS Notif | Heads-up | Badge | Inbox Prominence |
|------------|-------|----------|----------|-------|------------------|
| `urgent` | Yes | Yes | Yes | Yes | Top, highlighted |
| `high` | Yes | Yes | No | Yes | Highlighted |
| `default` | Yes | Optional | No | Yes | Normal |
| `low` | No | No | No | Yes | Normal |
| `min` | No | No | No | Yes | De-emphasized |

---

## Part 9: Common Channel Conventions

To bootstrap the folksonomy, we recommend these standard channel IDs:

| Channel ID | Name | Suggested Importance | Use Case |
|------------|------|---------------------|----------|
| `messages` | Messages | high | Direct human-to-human communication |
| `mentions` | Mentions | high | When user is @mentioned |
| `reminders` | Reminders | urgent | Time-sensitive reminders |
| `tasks` | Tasks | default | Task assignments and updates |
| `calendar` | Calendar | high | Calendar events and changes |
| `updates` | Updates | low | Non-urgent content updates |
| `social` | Social | low | Social activity (likes, follows) |
| `system` | System | default | System notifications |
| `background` | Background | min | Background sync, maintenance |

Patterns are encouraged to use these conventions for maximum user benefit.

---

## Part 10: Updated Data Models

### 10.1 Updated InboxEntry

```typescript
interface InboxEntry {
  id: string;
  ref: NormalizedLink;
  addedAt: Date;

  // Notification state
  state: 'active' | 'noticed' | 'dismissed' | 'snoozed';
  snoozedUntil?: Date;
  expiresAt?: Date;

  // Charm identity (injected by runtime)
  charmId: string;               // did:charm:... - stable, content-addressed
  charmSlug: string;             // Current human-readable slug
  charmName: string;             // Current display name

  // Channel reference
  channelId: string;

  // Grouping
  groupKey: GroupKey;

  // Cached data
  cachedName?: string;
  cachedPreview?: string;
}
```

### 10.2 Updated NotificationPayload

```typescript
interface NotificationPayload {
  ref: NormalizedLink;

  // Grouping
  group?: string | null;
  groupTitle?: string;
  groupIcon?: string;
  groupViewAllRef?: NormalizedLink;

  // Channel (all optional - defaults to 'default')
  channel?: string;
  channelName?: string;
  channelDescription?: string;
  channelImportance?: ChannelImportance;
}
```

---

## Part 11: Implementation Phases

### Phase 1: MVP Channels

1. Add `Channel` type and `ChannelRegistry`
2. Add `channelId` and charm identity to `InboxEntry`
3. Accept channel fields in `notify()`
4. Inject charm identity from runtime context
5. Auto-create channels on first use
6. Apply channel importance to delivery
7. Default channel works

**No UI changes yet** - channels work automatically.

### Phase 2: Channel Settings UI

1. Settings panel listing all channels
2. Per-channel importance control
3. Per-channel sound/OS notification toggles
4. Complete mute (`showInInbox: false`)
5. "Used by" display showing declaring charms

### Phase 3: Charm × Channel Rules

1. Add `NotificationRule` type
2. Rule matching with specificity resolution
3. Settings UI for charm overrides
4. Per-charm muting (independent of channels)
5. Per-charm-channel combinations

### Phase 4: Advanced Features

1. Channel filtering in inbox
2. Importance override restrictions
3. Channel archiving
4. Rule import/export

---

## Appendix: Android Comparison

| Feature | Android | Common Tools |
|---------|---------|--------------|
| Channel creation | App creates, user controls | Pattern declares, user controls |
| Importance levels | 5 (NONE through HIGH) | 5 (min through urgent) |
| User override | Yes, app cannot escalate | Yes, pattern cannot escalate |
| Per-app channels | Yes, namespaced by app | No, folksonomy model |
| Default channel | Required | Yes, 'default' |
| Complete mute | Per-channel | Yes, `showInInbox: false` |

---

## References

- [NOTIFICATIONS.md](./NOTIFICATIONS.md) - Core notification system design
- [NOTIFICATIONS_GROUPING.md](./NOTIFICATIONS_GROUPING.md) - Grouping system design
- [Android Notification Channels](https://developer.android.com/develop/ui/views/notifications/channels)
