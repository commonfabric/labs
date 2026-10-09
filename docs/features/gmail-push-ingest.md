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

1. The syncer mints an ingest channel with the `latest` sink into a space it
   owns, as [self-serve-ingest-channels.md](self-serve-ingest-channels.md)
   describes. A `latest` channel has one cell, which holds only the newest
   notification; a mailbox needs no history of them, and a cell that never
   grows is one the syncer can watch for as long as it runs.
2. It binds the channel to its mailbox with `gmail-bind`, handing toolshed a
   Google access token that reads the mailbox. Only a `latest` channel binds.
3. It calls Gmail's `users.watch` with that user's token, naming the Pub/Sub
   topic, and repeats the call before the watch expires.
4. When the mailbox changes, Gmail publishes to the topic, and the push
   subscription POSTs the message to
   `/api/spaces/:space/ingest-push/gmail`.
5. Toolshed checks the push token, looks the mailbox up, and writes the
   notification into each live bound channel's cell, unless the cell already
   holds a newer history id.
6. The syncer sees the cell change and runs an incremental sync.

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
- was issued by `https://accounts.google.com`;
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

### `POST /api/spaces/:space/ingest-channels/gmail-bind` and `gmail-unbind`

Two verbs on the ingest-channel control plane. They share its first-party
request proof, its 16 KB body limit, and its gate on
`INGEST_SELF_SERVE_ENABLED`, and are gated a second time on Gmail push being
configured. Like the other verbs that take a channel id, they are addressed
to the space the channel writes into, and a channel addressed through any
other space answers as one the caller does not own.

`gmail-bind` takes `{ id, accessToken, requestId }` and returns
`{ id, emailAddress }`.
It binds channel `id` to the mailbox `accessToken` reads, moving the channel
off any mailbox it was bound to before. Two proofs stand behind a binding:

- **The caller owns the channel's space.** The check is the one rotate and
  revoke make, against the space in the stored registration, never a space
  the caller names.
- **The caller holds a token Gmail accepts for the mailbox.** Toolshed asks
  Gmail's `users/me/profile` which mailbox the token reads, and binds that
  mailbox. The token is used for that one lookup and is never stored or
  logged. Without this proof, anyone could bind someone else's address to a
  channel of their own and learn when that person's mail arrives.

Ownership is checked first, so a caller who does not own the channel never
causes a request to Gmail.

`requestId` is a random id the caller generates for each request, as on mint,
rotate and revoke. The proof on a request stays valid for several minutes, so
without it a late duplicate of an earlier bind would move the channel back to
the mailbox that bind named, and a late duplicate of an unbind would clear a
binding made since. The id is recorded in the transaction that writes the
binding, so a second request carrying it answers 409 and changes nothing, and
a request that failed leaves its id free to retry with.

| Status | When |
| --- | --- |
| 200 | Bound |
| 400 | Gmail did not accept the access token, or `requestId` is malformed |
| 401 | Missing or invalid first-party request proof |
| 403 | Not an owner of the channel's space, no such channel, or the channel does not write into `:space` |
| 409 | `requestId` was already used, the channel is revoked or expired, the mailbox is at its limit, the binding changed concurrently, or this deployment cannot write to the space |
| 413 | Body over 16 KB, checked before the proof |
| 422 | Body failed schema validation, checked after the proof |
| 429 | Rate limited, or the caller has too many recent request ids on record |
| 502 | Storage failed, or the Gmail lookup failed |

`gmail-unbind` takes `{ id, requestId }` and returns `{ id, unbound }`, where
`unbound` says whether the channel was bound to anything. It needs only
ownership, and works on a revoked channel, so a retired channel can still be
cleared. It answers with the same statuses as `gmail-bind`, except that its
400 is only for a malformed `requestId`. A caller answered 429 for too many
recent request ids can still stop delivery at once by revoking the channel,
since a revoked channel is skipped.

From the command line, `cf ingest gmail-bind <id>` binds a channel, reading
the access token from `--gmail-access-token` or, better for a credential, from
the `CF_GMAIL_ACCESS_TOKEN` environment variable. `cf ingest gmail-unbind <id>`
removes the binding. Each sends a fresh `requestId` for you, and addresses the
channel's space, which it looks up among the channels you minted unless
`--space` names it.

`gmail-bind` shares the mint and rotate rate-limit bucket, because each call
costs a request to Gmail. `gmail-unbind` has a bucket of its own, so that it
stays available when binding is throttled and never spends the budget that
revoke relies on.

## The cell

A `latest` channel's one cell has the cause the channel's `causePrefix`
names, in the channel's space. Each delivery replaces what the cell holds
with the notification:

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
unset, the space named by the deployment's own identity.

A push is delivered against the bindings of the deployment that receives it,
and a binding is written by the deployment that handled the `gmail-bind`. So
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
  one syncer can each have their own. Binding past that answers 409.
- A channel binds to at most one mailbox. Binding it again moves it.
- Only a `latest` channel binds; binding a journal answers 409.
- A bound channel that is revoked, expired, or gone is skipped on delivery,
  and gives up its place in the mailbox's list at the next bind to that
  mailbox.

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
the push endpoint and both control-plane verbs answer 404.

| Var | Notes |
| --- | --- |
| `INGEST_GMAIL_PUSH_SERVICE_ACCOUNTS` | Comma-separated service accounts the push subscriptions sign as. |
| `INGEST_GMAIL_PUSH_AUDIENCE` | The audience the push subscriptions put on their tokens. Unset, it is the service space's DID. |

The default audience is the service space's DID because that DID is already
in the push URL, it differs between deployments, so a token minted for one is
refused by another, and it depends on no hostname, which matters where a
deployment is reached under more than one. A DID is a public identifier, and
an audience is not a secret: what a push token proves rests on Google's
signature and the service account.

The binding verbs also need `INGEST_SELF_SERVE_ENABLED`, which mounts the
control plane they sit on. `INGEST_SERVICE_SPACE`, described in
[CONFIGURATION.md](../development/CONFIGURATION.md#ingest-registry), names
the service space.
