# Gmail push ingest

Gmail push ingest lets a mailbox change wake whatever syncs that mailbox
promptly, without the syncer being reachable from the internet. It replaces
frequent polling of Gmail as the way new mail is noticed; a slower poll stays
as the backstop for a notification that never arrives.

Gmail's `users.watch` publishes to a Cloud Pub/Sub topic when a watched
mailbox changes. A Pub/Sub push subscription delivers each message to
toolshed, and toolshed writes the notification into the cell of every
[ingest channel](self-serve-ingest-channels.md) bound to that mailbox. The
syncer watches that cell and, when it changes, resyncs the mailbox from its
own cursor.

[`gmail-push-architecture.md`](gmail-push-architecture.md) draws the whole
path, across Google, toolshed, and the user's machine, and says who runs each
part of it. This document is the reference for the part toolshed implements.

A notification carries the mailbox's address and its latest history id, and
nothing else: no message, no sender, no subject. So what lands in a user's
space is a signal that something changed, never mail.

## The flow

1. The syncer mints a gmail channel into a space it owns, as
   [self-serve-ingest-channels.md](self-serve-ingest-channels.md) describes,
   naming the cell the notifications are to be written to and carrying a
   proof of the mailbox: a Google access token that reads it, or a Google ID
   token naming it. The mint binds the channel to that mailbox. The cell
   holds only the newest notification; a mailbox needs no history of them,
   and a cell that never grows is one the syncer can watch for as long as it
   runs.
2. It calls Gmail's `users.watch` with that user's token, naming the Pub/Sub
   topic, and repeats the call before the watch expires.
3. When the mailbox changes, Gmail publishes to the topic, and the push
   subscription POSTs the message to
   `/api/spaces/:space/ingest-push/gmail`.
4. Toolshed checks the push token, looks the mailbox up, and writes the
   notification into each live bound channel's cell, unless the cell already
   holds a newer history id.
5. The syncer sees the cell change and runs an incremental sync.

## Routes

### `POST /api/spaces/:space/ingest-push/gmail`

The push endpoint, called by Pub/Sub and by nothing else.

`:space` is the space this deployment keeps its ingest registry in, the
[service space](#the-service-space), and not a user's space. A notification
names a mailbox and nothing else, and which channels that mailbox reaches is
what the registry says, so the registry's space is the one a push can be
addressed to. Whatever dispatches requests by space then sends the push to the
deployment whose bindings it should be read against. A push naming any other
space gets a 404.

The route sits under its own `ingest-push` path segment, apart from the data
plane's `ingest`, where `POST /api/spaces/:space/ingest/:id` would shadow it
and that prefix's wildcard CORS would apply to it.

A request is accepted when its `Authorization` header carries a Google-signed
OIDC token that:

- verifies against Google's published keys, with algorithm `RS256`;
- was issued by `https://accounts.google.com` or `accounts.google.com`, the
  two issuer values Google writes;
- names this deployment's audience, which is the service space's DID unless
  `INGEST_GMAIL_PUSH_AUDIENCE` sets another;
- is signed for one of `INGEST_GMAIL_PUSH_SERVICE_ACCOUNTS`, with
  `email_verified` true;
- has not expired.

The body is the Pub/Sub push envelope. Its `message.data` is base64 JSON
holding `emailAddress` and `historyId`.

Pub/Sub acknowledges a message on any `2xx` and redelivers it otherwise, and
each status is chosen for what Pub/Sub does next:

| Status | When | What Pub/Sub does |
| --- | --- | --- |
| 200 `{ delivered }` | Delivered to `delivered` channels, which is zero for a mailbox nobody bound | Acknowledges |
| 200 `{ delivered: 0 }` | The body is not a Gmail notification | Acknowledges, so the message is not redelivered for as long as the subscription retains it |
| 401 | No token, or one that fails any check above | Redelivers with backoff |
| 404 | Gmail push is not configured, or `:space` is not this deployment's service space; checked before the token | Redelivers with backoff |
| 413 | Body over 16 KB, checked before the token | Redelivers with backoff |
| 502 | Google's keys could not be fetched, or a lookup or a cell write failed | Redelivers with backoff |

A delivery that fails partway through is redelivered in full. That is
harmless: a channel already written carries the notification's history id,
so the redelivery leaves its cell unchanged and wakes nothing, and only the
channels the first attempt did not reach are written.

### Binding a mailbox, on mint

A mailbox is bound by the mint verb of the
[ingest-channel control plane](self-serve-ingest-channels.md), which gains
two optional fields that come together, `target` and `gmail`, and nothing
else. Mint keeps its first-party request proof, its ownership check, its
16 KB body limit, its rate-limit bucket, and its gate on
`INGEST_SELF_SERVE_ENABLED`. A mint carrying the fields answers 400 where
Gmail push is not configured.

```json
{
  "installId": "gmail-1",
  "target": "fcl1:{\"id\":\"of:…\",\"space\":\"did:key:…\",\"path\":[\"inbox\"]}",
  "gmail": { "accessToken": "ya29…" },
  "requestId": "…"
}
```

`target` is a link to the cell the notifications are written to, in the
space the mint is addressed to, in the `fcl1:` wire form a cell link takes
when it leaves the runtime: the document id, the space, and the path, which
`linkRefPayloadToString()` from `@commonfabric/runner/shared` writes and the
mint reads back through `linkRefFrom()`. The id is a document id, and the
link is space-scoped. The caller chooses the cell, and is the one
keeping it from colliding with anything else in the space; two channels
naming one cell write the same cell. It cannot change once the channel
exists, since it is what the syncer watches.

`gmail` holds exactly one of two proofs that the caller holds the mailbox:

- **`accessToken`**, a Google access token that reads the mailbox. Toolshed
  asks Gmail's `users/me/profile` which mailbox the token reads, binds that
  mailbox, and keeps the token nowhere; it is used for that one lookup and
  never stored or logged.
- **`idToken`**, a Google ID token naming the mailbox, which a consent that
  requested the `openid` scope returns beside the access token. Toolshed
  verifies it against Google's published keys for one of the OAuth client
  ids in `INGEST_GMAIL_OAUTH_CLIENT_IDS` and binds the verified address. The
  address has to be one Google is the authority on: a `gmail.com` address,
  or a Workspace address whose domain the token's `hd` claim names. A Google
  account can carry an address at any other domain, and the token's
  `email_verified` says only that Google checked it once, so such an address
  is refused with a 400 that says to use an access token. An ID token grants
  no access to anything, so it is the proof to prefer; with no client ids
  configured, it is refused the same way.

Without either proof, anyone could bind someone else's address to a channel
of their own and learn when that person's mail arrives. Ownership of the
space is checked first, so a caller who does not own it never causes a
request to Google, and a replayed `requestId` is refused before the proof is
checked, so a replay costs no request either.

The two fields together make the channel a gmail channel, written by
toolshed into the target cell, where a mint without them makes a device
channel, written by a device with the token mint returns. One without the
other answers 400, as does a cause prefix beside them, or a proof on a
channel minted as a device channel. The response gains `emailAddress`, the
mailbox bound, and `target`, and carries no device URL or token.

The binding is part of the registration: the registration carries the key
of the mailbox it is bound to, and the mailbox's list of channel ids, which
a push is delivered through, is written in the same transaction, so the two
cannot disagree. A mailbox at its channel limit refuses the whole mint with
a 409, and nothing is written. Minting the same channel again with a proof
for another mailbox moves it; minting it again with no proof leaves the
binding as it is. Revoking a gmail channel takes it out of its mailbox's
list in the revoking write, so it holds no place at the limit, and minting
it again puts it back; there is no unbind. A gmail channel bound to no
mailbox, which a registration written before the key was stored with it may
be, is minted again with a proof, and a proof-less re-mint of one answers
400. Rotate answers 400 for a gmail channel, which has no token to rotate:
minting it again is what re-enables or extends it.

| Status | When |
| --- | --- |
| 200 | Minted and bound |
| 400 | Gmail push is not configured here, a proof without a target or a target without a proof, a cause prefix beside them, a proof on a device channel, a proof-less re-mint of a gmail channel bound to no mailbox, a target in another space, not space-scoped, or not a complete link to a document, a proof Google did not accept, or an ID token where none is accepted |
| 403 | Not an owner of the space |
| 409 | Replayed `requestId`, the channel is another owner's or writes another cause prefix or target cell, this deployment cannot write to the space, or the mailbox is at its channel limit, in which case nothing is minted |
| 422 | The body failed schema validation: two proofs or none in `gmail`, or a malformed `target` |
| 502 | Storage failed, or Google could not be reached |

**Choosing the install id.** The channel id is derived from the space and
the install id, so the same pair names the same channel: a retry, a renewal,
or a reconnect mints it again rather than making another. Choose one stable
id per mailbox subscription within a space, `gmail-personal` and
`gmail-work` say, and never one per attempt. Minting an existing channel
with a proof for a different mailbox moves that channel's binding; two
mailboxes that should both deliver need two install ids, even where their
notifications are meant to land in the same cell. The target is a separate
choice: two channels naming one cell write the same cell, and a caller who
wants notifications kept apart gives each channel its own.

From the command line, `cf ingest mint` takes `--target`, a cell reference
in the channel's space, and `--gmail-access-token` or `--gmail-id-token`,
or, better for a credential, reads `CF_GMAIL_ACCESS_TOKEN` or
`CF_GMAIL_ID_TOKEN` from the environment. It prints the mailbox it bound and
the target as a reference `--target` reads back.

## The cell

A gmail channel's one cell is the `target` its mint named, held in the
registration as the parts of the link: the space, the document id, and the
path. Each delivery replaces what the cell holds with the notification:

```json
{
  "type": "gmail.push",
  "emailAddress": "alice@example.com",
  "historyId": "4242",
  "publishTime": "2026-09-30T12:34:56.789Z"
}
```

`historyId` is a decimal string, since a history id is an unsigned 64-bit
integer and a JSON number that large loses precision. The write carries the
ExternalIngest mark every vouched write carries, and the delivery stamps the
channel's last-seen time.

The cell only ever moves forward. A notification whose history id is not
newer than the one the cell holds is not written: nothing changes in the
cell, no provenance mark is minted, and nothing watching the cell is woken.
So a redelivery, or two deliveries landing on different instances out of
order, cannot set the cursor back, and a reader is woken once per change
however many deliveries carried the same id. History ids order one mailbox's
notifications only, so after a channel is rebound to another mailbox, that
mailbox's first notification replaces the cell whatever its id.

## The service space

Channel registrations and mailbox bindings live in one space, which only this
deployment reads. It is the space `INGEST_SERVICE_SPACE` names, or with that
unset, the space named by the deployment's own identity. A gmail channel's
registration carries the key of its mailbox, a hash of the address, and one
cell per mailbox key lists the channel ids bound to it. The list is the index
a push is delivered through, and the registration is what each listed channel
is checked against: its kind, its liveness, and that its key is still the
mailbox's.

A push is delivered against the bindings of the deployment that receives it,
and a binding is written by the deployment that handled the mint. So
where a space decides which deployment a request reaches, three things have to
land together: the user's space, the registration of the channel that writes
into it, and the service space the push is addressed to. A deployment in that
position names a service space that is dispatched to it.

## Bindings

Bindings live in the service space, beside the channel registrations.
A mailbox's key is a hash of its address, lowercased and trimmed, so no
address appears in a cell id, and neither the address nor the key appears in
a log line.

- A mailbox binds to at most eight channels at once, so several installs of
  one syncer can each have their own. Binding past that answers 409, with
  nothing minted.
- A channel binds to at most one mailbox. Minting it again with a proof for
  another mailbox moves it.
- A proof and a target mint a gmail channel; a proof on a device channel
  answers 400.
- A bound channel that is revoked, expired, or gone is skipped on delivery.
  Revoking is how delivery to a channel is stopped, and the revoking write
  takes the channel out of the mailbox's list, so its place is free at once.
  An expired channel, or one whose registration is gone, keeps its place
  until the next mint that binds that mailbox, which prunes it.

## Setting up the Google side

[`gmail-push-setup.md`](gmail-push-setup.md) has the commands for everything
in this section, and for a deployment Google cannot reach.

Gmail requires the topic to be in the same Google Cloud project as the OAuth
client whose token calls `users.watch`. A deployment whose users sign in
through more than one client needs one topic per client's project; every
topic's push subscription can deliver to the same endpoint.

A topic delivers each message to every subscription on it, and nothing in a
notification says which deployment holds the mailbox's binding. So where more
than one deployment serves the mailboxes behind one topic, each gets a
subscription of its own, addressed to its own service space. Every one of
them receives every notification, and the ones holding no binding for the
mailbox acknowledge it with `delivered: 0`.

For each project:

1. Create a topic, and grant `gmail-api-push@system.gserviceaccount.com` the
   Pub/Sub Publisher role on it.
2. Create a service account for the push subscription to sign as.
3. Create a push subscription on the topic, with the endpoint
   `https://<toolshed>/api/spaces/<service space>/ingest-push/gmail`, OIDC
   authentication as that service account, and the deployment's audience:
   the service space's DID, unless `INGEST_GMAIL_PUSH_AUDIENCE` sets
   another.
4. Add the service account to `INGEST_GMAIL_PUSH_SERVICE_ACCOUNTS`.

The audience has to be set on the subscription. One that names none gets the
endpoint URL as its audience, which toolshed refuses unless
`INGEST_GMAIL_PUSH_AUDIENCE` is set to that URL.

## What the syncer owns

Toolshed delivers notifications; it does not call Gmail on a user's behalf
beyond the one profile lookup at bind time. The syncer holding the user's
token is responsible for:

- **Calling `users.watch`, and renewing it.** A watch expires after seven
  days, and Google recommends renewing daily. Passing `labelIds: ["INBOX"]`
  with `labelFilterBehavior: "include"` limits notifications to inbox changes
  rather than every label and read-state change.
- **Treating a record as a hint.** Compare its history id against the last one
  synced, drop the ones already covered, and coalesce a burst into one sync.
- **Polling as well.** Google does not guarantee delivery: a notification can
  be delayed or dropped, and a sync can fall out of Gmail's history window. A
  slower poll catches both.

## Configuration

Gmail push ingest is on when a service account is set, and off otherwise. Off,
the push endpoint answers 404, and a mint carrying a `gmail` proof answers
400; minting without one is unaffected.

| Var | Notes |
| --- | --- |
| `INGEST_GMAIL_PUSH_SERVICE_ACCOUNTS` | Comma-separated service accounts the push subscriptions sign as. |
| `INGEST_GMAIL_PUSH_AUDIENCE` | The audience the push subscriptions put on their tokens. Unset, it is the service space's DID. |
| `INGEST_GMAIL_OAUTH_CLIENT_IDS` | Comma-separated OAuth client ids whose Google ID tokens a mint accepts as proof of a mailbox. Unset, a mint proves a mailbox with an access token only. |

The default audience is the service space's DID because that DID is already
in the push URL, it differs between deployments, so a token minted for one is
refused by another, and it depends on no hostname, which matters where a
deployment is reached under more than one. A DID is a public identifier, and
an audience is not a secret: what a push token proves rests on Google's
signature and the service account.

Minting at all, with or without a proof, needs `INGEST_SELF_SERVE_ENABLED`,
which mounts the control plane. `INGEST_SERVICE_SPACE`, described in
[CONFIGURATION.md](../development/CONFIGURATION.md#ingest-registry), names
the service space.
