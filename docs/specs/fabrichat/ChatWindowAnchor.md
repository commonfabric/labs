# ChatWindowAnchor

Status: proposed design (see [`README.md`](README.md)).

Where a window of messages sits in its view of the conversation. A client passes
one to [`ChatMessageList`](ChatMessageList.md)'s `openWindow`, as `from`.

```ts
// Shown for illustration only.
type ChatWindowAnchor =
  | { before: FabricEpochNsec | "end" }
  | { after: FabricEpochNsec | "start" }
  | { around: FabricEpochNsec };
```

Exactly one of the three keys is present.

## The anchors

- **`{ before: t }`**: the newest messages sent before `t`. With `"end"`, the
  newest messages there are. A client opening a conversation at its latest
  messages uses `{ before: "end" }`, and pages back with `{ before: t }`, where
  `t` is the `sentAt` of the oldest message it has.
- **`{ after: t }`**: the oldest messages sent after `t`. With `"start"`, the
  earliest messages there are. A client scrolled to the top of a thread uses
  `{ after: "start" }`, and pages forward with `{ after: t }`, where `t` is the
  `sentAt` of the newest message it has.
- **`{ around: t }`**: the messages on either side of the message whose `sentAt`
  is `t`, that message included, about half on each side. A side with too few
  messages is filled from the other, so the window is as full as the view
  allows. A client uses it to jump to a message, such as a reply's target or a
  message a link points at, without paging from either end. The message MUST be
  in the view: an `around` that names a message outside it is refused.

Every message's `sentAt` is unique in the room (see [unique
times](ChatMessage.md#unique-times)), so a `sentAt` names one point exactly, and
a window never starts or ends in the middle of a tie.

A window's `hasOlder` and `hasNewer` (see
[`ChatMessageWindow`](ChatMessageWindow.md)) say whether there is more on either
side of wherever it was anchored.
