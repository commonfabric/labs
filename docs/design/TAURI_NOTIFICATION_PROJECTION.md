# Tauri OS Notification Projection System

> **Status**: Draft v2
> **Date**: 2026-01-09
> **Parent Document**: `NOTIFICATIONS.md` (Phase 3)
> **Depends on**: Fabric URL Structure (charm identity)

---

## Executive Summary

This document specifies how Tauri projects inbox state to OS-level notifications. The key architectural principle:

**"Tauri is an idiomatic projection of inbox content. Inbox owns all state; Tauri is a dumb renderer."**

This means:
- **Inbox pattern** is the single source of truth for notification state
- **Tauri observes** inbox changes and projects them to OS notifications
- **Tauri does not own state** - it reflects inbox state
- **Tauri-side logic is minimal** - just API calls, no business logic

---

## 1. Observation Model

### Design Decision: Frontend Push (Not Rust Poll)

The frontend (shell) pushes notification events to Tauri, rather than Rust polling a cell or subscribing via WebSocket.

**Why Frontend Push?**

| Approach | Pros | Cons |
|----------|------|------|
| Rust polls cell | Rust controls timing | Complex: Rust needs runtime access, auth, cell parsing |
| Rust WebSocket subscription | Real-time | Complex: duplicate subscription logic, auth in Rust |
| **Frontend push to Rust** | Simple, leverages existing runtime | Requires app to be running |

**The third option wins** because:
1. The shell already has the runtime, authentication, and cell access
2. Inbox is already observed for the badge count and dropdown
3. Tauri backend stays dumb - just receives events and calls OS APIs
4. Background notification service (future) can run in the web layer, not Rust

### Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SHELL (Frontend)                                │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                        InboxController                                │   │
│  │                                                                       │   │
│  │  entries$ ────────┬──────────────────────────────────────────────►   │   │
│  │                   │                                                   │   │
│  │                   │  On entry change:                                │   │
│  │                   │  1. Compute diff (new active entries)            │   │
│  │                   │  2. Call TauriNotificationBridge                 │   │
│  │                   │                                                   │   │
│  │  unseenCount$ ────┴──► TauriNotificationBridge.updateBadge()         │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                      │                                       │
│                                      │ invoke()                              │
│                                      ▼                                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       │ Tauri IPC
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              TAURI (Rust)                                    │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                        Notification Commands                          │   │
│  │                        (Thin wrappers around OS APIs)                 │   │
│  │                                                                       │   │
│  │  show_notification()  ──► tauri_plugin_notification::show()          │   │
│  │  cancel_notification() ──► OS notification dismiss                    │   │
│  │  update_badge()       ──► app.dock().set_badge_label()               │   │
│  │                                                                       │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                      │                                       │
│                                      │ OS Event (click/dismiss)             │
│                                      ▼                                       │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  on_notification_event()                                              │   │
│  │  - Click → emit("notification-clicked", payload)                      │   │
│  │  - Dismiss → emit("notification-dismissed", payload)                  │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                      │                                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       │ Tauri event
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SHELL (Frontend)                                │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  TauriNotificationBridge (event listener)                             │   │
│  │                                                                       │   │
│  │  "notification-clicked" → navigateToSource(payload)                   │   │
│  │                          → inbox.markNoticed(payload.notificationId)  │   │
│  │                                                                       │   │
│  │  "notification-dismissed" → (no action - OS dismissed, inbox unchanged)│  │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Projection Rules

### When Does an Inbox Entry Become an OS Notification?

The projection is straightforward: **new `active` entries trigger OS notifications**.

```typescript
// InboxController projection logic
class InboxController {
  private previousEntryIds = new Set<string>();

  private onEntriesChanged(entries: InboxEntry[]) {
    const currentActiveIds = new Set(
      entries
        .filter(e => e.state === 'active')
        .map(e => e.id)
    );

    // Find NEW active entries (not previously known)
    for (const entry of entries) {
      if (entry.state === 'active' && !this.previousEntryIds.has(entry.id)) {
        // This is a new notification - project to OS
        this.projectToOS(entry);
      }
    }

    // Update tracking
    this.previousEntryIds = currentActiveIds;
  }
}
```

### Projection Criteria

| Inbox State | Projects to OS? | Rationale |
|-------------|-----------------|-----------|
| New `active` entry | YES | User needs to know |
| Entry transitions `active` → `noticed` | NO (cancel OS notification) | User saw it in-app |
| Entry transitions `active` → `dismissed` | NO (cancel OS notification) | User handled it |
| Entry transitions `snoozed` → `active` | YES | Snooze expired, re-notify |
| Entry already `active` (seen before) | NO | Already projected |
| Entry `noticed` or `dismissed` | NO | Already handled |

### Rate Limiting

Rate limiting happens at the **inbox pattern level**, not Tauri:

```typescript
// In inbox pattern, not Tauri
const RATE_LIMIT = {
  maxPerMinute: 10,
  cooldownMs: 6000, // 6 seconds between rapid-fire
};

// Inbox batches rapid notifications
function onNotificationReceived(payload: NotificationPayload) {
  if (shouldThrottle()) {
    // Batch into "X new notifications" instead of individual
    batchPendingNotification(payload);
  } else {
    addEntry(payload);
  }
}
```

Tauri just renders what inbox tells it to render.

---

## 3. State Sync: OS Interactions

### Click: Navigate and Mark Noticed

When user clicks an OS notification:

1. **Tauri** emits `notification-clicked` event with payload
2. **Frontend** navigates to the source content
3. **Frontend** calls `inbox.markNoticed(id)` (inbox owns state)
4. **Inbox pattern** updates entry state to `noticed`
5. **InboxController** observes change, cancels the OS notification

```typescript
// Frontend handler
listen<OSNotificationPayload>("notification-clicked", async (event) => {
  const { notificationId, ref } = event.payload;

  // Navigate to content
  await navigateToCell(ref);

  // Mark noticed in inbox (inbox owns state)
  const inbox = await wish('#inbox');
  inbox.markNoticed({ id: notificationId });
});
```

### Dismiss: OS-Only, Inbox Unchanged

**Critical design decision**: OS dismiss does NOT update inbox state.

Why?
- Inbox is the user's "TODO list" of pending attention
- OS dismiss just hides the OS notification from notification center
- User can still see the notification in their inbox
- This matches iOS/Android behavior: swiping away a notification doesn't mark email as read

```typescript
// Frontend handler
listen<OSNotificationPayload>("notification-dismissed", async (event) => {
  // Do nothing to inbox state!
  // The entry remains 'active' in inbox
  // User will still see badge count and entry in dropdown

  // Optional: track that OS notification was dismissed (for analytics)
  console.debug(`OS notification ${event.payload.notificationId} dismissed`);
});
```

The user can still:
- See the notification in their inbox dropdown
- Click it from inbox to navigate
- Dismiss it from inbox (which DOES update state)

---

## 4. Snooze Handling

### Inbox Pattern Owns Snooze Logic

Snooze is entirely inbox-managed:

```typescript
// Inbox pattern (simplified)
interface InboxEntry {
  state: 'active' | 'noticed' | 'dismissed' | 'snoozed';
  snoozedUntil?: Date;
}

// Computed: check snoozed entries
computed(() => {
  const now = Date.now();
  for (const entry of entries) {
    if (entry.state === 'snoozed' && entry.snoozedUntil && entry.snoozedUntil <= now) {
      // Snooze expired - transition back to active
      entry.state = 'active';
      entry.snoozedUntil = undefined;
    }
  }
});
```

### Projection Flow

1. User snoozes notification in inbox UI
2. Inbox pattern: `entry.state = 'snoozed'`
3. InboxController observes: cancels OS notification (no longer active)
4. ... time passes ...
5. Inbox pattern: computed detects snooze expired, `entry.state = 'active'`
6. InboxController observes: new active entry! Projects to OS
7. User sees fresh OS notification

**Tauri has zero knowledge of snooze.** It just sees entries become active.

### Background Snooze Check (App Running)

When the app is running, snooze uses the `#now` reactive primitive:

```typescript
// In inbox pattern
const now = wish('#now', { interval: 1000 });

// Snooze expiry is reactive
const activeEntries = computed(() => {
  const t = now.get();
  return entries.map(e => {
    if (e.state === 'snoozed' && e.snoozedUntil && e.snoozedUntil <= t) {
      return { ...e, state: 'active', snoozedUntil: undefined };
    }
    return e;
  });
});
```

---

## 5. Scheduled Notifications (Background Snooze)

When the app is **closed**, snooze relies on OS-level scheduled notifications.

### The Problem

Reactive computations only run when observed. If the user closes the app:
1. `wish('#now')` stops ticking
2. Snooze expiry computed doesn't run
3. User misses their reminder

### The Solution: Tauri Scheduled Notifications

When a user snoozes, we schedule an OS notification for the wake-up time:

```typescript
// Frontend: when user snoozes
async function handleSnooze(entryId: string, until: Date): Promise<void> {
  // 1. Update inbox state
  inbox.snooze({ id: entryId, until });

  // 2. Schedule OS notification for wake-up
  const entry = inbox.getEntry(entryId);
  await tauriNotificationBridge.scheduleNotification({
    id: `snooze-${entryId}`,
    at: until,
    title: entry.charmName || 'Reminder',
    body: entry.cachedName || 'Snoozed notification',
    payload: {
      notificationId: entryId,
      refSpace: entry.ref.space,
      refId: entry.ref.id,
      refPath: entry.ref.path,
      isSnoozedWakeup: true,
    },
  });
}
```

### Tauri Scheduled Notification Command

```rust
// src-tauri/src/commands/notifications.rs

use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduledNotificationParams {
    pub id: String,
    pub at: DateTime<Utc>,
    pub title: String,
    pub body: String,
    pub payload: NotificationPayload,
}

/// Schedule a notification for future delivery
#[tauri::command]
pub async fn schedule_notification(
    app: tauri::AppHandle,
    params: ScheduledNotificationParams,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    let notification = app.notification();

    let payload_json = serde_json::to_string(&params.payload)
        .map_err(|e| e.to_string())?;

    notification
        .builder()
        .identifier(&params.id)
        .title(&params.title)
        .body(&params.body)
        .extra("payload", payload_json)
        .schedule(params.at)
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Cancel a scheduled notification
#[tauri::command]
pub async fn cancel_scheduled_notification(
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    app.notification()
        .cancel_scheduled(&id)
        .map_err(|e| e.to_string())
}
```

### Handling Snooze Cancellation

If user dismisses a snoozed notification before wake-up, cancel the scheduled OS notification:

```typescript
// Frontend: when dismissing a snoozed entry
async function handleDismiss(entryId: string): Promise<void> {
  const entry = inbox.getEntry(entryId);

  // If it was snoozed, cancel the scheduled wake-up
  if (entry.state === 'snoozed') {
    await tauriNotificationBridge.cancelScheduledNotification(`snooze-${entryId}`);
  }

  inbox.dismiss({ id: entryId });
}
```

### When Scheduled Notification Fires

When the OS delivers the scheduled notification:

1. If app is open: InboxController already transitioned entry to 'active' via reactive time
2. If app is closed: OS shows notification, user clicks, app opens
3. On click: Navigate to content, mark as noticed

```typescript
// Frontend: handle scheduled notification click
listen<NotificationPayload>("notification-clicked", async (event) => {
  const { isSnoozedWakeup, notificationId } = event.payload;

  // Activate window
  await tauriNotificationBridge.activateWindow();

  if (isSnoozedWakeup) {
    // Snooze already expired in inbox (or will when we access it)
    // Just navigate to the content
  }

  // Navigate to content
  await navigateToCell({
    space: event.payload.refSpace,
    id: event.payload.refId,
    path: event.payload.refPath,
  });

  // Mark as noticed
  inbox.markNoticed({ id: notificationId });
});
```

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| User snoozes, app open at snooze time | Reactive time handles it, OS notification also fires (redundant but harmless) |
| User snoozes, app closed at snooze time | OS scheduled notification fires |
| User dismisses before snooze expires | Cancel scheduled notification |
| User modifies snooze time | Cancel old scheduled, create new one |
| App crashes | Scheduled notification still fires (OS-managed) |

---

## 6. Badge Sync

### Simple Number Push

Badge is the simplest projection: just a number.

```typescript
// InboxController
class InboxController {
  private lastBadgeCount = 0;

  private onEntriesChanged(entries: InboxEntry[]) {
    // Compute unseen count (same as bell icon)
    const unseenCount = entries
      .filter(e => e.state === 'active')
      .filter(e => !this.isContentSeen(e.ref))
      .length;

    // Only update if changed
    if (unseenCount !== this.lastBadgeCount) {
      this.lastBadgeCount = unseenCount;
      TauriNotificationBridge.updateBadge(unseenCount);
    }
  }
}
```

### Tauri Badge Command

```rust
// src-tauri/src/commands/badge.rs

#[tauri::command]
pub fn update_badge(app: tauri::AppHandle, count: u32) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let dock = app.dock().map_err(|e| e.to_string())?;
        if count == 0 {
            dock.set_badge_label(None).map_err(|e| e.to_string())?;
        } else {
            dock.set_badge_label(Some(&count.to_string())).map_err(|e| e.to_string())?;
        }
    }

    // Windows: Use overlay icon (requires pre-rendered badge icons)
    #[cfg(target_os = "windows")]
    {
        // TODO: Implement with overlay icons
    }

    Ok(())
}
```

---

## 7. Permission Flow

### Lazy Request on First Notification

Don't ask for permission until we need to show a notification:

```typescript
// TauriNotificationBridge
class TauriNotificationBridge {
  private permissionState: 'unknown' | 'granted' | 'denied' | 'pending' = 'unknown';

  async showNotification(entry: InboxEntry): Promise<void> {
    // Check permission on first use
    if (this.permissionState === 'unknown') {
      await this.ensurePermission();
    }

    // If denied, silently skip OS notification
    // (User still sees notification in inbox)
    if (this.permissionState !== 'granted') {
      return;
    }

    await invoke('show_notification', {
      id: entry.id,
      title: entry.cachedName || 'New notification',
      body: this.formatBody(entry),
      payload: this.createPayload(entry),
    });
  }

  private async ensurePermission(): Promise<void> {
    this.permissionState = 'pending';

    const { isPermissionGranted, requestPermission } = await import(
      '@tauri-apps/plugin-notification'
    );

    let granted = await isPermissionGranted();
    if (!granted) {
      const result = await requestPermission();
      granted = result === 'granted';
    }

    this.permissionState = granted ? 'granted' : 'denied';
  }
}
```

### UI When Permission Denied

If permission is denied, the inbox still works perfectly. OS notifications are just a convenience layer.

Optional: Show a one-time hint in inbox UI:

```typescript
// InboxDropdown component
if (tauriBridge.permissionState === 'denied') {
  // Show subtle hint once
  if (!localStorage.getItem('notification-permission-hint-shown')) {
    showHint('Enable notifications in System Settings to get alerts');
    localStorage.setItem('notification-permission-hint-shown', 'true');
  }
}
```

---

## 8. Grouping Projection

### Inbox Groups → OS Groups

The inbox has optional grouping (by source, channel, etc). Project this to OS:

```typescript
// When projecting to OS
async showNotification(entry: InboxEntry): Promise<void> {
  const groupId = this.getGroupId(entry);

  await invoke('show_notification', {
    id: entry.id,
    title: entry.cachedName || 'New notification',
    body: this.formatBody(entry),
    payload: this.createPayload(entry),
    groupId, // OS will group notifications with same groupId
  });
}

private getGroupId(entry: InboxEntry): string {
  // Group by source charm
  // e.g., all notifications from "Chat" grouped together
  const charmId = entry.ref.id.split('/')[0];
  return `${entry.ref.space}/${charmId}`;
}
```

### Summary Notifications (Future)

When a group has many notifications, show a summary:

```typescript
// InboxController
private async updateGroupSummary(groupId: string, entries: InboxEntry[]) {
  const count = entries.length;

  if (count > 3) {
    // Show summary instead of individual notifications
    await invoke('show_group_summary', {
      groupId,
      title: `${count} notifications from ${this.getGroupName(groupId)}`,
      count,
    });
  }
}
```

---

## 9. Minimal Tauri Rust Code

The Rust side should be as thin as possible - just receiving commands and calling OS APIs.

```rust
// src-tauri/src/commands/notifications.rs

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// Payload attached to OS notification for click handling
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationPayload {
    #[serde(rename = "notificationId")]
    pub notification_id: String,
    pub ref_space: String,
    pub ref_id: String,
    pub ref_path: Vec<String>,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
}

/// Show an OS notification
#[tauri::command]
pub async fn show_notification(
    app: tauri::AppHandle,
    id: String,
    title: String,
    body: String,
    payload: NotificationPayload,
    group_id: Option<String>,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    let notification = app.notification();

    // Serialize payload to JSON for extra data
    let payload_json = serde_json::to_string(&payload)
        .map_err(|e| e.to_string())?;

    let mut builder = notification
        .builder()
        .identifier(&id)
        .title(&title)
        .body(&body)
        .extra("payload", payload_json);

    if let Some(group) = group_id {
        builder = builder.group(&group);
    }

    builder.show().map_err(|e| e.to_string())
}

/// Cancel a specific OS notification
#[tauri::command]
pub async fn cancel_notification(
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    app.notification()
        .remove_by_identifier(&id)
        .map_err(|e| e.to_string())
}

/// Update the dock badge count
#[tauri::command]
pub fn update_badge(app: tauri::AppHandle, count: u32) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let dock = app.dock().map_err(|e| e.to_string())?;
        if count == 0 {
            dock.set_badge_label(None).map_err(|e| e.to_string())?;
        } else {
            dock.set_badge_label(Some(&count.to_string())).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Activate (focus) the main window
#[tauri::command]
pub async fn activate_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_minimized().unwrap_or(false) {
            window.unminimize().map_err(|e| e.to_string())?;
        }
        window.set_focus().map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}
```

### Event Handlers (Also Minimal)

```rust
// src-tauri/src/lib.rs

use tauri_plugin_notification::{NotificationExt, NotificationEvent};
use crate::commands::notifications::NotificationPayload;

pub fn setup_notification_handlers(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();

    app.notification().on_notification_event(move |event| {
        match event {
            NotificationEvent::Action { id, action_id, .. } => {
                // Extract payload from notification
                if let Some(payload) = get_notification_payload(&id) {
                    match action_id.as_str() {
                        "click" | "" => {
                            // Main click - emit to frontend
                            handle.emit("notification-clicked", &payload).ok();
                        }
                        "dismiss" => {
                            // OS dismiss - emit to frontend
                            handle.emit("notification-dismissed", &payload).ok();
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    });

    Ok(())
}
```

That's the entire Rust notification system: ~100 lines of thin wrapper code.

---

## 10. Frontend → Tauri Bridge

### Complete API Surface

```typescript
// packages/shell/src/lib/tauri-notification-bridge.ts

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface NotificationPayload {
  notificationId: string;
  refSpace: string;
  refId: string;
  refPath: string[];
  createdAt: number;
}

export interface TauriNotificationBridge {
  // Commands (frontend → Tauri)
  showNotification(params: {
    id: string;
    title: string;
    body: string;
    payload: NotificationPayload;
    groupId?: string;
  }): Promise<void>;

  cancelNotification(id: string): Promise<void>;

  // Scheduled notifications (for background snooze)
  scheduleNotification(params: {
    id: string;
    at: Date;
    title: string;
    body: string;
    payload: NotificationPayload;
  }): Promise<void>;

  cancelScheduledNotification(id: string): Promise<void>;

  updateBadge(count: number): Promise<void>;

  activateWindow(): Promise<void>;

  // Events (Tauri → frontend)
  onNotificationClicked(callback: (payload: NotificationPayload) => void): Promise<() => void>;

  onNotificationDismissed(callback: (payload: NotificationPayload) => void): Promise<() => void>;
}
```

### Implementation

```typescript
// packages/shell/src/lib/tauri-notification-bridge.ts

class TauriNotificationBridgeImpl implements TauriNotificationBridge {
  private isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

  async showNotification(params: {
    id: string;
    title: string;
    body: string;
    payload: NotificationPayload;
    groupId?: string;
  }): Promise<void> {
    if (!this.isTauri) return;

    await invoke('show_notification', {
      id: params.id,
      title: params.title,
      body: params.body,
      payload: {
        notification_id: params.payload.notificationId,
        ref_space: params.payload.refSpace,
        ref_id: params.payload.refId,
        ref_path: params.payload.refPath,
        created_at: params.payload.createdAt,
      },
      group_id: params.groupId,
    });
  }

  async cancelNotification(id: string): Promise<void> {
    if (!this.isTauri) return;
    await invoke('cancel_notification', { id });
  }

  async updateBadge(count: number): Promise<void> {
    if (!this.isTauri) return;
    await invoke('update_badge', { count });
  }

  async activateWindow(): Promise<void> {
    if (!this.isTauri) return;
    await invoke('activate_window');
  }

  async onNotificationClicked(
    callback: (payload: NotificationPayload) => void
  ): Promise<() => void> {
    if (!this.isTauri) return () => {};

    const unlisten = await listen<NotificationPayload>(
      'notification-clicked',
      (event) => callback(event.payload)
    );
    return unlisten;
  }

  async onNotificationDismissed(
    callback: (payload: NotificationPayload) => void
  ): Promise<() => void> {
    if (!this.isTauri) return () => {};

    const unlisten = await listen<NotificationPayload>(
      'notification-dismissed',
      (event) => callback(event.payload)
    );
    return unlisten;
  }
}

export const tauriNotificationBridge = new TauriNotificationBridgeImpl();
```

---

## 11. InboxController Integration

### Complete Flow Example

```typescript
// packages/shell/src/lib/inbox-controller.ts

import { tauriNotificationBridge, NotificationPayload } from './tauri-notification-bridge';

export class InboxController {
  private knownEntryIds = new Set<string>();
  private lastBadgeCount = 0;

  constructor(private inbox: InboxInterface) {
    // Subscribe to inbox entries
    this.watchEntries();

    // Set up Tauri event handlers
    this.setupTauriHandlers();
  }

  private watchEntries() {
    // Reactive subscription to inbox entries
    effect(() => {
      const entries = this.inbox.entries.get();
      this.handleEntriesChanged(entries);
    });
  }

  private handleEntriesChanged(entries: InboxEntry[]) {
    // 1. Project new active entries to OS
    for (const entry of entries) {
      if (entry.state === 'active' && !this.knownEntryIds.has(entry.id)) {
        this.projectToOS(entry);
      }
    }

    // 2. Cancel OS notifications for entries no longer active
    for (const id of this.knownEntryIds) {
      const entry = entries.find(e => e.id === id);
      if (!entry || entry.state !== 'active') {
        tauriNotificationBridge.cancelNotification(id);
      }
    }

    // 3. Update tracking
    this.knownEntryIds = new Set(
      entries.filter(e => e.state === 'active').map(e => e.id)
    );

    // 4. Update badge
    this.updateBadge(entries);
  }

  private async projectToOS(entry: InboxEntry) {
    const payload: NotificationPayload = {
      notificationId: entry.id,
      refSpace: entry.ref.space,
      refId: entry.ref.id,
      refPath: entry.ref.path,
      createdAt: Date.now(),
    };

    await tauriNotificationBridge.showNotification({
      id: entry.id,
      title: entry.cachedName || 'New notification',
      body: this.formatNotificationBody(entry),
      payload,
      groupId: this.getGroupId(entry),
    });
  }

  private updateBadge(entries: InboxEntry[]) {
    const count = entries
      .filter(e => e.state === 'active')
      .filter(e => !this.isContentSeen(e.ref))
      .length;

    if (count !== this.lastBadgeCount) {
      this.lastBadgeCount = count;
      tauriNotificationBridge.updateBadge(count);
    }
  }

  private async setupTauriHandlers() {
    // Handle OS notification click
    await tauriNotificationBridge.onNotificationClicked(async (payload) => {
      // 1. Activate window
      await tauriNotificationBridge.activateWindow();

      // 2. Navigate to source
      await this.navigateToRef({
        space: payload.refSpace,
        id: payload.refId,
        path: payload.refPath,
      });

      // 3. Mark as noticed in inbox (inbox owns state)
      this.inbox.markNoticed({ id: payload.notificationId });
    });

    // Handle OS notification dismiss (no-op for inbox state)
    await tauriNotificationBridge.onNotificationDismissed((payload) => {
      // Intentionally empty - OS dismiss doesn't change inbox state
      // Entry remains in inbox for user to handle there
      console.debug(`OS notification dismissed: ${payload.notificationId}`);
    });
  }

  private formatNotificationBody(entry: InboxEntry): string {
    // Use cached preview or generic message
    return entry.cachedPreview || 'Tap to view';
  }

  private getGroupId(entry: InboxEntry): string {
    // Group by source charm
    const charmId = entry.ref.id.split('/')[0];
    return `${entry.ref.space}/${charmId}`;
  }

  private isContentSeen(ref: NormalizedLink): boolean {
    // Check annotation first, then source field
    const annotation = getAnnotation<{ seen?: boolean }>(ref);
    if (annotation?.seen === true) return true;

    const content = $(ref);
    if (content?.seen === true) return true;

    return false;
  }

  private async navigateToRef(ref: { space: string; id: string; path: string[] }) {
    // Use shell navigation
    const charmId = ref.id.startsWith('of:') ? ref.id.slice(3) : ref.id;
    await globalThis.app.setView({
      spaceDid: ref.space,
      charmId,
    });
  }
}
```

---

## 12. Summary: The Projection Model

### What Tauri Does

| Operation | Tauri's Role |
|-----------|--------------|
| Show notification | Call `tauri_plugin_notification::show()` |
| Cancel notification | Call `tauri_plugin_notification::remove()` |
| **Schedule notification** | Call `tauri_plugin_notification::schedule()` for background snooze |
| **Cancel scheduled** | Call `tauri_plugin_notification::cancel_scheduled()` |
| Update badge | Call `app.dock().set_badge_label()` |
| Handle click | Emit event to frontend |
| Handle dismiss | Emit event to frontend |

### What Tauri Does NOT Do

| Operation | Why Not Tauri |
|-----------|---------------|
| Decide when to notify | Inbox pattern decides |
| Track notification state | Inbox pattern owns state |
| Handle snooze logic (app open) | Inbox pattern + `#now` reactive primitive |
| Rate limit | Inbox pattern handles |
| Group notifications | Frontend decides groupId |
| Manage permissions | Frontend requests |

### Benefits of This Model

1. **Single source of truth**: Inbox pattern owns all state
2. **Testable**: Can test notification logic without Tauri
3. **Portable**: Same logic works in web (with Web Notifications API fallback)
4. **Simple Tauri code**: ~100 lines of Rust, no business logic
5. **Maintainable**: All notification logic in TypeScript/patterns

---

## References

- [Tauri v2 Notification Plugin](https://v2.tauri.app/plugin/notification/)
- [Parent: NOTIFICATIONS.md](/Users/alex/Code/labs-4/docs/design/NOTIFICATIONS.md)
- [Deep Linking: NOTIFICATIONS_DEEP_LINKING.md](/Users/alex/Code/labs-4/docs/design/NOTIFICATIONS_DEEP_LINKING.md)
