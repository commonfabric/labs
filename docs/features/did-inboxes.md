# DID inboxes

A DID inbox is a private delivery queue at one toolshed host. A recipient opts in
by signing `enable`. Any signing identity can then deliver bounded inert JSON.
The service authenticates the sender, stores the payload and receipt atomically,
and permits only the recipient to list, read, or acknowledge messages. Delivery
changes no space ACL and runs no pattern or message-supplied code.

## API and SDK

`InboxClient` and `InboxError` are exported from `@commonfabric/runner/inbox`.
Construct a client with `{host, signer}`. Host normalization requires an HTTPS
origin, with HTTP allowed for loopback development. Requests refuse redirects
and mutations are never automatically retried.

`GET /api/inbox` advertises version 1 and limits. All other operations use signed
JSON POSTs under `/api/inbox/`:

| Operation | Input | Result |
| --- | --- | --- |
| `enable` | `{}` | `{recipientDid, enabled: true}` |
| `status` | `{recipientDid}` | `{recipientDid, enabled}` |
| `send` | `{recipientDid, operationId, payload}` | `InboxReceipt` |
| `list` | `{cursor?, limit?}` | `{messages, nextCursor}` |
| `get` | `{senderDid, operationId}` | `{message}` |
| `acknowledge` | `{senderDid, operationId}` | `{acknowledged}` |

The SDK uses these shapes except `status`, which takes the recipient DID string.
`list` defaults to 50 messages and permits 1–100. A null `nextCursor` ends the
current page sequence; a subsequent refresh starts without a cursor. Message
arrival can race a page read. `get` retrieves a selected item without depending
on list position. A missing or acknowledged message returns null. Acknowledging
an existing receipt returns true, including a repeated acknowledgment.

An `InboxReceipt` contains `recipientDid`, verified `senderDid`, `operationId`,
`payloadHash`, and `receivedAt` (epoch milliseconds). An `InboxMessage` contains
`receipt` and `payload`. The payload is JSON up to 16 KiB in serialized UTF-8,
with finite numbers and a maximum nesting depth of 64. Link-shaped objects are
stored as inert JSON, never resolved as runtime references.

## Durable identity and limits

The receipt key is `(recipientDid, senderDid, operationId)`. An operation ID is
1–128 ASCII letters, digits, underscores, or hyphens. The same key and canonical
payload return the original immutable receipt. Changed payload returns
`operation-conflict`. Object property order does not change payload identity. JSON wire normalization
precedes hashing: negative zero becomes zero and sparse array holes become null.
Acknowledgment clears the payload while retaining its hash and receipt; a retry
cannot restore the cleared message.

Each recipient has at most 1,000 pending messages, 100 pending messages per
sender, and 100,000 lifetime receipts. Acknowledgment releases pending capacity
but does not release receipt capacity. Existing exact retries remain possible
at capacity. These limits and HTTP request rate limits bound admitted work;
they are not proof that a sender is a person or a contact the recipient knows.

A send to a recipient that has not enabled its inbox returns `not-enabled`.
Other stable refusals are `invalid-request`, `invalid-payload`, `invalid-proof`,
`inbox-full`, `rate-limited`, and `service-error`. The SDK also reports
`invalid-response` and `outcome-unknown`. An uncertain send must retain the
original operation ID and payload for an explicit retry.

## Authority and storage

Request proofs bind method, host, path, body and signer. Enable/list/get/acknowledge
always act as that signer; those requests cannot nominate another recipient.
Send cannot nominate a sender. Status is an authenticated public readiness
query. The inbox routes enable no cross-origin POST policy and are not in the
pattern fetch signer's allowlist: reading a private inbox requires a client
holding the identity, not merely a running pattern.

The serving memory instance owns a separate SQLite inbox database under its
store directory. SQLite transactions atomically check duplicate identity and
capacity before inserting, including across independent connections. WAL and
full synchronization make an acknowledged delivery durable across process
termination. Schema initialization and all writes serialize through
a retained advisory lock file beside the database, waiting for ownership without a
wall-clock deadline. Closing its descriptor releases the lock, and the file remains
so every writer locks the same inode. Database paths resolve filesystem symlinks
before deriving that lock; a new database uses its resolved parent directory.
Dangling database symlinks are refused until their target exists. WAL readers do
not take the write lock. Shutdown
closes the inbox connection. Backups must include this
service-private database and its WAL consistently; ordinary space exports do
not contain inbox messages.

A receipt proves storage acceptance, not recipient reading, external delivery,
or access to a referenced resource. Applications must independently authorize
resource access and retain full reference identity when opening a message.
