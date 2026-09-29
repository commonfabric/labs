# ChatRoomSession

Status: proposed design (see [`README.md`](README.md)).

One session's view of a room: the state that belongs to a single connection to
the room, not to the room. A room ([`ChatRoomOutput`](ChatRoomOutput.md)) is one
per room and the same for everyone. Each session that reads it gets a
`ChatRoomSession` of its own, through the room's `session`.

```ts
// Shown for illustration only.
interface ChatRoomSession {
  /** The room this is a session of. */
  room: Cell<ChatRoomOutput>;

  /** Whether this session's viewer can send, edit, delete, react, and show a
   * profile now. */
  canSend: boolean;

  /** The newest messages of the main conversation, kept current. */
  latest: ChatMessageWindow;

  /** The room's messages, read through this session's windows. */
  messages: ChatMessageList;

  /** The composer's state: the draft, and the reply being composed. */
  composer: {
    draft: string;
    replyTo?: ChatReply;
  };
}
```

## Scope

Everything here is [`PerSession`](../scoped-cell-instances.md#summary): one
instance per memory session in the room's space. A session is, roughly, one
connection: a client's runtime talking to the room. Two sessions reading the
same room get two `ChatRoomSession`s, with their own windows and their own
drafts, even when they belong to the same person.

The state here goes when its session does. None of it is shared, and none of it
is part of the room's record.

## Fields

- **`room`** links back to the room, which is the room's unique representative:
  the thing to pass around, compare, or record, as a manager's index does.
- **`canSend`** says whether this session's viewer can send, edit, delete,
  react, and show a profile right now: their access is WRITE or OWNER, and their
  profile resolves. It is computed for the viewer, so a READ-only member's
  client can tell them why their gestures would be refused before they make one.
  Knowing the viewer's access level needs the space's member set (see [shared
  spaces](README.md#shared-spaces)).
- **`latest`** is a [`ChatMessageWindow`](ChatMessageWindow.md) holding the
  newest messages of the main conversation, up to the room's `maxWindowCount`.
  Unlike the windows under `messages`, it needs no request, and it follows the
  conversation as new messages arrive. So every member can read the room, even
  one with only READ, who can't append the event that opens a window (see
  [`ChatRoomOutput`](ChatRoomOutput.md#membership)).
- **`messages`** is a [`ChatMessageList`](ChatMessageList.md): the room's
  messages, read through windows this session opens.
- **`composer`** is the state of the room's own composer, which the room's
  `[UI]` shows and sends from. A client that draws its own composer keeps its
  own state instead.

## Writing

A session has no streams that write the room. Every write goes to the room's own
streams (see [`ChatRoomOutput`](ChatRoomOutput.md#streams)), whichever session
the client reads through, because every write changes the room, which is
`PerSpace` and shared, and never the session. Keeping the writes on the room
keeps that line where the scopes draw it: the room is the shared thing, and a
session is one reader's view of it. The only streams under a session are its
message list's `openWindow` and `closeWindow`, which change nothing but the
session's own windows.
