# Multi-User Patterns

Use this guide when one pattern instance should behave differently for different
people or browser sessions while still sharing common state.

The core design step is deciding the sharing boundary for each field before
building the UI.

| State kind                                                                | Scope           |
| ------------------------------------------------------------------------- | --------------- |
| shared records, rooms, messages, documents, role registries               | `PerSpace<T>`   |
| profile, display name, personal preferences, durable personal drafts      | `PerUser<T>`    |
| selected tab, selected room, modal state, local filter text, focused item | `PerSession<T>` |

If a value should be visible to everyone in the same space, make it
`PerSpace<T>`. If it should follow the authenticated user across tabs and
sessions, make it `PerUser<T>`. If opening the same piece in a new tab should
start with a fresh value, make it `PerSession<T>`.

Scopes are data-addressing boundaries, not authorization boundaries. Use CFC/IFC
policy for enforcement, trusted writes, and role-protected operations.

## Basic Shape

Prefer object-shaped shared state and scoped writable aliases when handlers need
stable cell handles.

```tsx
// Shown for illustration only.
import {
  Default,
  handler,
  pattern,
  type PerSession,
  type PerSpace,
  type PerUser,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

interface ChatProfile {
  name: string;
}

const DEFAULT_PROFILE = { name: "" } satisfies ChatProfile;
type ProfileCell = Writable<ChatProfile | Default<typeof DEFAULT_PROFILE>>;

interface ChatMessage {
  authorProfile: ProfileCell;
  authorName: string;
  body: string;
  sentAt: number;
}

interface ChatRoom {
  name: string;
  messages: ChatMessage[] | Default<[]>;
}

interface Conversation {
  rooms: ChatRoom[] | Default<[]>;
}

interface SelectedRoom {
  room?: ChatRoom;
}

const DEFAULT_CONVERSATION = { rooms: [] } satisfies Conversation;

type ConversationCell = Writable<
  Conversation | Default<typeof DEFAULT_CONVERSATION>
>;
type SelectedRoomCell = Writable<
  SelectedRoom | Default<Record<PropertyKey, never>>
>;
type DraftCell = Writable<string | Default<"">>;

interface ChatInput {
  profile?: PerUser<ProfileCell>;
  conversation?: PerSpace<ConversationCell>;
  selectedRoom?: PerSession<SelectedRoomCell>;
  draft?: PerUser<DraftCell>;
}

interface ChatOutput {
  [UI]: VNode;
  profile: PerUser<ProfileCell>;
  conversation: PerSpace<ConversationCell>;
  selectedRoom: PerSession<SelectedRoomCell>;
  draft: PerUser<DraftCell>;
}

const sendMessage = handler<void, {
  profile: ProfileCell;
  conversation: ConversationCell;
  selectedRoom: SelectedRoomCell;
  draft: DraftCell;
}>((_, { profile, conversation, selectedRoom, draft }) => {
  const body = draft.get().trim();
  const currentProfile = profile.get();
  if (!body || !currentProfile.name) return;

  const selectedRoomRef = selectedRoom.key("room");
  const roomRef = selectedRoomRef.get()
    ? selectedRoomRef
    : conversation.key("rooms", 0);
  if (!roomRef.get()) return;

  roomRef.key("messages").push({
    authorProfile: profile,
    authorName: currentProfile.name,
    body,
    sentAt: Date.now(),
  });
  draft.set("");
});

export default pattern<ChatInput, ChatOutput>(
  ({ profile, conversation, selectedRoom, draft }) => {
    const send = sendMessage({ profile, conversation, selectedRoom, draft });

    return {
      [UI]: (
        <cf-vstack>
          <cf-input $value={draft} placeholder="Message" />
          <cf-button onClick={send}>Send</cf-button>
        </cf-vstack>
      ),
      profile,
      conversation,
      selectedRoom,
      draft,
    };
  },
);
```

Use a plain data-shaped input style when the pattern should expose a simple API
and only reads values:

```ts
// Shown at module scope.
interface ChatInput {
  profile?: PerUser<ChatProfile | Default<typeof DEFAULT_PROFILE>>;
  conversation?: PerSpace<Conversation | Default<typeof DEFAULT_CONVERSATION>>;
  selectedRoom?: PerSession<SelectedRoom | Default<Record<PropertyKey, never>>>;
}
```

Use scoped `Writable` aliases when handlers need `.get()`, `.set()`, `.push()`,
`.key(...)`, or stable cell references.

## Shared Directories And "Me"

For a shared list of participants, keep the directory in `PerSpace<T>` and keep
each viewer's pointer or profile in `PerUser<T>`.

```tsx
// Shown at module scope.
interface User {
  displayName: string;
}

interface Directory {
  users: User[] | Default<[]>;
}

interface MyUser {
  user?: User;
}

const DEFAULT_DIRECTORY = { users: [] } satisfies Directory;

type DirectoryCell = Writable<Directory | Default<typeof DEFAULT_DIRECTORY>>;
type MyUserCell = Writable<MyUser | Default<Record<PropertyKey, never>>>;

interface DirectoryInput {
  directory?: PerSpace<DirectoryCell>;
  me?: PerUser<MyUserCell>;
}

const joinAs = handler<{ name: string }, {
  directory: DirectoryCell;
  me: MyUserCell;
}>(({ name }, { directory, me }) => {
  const displayName = name.trim();
  if (!displayName) return;

  const users = directory.key("users");
  users.push({ displayName });
  me.set({ user: users.key(users.get().length - 1) });
});
```

This keeps the participant list shared while letting each authenticated user
remember which entry is theirs. For simpler demos where names are immutable and
unique enough for the domain, a `PerUser<string>` display name plus shared
records that carry that name can also be acceptable.

Source identity from the viewer's **shared profile** rather than a free-text
field: `wish({ query: "#profile" })` resolves the current viewer's profile, and
its built-in `[UI]` covers the whole lifecycle (create surface when the user has
no profile, a picker with inline create when they have several). On join, store
a **link to that profile cell** in the shared entry and render every participant
with a live, visitable `<cf-profile-badge $profile={p.profile} />` — cross-space
reads resolve for any authorized viewer (CT-1667/1687), so the badge stays
current, carries the verified-identity seal, and links to each contributor's
profile. Snapshotting the `#profileName` / `#profileAvatar` strings instead is
the self-containment fallback (renders with remote profile spaces offline). See
the [shared-profile roster guide](../../specs/shared-profile-rosters.md);
canonical live-link demo:
`packages/patterns/profile-roster-live-demo.tsx`; worked examples:
`packages/patterns/profile-group-chat/main.tsx`,
`packages/patterns/scrabble/scrabble.tsx`,
`packages/patterns/battleship/multiplayer/lobby.tsx`,
`packages/patterns/lunch-poll/main.tsx`.

**`<cf-profile-badge>` is the one idiomatic way to render an identity** — avatar +
name + the runtime-attested generative seal (a DID-derived aura ring + cursor
glint; there is no shield icon), navigable to the person's profile. Prefer it
anywhere an identity appears (rosters, message authors, "playing as",
scoreboards); inline a name into a string only as an explicit fallback. Four
variants, all carrying the same seal (CT-1761):

A roster written before the space had profiles holds a name and no cell to
bind. Pass that stored name as `fallback-name` rather than branching the render
on whether the row has a profile — a presence test on a cell-typed field reads
truthy when the field is absent, so the branch would take the wrong arm exactly
where it matters. The fallback is untrusted and shows only where no profile
resolved: it never renders beside the seal, and never over a profile that
resolved without a name.


| variant | shows | use for |
| ------- | ----- | ------- |
| `full` (default) | avatar + name pill | roster rows, "playing as" |
| `chip` | name + compact seal dot (no avatar) | inline names in dense UI, participant strips |
| `circle` | avatar + seal ring only (name on hover / for AT) | avatar strips, message gutters |
| `hero` | large avatar over name | profile page header (pair with `noNavigate`) |

Storing a live profile **cell** in shared state is what lets every viewer render
the badge. Keep that shared state **object-wrapped** (`{ items: [...] }`, like the
roster's `Roster` or scrabble's `PlayerRoster`) rather than a bare
`Writable<T[]>`: a bare array with a nested live cell unwraps to a weak object and
breaks CTS handler-state / `.get()`-snapshot output typing. Two rules make it
work (see `scrabble.tsx`): type the **input** value-side — `PerSpace<Roster>`,
not `PerSpace<Writable<Roster>>` (handlers still take `Writable<Roster>` state, so
the body uses field access `players.list` while handlers use `.get()`/`.key()`);
and type the **output** as a profile-less view (`Omit<Player, "profile">`) so the
flat `.get()` snapshot doesn't try to reconcile the live cell. With both, the
whole scrabble scoreboard renders `circle` badges for every player.

Do not store user DIDs, session ids, or generated ids only to simulate scoped
visibility. Let `PerUser<T>` and `PerSession<T>` select the right storage
instance. When comparing object or cell identity, use `equals()` instead of
custom `id` fields.

## Presenting Identity

Choosing scopes decides *where* state lives; this section decides *who* a piece of
state belongs to and how to show them. Do not reinvent identity with dead name
strings — resolve the real viewer and render people with the identity components
([COMPONENTS → Identity components](../components/COMPONENTS.md#identity-components)).

### Resolve the current viewer

An action or handler reads its authenticated actor with `currentPrincipal()`
([Handling Events](../concepts/action.md#who-the-action-acts-for)). A computation
can read the demanding viewer with `viewerPrincipal()`; the result is scoped
per user and carries `User(viewer)` confidentiality. A pattern body cannot read
either identity. See [pattern space membership](../../features/pattern-space-membership.md).
To show the viewer, resolve their profile with `wish` (it reads the active
user's home space):

```tsx
// Shown inside a pattern body.
const profileWish = wish({ query: "#profile" });            // the viewer's profile CELL
const profileNameWish = wish<string>({ query: "#profileName" });
const profileAvatarWish = wish<string>({ query: "#profileAvatar" });
const myName = computed(() => (profileNameWish.result ?? "").trim());
const myAvatar = computed(() => (profileAvatarWish.result ?? "").trim());
const hasProfile = computed(() => (profileNameWish.result ?? "").trim() !== "");
```

**Never** add a "type your name" field and treat that string as the current user.
The viewer is whoever the runtime says they are; `#profile` is how you read it.

### Show every participant with `cf-profile-badge`

```tsx
// Shown for illustration only.
// the viewer — badge bound to their own profile CELL
<cf-profile-badge $profile={profileWish.result} size="sm" />

// everyone else — badge bound to the profile CELL they contributed on join
{roster.items.map((p) => <cf-profile-badge $profile={p.profile} size="xs" />)}
```

`cf-profile-badge` renders **any** participant, not just the viewer: bind the live
profile cell you stored for them on join. Cross-space profile reads resolve for
every authorized viewer (CT-1667/1687), so each badge stays current and carries the
verified seal. Fall back to `<cf-avatar src={p.avatar} name={p.name} />` only when
you deliberately hold just a snapshot — a self-contained piece, or a participant
whose remote profile space is offline.

> ⚠️ **`$profile` must be at a STATIC `[UI]` position** — like every `$`-binding
> (`$value` / `$checked`). Bind it where the JSX is built once; **never inside a
> `{computed(() => …)}` subtree**. There the cell is auto-unwrapped to a plain value
> and the renderer throws *"Bidirectionally bound property $profile is not
> reactive"*, blanking the whole pattern. Build each view as static JSX and switch
> with `ifElse(cond, staticA, staticB)` as a child of a static wrapper; gate only
> *siblings* reactively. Repro: `packages/patterns/scope-bug-computed-vnode-blank/`.

### Build the roster by join

There is no "list everyone's profiles" primitive. Each viewer contributes their
own identity on join: push their live `#profile` **cell** into the shared
`PerSpace` roster (plus a `{ displayName, avatar }` snapshot for the offline
fallback), and keep a `PerUser` pointer that is a **cell reference** to their own
entry (see [Shared Directories And "Me"](#shared-directories-and-me)). Decide "is
this me?" with `equals()` on the stored profile cell (or the entry reference) —
never by comparing the mutable, non-unique display name. The live demo
`packages/patterns/profile-roster-live-demo.tsx` is the reference implementation.

### Ownership and authorship

"Who created this / who wrote this" is identity too. For display, snapshot the
actor's `{ displayName, avatar }`. For an *attested* claim the user cannot forge,
use the CFC wrappers `AuthoredByCurrentUser<T>` / `RepresentsCurrentUser<T>` and
render with `cf-cfc-authorship`. Read-only display works today; note that
owner-protected profile *writes* are currently constrained (see CT-1665).

### Checking a DID read from data

A DID a pattern reads from its data — a member list, a message's author, an
invitation — is only a string, and anything can be written there. Before showing
one to a person or treating it as the principal a record names, ask
`isWellFormedDID()`, exported from `commonfabric`. It returns whether the value is
a DID in DID Core syntax and at most 256 characters long, and narrows it to `DID`
when it is. A longer DID fails it even when its syntax is valid:

```tsx
// Shown inside a pattern body.
const donutFans = new Writable<string[]>([]);

const addFan = action(({ fan }: { fan: unknown }) => {
  if (!isWellFormedDID(fan)) return;
  donutFans.push(fan);
});
```

- It is the same predicate the runtime decides DID syntax with, so do not
  restate the syntax in a pattern.
- It checks syntax alone. A value that passes names no one in particular and says
  nothing about who wrote it; `currentPrincipal()` is what names the acting user.
- It reads nothing but its argument, so it works anywhere: in an action or
  handler, in a `computed()` or `lift()`, and in a pattern body or JSX, where a
  call on a reactive value is lifted like a call to any other function.

### Anti-patterns (do not ship these)

- A "your name" text field used as the current user's identity → resolve `#profile`.
- Deduping a roster by normalized display name → key by cell reference / `equals()`.
- "Is this me?" via `name === myName` → compare the `me` cell reference.
- A person rendered as `{name}` text or a raw `<img>` → `cf-avatar`/`cf-profile-badge`.

### Constraints to design within (today)

- `currentPrincipal()` names the acting user in a handler; `viewerPrincipal()`
  names the demanding viewer in a computation. Neither is available in a
  pattern body. Resolve `#profile` for the viewer's presentation.
- No list-all-profiles — build rosters by join (each viewer contributes their own cell).
- Cross-space profile reads resolve (CT-1667/1687) — badge every participant from
  the profile cell they contributed on join. Snapshot + `cf-avatar` is the
  fallback for self-contained pieces or an offline remote profile space.
- Owner-protected profile *writes* (avatar/elements) are blocked (CT-1665) — a
  pattern that only *displays* identity is unaffected.

### What a spec should capture about identity

Any multi-user spec or design should answer these before build — include them as
an **Identity & Presentation** section in the spec:

1. **Who is the current viewer**, and is it resolved via `#profile` (not typed in)?
2. **How is each person displayed** — `cf-profile-badge` for every participant,
   bound to the profile cell they contributed on join (`cf-avatar` + snapshot only
   as an explicit offline fallback)?
3. **What is shared vs per-user** (`PerSpace` roster/records, `PerUser` "me"
   pointer, `PerSession` form state)?
4. **How is a person identified** for dedup / "is this me" — by cell reference and
   `equals()`, not by display name?
5. **Is any record's ownership/authorship attested** (CFC) or just snapshotted?

## UI State

Default UI-local state to `PerSession<T>`:

- selected room
- selected tab
- open modal
- local filter text
- focused or highlighted item
- one-tab form state that should not follow the user elsewhere

Use `PerUser<T>` only when the value should persist for that user, such as a
profile, durable preference, or draft that should resume in another tab.

For pattern-owned local cells that are not inputs, use scoped constructors:

```ts
// Shown inside a pattern body.
const sharedBoard = new Writable.perSpace(DEFAULT_BOARD);
const displayName = new Writable.perUser("");
const selectedItem = new Writable.perSession<string | null>(null);
```

Plain `new Writable(...)` inherits the containing pattern or factory scope. Use
the scoped constructors when the local cell must have a specific sharing
boundary.

## Authorization And Admin Roles

Scopes decide which data instance a user sees. They do not decide who may write
a protected value.

If a multi-user pattern has admins, moderators, managers, or protected writes:

1. Keep the shared role registry in `PerSpace<T>`.
2. Run one integrity atom through the whole thing: the roles, the roster the
   roles sit in, and the floor on that roster. A second atom for "who may edit
   the roster" makes every roster change after the first one impossible, for
   the reason given below.
3. Define role names, subjects, and the integrity string beside the owning
   pattern.
4. Reuse `packages/patterns/cfc/admin/mod.ts` for the registry shape and lookup
   helpers.
5. Name one reviewed handler in the roster's write contract, and send every
   roster change to it as an event.
6. Keep any per-user switch that reveals the admin controls in `PerUser<T>`,
   and give it no integrity at all. It decides what is on screen. It never
   decides who may write.
7. Check the acting viewer's own role inside the handler, with an empty roster
   as the only opening. Without that check the switch becomes the
   authorization, and any viewer grants themselves admin.
8. Make a role name a profile cell drawn from the pattern's own list of
   people, pinned with `resolveAsCell()`. An event says which row; it never
   supplies the identity.

```ts
// Shown at module scope.
import {
  type ActiveAdminRole,
  adminRegistryEntries,
  type EmptyAdminRegistryValue,
  subjectHasAdminRole,
} from "../cfc/admin/mod.ts";
import {
  type AddIntegrity,
  type Default,
  handler,
  type RequiresIntegrity,
  type Writable,
  type WriteAuthorizedBy,
} from "commonfabric";

const CHAT_ADMIN = "chat-admin" as const;

type ChatAdminRole = ActiveAdminRole<ProfileCell, typeof CHAT_ADMIN>;

// The roster carries three contracts, all naming the same atom.
// `RequiresIntegrity` is the floor: a value landing here has to carry the
// `chat-admin` endorsement, and so does every labeled value read on the way to
// writing it. `AddIntegrity` mints that endorsement on the list itself, which
// is what the floor tests; the endorsement each role carries labels the
// entries and does not reach the list path. `WriteAuthorizedBy` names the one
// handler that may write the roster.
type ChatAdminList = RequiresIntegrity<
  WriteAuthorizedBy<
    AddIntegrity<ChatAdminRole[], readonly [typeof CHAT_ADMIN]>,
    typeof commitChatAdminChange
  >,
  readonly [typeof CHAT_ADMIN]
>;

interface ChatAdminRegistryStoredValue {
  readonly admins?: ChatAdminList;
}
type ChatAdminRegistryValue =
  | ChatAdminRegistryStoredValue
  | Default<EmptyAdminRegistryValue>;
type AdminRegistryCell = Writable<ChatAdminRegistryValue>;

// The switch that reveals the admin controls. Any viewer can turn it on for
// themselves, so it carries no integrity: a self-granted value that claimed
// one would endorse every protected write that consulted it.
type AdminManagerModeCell = Writable<boolean>;

// A row is a name until someone claims it with their own profile. A row with
// no profile can hold no role, because nothing says who it is.
interface ChatParticipant {
  readonly name: string;
  readonly profile?: ProfileCell;
}

const currentUserIsAdmin = (
  registry: AdminRegistryCell,
  profile: ProfileCell,
): boolean =>
  subjectHasAdminRole(adminRegistryEntries(registry), profile);

// Who may change the roster. An empty roster is open, which is what lets the
// first admin exist; after that only an admin may grant one. The per-user
// switch is not part of this answer — it decides whether the controls are on
// screen, and a viewer sets it for themselves.
const actorMayChangeAdmins = (
  registry: AdminRegistryCell,
  actor: ProfileCell,
): boolean =>
  adminRegistryEntries(registry).length === 0 ||
  currentUserIsAdmin(registry, actor);

// The one place the roster is written. Every other part of the pattern reaches
// it by sending an event, so a write from an unreviewed action here, or from
// another pattern holding the registry cell under this schema, is refused by
// the runtime rather than by convention.
const commitChatAdminChange = handler<
  { name: string },
  {
    registry: AdminRegistryCell;
    managerMode: AdminManagerModeCell;
    participants: Writable<ChatParticipant[]>;
    viewerProfile: ProfileCell;
    viewerName: string;
  }
>((
  event,
  { registry, managerMode, participants, viewerProfile, viewerName },
) => {
  if (managerMode.get() !== true) return;
  // Gate on the viewer's resolved name, not on the profile being falsy: an
  // unset optional cell input reads back as a present-but-empty handle, so a
  // falsy test on it never fires.
  if ((viewerName ?? "").trim() === "") return;
  // Pin the terminal cell. A bound alias stored or compared as it stands is
  // "whoever the reader resolves", which is a different person in every
  // runtime.
  const actor = viewerProfile.resolveAsCell();
  if (actor.get() === undefined) return;
  if (!actorMayChangeAdmins(registry, actor)) return;
  // The event says which row to grant to. The identity comes from the row,
  // never from the event, so a role can only name someone the pattern already
  // lists.
  const row = (participants.get() ?? []).findIndex(
    (participant) => participant.name === event.name,
  );
  if (row < 0) return;
  const subject = participants.key(row).key("profile").resolveAsCell();
  const displayName = subject.get()?.name;
  if (!displayName) return;
  const admins: ChatAdminRole[] = adminRegistryEntries(registry);
  if (subjectHasAdminRole(admins, subject)) return;
  registry.key("admins").set([
    ...admins,
    { subject, displayName },
  ] as ChatAdminList);
});
```

Two atoms are the trap here. A floored write may only consume reads that share
a single witness atom for the floor. Deciding whether the acting person may
change the roster means reading the roster, so a floor named on a
`chat-admin-manager` atom over roles that carry `chat-admin` can never be met:
the read carries one atom, the floor demands the other, and nothing carries
both. The first change goes through, because it reads an empty roster and
consumes no labeled read. Every change after that is dropped. The drop is
silent, so a roster that can take one admin and never a second looks exactly
like one that works. A test that changes the roster once cannot tell the
difference. One that changes it twice can.

`packages/patterns/cfc/README.md` gives the full set of rules under "Floor An
Admin Registry", with the failure each one produces when it is broken, and says
what choosing a cell rather than a name as the role's subject costs and saves.

For protected writes that must come from reviewed UI, check the shared CFC
helper docs before copying from a demo:

- `packages/patterns/cfc/README.md`
- `packages/patterns/cfc/INDEX.md`
- `docs/common/ai/cfc-helper-authoring-guide.md`

Shared CFC helpers provide reusable policy structure. The pattern still owns its
domain policy: role names, integrity strings, subjects, trusted surfaces, and
which operations require which integrity.

### The viewer's own access to a space

`spaceAccess(target)` returns what the current principal may do in the space
`target`'s value lives in, as that space's access list grants it: `"OWNER"`,
`"WRITE"`, `"READ"`, or `"none"`. It returns `undefined` when the answer is not
known or not available: the access list has not arrived, the space has no
access list, there is no principal to ask about, or `target` is itself
`undefined`, as a value that cannot be read yet is. Treat `undefined` as "not
known", neither as access nor as "no access". `target` is a cell, and it is
required: to ask about the space the pattern runs in, pass a cell that lives
there.

```tsx
// Shown inside a pattern body.
const board = new Writable.perSpace<string[]>([]);
const canManage = computed(() => spaceAccess(board) === "OWNER");
```

Call it inside `computed()`, `lift()`, or a handler. In a computation the level
is that of whoever is viewing, and each viewer sees their own; in a handler, it
is that of the person who sent the event. Called directly in a pattern body it
throws, because the body builds one graph for every viewer.

It decides what to offer, not what is allowed. A memory server in `enforce`
mode, which is toolshed's default, checks every write against the access list
regardless, and a rule a pattern enforces only by consulting
`spaceAccess(target)` holds among honest runtimes and nowhere else. For a write
that must be refused, use a write policy as described above.
[`space-access.md`](../../features/space-access.md) has the details.

### Granting and revoking access to a space

`grantSpaceAccess(target, principal, level)` sets `principal`'s entry in the
access list of the space `target`'s value lives in to exactly `level`:
`"READ"`, `"WRITE"`, or `"OWNER"`, raising or lowering it.
`revokeSpaceAccess(target, principal)` removes the entry. `target` is a cell in
the space, as for `spaceAccess(target)`.

**A grant exposes everything already in the space.** Adding a member changes
no value's label, so the new member can read what was written before they
were added, not only what comes after. Put data a new member must not see in
another space before granting.

```tsx
// Shown at module scope.
const addMember = handler<
  { member: DID },
  { members: Writable<DID[]> }
>(({ member }, { members }) => {
  grantSpaceAccess(members, member, "WRITE");
  members.addUnique(member);
});
```

Both calls work only in a handler whose event is a trusted gesture, a person's
action on a rendered surface; anywhere else, or for an event without one, they
throw. The person who sent the event must hold `OWNER` in the space, which
may not be their own Home space, and `principal` must be a DID other than
theirs, the space's own, and `"*"`. A change that would leave the space with
no concrete `OWNER` is refused. Every refusal throws. A throw the handler lets
escape drops its whole transaction, so its other writes are dropped too; the
call throws before staging anything, so a handler that catches the throw has
changed nothing for that call.

Granting a level someone already holds, or revoking an entry that is not
there, does nothing, so a handler that runs again for the same event is safe.
The change to the access list commits on its own, just before the handler's
other writes, so if those fail the change still stands; the handler running
again for the same event repairs that.

Both calls throw on a serving runtime for now.
[`space-access-changes.md`](../../features/space-access-changes.md) has the
details.

## Mapping Shared Lists

`map` is the normal way to render shared lists. Pass object references or cell
references through handlers instead of inventing lookup ids.

```ts
// Shown for illustration only.
const roomButtons = conversation.rooms.map((room) => (
  <cf-button onClick={selectRoom({ selectedRoom, room })}>
    {room.name}
  </cf-button>
));
```

For editable nested objects, pass a writable item reference and use `.key(...)`
inside the child pattern or handler.

## Concurrent Edits Without Clobbering

When several users edit the same shared data at once, a handler written as
read-the-whole-value, change it, write it back will lose writes: the runtime
commits optimistically, and the second commit is rejected because its read of
the value predates the other user's edit. Use the **mergeable** write methods so
concurrent edits combine instead of overwriting each other — the commit carries
the operation ("append this", "add if absent", "add this number", "remove
this"), which the server applies against the current durable value:

- Counter shared across users → `count.increment(1)`, not
  `count.set(count.get() + 1)`.
- Set-like shared list → `list.addUnique(item)`, not a read-then-`push`.
- Append to a shared log/roster → `list.push(item)` (already mergeable).
- Delete from a shared list → `list.removeByValue(item)`, not
  `list.set(list.get().filter(...))`.
- Edit one record of a shared list of records → address it by a stable key with
  `list.elementById(key)` and edit its fields directly, instead of finding it by
  index and rewriting the list; manage its membership with `addUnique` /
  `removeByValue`.

A write whose correctness depends on what it first read (for example "join only
if this name is free") is not made safe this way; keep its explicit `.get()` so
it conflicts-and-retries, or use `addUnique` when the condition is uniqueness.
See [Writable → Mergeable writes](../concepts/types-and-schemas/writable.md#mergeable-writes-for-shared-multi-user-state)
for the full method list and the
[mergeable](../../features/mergeable-collection-writes.md) /
[keyed](../../features/keyed-collection-writes.md) collection-write design
notes. The lunch poll (`packages/patterns/lunch-poll/`) is a worked example: its
votes and options are keyed, mergeable, multi-user state.

## Testing Multi-User Behavior

Use pattern tests for deterministic state transitions and browser/integration
tests for identity behavior. A single runtime (or one page that switches
identities) cannot catch cross-user leaks or fails-to-propagate bugs.

Three escalating options:

1. **Multi-user pattern tests (`cf test`)** — the default for pattern
   authors. Export a `multiUserTest({ setup, participants })` descriptor;
   each participant pattern runs in its own isolated runtime against one
   shared space, coordinating via `{ label }` / `{ await }` markers. See the
   "Multi-User Tests" section of `docs/common/ai/pattern-testing-guide.md`
   and the example `packages/patterns/cfc-group-chat-demo/multi-user.test.tsx`.
2. **Multi-runtime integration harness**
   (`packages/patterns/integration/multi-runtime-harness.ts`): opens an
   existing piece in several worker-isolated runtimes (distinct identities,
   or one identity in two sessions); supports trusted-surface CFC events
   headlessly. It serves the authored patterns tree beside its in-process
   storage server, so a `#profile` wish opens the real create surface and a
   pattern whose identity is a profile cell can be driven without a test seam
   standing in for one. See `cfc-group-chat-demo-multi-runtime.test.ts` and
   `profile-create-surface-multi-runtime.test.ts`.
3. **Two simultaneous browsers**
   (`cfc-group-chat-demo-two-browsers.test.ts`,
   `lunch-poll-vote.test.ts`): guards the real DOM input binding /
   event-provenance / login stack. The lunch-poll test casts two users' votes
   on one option concurrently and asserts both survive — the mergeable-write
   payoff through the browser.

Expected visibility:

- `PerSpace<T>` data should be visible to every identity in the same space.
- `PerUser<T>` data should be isolated by active user DID.
- `PerSession<T>` data should be isolated by active user DID and browser/runtime
  session.

When a test is not intentionally multi-user, use one identity everywhere: CLI,
browser, FUSE, and browser-driving agents. When a test is intentionally
multi-user, use separate browser sessions and verify each active DID before
debugging missing data.

See:

- `docs/features/shared-identity.md`
- `docs/common/ai/manual-testing-guide.md`
- `docs/development/debugging/gotchas/scoped-cell-pitfalls.md`

## Good Examples

- `packages/patterns/scoped-group-chat/main-plain-inputs.tsx`: data-shaped
  scoped inputs.
- `packages/patterns/scoped-group-chat/main-with-writable-inputs.tsx`: scoped
  writable aliases for mutation-heavy UI.
- `packages/patterns/scoped-user-directory/`: per-user pointer into a shared
  directory.
- `packages/patterns/battleship/multiplayer/`: shared match state with per-user
  player identity.
- `packages/patterns/cfc-group-chat-demo/`: multi-user chat with CFC-backed
  authorship and admin-protected room creation.
- `packages/patterns/profile-roster-live-demo.tsx`: the canonical identity
  presentation — `#profile` viewer resolution, join stores each participant's live
  profile cell, and **every** member renders with
  `<cf-profile-badge $profile={p.profile}>`. `packages/patterns/scrabble/scrabble.tsx`
  is the worked multi-user example (object-wrapped roster, per-player live badges).
- `packages/patterns/fair-share/`: the snapshot-fallback style — a
  `cf-profile-badge` "You" card with `cf-avatar` for other members (use only when a
  live profile cell is not stored).

## Checklist

- Shared canonical data is `PerSpace<T>`.
- User-owned durable data is `PerUser<T>`.
- Tab/session-local UI state is `PerSession<T>`.
- Handlers use scoped `Writable` aliases when they need stable cell handles.
- The pattern does not store user ids or session ids to fake isolation.
- Object identity uses references and `equals()`, not synthetic ids.
- Concurrently-edited shared collections and counters use the mergeable writes
  (`push` / `addUnique` / `increment` / `removeByValue` / `elementById`), not
  read-modify-write `set`, so simultaneous edits merge instead of clobbering.
- Every participant is rendered with `cf-profile-badge` bound to their profile cell
  (`cf-avatar` + snapshot only as an offline fallback), never a bare name string.
- The current viewer is resolved via `#profile`, not a self-typed name field.
- Rosters are built by join (each viewer contributes their live profile cell); "me"
  is a cell reference, not a name.
- Authorization is modeled with CFC/IFC policy, not scopes.
- `PerAny<T>` is reserved for truly scope-polymorphic inner values.
- Multi-user tests verify the active identity for each browser or CLI session.
