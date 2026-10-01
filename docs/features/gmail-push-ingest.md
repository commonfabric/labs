# Gmail push ingest

Gmail push ingest lets a mailbox change wake whatever syncs that mailbox
promptly, without the syncer being reachable from the internet. It replaces
frequent polling of Gmail as the way new mail is noticed; a slower poll stays
as the backstop for a notification that never arrives. Gmail's `users.watch` publishes to a Cloud Pub/Sub topic when a
watched mailbox changes. A Pub/Sub push subscription delivers each message to
toolshed, and toolshed appends a record to the journal of every
[ingest channel](self-serve-ingest-channels.md) bound to that mailbox. The
syncer reads its channel's journal and, on a new record, resyncs the mailbox
from its own cursor.

A notification carries the mailbox's address and its latest history id, and
nothing else: no message, no sender, no subject. So what lands in a user's
space is a signal that something changed, never mail.

## The flow

1. The syncer mints an ingest channel for the space it reads from, as
   [self-serve-ingest-channels.md](self-serve-ingest-channels.md) describes.
2. It binds the channel to its mailbox with `gmail-bind`, handing toolshed a
   Google access token that reads the mailbox.
3. It calls Gmail's `users.watch` with that user's token, naming the Pub/Sub
   topic, and repeats the call before the watch expires.
4. When the mailbox changes, Gmail publishes to the topic, and the push
   subscription POSTs the message to `/api/ingest-push/gmail`.
5. Toolshed checks the push token, looks the mailbox up, and appends one
   record to each live bound channel's journal.
6. The syncer sees the new record and runs an incremental sync.

## Routes

### `POST /api/ingest-push/gmail`

The push endpoint, called by Pub/Sub and by nothing else. It sits under its own
prefix, apart from `/api/ingest/*`, where `POST /api/ingest/:id` would shadow
it and the prefix's wildcard CORS would apply to it.

A request is accepted when its `Authorization` header carries a Google-signed
OIDC token that:

- verifies against Google's published keys, with algorithm `RS256`;
- was issued by `https://accounts.google.com`;
- names this deployment's audience, `INGEST_GMAIL_PUSH_AUDIENCE`;
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
| 413 | Body over 16 KB, checked before the token | Redelivers with backoff |
| 502 | Google's keys could not be fetched, or a lookup or append failed | Redelivers with backoff |

An append that fails partway through a delivery is redelivered in full, so a
channel can receive one notification twice. Records carry the history id,
which makes that harmless to a reader.

### `POST /api/ingest-channels/gmail-bind` and `gmail-unbind`

Two verbs on the ingest-channel control plane. They share its first-party
request proof, its 16 KB body limit, and its gate on
`INGEST_SELF_SERVE_ENABLED`, and are gated a second time on Gmail push being
configured.

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
| 403 | Not an owner of the channel's space, or no such channel |
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

`gmail-bind` shares the mint and rotate rate-limit bucket, because each call
costs a request to Gmail. `gmail-unbind` has a bucket of its own, so that it
stays available when binding is throttled and never spends the budget that
revoke relies on.

## The record

Each delivery appends one record to the journal partition named for the UTC
day the message was published, or for the current day when the publish time
does not parse:

```json
{
  "type": "gmail.push",
  "emailAddress": "alice@example.com",
  "historyId": "4242",
  "messageId": "1234567890",
  "publishTime": "2026-09-30T12:34:56.789Z"
}
```

`historyId` is a decimal string, since a history id is an unsigned 64-bit
integer and a JSON number that large loses precision. The record carries the
ExternalIngest mark every journal append carries, and the delivery stamps the
channel's last-seen time.

## Bindings

Bindings live in toolshed's service space, beside the channel registrations.
A mailbox's key is a hash of its address, lowercased and trimmed, so no
address appears in a cell id, and neither the address nor the key appears in
a log line.

- A mailbox binds to at most eight channels at once, so several installs of
  one syncer can each have their own. Binding past that answers 409.
- A channel binds to at most one mailbox. Binding it again moves it.
- A bound channel that is revoked, expired, or gone is skipped on delivery,
  and gives up its place in the mailbox's list at the next bind to that
  mailbox.

## Setting up the Google side

Gmail requires the topic to be in the same Google Cloud project as the OAuth
client whose token calls `users.watch`. A deployment whose users sign in
through more than one client needs one topic per client's project; every
topic's push subscription can deliver to the same endpoint.

For each project:

1. Create a topic, and grant `gmail-api-push@system.gserviceaccount.com` the
   Pub/Sub Publisher role on it.
2. Create a service account for the push subscription to sign as.
3. Create a push subscription on the topic, with the endpoint
   `https://<toolshed>/api/ingest-push/gmail`, OIDC authentication as that
   service account, and an audience.
4. Add the service account to `INGEST_GMAIL_PUSH_SERVICE_ACCOUNTS`. Every
   subscription uses the one audience set in `INGEST_GMAIL_PUSH_AUDIENCE`.

The endpoint URL is the natural audience, and is what Pub/Sub uses when a
subscription names none.

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

Gmail push ingest is on when both of these are set, and off otherwise. Off, the
push endpoint and both control-plane verbs answer 404.

| Var | Notes |
| --- | --- |
| `INGEST_GMAIL_PUSH_AUDIENCE` | The audience the push subscriptions put on their tokens. |
| `INGEST_GMAIL_PUSH_SERVICE_ACCOUNTS` | Comma-separated service accounts the push subscriptions sign as. |

The binding verbs also need `INGEST_SELF_SERVE_ENABLED`, which mounts the
control plane they sit on.
