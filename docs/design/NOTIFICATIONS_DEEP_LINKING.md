# OS Notification Deep Linking Specification

> **Status**: Draft
> **Date**: 2026-01-09
> **Parent Document**: `NOTIFICATIONS.md` (Phase 2)

---

## Executive Summary

This document specifies how OS notifications (via Tauri) deep link back into Common Tools when clicked. The design prioritizes:

1. **High integrity**: Clicking always shows current, live content
2. **Graceful degradation**: Handle all app states and error conditions
3. **Simplicity**: Minimal data in notification payload, resolve at click time
4. **Future-proofing**: Support cross-space references and multi-user

---

## 1. Deep Link Format

### Decision: Structured Payload, Not URL

We use a **structured payload** attached to the notification, not a URL scheme.

**Why not URL schemes?**

| Approach | Pros | Cons |
|----------|------|------|
| `common-tools://space/{did}/cell/{id}` | Simple, works with system handlers | DIDs contain `:` characters (encoding issues), path encoding complex, parsing fragile |
| Structured payload | Type-safe, no encoding issues, can include metadata | Requires Tauri-specific handling |

**Decision**: Use structured payload. URL schemes add complexity without benefit since we control both ends (Tauri backend and frontend).

### Payload Structure

```typescript
/**
 * Data attached to OS notification for click handling.
 * Minimal: just enough to resolve the content at click time.
 */
interface OSNotificationPayload {
  // Unique notification entry ID (for deduplication and state sync)
  notificationId: string;

  // Reference to source content (serialized NormalizedFullLink)
  ref: SerializedNormalizedLink;

  // Timestamp for staleness detection
  createdAt: number; // Unix timestamp ms
}

/**
 * Serialized form of NormalizedFullLink for JSON transport.
 * All fields are strings/arrays (no MemorySpace object).
 */
interface SerializedNormalizedLink {
  id: string;           // URI format: "of:bafyabc123..."
  space: string;        // DID: "did:key:z6Mk..."
  path: string[];       // JSON path: ["messages", "0"]
  type: string;         // MIME type: "application/json"
}
```

### Serialization Functions

```typescript
// packages/common/src/notification-payload.ts

import type { NormalizedFullLink } from "@commontools/runner";

export interface SerializedNormalizedLink {
  id: string;
  space: string;
  path: string[];
  type: string;
}

export interface OSNotificationPayload {
  notificationId: string;
  ref: SerializedNormalizedLink;
  createdAt: number;
}

export function serializeNormalizedLink(
  link: NormalizedFullLink
): SerializedNormalizedLink {
  return {
    id: link.id,
    space: link.space,
    path: [...link.path],
    type: link.type,
  };
}

export function deserializeNormalizedLink(
  serialized: SerializedNormalizedLink
): NormalizedFullLink {
  return {
    id: serialized.id as `${string}:${string}`,
    space: serialized.space as `did:${string}:${string}`,
    path: serialized.path,
    type: serialized.type,
  };
}

export function createOSNotificationPayload(
  notificationId: string,
  ref: NormalizedFullLink
): OSNotificationPayload {
  return {
    notificationId,
    ref: serializeNormalizedLink(ref),
    createdAt: Date.now(),
  };
}
```

---

## 2. Tauri Notification Payload

### Sending an OS Notification

The background notification service sends OS notifications for high-priority inbox entries:

```rust
// src-tauri/src/notifications.rs

use tauri::Manager;
use tauri_plugin_notification::{NotificationBuilder, PermissionState};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerializedNormalizedLink {
    pub id: String,
    pub space: String,
    pub path: Vec<String>,
    #[serde(rename = "type")]
    pub content_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OSNotificationPayload {
    #[serde(rename = "notificationId")]
    pub notification_id: String,
    pub ref_: SerializedNormalizedLink,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationRequest {
    pub title: String,
    pub body: String,
    pub payload: OSNotificationPayload,
    pub group_id: Option<String>,
}

#[tauri::command]
pub async fn send_os_notification(
    app: tauri::AppHandle,
    request: NotificationRequest,
) -> Result<(), String> {
    let notification = app.notification();

    // Check permission
    if notification.permission_state()? != PermissionState::Granted {
        return Err("Notification permission not granted".into());
    }

    // Build notification with payload as extra data
    let mut builder = notification.builder()
        .title(&request.title)
        .body(&request.body)
        .extra("payload", serde_json::to_string(&request.payload)?);

    // Group notifications by source
    if let Some(group) = request.group_id {
        builder = builder.group(&group);
    }

    builder.show()?;

    Ok(())
}
```

### Click Handler Registration

Register the click handler when the app starts:

```rust
// src-tauri/src/lib.rs

use tauri_plugin_notification::NotificationExt;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Register notification click handler
            let handle = app.handle().clone();

            app.notification().on_notification_event(move |event| {
                match event {
                    tauri_plugin_notification::Event::Click(click) => {
                        // Extract payload from notification extra data
                        if let Some(payload_str) = click.extra.get("payload") {
                            if let Ok(payload) = serde_json::from_str::<OSNotificationPayload>(payload_str) {
                                // Emit event to frontend
                                handle.emit_all("notification-clicked", payload).ok();
                            }
                        }
                    }
                    tauri_plugin_notification::Event::Dismiss(_) => {
                        // Could sync dismissal back to inbox
                    }
                    _ => {}
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}
```

---

## 3. Click Handler Implementation

### TypeScript Bridge (Frontend)

```typescript
// packages/shell/src/lib/notification-handler.ts

import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { App } from "./app/controller.ts";
import type { OSNotificationPayload } from "@commontools/common/notification-payload";
import { deserializeNormalizedLink } from "@commontools/common/notification-payload";

/**
 * Notification click handler result
 */
type NavigationResult =
  | { success: true }
  | { success: false; reason: "content_deleted" | "access_denied" | "space_offline" | "unknown" };

/**
 * Register Tauri notification click listener.
 * Call this once during app initialization.
 */
export async function initNotificationHandler(app: App): Promise<void> {
  // Skip if not in Tauri environment
  if (!window.__TAURI__) {
    return;
  }

  await listen<OSNotificationPayload>("notification-clicked", async (event) => {
    const payload = event.payload;
    const result = await handleNotificationClick(app, payload);

    if (!result.success) {
      handleNavigationError(app, payload, result.reason);
    }
  });
}

/**
 * Handle a notification click by navigating to the source content.
 */
async function handleNotificationClick(
  app: App,
  payload: OSNotificationPayload
): Promise<NavigationResult> {
  const ref = deserializeNormalizedLink(payload.ref);

  try {
    // 1. Ensure app is focused (Tauri handles window activation)
    await invoke("activate_window");

    // 2. Navigate to the content
    await navigateToCell(app, ref);

    // 3. Sync notification state (mark as noticed in inbox)
    await syncNotificationState(payload.notificationId, "noticed");

    return { success: true };
  } catch (error) {
    console.error("[notification-handler] Navigation failed:", error);

    // Classify the error
    if (isContentDeletedError(error)) {
      return { success: false, reason: "content_deleted" };
    }
    if (isAccessDeniedError(error)) {
      return { success: false, reason: "access_denied" };
    }
    if (isOfflineError(error)) {
      return { success: false, reason: "space_offline" };
    }

    return { success: false, reason: "unknown" };
  }
}

/**
 * Navigate the shell to display a specific cell.
 */
async function navigateToCell(
  app: App,
  ref: NormalizedFullLink
): Promise<void> {
  // Extract charm ID from the cell reference
  // The id is in format "of:bafyabc123..." - extract the CID
  const charmId = ref.id.startsWith("of:")
    ? ref.id.slice(3)
    : ref.id;

  // Navigate using shell's existing navigation system
  await app.setView({
    spaceDid: ref.space as DID,
    charmId,
  });

  // If there's a path, we may need additional navigation within the charm
  // This could be handled by the charm itself via URL params or charm state
  if (ref.path.length > 0) {
    // Emit event for charm to handle internal navigation
    globalThis.dispatchEvent(
      new CustomEvent("ct-navigate-to-path", {
        detail: { path: ref.path },
      })
    );
  }
}

/**
 * Sync notification state back to inbox.
 */
async function syncNotificationState(
  notificationId: string,
  state: "noticed" | "dismissed"
): Promise<void> {
  // Use runtime to update inbox entry state
  // This ensures consistency between OS notification and in-app inbox
  const runtime = globalThis.runtime; // Assuming runtime is available globally
  if (!runtime) return;

  // TODO: Implement inbox state sync via wish('#inbox')
  // For now, emit event that inbox pattern can listen to
  globalThis.dispatchEvent(
    new CustomEvent("ct-notification-state-change", {
      detail: { notificationId, state },
    })
  );
}
```

### Error Classification

```typescript
// packages/shell/src/lib/notification-handler.ts (continued)

function isContentDeletedError(error: unknown): boolean {
  if (error instanceof Error) {
    return (
      error.message.includes("not found") ||
      error.message.includes("deleted") ||
      error.message.includes("ENOENT")
    );
  }
  return false;
}

function isAccessDeniedError(error: unknown): boolean {
  if (error instanceof Error) {
    return (
      error.message.includes("access denied") ||
      error.message.includes("unauthorized") ||
      error.message.includes("forbidden") ||
      error.message.includes("403")
    );
  }
  return false;
}

function isOfflineError(error: unknown): boolean {
  if (error instanceof Error) {
    return (
      error.message.includes("offline") ||
      error.message.includes("network") ||
      error.message.includes("timeout") ||
      error.message.includes("ETIMEDOUT")
    );
  }
  return false;
}
```

---

## 4. App State Handling

### State Matrix

| App State | Window State | Action Required |
|-----------|--------------|-----------------|
| Running, focused | Visible | Navigate directly |
| Running, background | Hidden/minimized | Activate window, then navigate |
| Not running | N/A | Launch app, wait for init, navigate |

### Rust: Window Activation

```rust
// src-tauri/src/window.rs

#[tauri::command]
pub async fn activate_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_window("main") {
        // Unminimize if minimized
        if window.is_minimized()? {
            window.unminimize()?;
        }

        // Bring to front and focus
        window.set_focus()?;
        window.show()?;

        Ok(())
    } else {
        Err("Main window not found".into())
    }
}
```

### Cold Start Navigation

When the app isn't running, Tauri launches it with the notification payload:

```rust
// src-tauri/src/lib.rs

use std::sync::Mutex;
use once_cell::sync::Lazy;

// Store pending navigation for cold start
static PENDING_NAVIGATION: Lazy<Mutex<Option<OSNotificationPayload>>> =
    Lazy::new(|| Mutex::new(None));

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let handle = app.handle().clone();

            app.notification().on_notification_event(move |event| {
                if let tauri_plugin_notification::Event::Click(click) = event {
                    if let Some(payload_str) = click.extra.get("payload") {
                        if let Ok(payload) = serde_json::from_str::<OSNotificationPayload>(payload_str) {
                            // Check if frontend is ready
                            if is_frontend_ready(&handle) {
                                // Emit immediately
                                handle.emit_all("notification-clicked", payload).ok();
                            } else {
                                // Store for later
                                *PENDING_NAVIGATION.lock().unwrap() = Some(payload);
                            }
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            activate_window,
            send_os_notification,
            get_pending_navigation,
            clear_pending_navigation,
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}

#[tauri::command]
pub fn get_pending_navigation() -> Option<OSNotificationPayload> {
    PENDING_NAVIGATION.lock().unwrap().clone()
}

#[tauri::command]
pub fn clear_pending_navigation() {
    *PENDING_NAVIGATION.lock().unwrap() = None;
}
```

### Frontend: Cold Start Check

```typescript
// packages/shell/src/lib/notification-handler.ts (continued)

/**
 * Check for pending navigation from cold start.
 * Call this after app initialization is complete.
 */
export async function checkPendingNavigation(app: App): Promise<void> {
  if (!window.__TAURI__) return;

  try {
    const pending = await invoke<OSNotificationPayload | null>("get_pending_navigation");

    if (pending) {
      // Clear the pending navigation
      await invoke("clear_pending_navigation");

      // Handle it
      const result = await handleNotificationClick(app, pending);

      if (!result.success) {
        handleNavigationError(app, pending, result.reason);
      }
    }
  } catch (error) {
    console.error("[notification-handler] Failed to check pending navigation:", error);
  }
}
```

### Shell Integration

```typescript
// packages/shell/src/index.ts (modified)

import { initNotificationHandler, checkPendingNavigation } from "./lib/notification-handler.ts";

// ... existing initialization ...

const app = new App(root as XRootView);
await app.initializeKeys();

const _navigation = new Navigation(app);

// Initialize notification handler (no-op if not in Tauri)
await initNotificationHandler(app);

// After all initialization is complete, check for cold-start navigation
// Use requestIdleCallback to ensure UI is ready
if (window.requestIdleCallback) {
  window.requestIdleCallback(() => checkPendingNavigation(app));
} else {
  setTimeout(() => checkPendingNavigation(app), 100);
}
```

---

## 5. Error Handling UX

### Error States and User Feedback

```typescript
// packages/shell/src/lib/notification-handler.ts (continued)

import { showAlert } from "@commontools/ui/v2/components/ct-alert";

function handleNavigationError(
  app: App,
  payload: OSNotificationPayload,
  reason: "content_deleted" | "access_denied" | "space_offline" | "unknown"
): void {
  const messages: Record<typeof reason, { title: string; description: string; action?: () => void }> = {
    content_deleted: {
      title: "Content No Longer Available",
      description: "The content you're looking for has been deleted or moved.",
      action: () => navigateToInbox(app),
    },
    access_denied: {
      title: "Access Denied",
      description: "You no longer have access to this content.",
      action: () => navigateToInbox(app),
    },
    space_offline: {
      title: "Content Unavailable",
      description: "The content is currently offline. Please try again later.",
      action: () => retryNavigation(app, payload),
    },
    unknown: {
      title: "Navigation Failed",
      description: "Unable to open this notification. Please try from your inbox.",
      action: () => navigateToInbox(app),
    },
  };

  const message = messages[reason];

  // Show alert/toast to user
  showNavigationErrorAlert(message.title, message.description, message.action);

  // Mark notification as having an error (for inbox UI to show)
  globalThis.dispatchEvent(
    new CustomEvent("ct-notification-error", {
      detail: {
        notificationId: payload.notificationId,
        reason,
      },
    })
  );
}

function showNavigationErrorAlert(
  title: string,
  description: string,
  action?: () => void
): void {
  // Use a simple alert mechanism
  // In the future, this could be a toast/snackbar component
  const alert = document.createElement("div");
  alert.className = "ct-notification-error-alert";
  alert.innerHTML = `
    <div class="alert-content">
      <strong>${title}</strong>
      <p>${description}</p>
      <div class="alert-actions">
        <button class="alert-action-primary">Go to Inbox</button>
        <button class="alert-dismiss">Dismiss</button>
      </div>
    </div>
  `;

  alert.querySelector(".alert-action-primary")?.addEventListener("click", () => {
    action?.();
    alert.remove();
  });

  alert.querySelector(".alert-dismiss")?.addEventListener("click", () => {
    alert.remove();
  });

  document.body.appendChild(alert);

  // Auto-dismiss after 10 seconds
  setTimeout(() => alert.remove(), 10000);
}

function navigateToInbox(app: App): void {
  // Navigate to inbox pattern in home space
  const userDID = app.state().identity?.did();
  if (userDID) {
    app.setView({
      spaceDid: userDID,
      charmId: "inbox", // Well-known inbox charm ID
    });
  }
}

async function retryNavigation(app: App, payload: OSNotificationPayload): Promise<void> {
  // Wait a moment and retry
  await new Promise(resolve => setTimeout(resolve, 1000));
  const result = await handleNotificationClick(app, payload);
  if (!result.success) {
    // If still failing, show permanent error
    handleNavigationError(app, payload, result.reason);
  }
}
```

---

## 6. Multiple Notifications

### Behavior When Multiple Pending

When user clicks one notification but has multiple from the same source:

1. **Navigate to the clicked notification's content** (primary action)
2. **Do NOT auto-dismiss other notifications** (user's TODO list - they decide)
3. **Badge count updates** when user views content (via seen state)

### Grouping on OS Level

```typescript
// packages/common/src/notification-service.ts

/**
 * Generate group ID for notification grouping.
 * Notifications with same group ID are collapsed on OS level.
 */
export function getNotificationGroupId(ref: NormalizedFullLink): string {
  // Group by space + charm (not by individual cell)
  // This way, 5 messages from "Chat" group together as "5 new from Chat"
  return `${ref.space}/${ref.id.split("/")[0]}`;
}
```

### Summary Notification (Future Enhancement)

For Android/macOS notification grouping:

```rust
// src-tauri/src/notifications.rs

#[tauri::command]
pub async fn update_notification_group(
    app: tauri::AppHandle,
    group_id: String,
    count: u32,
    summary_title: String,
) -> Result<(), String> {
    // Create/update a summary notification for the group
    app.notification()
        .builder()
        .title(&summary_title) // e.g., "5 new messages"
        .group(&group_id)
        .group_summary(true)
        .show()?;

    Ok(())
}
```

---

## 7. Notification Actions

### Action Definitions

Tauri v2 supports notification actions (buttons). Define standard actions:

```rust
// src-tauri/src/notifications.rs

use tauri_plugin_notification::NotificationAction;

pub fn create_notification_actions() -> Vec<NotificationAction> {
    vec![
        NotificationAction {
            id: "view".into(),
            title: "View".into(),
            ..Default::default()
        },
        NotificationAction {
            id: "dismiss".into(),
            title: "Dismiss".into(),
            destructive: true,
            ..Default::default()
        },
        NotificationAction {
            id: "snooze".into(),
            title: "Later".into(),
            ..Default::default()
        },
    ]
}
```

### Action Handlers

```rust
// src-tauri/src/lib.rs

app.notification().on_notification_event(move |event| {
    match event {
        tauri_plugin_notification::Event::Action { action_id, payload, .. } => {
            if let Some(payload_str) = payload.extra.get("payload") {
                if let Ok(notif_payload) = serde_json::from_str::<OSNotificationPayload>(payload_str) {
                    match action_id.as_str() {
                        "view" => {
                            // Same as click - emit to frontend
                            handle.emit_all("notification-clicked", notif_payload).ok();
                        }
                        "dismiss" => {
                            // Dismiss without opening app
                            handle.emit_all("notification-dismissed", notif_payload).ok();
                        }
                        "snooze" => {
                            // Snooze notification (re-show in 1 hour)
                            handle.emit_all("notification-snoozed", notif_payload).ok();
                        }
                        _ => {}
                    }
                }
            }
        }
        _ => {}
    }
});
```

### Frontend Action Handlers

```typescript
// packages/shell/src/lib/notification-handler.ts (continued)

export async function initNotificationHandler(app: App): Promise<void> {
  if (!window.__TAURI__) return;

  // Click handler (existing)
  await listen<OSNotificationPayload>("notification-clicked", async (event) => {
    // ... existing code ...
  });

  // Dismiss action handler
  await listen<OSNotificationPayload>("notification-dismissed", async (event) => {
    await syncNotificationState(event.payload.notificationId, "dismissed");
  });

  // Snooze action handler
  await listen<OSNotificationPayload>("notification-snoozed", async (event) => {
    const snoozeUntil = Date.now() + 60 * 60 * 1000; // 1 hour

    globalThis.dispatchEvent(
      new CustomEvent("ct-notification-snooze", {
        detail: {
          notificationId: event.payload.notificationId,
          until: snoozeUntil,
        },
      })
    );
  });
}
```

---

## 8. Badge Count Sync

### Platform Support

| Platform | Badge API | Implementation |
|----------|-----------|----------------|
| macOS | Dock badge | `app.dock().set_badge_label()` |
| Windows | Taskbar badge | `tauri-plugin-badger` or overlay icon |
| Linux | Varies by DE | Unity/GNOME via D-Bus, often unsupported |

### Rust: Badge Update

```rust
// src-tauri/src/badge.rs

#[tauri::command]
pub fn update_badge_count(app: tauri::AppHandle, count: u32) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if count == 0 {
            app.dock()?.set_badge_label(None)?;
        } else {
            app.dock()?.set_badge_label(Some(&count.to_string()))?;
        }
    }

    #[cfg(target_os = "windows")]
    {
        // Use overlay icon for badge
        // Requires icon assets for different counts
        if count == 0 {
            app.get_window("main")?.set_overlay_icon(None)?;
        } else {
            let badge_icon = get_badge_icon(count);
            app.get_window("main")?.set_overlay_icon(Some(badge_icon))?;
        }
    }

    Ok(())
}
```

### Frontend: Badge Sync

```typescript
// packages/shell/src/lib/badge-sync.ts

import { invoke } from "@tauri-apps/api/core";

/**
 * Sync inbox unseen count to OS badge.
 * Called reactively when inbox count changes.
 */
export async function syncBadgeCount(count: number): Promise<void> {
  if (!window.__TAURI__) return;

  try {
    await invoke("update_badge_count", { count });
  } catch (error) {
    // Badge not supported on this platform - fail silently
    console.debug("[badge-sync] Badge update failed:", error);
  }
}
```

### Integration with Inbox Controller

```typescript
// packages/shell/src/lib/inbox-controller.ts (sketch)

import { syncBadgeCount } from "./badge-sync.ts";

class InboxController {
  private unseenCount = 0;

  // Called when inbox entries change
  private onEntriesChanged(entries: InboxEntry[]) {
    const newCount = entries.filter(
      e => e.state === "active" && !this.isContentSeen(e.ref)
    ).length;

    if (newCount !== this.unseenCount) {
      this.unseenCount = newCount;

      // Update shell badge
      this.dispatchEvent(new CustomEvent("unseen-count-changed", {
        detail: { count: newCount }
      }));

      // Update OS badge
      syncBadgeCount(newCount);
    }
  }
}
```

---

## 9. Implementation Checklist

### Phase 2a: Basic Deep Linking

- [ ] Create `OSNotificationPayload` types in `@commontools/common`
- [ ] Add `notification-clicked` event handler in shell
- [ ] Implement `navigateToCell()` using existing shell navigation
- [ ] Add `activate_window` Tauri command
- [ ] Test: Click notification when app is focused
- [ ] Test: Click notification when app is in background

### Phase 2b: Cold Start & Errors

- [ ] Implement pending navigation storage in Tauri
- [ ] Add `checkPendingNavigation()` to shell init
- [ ] Implement error classification and handling
- [ ] Create error alert UI component
- [ ] Test: Click notification when app is closed
- [ ] Test: Click notification for deleted content

### Phase 2c: Actions & Badge

- [ ] Add notification actions (View, Dismiss, Snooze)
- [ ] Implement action handlers on Rust side
- [ ] Connect action handlers to inbox state
- [ ] Implement badge sync for macOS
- [ ] Implement badge sync for Windows (overlay icons)
- [ ] Test: Dismiss action without opening app
- [ ] Test: Badge updates correctly

---

## 10. Security Considerations

### Payload Validation

Always validate incoming payloads:

```typescript
function isValidOSNotificationPayload(value: unknown): value is OSNotificationPayload {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;

  return (
    typeof obj.notificationId === "string" &&
    typeof obj.createdAt === "number" &&
    isValidSerializedRef(obj.ref)
  );
}

function isValidSerializedRef(value: unknown): value is SerializedNormalizedLink {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;

  return (
    typeof obj.id === "string" &&
    typeof obj.space === "string" &&
    Array.isArray(obj.path) &&
    obj.path.every(p => typeof p === "string") &&
    typeof obj.type === "string"
  );
}
```

### No Sensitive Data in Payload

The payload contains only references, never actual content. Content is fetched at click time with proper authentication.

---

## 11. Future Enhancements

### Reply Actions (Phase 3+)

For conversation notifications, support inline reply:

```rust
NotificationAction {
    id: "reply".into(),
    title: "Reply".into(),
    input: Some(NotificationActionInput {
        placeholder: "Type a message...".into(),
        ..Default::default()
    }),
    ..Default::default()
}
```

### Rich Notification Content

When supported by the platform:

```rust
builder
    .title(&title)
    .body(&body)
    .large_body(&extended_content)  // Expanded view
    .icon(&icon_path)               // Charm icon
    .attachment(&image_path)        // Preview image
```

### Custom URL Scheme (Optional)

If needed for external integrations (e.g., opening from browser):

```
common-tools://open?space=did%3Akey%3Az6Mk...&id=of%3Abafyabc...&path=messages%2F0
```

Register in Tauri config:

```json
{
  "tauri": {
    "bundle": {
      "deepLink": {
        "schemes": ["common-tools"]
      }
    }
  }
}
```

---

## References

- [Tauri v2 Notification Plugin](https://v2.tauri.app/plugin/notification/)
- [Tauri v2 Deep Links](https://v2.tauri.app/plugin/deep-link/)
- [NormalizedLink types](/Users/alex/Code/labs-4/packages/runner/src/link-types.ts)
- [Shell Navigation](/Users/alex/Code/labs-4/packages/shell/src/lib/navigate.ts)
- [Parent: NOTIFICATIONS.md](/Users/alex/Code/labs-4/docs/design/NOTIFICATIONS.md)
