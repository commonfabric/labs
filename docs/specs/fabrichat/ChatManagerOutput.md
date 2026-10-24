# ChatManagerOutput

The result of a user's chat manager: what `wish({ query: "#chatManager" })`
resolves to. It is the contract clients read, and it is named for the role
rather than for an implementation. [`FabriChatManager`](FabriChatManager.md) is
an implementation of it: its result satisfies `ChatManagerOutput`, and another
pattern that satisfies it can fill the same role. Everything in this document
binds every implementation.

```ts
// Shown for illustration only.
interface ChatManagerOutput {
  /** Every room this user belongs to and hasn't forgotten, newest first. */
  rooms: PerUser<ChatIndexEntry[]>;

  /** The direct room this user shares with each counterpart, by principal. */
  direct: Record<string, ChatIndexEntry>;

  /** The user's shared-space catalog, as stored. */
  sharedSpaceCatalog: object;

  /** Explicit choices about individual conversations. */
  roomMembership: (ChatIndexEntry & {
    state: "saved" | "archived";
    revision: string;
    catalogRevision?: string;
  })[];

  /** The outcome of each request, by the `requestId` its caller chose. */
  requests: Record<
    string,
    | { status: "pending" }
    | {
      status: "done";
      entry?: ChatIndexEntry;
      delivery?: "offered" | "noticed";
    }
    | {
      status: "refused";
      reason: string;
      code?: "space-own-chat" | "shared-inbox";
    }
  >;

  /** Notices this user's requests have produced that no one has delivered. */
  outgoingNotices: {
    id: string;
    room: Cell<ChatRoomOutput>;
    recipient: string;
  }[];

  /** The people this user's rooms list, by principal. */
  people: PerUser<Record<string, Cell<ChatProfile>[]>>;

  openDirect: Stream<{ requestId: string; counterpart: string }>;
  createGroup: Stream<{
    requestId: string;
    members: string[];
    profiles?: Cell<ChatProfile>[];
    title: string;
    joinableByLink?: boolean;
  }>;
  offerRoom: Stream<{
    requestId: string;
    room: Cell<ChatRoomOutput>;
    member?: string;
    profile?: Cell<ChatProfile>;
  }>;
  accept: Stream<{
    requestId: string;
    room: Cell<ChatRoomOutput>;
    counterpart?: string;
    container?: Cell<{ chatRoom?: Cell<ChatRoomOutput> }>;
  }>;
  joinRoom: Stream<{
    requestId?: string;
    room: Cell<ChatRoomOutput>;
    container?: Cell<{ chatRoom?: Cell<ChatRoomOutput> }>;
    messageAct?: boolean;
  }>;
  forget: Stream<{
    requestId: string;
    room: Cell<ChatRoomOutput>;
    revision: string;
  }>;
  delivered: Stream<{ requestId: string; id: string }>;

  [VIEWS]: { chats: object };
}
```

Principals are DIDs throughout.

## Where the role lives

Each user has exactly one chat manager, in their home space. A client reaches it
with `wish<ChatManagerOutput>({ query: "#chatManager" })` and uses the wish's
`result`. `#chatManager` is a home target, like `#agent_queue` and `#profile`,
and names the role rather than the pattern that fills it. On a serving runtime,
it resolves against the demanding identity's home space and never the service's
([server-side builtins](../server-side-execution/builtins.md)). A home whose
system pattern was set up before it held a manager holds none until the home
space is next opened, and a custom home pattern holds one only if it says so;
until then the wish reports an error naming both remedies, with no `result`.

Everything a manager holds is private to its user, as the home space is: nobody
else learns whom a user talks to by reading it.

## Admission to a room

A manager admits the other members of a room it creates by granting each of them
access to the room's space, by principal. It never issues a space invitation: a
space invitation is a bearer credential, redeemable by whoever holds its code,
so it can't guarantee that the person admitted is the one intended, and a direct
room's `counterpart` has to be exactly that person.

A grant gives access but tells the recipient nothing. So the manager also tells
each other member: it offers them the room through their share inbox when the
request names their profile and the profile points at one (see
[offers](#offers)), and otherwise produces a **notice**, saying which room they
have been admitted to and by whom (see
[delivering notices](#delivering-notices)). A client finds the profiles of the
people this user already shares a room with in `people`, so a new room can name
each of them by profile. Someone this user adds to a room later, from the
room's [`addMember`](ChatRoomOutput.md#addmemberrequestid-string-target--value-string--profile-cellchatprofile),
is told the same way, through
[`offerRoom`](#offerroomrequestid-string-room-cellchatroomoutput-member-string-profile-cellchatprofile),
which the room sends.

## Views

The manager offers its facts and streams as a `[VIEWS]` group, `chats`, for
hosts that draw natively: `rooms`, `direct`, `requests`, `outgoingNotices`, and
`people`, and every stream below. A native client drives the manager through
that group as it drives a room through the room's `room` group (see
[`clients.md`](clients.md#showing-a-room)).

## Scopes

Everything a manager stores is `PerSpace` in the user's home space (see
[scopes](../scoped-cell-instances.md#summary)). A home space admits only its
user, so `PerSpace` there means one instance for that user, which is why nothing
it stores needs to be `PerUser` or `PerSession`.

`rooms`, which the manager doesn't store, is `PerUser` all the same, and so is
`people`, which is drawn from it, though each room's `roster` is shared by
everyone the room's space admits: a profile lives in its owner's own space, and
attests no principal to a reader that space refuses, so two readers can key the
same roster differently. Each room in it is read under the reader's own access,
so a manager more than one principal reads, as one outside a home space can be,
lists different rooms to a principal a room's space refuses than to its members.
Stored once for every reader, a value readers derive differently is one their
runtimes overwrite without end. Read access is a property of the principal, so
every session of one user derives the same values, and one instance per user
serves them all. A stream reads neither, except `offerRoom`, which reads
`people` for the user that sends it: every other request names a room's members
by principal or by profile itself.

## Facts

- **`rooms`** holds a [`ChatIndexEntry`](ChatIndexEntry.md) for every room this
  user belongs to and hasn't forgotten, newest first. An entry is a link to its
  room and never a copy of the room's data: what a room holds is read from the
  room, under the reader's own access. Through the link a reader finds the
  room's `about`, including its current title after a retitle, and where its
  conversation stands, `messages.count` and `messages.newestAt`; [`ChatIndexEntry`](ChatIndexEntry.md) says why the link
  declares those and no more. `rooms` is drawn from the user's shared-space
  catalog, Home's: standalone `fabrichat-room` roots and explicit `chatRoom`
  declarations on other saved spaces' roots, combined with the manager's
  individual `roomMembership` choices. Resolved room identity deduplicates
  discovery paths; an archived individual entry suppresses every path.
- **`roomMembership`** keeps explicit choices about individual conversations:
  resolved room links, `saved` or `archived` state, `since`, and opaque
  `revision`. An optional `catalogRevision` records that standalone catalog
  membership governs the room, including when its catalog entry is removed.
  These choices are independent of the catalog's container membership.
- **`sharedSpaceCatalog`** is that catalog
  ([`shared-space-catalog.md`](../../features/shared-space-catalog.md)), as
  stored. A standalone room's catalog `title` is a display hint: the room's
  title as the manager last heard of it, refreshed when it handles `accept` or
  `joinRoom` for the room, other than a `joinRoom` marked `messageAct`. A client reads a room's current title from the
  room. Membership checks belong to the manager's Home-space handling. A room
  sends
  [`joinRoom`](#joinroomrequestid-string-room-cellchatroomoutput) after a
  successful message or reaction without reading this private catalog.
- **`direct`** holds, for each counterpart principal, the entry of the direct
  room this user shares with them. It has at most one entry per counterpart. It
  keeps a direct room's entry even after the room is forgotten, so the
  conversation with that person is always the same room.
- **`requests`** records each request's outcome under the `requestId` its caller
  chose: `pending`, then `done` or `refused`. `done` carries the entry, except
  for `forget`, whose entry is no longer in `rooms`. `refused` carries a reason,
  prose for a person, and a refusal a client can act on carries a `code` as
  well, which stays the same whatever the reason says. An implementation MAY
  discard a `done` or `refused` outcome after a retention period it documents. A
  request sent again after that starts afresh: an `openDirect` still finds the
  existing room, but a `createGroup` creates another.
- **`outgoingNotices`** holds each notice this user's requests have produced,
  until a client reports it delivered or the room's roster lists a profile
  attesting its recipient, who then needs no telling.
- **`people`** holds the people this user shares a room with: for each
  principal, the profiles attesting it, read from the roster of each room in
  `rooms` (see [`ChatRoomOutput`](ChatRoomOutput.md#facts)) and keyed by each
  profile's own `represents-principal` label, never by what a roster claims
  about it. Each profile is listed once, in the order the rooms list them:
  newest room first, and within a room in its roster's order. So a person's
  first profile is a fixed choice for a given list of rooms. A profile that
  attests no principal, or a DID no principal can have, or one whose label the
  reader can't read, names no one and is left out, and so are this user's own
  profiles. Like a roster, it is a claim, not an access list: a client uses
  it to offer the people to name a new room's members by, through
  `createGroup`'s `profiles`, and a room's add control the people to add, and
  `offerRoom` offers a room through it to a member named by principal alone.

## Streams

Each stream is a one-way, asynchronous request to the manager. Sending an event
finishes when the event is accepted, not when it takes effect, and returns no
value. So every event carries a `requestId` its sender chooses, and the manager
records the outcome under that id in `requests`: `pending`, then `done` or
`refused`. A sender watches for it there. An event a stream does not admit, by
the rules below, is not a request, and records no outcome.

Each stream below is written as a call, with its event's keys as the parameters:
`openDirect(requestId: string, counterpart: string)` sends
`{ requestId, counterpart }`.

These rules hold for every stream:

- A stream that names a reviewed surface admits an event that creates a room
  only as a trusted gesture on that surface (see
  [`clients.md`](clients.md#writing-the-reviewed-gesture-requirement)).
- A request that is interrupted is resumed by sending the same event again with
  the same `requestId`. It never creates a second room.
- An admitted request missing a key its stream needs is refused, with a reason
  that says which, rather than ignored.
- Every stream changes only this user's own manager, except `openDirect` and
  `createGroup`, which also create a room, grant other people access to it, and
  can offer it to the people the request names by profile, and add them to its
  participants, as `openDirect` can for a direct room it finds, and `offerRoom`,
  which can offer a room to the member it names and add them to its
  participants.
  `openDirect`, `createGroup`, `accept` and `joinRoom` also add this user to
  the room's participants, which anyone the room's space admits may do.

| Stream | Reviewed surface | Effect |
| --- | --- | --- |
| [`openDirect`](#opendirectrequestid-string-counterpart-string-profile-cellchatprofile) | `ChatStartSurface` | the direct room with `counterpart`, found or created |
| [`createGroup`](#creategrouprequestid-string-members-string-profiles-cellchatprofile-title-string-joinablebylink-boolean) | `ChatStartSurface` | a new group room |
| [`offerRoom`](#offerroomrequestid-string-room-cellchatroomoutput-member-string-profile-cellchatprofile) | none | a room this user added someone to, offered to them |
| [`accept`](#acceptrequestid-string-room-cellchatroomoutput-counterpart-string-keeparchived-boolean) | none | an entry for a room this user has been admitted to |
| [`joinRoom`](#joinroomrequestid-string-room-cellchatroomoutput) | none | a room this user has joined, made one of their chats |
| [`forget`](#forgetrequestid-string-room-cellchatroomoutput-revision-string) | none | the entry removed from `rooms`; the room itself is untouched |
| [`delivered`](#deliveredrequestid-string-id-string) | none | the notice removed from `outgoingNotices` |

### `openDirect(requestId: string, counterpart: string, profile?: Cell<ChatProfile>)`

- `requestId: string` — Chosen by the sender, and unique among its requests. The
  outcome is recorded under it in `requests`, and sending the same event again
  with it resumes the request rather than starting another.
- `counterpart: string` — The DID of the other person. Must not be this user's
  own.
- `profile?: Cell<ChatProfile>` — The other person's profile, whose
  `represents-principal` label must name `counterpart`. A new room, or a found
  one that was offered them nothing, is offered to them through the share inbox
  it points at (see [offers](#offers)).

Finds the direct room this user shares with a person, or creates it. This is an
outward act when it creates a room, or offers one it finds.

- **Admitted:** as a trusted gesture on `ChatStartSurface` when it creates a
  room. Finding one needs none, and neither does offering a found room to
  `counterpart`: the start that created it, and granted them access, was that
  gesture, as the add that admitted a member is for `offerRoom`.
- **Effect:** if `direct` has an entry for `counterpart`, that entry is the
  outcome, and it is put back in `rooms` if it was forgotten, whatever its
  catalog entry's revision: starting the chat is the person's choice to have it
  listed, so this restore wins over a concurrent forget, from another device,
  say. A room `counterpart` created and offered this user is in `direct` once
  this user's host has accepted it for them (see [offers](#offers)). A found
  room that was offered `counterpart` nothing, since a notice for them of it is
  still in `outgoingNotices`, is offered them through `profile`'s inbox when
  there is one, and `profile` is added to the room's participants, as for a new
  room, and the notice is removed. A room whose roster already lists a profile
  attesting `counterpart` is one they have joined, and is offered nothing; so is
  one whose notice has been delivered. Nor is a room offered, and its notice
  stays, when `requestId` is longer than an offer's `id` may be.
  Otherwise, if a creation for the same `counterpart` is still pending under
  another `requestId`, the manager MUST resume that creation rather than start
  another, and records its outcome under both ids. Otherwise, creates a direct
  room whose members are this user and `counterpart`, grants `counterpart`
  access, offers the room through `profile`'s inbox when there is one and adds
  `profile` to the room's participants, or else produces a notice for them, and
  records the new entry in `rooms` and `direct`; adding this user to the new
  room's participants follows.
- **Outcome:** `done` with the entry, or `refused` if `counterpart` is this
  user, or `profile`'s label doesn't name `counterpart`.

It is the only way a direct room is created, which is what keeps one person's
conversation from splitting.

### `createGroup(requestId: string, members: string[], profiles?: Cell<ChatProfile>[], title: string, joinableByLink?: boolean)`

- `requestId: string` — Chosen by the sender, and unique among its requests. The
  outcome is recorded under it in `requests`, and sending the same event again
  with it resumes the request rather than starting another.
- `members: string[]` — The DIDs of the people to admit besides this user,
  each a principal's. Duplicates, and this user's own DID, are ignored. It may
  be empty, which creates a group room of one, and people can be added later
  from the room's add control.
- `profiles?: Cell<ChatProfile>[]` — The profiles of more people to admit, as
  `people` lists them. Each names the principal its `represents-principal`
  label attests, who is admitted as a member, and the room is offered to them
  through the share inbox the profile points at (see [offers](#offers)). A
  person named by more than one profile is offered the room through each
  distinct inbox those profiles point at, once per inbox, and added to the
  room's participants once. Profiles of two different people must not point at
  the same inbox. This user's own profiles are ignored.
- `title: string` — The room's title, which every member sees. Must not be
  empty.
- `joinableByLink?: boolean` — Whether the room admits anyone who has its
  link. When true, the room's space grants every principal WRITE (the `"*"`
  wildcard) besides its members, so the room's address is all that keeps it
  private: whoever holds it can read and write the room, and joins it, as one
  of their chats, by writing in it. Absent or false, the room admits its members
  alone.

Creates a group room. This is an outward act: it grants other people access.

- **Admitted:** as a trusted gesture on `ChatStartSurface`.
- **Effect:** always creates a new space, with a new room as its root, even
  when another group room has the same members. Grants each member access,
  offers the room to each member `profiles` names and adds their profile to the
  room's participants, produces a notice for each other member, and records the
  entry in `rooms`; adding this user to the new room's participants follows.
- **Outcome:** `done` with the entry, or `refused` if `title` is empty,
  `members` is absent, a member is not a principal's DID, a profile in
  `profiles` attests no principal, or profiles of two different people point
  at the same inbox, with the `code` `shared-inbox`. No setup points one
  person's profile at another's inbox, so the request is refused whole, before
  anything is created, granted, or offered, rather than handing each person an
  offer meant for the other.

### `offerRoom(requestId: string, room: Cell<ChatRoomOutput>, member?: string, profile?: Cell<ChatProfile>)`

- `requestId: string` — Chosen by the sender, and unique among its requests. The
  outcome is recorded under it in `requests`, and sending the same event again
  with it changes nothing further. It is also the offer's `id`, which a share
  inbox keeps one of per sender, so a room's
  [`addMember`](ChatRoomOutput.md#addmemberrequestid-string-target--value-string--profile-cellchatprofile)
  composes it from the room's space and the add's own `requestId`.
- `room: Cell<ChatRoomOutput>` — A link to the room, one this user may add
  people to.
- `member?: string` — The DID of the person to tell of the room.
- `profile?: Cell<ChatProfile>` — The person's profile, whose
  `represents-principal` label must name `member`, or names the person when
  `member` is absent.

Tells someone this user has added to a room of the room. The room's
`addMember` sends it, once it has granted the person access, and reads its
outcome back as the add's `delivery`.

- **Admitted:** without a reviewed gesture: the add that admitted the person
  took one.
- **Effect:** offers the room to the person (see [offers](#offers)): through
  the share inbox `profile` points at, or, with no `profile`, through each
  distinct inbox the profiles `people` lists for `member` point at, once per
  inbox, as this user reads `people`. The first profile the room is offered
  through is added to the room's participants. A person offered nothing, since
  no profile known for them points at an inbox, gets a notice instead. It
  grants nobody anything.
- **Outcome:** `done` with `delivery`, `offered` or `noticed`, and no entry;
  or `refused` if this user's catalog doesn't list the room, the room space's
  access list grants this user a level other than OWNER, the link isn't to a
  group room, as its creator's record would say, `requestId` is longer than an
  offer's `id` may be, `profile` attests no principal or names someone other
  than `member`, `member` is not a principal's DID, or it is this user. An
  access list the run doesn't hold yet, as a served run may not for a room
  created moments before, refuses nothing. `offered` means sent, not received.

### `accept(requestId: string, room: Cell<ChatRoomOutput>, counterpart?: string, keepArchived?: boolean)`

- `requestId: string` — Chosen by the sender, and unique among its requests. The
  outcome is recorded under it in `requests`, and sending the same event again
  with it resumes the request rather than starting another.
- `room: Cell<ChatRoomOutput>` — A link to the room this user has been admitted
  to, from the notice that announced it.
- `counterpart?: string` — For a direct room, the DID of its other member,
  which is the room's creator, as the room's `about.record` is labeled. The
  client MUST have checked that before sending (see
  [`ChatRoomAbout`](ChatRoomAbout.md#who-created-the-room) and
  [`clients.md`](clients.md#finding-conversations)); a notice's claim of who
  sent it is only a hint. Ignored for a group room.
- `keepArchived?: boolean` — Whether an archived entry for the room stays
  archived. An acceptance this user's host makes on their behalf sets it (see
  [offers](#offers)), since it is not the person's choice to have the room
  listed. Absent or false, accepting the room restores an archived entry.

Records a room this user has been admitted to.

- **Admitted:** without a reviewed gesture, since it changes only this user's
  own index, beside adding them to the room's participants, which needs none.
  Whether to add a room to their index is the user's decision (see
  [`clients.md`](clients.md#finding-conversations)), except for a room offered
  to them, which their host accepts for them once it has vetted and registered
  the offer.
- **Effect:** records an entry in `rooms`, putting a forgotten room back
  whatever its catalog entry's revision, unless `keepArchived` is set: accepting
  the room is the person's choice to have it listed, so this restore wins over
  a concurrent forget. With `keepArchived`, an archived entry stays archived,
  and the rest of the effect is the same. For a direct room, the counterpart it
  records is the creator `about.record`'s label names, which it reads itself;
  once the room's space has a member set, it also checks that the counterpart is
  a member. For a direct room, it also records the entry in `direct`, unless
  `direct` already has an entry for `counterpart`, in which case that entry
  stays, as under [crossing creations](#crossing-creations). Adding this
  user's profile to the room's participants follows, when the profile has
  resolved. Without one, the room is recorded all the same, and joins no one:
  an acceptance this user's host makes on their behalf can come before their
  profile resolves, and the room's sender has already joined them to it.
- **Outcome:** `done` with the entry, or `refused` if the request names no
  room, or this user can't read the room, or a container's chat is named
  without its matching declaration, or if the room is direct and its label names no creator, names this
  user, or names someone other than a `counterpart` sent, or, once there are
  member sets, the counterpart isn't a member.

A container's conversation is accepted with `container`, a link to the root
whose `chatRoom` declares the requested room. The manager compares resolved
room identities and records individual membership, leaving the container's
catalog entry alone. A room lacking both a standalone creator record and a
matching declaration is refused with `space-own-chat`.

### `joinRoom(requestId?: string, room: Cell<ChatRoomOutput>)`

- `requestId?: string` — Chosen by the sender, and unique among its requests.
  The outcome is recorded under it in `requests`. Unlike any other stream's, it
  may be absent: a caller that only says the user has joined a room sends none,
  and the manager records the outcome under an id of its own, or, for a room
  this user's chats list already, records nothing.
- `room: Cell<ChatRoomOutput>` — A link to the room this user has joined.
- `container?: Cell<{ chatRoom?: Cell<ChatRoomOutput> }>` — The root declaring
  a container conversation. Its `chatRoom` must resolve to `room`.
- `messageAct?: boolean` — Whether the user joined by sending a message or a
  reaction in the room. A room marks the `joinRoom` it sends with each of
  those; absent, the join came some other way, a retitle or the user opening
  the room among them.

Makes a room this user has joined one of their chats. The caller says what
happened, that the user entered the room, and the manager decides what that
takes. Which act counts as joining a room is the caller's to decide: a room
counts its viewer writing in it (see
[`ChatRoomOutput`](ChatRoomOutput.md#streams)), and a host MAY count the user
opening the room's page.

- **Admitted:** without a reviewed gesture, as for `accept`.
- **Effect:** for a room this user's chats list already, nothing but to bring
  the title its catalog entry holds up to the room's, where the two differ,
  leaving the entry's revision and membership as they are; with `messageAct`,
  which arrives with every message and reaction and none of which changes the
  title, not even that, and the room's `about` goes unread. Otherwise what
  `accept` does with no `counterpart` and without `keepArchived`: records an
  entry in `rooms`, putting a forgotten room back, and adds this user's profile
  to the room's participants once it has resolved. One case differs: a direct
  room this user created, which `accept` refuses, is listed again, and its entry
  in `direct` stays as it is. Sending it again changes nothing, so a caller MAY
  send it each time the user enters the room, without first reading whether
  their chats list it.
- **Outcome:** `done` with the entry, or `refused` for the reasons `accept`
  gives, other than that this user created a direct room. Without a
  `requestId`, a join of a room this user's chats list already records no
  outcome.

### `forget(requestId: string, room: Cell<ChatRoomOutput>, revision: string)`

- `requestId: string` — Chosen by the sender, and unique among its requests. The
  outcome is recorded under it in `requests`, and sending the same event again
  with it resumes the request rather than starting another.
- `room: Cell<ChatRoomOutput>` — A link to a room in this user's list.
- `revision: string` — The room's entry's `revision`, as the list the request
  was made from showed it. A choice about the room made since, by another
  client, is never overridden by one made against an older list.

Removes a room from this user's list.

- **Admitted:** without a reviewed gesture.
- **Effect:** archives the room's individual membership, or its standalone
  catalog entry, which removes it from `rooms`. A container's catalog entry is
  untouched. The opaque revision may name either form of membership; clients
  pass it unchanged. A direct room's entry stays in `direct`, so a later `openDirect` with the same
  person returns the same room. The room, and this user's access to it, are
  untouched.
- **Outcome:** `done`, with no entry, or `refused` if the request names no room
  or no revision, or the room's entry has moved on from `revision`.

### `delivered(requestId: string, id: string)`

- `requestId: string` — Chosen by the sender, and unique among its requests.
  Sending the same event again with it changes nothing further.
- `id: string` — The id of a notice in `outgoingNotices`. An id that isn't there
  is ignored.

Reports that a notice in `outgoingNotices` has been delivered.

- **Admitted:** without a reviewed gesture.
- **Effect:** removes the notice from `outgoingNotices`. It records no outcome
  in `requests`, except `refused` when the request names no notice.

## Creating a room: partial states

Creating a room takes several steps, and a request interrupted between them
leaves a room in between. Until a creation's request is `done`:

- The room can already admit some of its other members, since grants come before
  notices. A member granted before an interruption can use the room, but has no
  notice of it until the request is resumed.
- The room is not yet in `rooms` or `direct`. A new `openDirect` for the same
  counterpart resumes the pending creation, whatever its `requestId` (see
  [`openDirect`](#opendirectrequestid-string-counterpart-string-profile-cellchatprofile)). A
  `createGroup` has no such key, so a client MUST resume an interrupted request
  with its original `requestId`, and SHOULD do so for `openDirect` too.

Resuming the request finishes the grants and notices that remain, and records
the entry. It never creates a second room.

## Delivering notices

A notice has to reach a principal who may share no space with this user. Until a
pattern can deliver one itself (see [first
contact](FabriChatManager.md#first-contact)), the manager lists notices in
`outgoingNotices` and a client delivers them. The list leaves out a notice whose
recipient the room's roster already lists. A notice says which room, and who
sent it: this user. A client MUST deliver only that, and MUST NOT deliver any of
the room's contents. It then sends `delivered` with the notice's `id`.

A notice carries no credential. The recipient already has access through the
grant, so a notice that reaches the wrong person gives them nothing but the
knowledge that a room exists.

A notice is also unauthenticated: it travels by whatever channel a client has,
so its claim of who sent it can be false. A recipient MUST NOT rely on that
claim. Who created a room is what the room's `about` is labeled with (see
[`ChatRoomAbout`](ChatRoomAbout.md#who-created-the-room)), and a client checks a
direct room's `counterpart` against that label before it sends `accept`.

## Offers

When a request names a member's profile, as `openDirect`'s `profile` and
`createGroup`'s `profiles` do, the manager offers the new room to that member
through the share inbox the profile's `inbox` points at
([`private-inbox.md`](../../features/private-inbox.md)), once per distinct
inbox among the member's profiles, after the room is created, and adds the
first profile it offered the room through to the room's participants, through
the room's `addParticipant`, without a step of the member's own. A profile that
points at no inbox is offered nothing. `offerRoom` offers a room someone was
added to the same way, and so does `openDirect` a direct room it finds whose
counterpart has a notice of it still waiting, which the offer replaces. The
offer is the envelope a share inbox takes:

- `kind` — `fabrichat-room`.
- `id` — the request's `requestId`. The inbox keeps one offer per sender and
  `id`.
- `space` — the DID of the room's space. For a group joinable by its link, the
  space's DID is all a principal needs to read and write the room, so an offer
  of one exposes it to whoever can read the inbox it lands in. While server
  execution is off that can be any principal: the inbox's space admits
  everyone, and only an honest runtime keeps to the label on its offers (see
  [the private inbox](../../features/private-inbox.md#what-the-offers-carry)).
- `host` and `ownerOrigin` — the origin of the host serving the manager, which
  serves the room's space too.
- `title` — a group room's title, or empty for a direct room.
- `from` — this user's DID. The inbox keeps the offer only when it names the
  principal sending it.
- `sharedAt` — when the offer was sent, in milliseconds since the epoch.

The recipient's host reads each offer in the inboxes their Home holds, vets it,
and registers the room's space in their Home's shared-space catalog
([`private-inbox.md`](../../features/private-inbox.md#the-share-intake)). When
that registers a new entry, the host then sends the room to the recipient's own
manager's `accept`, with `keepArchived`, so the recipient's manager records the
room as theirs. A direct room goes in their `direct` under its creator, unless
`direct` already holds a room with the sender, which stays, as under [crossing
creations](#crossing-creations); either way their later `openDirect` with the
sender returns the room `direct` holds rather than creating another. An entry
already in the catalog, archived or not, gets no acceptance. A notice is
produced for each other member offered nothing: one known only by their DID,
who has no profile to reach an inbox through, or one whose profile points at no
inbox. A member sent an offer gets no notice, and nothing tells the
sender whether the offer arrived: `offerRoom`'s `offered` means sent.

## Crossing creations

Each user's manager is their own. If two people each `openDirect` to the other
before either's offer or notice arrives, there are two rooms. Each manager
keeps the room it recorded first in `direct`. The other stays in `rooms`, and
can be forgotten. This contract accepts that for now. A deterministic
tie-break, such as the room whose creator's principal sorts first, is future
work.
