# Messaging Integration Architecture

## Status

Draft (round 4 revision)

## Overview

Common Tools needs bidirectional integration with messaging platforms (WhatsApp,
Telegram, Signal, Discord, iMessage, Slack). The key architectural insight:
**server-side platforms are just patterns** -- no new infrastructure needed.
Local-only platforms (iMessage, Signal, WhatsApp/Baileys) need a lightweight
daemon for machine access.

Every platform pattern exports the same consumer-facing shape: inbox data as
cells, a `sendMessage` Stream handler, and JSDoc `#tags` for wish() discovery.
Consumer patterns like Unified Inbox don't know or care whether delivery happens
via fetch() or daemon -- they just `.send()` to the Stream.

---

## Two Classes of Platform

### Server-Side Platforms (Pure Patterns)

Telegram, Discord, Slack, and WhatsApp Business are **just patterns**. The
pattern's `sendMessage` handler calls `fetch()` to the platform API. Inbound
messages arrive via webhook. No daemon, no toolshed watcher, no new
infrastructure.

A Telegram pattern is no different from any other pattern that calls an external
API. Toolshed provides auth/token setup routes (following the Google OAuth
model), but the pattern itself handles all messaging logic.

### Local-Only Platforms (Daemon-Bridged)

iMessage needs `chat.db` access. Signal needs `signal-cli` subprocess.
WhatsApp/Baileys needs local QR pairing. These require a daemon running on the
user's machine to bridge local data sources into the cell fabric.

| Platform | Why local? | Connection type |
|----------|-----------|----------------|
| iMessage | macOS `chat.db` + AppleScript | Filesystem polling |
| Signal | `signal-cli` subprocess | JSON-RPC (persistent) |
| WhatsApp/Baileys | QR code pairing | WebSocket (persistent) |

---

## Inbound Message Delivery

Preference order for how messages arrive into platform pattern cells:

### 1. Server-side webhook (preferred)

External service POSTs to `/api/webhooks/:id`, toolshed calls
`sendToStream()`. Instant delivery. Works for Telegram (`setWebhook`), Discord
(Interactions endpoint), Slack (Events API).

This is the **default and required path** for server-side messaging. Webhooks
are instant; polling is not acceptable for message delivery.

### 2. Server-side reactive polling (future)

Pattern uses `wish("#now:1000")` for fast interval-based polling. Not yet
landed. Currently, `bgUpdater` at 60s is the only server-side poll option --
acceptable as an interim hack for non-latency-sensitive maintenance tasks (token
refresh, health checks), not as the long-term messaging design.

### 3. Local daemon (local-only platforms)

Daemon runs on the user's machine, reactively responds to fabric updates via
`cell.sink()`, and bridges to local data sources (`chat.db`, `signal-cli`,
Baileys).

---

## Server-Side Platform Pattern Anatomy

Each server-side platform is a self-contained pattern that:

- Uses **webhook ingress** for inbound messages (instant delivery)
- Uses **`fetch()`** in handlers for outbound sends
- Uses **toolshed integration routes** for auth/token setup only
- Uses **`bgUpdater`** only for maintenance (token refresh, health checks)

**Example: Telegram pattern**

```
1. Toolshed route stores bot token, calls Telegram setWebhook → /api/webhooks/:id
2. Telegram POSTs updates to /api/webhooks/:id
3. Webhook handler calls sendToStream() into the Telegram pattern's inbox
4. Pattern's sendMessage handler calls fetch() to Telegram sendMessage API
```

**Key existing code:**

| Code | Role |
|------|------|
| `packages/toolshed/routes/webhooks/` | Webhook ingress (`sendToStream()`) |
| `packages/toolshed/routes/integrations/google-oauth/` | Auth + `setBGCharm()` template |
| `packages/toolshed/routes/integrations/discord/` | Existing Discord integration |
| `packages/background-charm-service/` | `bgUpdater` polling (60s) |

---

## Common Gateway: Local Daemon (Local-Only Platforms)

The daemon exists **only** because iMessage/Signal/WhatsApp-Baileys need local
machine access. For everything server-side, patterns handle it themselves.

A standalone Deno process ("Common Gateway") runs locally, imports the CT
runtime library directly, and bridges local data sources into the cell fabric.

### Core Architecture

```
                    Common Gateway (Deno process)
                    +----------------------------------+
                    |                                  |
                    |  +----------+  +--------------+  |
                    |  | Platform |  | CT Runtime   |  |
                    |  | Adapters |  | Client       |  |
  Local Data ------+--| iMessage |--| getCellFrom  |--+---- Toolshed API
  Sources          |  | Signal   |  | Link(), sync |  |     (storage)
  (chat.db,        |  | WhatsApp |  | editWithRetry|  |
   signal-cli)     |  +----------+  +--------------+  |
                    |                                  |
                    |  +------------------------------+|
                    |  | Gateway API (localhost:18790) ||
                    |  | - Status / health             ||
                    |  | - QR code display (WhatsApp)  ||
                    |  | - Adapter management          ||
                    |  +------------------------------+|
                    +----------------------------------+
```

### Communication with the Fabric

The daemon uses the **runtime library directly** (`@commontools/runner`), the
same approach as `background-charm-service`. This means:

- **No CLI shelling** (unlike the existing apple-sync approach of calling
  `ct charm set`)
- **No custom protocol** -- uses the same cell read/write/sync primitives as
  toolshed itself
- **Identity-based auth** -- daemon loads the user's identity key and signs UCAN
  tokens for storage access

**Key runtime primitives** (from
`packages/toolshed/routes/webhooks/webhooks.utils.ts`):

```typescript
// Get a cell reference from a link
const cell = runtime.getCellFromLink(parsedCellLink);
await cell.sync();
await runtime.storageManager.synced();

// Write to a cell
const { error } = await cell.runtime.editWithRetry((tx) => {
  cell.withTx(tx).set(data);
});

// Send to a Stream (for inbound messages)
const streamCell = cell.asSchema({ asStream: true });
streamCell.withTx(tx).send(payload);
```

### Daemon Internals

**Static adapter registry.** Adapters are configured in
`~/.common-gateway/config.json`, not discovered dynamically. The config
specifies which adapters are enabled and their cell links for inbox/send
Streams.

```json
{
  "toolshedUrl": "https://toolshed.saga-castor.ts.net",
  "identityKeyPath": "../labs/claude.key",
  "space": "my-space",
  "adapters": {
    "imessage": {
      "enabled": true,
      "inboxCellLink": "...",
      "sendCellLink": "..."
    },
    "signal": {
      "enabled": true,
      "phoneNumber": "+1234567890",
      "inboxCellLink": "...",
      "sendCellLink": "..."
    }
  }
}
```

**Config Discovery.** Hardcoded cell links in config go stale when the user
redeploys a platform pattern (new entity ID). To solve this, each platform
pattern writes its own cell links to a well-known `messaging-config` entity
in the user's space on deploy:

```typescript
// Written by each platform pattern on deploy
interface MessagingConfig {
  [platform: string]: {
    inboxLink: string;     // cell link to platform's inbox Stream
    outboxLink?: string;   // cell link to outbox cell (local-only platforms)
    updatedAt: string;     // ISO 8601
  };
}
```

The daemon watches this config entity via `cell.sink()` and dynamically updates
its adapter connections when links change. When a platform pattern is
redeployed, it writes new links to the config entity, and the daemon picks them
up automatically -- no manual config update needed.

For v1, manual config in `~/.common-gateway/config.json` works as a fallback.
Auto-discovery via the config entity replaces it as the default path.

**Single Deno event loop with async tasks per adapter.** Each adapter runs as
an independent async task within the same Deno process. No worker threads, no
subprocess per adapter -- just concurrent promises on one event loop.

**Error isolation.** One adapter crashing does not take down others. Each
adapter task catches its own errors, logs them, and attempts restart with
exponential backoff. The gateway API exposes per-adapter health status.

**Send stream discovery from config.** The daemon reads cell links from config,
calls `cell.sink()` on each platform's sendMessage Stream, and dispatches to
the appropriate local adapter when events arrive.

**Lightweight PlatformAdapter interface** (internal to the daemon, not
fabric-level):

```typescript
interface PlatformAdapter {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly healthy: boolean;
}
```

Each adapter's `start()` method sets up inbound polling/connections and
registers `cell.sink()` watchers for outbound sends. The daemon orchestrates
lifecycle but delegates all platform logic to the adapter.

### Per-Platform Adapter Notes

**iMessage:**

- Read: SQLite queries on `~/Library/Messages/chat.db`
- Write: AppleScript via `osascript` (macOS only)
- Polling: Watch chat.db for changes via `kqueue`/`fs.watch` or poll every 5-10
  seconds
- macOS only, requires Full Disk Access permission

**Signal:**

- Read/Write: `signal-cli` subprocess with JSON-RPC over stdio (event-driven,
  persistent connection)
- Requires phone number registration and verification
- Cross-platform (Linux/macOS/Windows)

**WhatsApp (local):**

- Read/Write: Baileys library (WhatsApp Web protocol, persistent WebSocket)
- Requires QR code pairing (gateway API serves a QR endpoint)
- Stores credentials locally in `~/.common-gateway/credentials/`
- Note: WhatsApp Business API is server-side, Baileys is local-only

---

## Message Schemas

Each platform defines its own lossless message type that preserves all
platform-specific fields. There is no shared base interface -- each type is fully
self-contained, following the established pattern convention (e.g., how
`gmail-importer.tsx` defines a flat `Email` type with all Gmail-specific fields).

Normalization, if desired, happens at a higher consumer layer.

### Platform-Specific Message Types

```typescript
// iMessage -- preserves all chat.db columns
interface IMessageMessage {
  rowId: number;              // chat.db ROWID
  guid: string;               // iMessage GUID
  text: string | null;
  handleId: string;
  chatGuid: string;           // e.g. "iMessage;+;chat12345"
  service: string;            // "iMessage" | "SMS"
  isFromMe: boolean;
  isDelivered: boolean;
  isRead: boolean;
  timestamp: string;          // ISO 8601
  dateSent: number;           // Core Data timestamp
  threadOriginatorGuid?: string;
  tapbackType?: number;
  associatedMessageGuid?: string;
  attachments?: IMessageAttachment[];
  // ... all other chat.db fields as needed
}

interface IMessageAttachment {
  filename: string;
  mimeType: string;
  transferName: string;
  totalBytes: number;
  // iMessage-specific attachment fields from chat.db
}

// Signal -- preserves signal-cli JSON-RPC fields
interface SignalMessage {
  text: string | null;
  timestamp: number;
  isFromMe: boolean;
  envelope: {
    source: string;           // phone number
    sourceDevice: number;
    timestamp: number;
  };
  groupId?: string;
  groupName?: string;
  expiresInSeconds?: number;
  quote?: {
    id: number;
    author: string;
    text: string;
  };
  reaction?: {
    emoji: string;
    targetTimestamp: number;
    targetAuthor: string;
  };
  attachments?: SignalAttachment[];
  // ... all signal-cli fields
}

interface SignalAttachment {
  contentType: string;
  filename?: string;
  size: number;
  id: string;
  // signal-cli attachment fields
}

// Telegram -- preserves Bot API Update fields
interface TelegramMessage {
  messageId: number;
  text: string | null;
  timestamp: number;          // unix epoch from date field
  isFromMe: boolean;
  from: { id: number; firstName: string; username?: string };
  chat: { id: number; type: string; title?: string };
  replyToMessage?: TelegramMessage;
  forwardFrom?: { id: number; firstName: string };
  editDate?: number;
  entities?: Array<{ type: string; offset: number; length: number }>;
  photo?: Array<{ fileId: string; width: number; height: number }>;
  // ... all Telegram Bot API fields
}

// Discord -- preserves Discord API fields
interface DiscordMessage {
  messageId: string;
  text: string | null;
  timestamp: string;
  isFromMe: boolean;
  channelId: string;
  guildId?: string;
  author: { id: string; username: string; discriminator: string };
  embeds?: Array<Record<string, unknown>>;
  reactions?: Array<{ emoji: string; count: number }>;
  referencedMessage?: DiscordMessage;
  attachments?: DiscordAttachment[];
  // ... all Discord API fields
}

interface DiscordAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
  proxyUrl: string;
}
```

### Per-Platform Cell Schemas

Each platform is its own pattern with its own cell types. Messages are stored as
inline data arrays within conversation entities, following the established
pattern convention (e.g., how `chatbot.tsx` stores `messages: BuiltInLLMMessage[]`
inline).

```typescript
// === iMessage Pattern ===

// Inbound: daemon pushes platform-specific messages here
type IMessageInbox = Stream<IMessageMessage>;

// Chat entity -- messages stored inline
type IMessageChat = {
  chatGuid: string;
  displayName?: string;
  participants: string[];       // handle IDs
  messages: IMessageMessage[];  // inline array, not links
  lastActivity: string;
};

// === Signal Pattern ===

type SignalInbox = Stream<SignalMessage>;

type SignalConversation = {
  phoneNumber: string;          // direct message
  groupId?: string;             // group chat
  groupName?: string;
  participants: string[];       // phone numbers
  messages: SignalMessage[];
  lastActivity: string;
};

// === Telegram Pattern ===

type TelegramInbox = Stream<TelegramMessage>;

type TelegramChat = {
  chatId: number;
  chatType: string;
  title?: string;
  messages: TelegramMessage[];
  lastActivity: string;
};

// (Discord, Slack, WhatsApp follow the same per-platform pattern)
```

---

## Uniform Send API

All platforms share a single `sendMessage` Stream type using a discriminated
union on `platform`. The schema generator produces `anyOf` with
enum-constrained discriminator fields. Each platform pattern's `sendMessage`
handler matches on `platform` and acts on its variant's fields.

```typescript
type SendMessage =
  | {
      platform: "imessage";
      text: string;
      chatGuid: string;
      replyToGuid?: string;
      attachments?: MessageAttachment[];
    }
  | {
      platform: "signal";
      text: string;
      phoneNumber?: string;
      groupId?: string;
      quoteTimestamp?: number;
      expiresInSeconds?: number;
      attachments?: MessageAttachment[];
    }
  | {
      platform: "telegram";
      text: string;
      chatId: number;
      replyToMessageId?: number;
      parseMode?: "HTML" | "Markdown";
    }
  | {
      platform: "discord";
      text: string;
      channelId: string;
      replyToMessageId?: string;
      embeds?: unknown[];
      attachments?: MessageAttachment[];
    };

interface MessageAttachment {
  data: string;              // base64 or data URI
  mimeType: string;
  filename?: string;
}
```

### Platform Pattern Output with #tags

Each platform pattern exports its Output with JSDoc `#tags` for wish()
discovery. This is how consumer patterns find platform inboxes without hardcoded
references.

```typescript
/** iMessage integration. #imessage #messaging */
interface Output {
  chats: IMessageChat[];
  sendMessage: Stream<SendMessage>;
  outbox: PendingMessage[];        // local-only: persistent outbox
}

/** Telegram bot integration. #telegram #messaging */
interface Output {
  chats: TelegramChat[];
  sendMessage: Stream<SendMessage>;
  // No outbox -- server-side, handler calls fetch() directly
}

/** Discord integration. #discord #messaging */
interface Output {
  chats: DiscordChat[];
  sendMessage: Stream<SendMessage>;
  // No outbox -- server-side, handler calls fetch() directly
}
```

### Delivery Status (Optional)

Stream `.send()` returns `void`. If delivery confirmation is needed, it flows
back through a separate delivery-status cell, not as a return value:

```typescript
type DeliveryStatus = {
  pending: number;
  lastError?: string;
  lastDelivered?: string;       // ISO 8601
};
```

### Error Handling for Outbound Sends

Stream `.send()` handlers that call external APIs must handle failures.
The model is `GmailClient.googleRequest()` at
`packages/patterns/google/core/util/gmail-client.ts:612-681`: retry with
exponential backoff, handle auth refresh (401), respect rate limits (429).

**Pattern:** The handler wraps `fetch()` in try/catch, retries with backoff,
and updates the `DeliveryStatus` cell on success or final failure. Retry is
application-level -- there is no framework retry middleware.

```typescript
// Server-side: Telegram handler with error handling
const handleSendMessage = handler<SendMessage, {}>(
  async (message, {}) => {
    if (message.platform !== "telegram") return;

    let lastError: string | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: message.chatId,
            text: message.text,
            reply_to_message_id: message.replyToMessageId,
            parse_mode: message.parseMode,
          }),
        });
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get("Retry-After") ?? 1);
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          continue;
        }
        if (!res.ok) throw new Error(`Telegram API ${res.status}`);
        // Update delivery status on success
        deliveryStatus.set({ pending: 0, lastDelivered: new Date().toISOString() });
        return;
      } catch (err) {
        lastError = String(err);
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
    deliveryStatus.set({ pending: 0, lastError });
  },
);
```

For local-only platforms, the daemon's outbox consumer applies the same
retry-with-backoff pattern before removing items from the outbox.

---

## Reactive Data Flow

### Inbound (local source -> fabric, daemon only)

- **iMessage:** Poll `chat.db` via `fs.watch`/kqueue on the WAL file, or
  short-interval poll (5-10s). Push new `IMessageMessage` entries via
  `sendToStream()` to the iMessage inbox.
- **Signal:** `signal-cli` JSON-RPC pushes messages as they arrive
  (event-driven, persistent connection). Pushed as `SignalMessage` to inbox.
- **WhatsApp/Baileys:** Event-driven WebSocket (persistent connection). Pushed
  as platform-specific messages to inbox.

### Inbound (server-side, webhook)

- **Telegram:** Telegram POSTs to `/api/webhooks/:id`, toolshed calls
  `sendToStream()`. Instant.
- **Discord:** Interactions endpoint webhook. Same flow.
- **Slack:** Events API webhook. Same flow.

### Outbound (consumer -> platform, uniform)

Consumer patterns call `.send()` on the platform's `sendMessage` Stream with
the appropriate discriminated union variant. The platform pattern's handler
dispatches:

- **Server-side patterns:** Handler calls `fetch()` to the platform API
  directly.
- **Local patterns:** Handler appends to a persistent outbox cell. Daemon
  watches the outbox via `cell.sink()` and dispatches to the local adapter.

```typescript
// Server-side: Telegram pattern's sendMessage handler
const handleSendMessage = handler<SendMessage, {}>(
  (message, {}) => {
    if (message.platform !== "telegram") return;
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      body: JSON.stringify({
        chat_id: message.chatId,
        text: message.text,
        reply_to_message_id: message.replyToMessageId,
        parse_mode: message.parseMode,
      }),
    });
  },
);

// Local: daemon watches iMessage outbox cell
iMessageOutboxCell.sink((outbox) => {
  for (const item of outbox) {
    if (processedIds.has(item.id)) continue;
    iMessageAdapter.send(item.payload.chatGuid, item.payload.text, item.payload.replyToGuid);
    processedIds.add(item.id);
    editWithRetry((tx) => {
      // Remove delivered item from outbox
      outboxCell.withTx(tx).set(outbox.filter((i) => i.id !== item.id));
    });
  }
});
```

### Stream/Sink Reliability

- **`Stream.send()` fires `cell.listeners` synchronously** -- an in-memory
  `Set` of callbacks. Stream events are **not** persisted to storage.
- **`cell.sink()` fires for every `.send()` call**, but only while the process
  is running. If the handler process is offline when `.send()` executes, the
  event is lost.
- **Server-side patterns:** This is fine. The handler runs in-process on
  toolshed, so `fetch()` executes immediately in the `.send()` callback.
- **Local-only patterns:** Events sent while the daemon is offline are lost.
  The outbox cell (below) solves this.

### Outbox Cell (Local-Only Platforms)

Server-side patterns don't need durability for outbound sends -- their handler
calls `fetch()` directly in-process on toolshed. Local-only platforms need a
persistent outbox because the daemon may be offline when the consumer sends.

Each local-only platform pattern adds an `outbox` cell to its Output:

```typescript
interface PendingMessage {
  id: string;           // crypto.randomUUID() — dedup key
  payload: SendMessage; // the send variant for this platform
  createdAt: string;    // ISO 8601
}
```

The `outbox` is a regular `Writable<Default<PendingMessage[], []>>` cell,
persisted via normal cell writes. This is the key insight: because the
`sendMessage` handler runs on toolshed (not on the daemon), it always succeeds
-- it just appends to the outbox cell, which is durable storage.

**Data flow:**

```
Consumer .send() → Stream handler on toolshed → outbox.push(...)
  → persisted to storage → syncs to daemon → cell.sink() fires
  → adapter delivers → outbox.remove(item)
```

**Daemon outbox consumption:**

- Daemon watches `outbox` with `cell.sink()` on the regular cell (fires on
  every state change, including changes made while offline)
- On delivery success: daemon removes item from outbox via `editWithRetry()`
- On daemon restart: syncs outbox cell, processes all remaining items
- Dedup: daemon maintains in-memory `processedIds` Set; for crash between
  delivery and removal, accept idempotent re-delivery for v1 (a local delivery
  log file can provide stricter dedup later)

### Single-Machine Assumption

The daemon runs on one "main" machine per user. Multi-device coordination is out
of scope. The cell fabric naturally prevents data conflicts since there's only
one writer for local-source data.

---

## Daemon Lifecycle

1. **First run:** Interactive setup -- prompts for toolshed URL, identity key
   path, space name. Saves config to `~/.common-gateway/config.json`.
2. **Start:** Loads config, initializes runtime client, connects to storage,
   starts enabled platform adapters, sets up `cell.sink()` watchers on each
   platform's send Stream.
3. **Running:** Inbound messages flow reactively into per-platform Stream cells.
   Send handler sinks fire callbacks for outbound delivery.
4. **`--daemon` mode:** Runs as a background process. On macOS, can install as a
   launchd service.

---

## Unified Inbox Pattern (Consumer)

The Unified Inbox is a **consumer pattern** that discovers platform inboxes via
`wish()`, aggregates messages via `computed()`, and routes replies to the
correct platform's `sendMessage` Stream.

```typescript
import { handler, UI, NAME } from "@commontools/common-ui";

// Discover all messaging platform patterns via #messaging tag
const imessage = wish<{
  chats: IMessageChat[];
  sendMessage: Stream<SendMessage>;
}>({ query: "#imessage #messaging" });

const telegram = wish<{
  chats: TelegramChat[];
  sendMessage: Stream<SendMessage>;
}>({ query: "#telegram #messaging" });

const discord = wish<{
  chats: DiscordChat[];
  sendMessage: Stream<SendMessage>;
}>({ query: "#discord #messaging" });

// Normalize all platform messages into a unified timeline
interface UnifiedMessage {
  platform: string;
  chatId: string;
  sender: string;
  text: string | null;
  timestamp: number;
  raw: unknown;               // preserve original for platform-specific features
}

const allMessages = computed(() => {
  const messages: UnifiedMessage[] = [];

  for (const chat of imessage.result?.chats ?? []) {
    for (const msg of chat.messages) {
      messages.push({
        platform: "imessage",
        chatId: chat.chatGuid,
        sender: msg.isFromMe ? "me" : msg.handleId,
        text: msg.text,
        timestamp: new Date(msg.timestamp).getTime(),
        raw: msg,
      });
    }
  }

  for (const chat of telegram.result?.chats ?? []) {
    for (const msg of chat.messages) {
      messages.push({
        platform: "telegram",
        chatId: String(chat.chatId),
        sender: msg.isFromMe ? "me" : msg.from.firstName,
        text: msg.text,
        timestamp: msg.timestamp * 1000,
        raw: msg,
      });
    }
  }

  // ... same for discord, signal

  return messages.sort((a, b) => b.timestamp - a.timestamp);
});

// Route replies to the correct platform's sendMessage Stream
function sendReply(platform: string, payload: SendMessage) {
  switch (platform) {
    case "imessage": imessage.result?.sendMessage.send(payload); break;
    case "telegram": telegram.result?.sendMessage.send(payload); break;
    case "discord":  discord.result?.sendMessage.send(payload); break;
  }
}
```

The Unified Inbox pattern:

- Discovers platform patterns via `wish()` with `#messaging` tags
- Projects platform-specific types into a common display format (lossy
  normalization -- only for rendering, not storage)
- Routes outbound replies to the correct per-platform `sendMessage` Stream
  based on which conversation the user is viewing
- Individual platform patterns work independently without the Unified Inbox

---

## Tauri Integration

### Daemon as Sidecar

The Common Gateway is designed to be bundled as a **Tauri sidecar**:

- Built with `deno compile` to produce a standalone binary
- No external dependencies at runtime (SQLite access via Deno's built-in,
  signal-cli bundled separately)
- Communicates via localhost HTTP API (Tauri frontend <-> Gateway sidecar)
- Tauri manages the sidecar lifecycle (start on app launch, stop on quit)

### Tauri App Structure

```
common-tools-app/
+-- src-tauri/
|   +-- src/main.rs            # Tauri app entry, sidecar management
|   +-- binaries/
|   |   +-- common-gateway-{target-triple}   # deno compile'd binary
|   +-- tauri.conf.json        # externalBin: ["binaries/common-gateway"]
+-- src/                       # Web app (wraps existing shell)
```

### Mobile Considerations (Tauri v2)

- **iOS/Android:** Sidecar binaries won't work on mobile. Use Tauri mobile
  plugins (Swift/Kotlin) for platform-specific messaging access.
- **iOS iMessage:** Not possible -- Apple doesn't expose iMessage to third-party
  apps on iOS.
- **Android SMS:** Possible via Kotlin Tauri plugin using Android's SMS
  ContentProvider.
- **Desktop gets full daemon. Mobile gets a subset via native plugins.**

### Progressive Enhancement Path

1. **Now:** Standalone Deno daemon, works without Tauri
2. **Soon:** Tauri desktop app wraps web shell + bundles daemon as sidecar
3. **Later:** Tauri mobile app with native plugins for mobile-accessible
   messaging
4. **Future:** Daemon auto-updates via Tauri's built-in updater

---

## Comparison with OpenClaw

| Aspect | OpenClaw | Common Tools |
|--------|----------|-------------|
| Runtime | Single Node.js Gateway process | Split: patterns (server) + daemon (local) |
| Server services | All local | Pure patterns (fetch + webhooks) |
| Local services | Same process | Local daemon (Common Gateway) |
| Communication | Internal function calls | Cell fabric (runtime library) |
| State | In-memory + local DB | Reactive cells in shared storage |
| UI | Chat apps themselves | CT patterns (web UI) |
| iMessage | BlueBubbles bridge | Direct SQLite + AppleScript |
| Signal | signal-cli JSON-RPC | signal-cli JSON-RPC (same) |
| Packaging | Docker / systemd | Standalone binary / Tauri sidecar |
| Message types | Normalized at transport | Per-platform lossless, normalize at consumer |
| Outbound | Shared send queue | Uniform sendMessage Stream (discriminated union) |

**Key architectural difference:** OpenClaw is a monolith -- everything runs in
one process. CT's approach splits cleanly: server-side platforms are just
patterns that call `fetch()` and receive webhooks, local-only platforms use the
daemon, and they all write to the same cell fabric. Each platform exports the
same consumer-facing shape (inbox cells + `sendMessage` Stream). This means:

- Server-side platforms work without any daemon
- The daemon only handles truly local things (filesystem, local subprocesses)
- State is always available via the web (even if daemon is offline, you see
  last-synced messages)
- No information is lost at the transport layer -- platform-specific features
  (reactions, threads, disappearing messages) are preserved
- Consumer patterns use `wish()` to discover platforms and don't care about
  delivery mechanism

---

## Open Questions

1. **WhatsApp: server-side or local?** WhatsApp Business API can authenticate
   server-side but requires a business account. Baileys requires local QR
   pairing but is more accessible to individual users. Likely support both.

2. **Rate limiting and backpressure:** How to handle high-volume channels
   without overwhelming the cell fabric?

3. **Credential storage:** Where do platform credentials live? Options: local
   keychain (via Tauri's security plugin), encrypted cells in the fabric, or
   local config files.

4. **Message history vs. streaming:** Should the daemon backfill historical
   messages on first connect, or only forward new messages from the point of
   connection?

5. **Attachment storage:** Large media (images, videos) -- store in the cell
   fabric or reference externally?

6. **Entity granularity:** Should each message be its own cell entity (using
   `asCell` in the schema), or should messages be stored as inline arrays within
   conversation entities? Existing patterns strongly favor inline arrays, but
   per-message entities enable fine-grained addressability.

7. **`wish("#now:1000")` for fast polling:** Once reactive polling lands,
   server-side patterns can poll at sub-second intervals without bgUpdater.
   This eliminates the 60s limitation and may make webhooks optional for some
   platforms.

---

## Implementation Roadmap

### Phase 1: Foundation

- [ ] Define per-platform message types (flat, self-contained, lossless)
- [ ] Build Common Gateway skeleton (Deno, runtime client, adapter interface)
- [ ] iMessage adapter with lossless `IMessageMessage` type (read-only)
- [ ] Simple iMessage viewer pattern for testing

### Phase 2: Bidirectional

- [ ] iMessage `sendMessage` Stream handler + AppleScript send
- [ ] Signal adapter with lossless `SignalMessage` type + send handler
- [ ] Per-platform chat UI patterns

### Phase 3: Server-Side Channels

- [ ] Telegram pattern (webhook ingress + `fetch()` send, pure pattern)
- [ ] Discord integration upgrade (currently webhook-only, add full messaging)
- [ ] WhatsApp local adapter (Baileys) with lossless type and send handler

### Phase 4: Tauri

- [ ] `deno compile` the gateway into a standalone binary
- [ ] Tauri desktop app wrapping the CT shell
- [ ] Sidecar integration (start/stop gateway from Tauri)
- [ ] QR code pairing UI for WhatsApp within Tauri

### Phase 5: Unified Experience

- [ ] Unified Inbox pattern (wish-based discovery, computed aggregation)
- [ ] Cross-platform reply routing via uniform sendMessage Stream
- [ ] Notification integration (Tauri native notifications)
- [ ] Mobile Tauri plugins (Android SMS)
- [ ] Auto-update for daemon/app

---

## Key Files Reference

| File | Role |
|------|------|
| `packages/toolshed/routes/webhooks/webhooks.utils.ts` | Runtime cell primitives (`sendToStream`, `getCellFromLink`) |
| `packages/toolshed/routes/webhooks/webhooks.handlers.ts` | Webhook ingress API |
| `packages/toolshed/routes/integrations/google-oauth/` | Auth + `setBGCharm()` template for server-side integrations |
| `packages/toolshed/routes/integrations/discord/` | Existing server-side integration |
| `packages/background-charm-service/` | `bgUpdater` polling (60s interval) |
| `packages/ui/src/v2/components/ct-webhook/` | Webhook UI component |
| `docs/specs/webhook-ingress/README.md` | Webhook system design spec |
