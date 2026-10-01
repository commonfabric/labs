# Telling a member of a space about it from a handler

`noticeSpaceAccess(principal, entry)` lets a handler tell someone about a space
they can reach: once the handler's commit is accepted, it sends a message to
`principal`'s [DID inbox](did-inboxes.md) naming the space and a document in
it. It is what a pattern that admits someone uses to let them know, when the
two share no space the person would think to look in. The implementation is
`packages/runner/src/builder/space-access-notice.ts`.

`entry` names the space and the document the way `target` does for
`spaceAccess(target)`, described in [`space-access.md`](space-access.md): a
cell, or a value read through one, after following any links it holds. It must
land at the root of a document in the space's own scope, since the notice names
a document the recipient can open, and a document of one principal's own scope
names nothing another principal can.

## What the message holds

The payload is inert JSON, and holds exactly this:

```json
{
  "type": "space-access-notice",
  "v": 1,
  "space": "did:key:…",
  "entry": "of:…"
}
```

`space` is the space's DID, and `entry` the id of the document `entry` resolved
to. Nothing the pattern chooses reaches the payload beyond which document it
names: no title, no text, no claim about who created the space. The inbox
service records the sender's DID from the request's signature, so the recipient
learns who sent it without the payload saying so.

The recipient trusts none of what the payload says. A sender can put any
payload in an enabled inbox, notice or not, so a notice may name a space the
recipient is not in, or a document that does not exist. What a notice tells the
recipient is only who sent it. Opening the space is what checks the rest: the
memory server admits the recipient or refuses them.

The message discloses to the recipient the space's DID and a document id,
which the space's access list and its documents show them anyway once they open
it, and that the sender told them. The host's operator can read who notifies
whom about which space, in the service-private inbox database; the same host
already holds the access lists. The inbox's public `status` operation says to
anyone whether a DID has an enabled inbox, whether or not anything is sent.

## Who may tell whom

The call acts for the event's actor, `Runtime.actingPrincipalFor()`, the same
principal `currentPrincipal()` returns, and the message is signed as that
actor: on a client runtime the actor is the runtime's own identity, which is
also the identity that signs its requests.

| Refused | Where |
| --- | --- |
| A call anywhere but a handler: a pattern body, a `computed()`, a `lift()` | the call |
| A call on a serving runtime | the call |
| A `principal` that is not a `did:key` DID in DID Core syntax, `"*"` among them | the call |
| An `entry` that is not a cell | the call |
| An `entry` below the root of its document, or in a scope other than the space's | the call |
| An actor without `OWNER` in the space | the send |
| A `principal` without an entry of its own in the space's list | the send |

An inbox addresses only `did:key` principals, so the call refuses a DID of any
other method, which no inbox could deliver to.

An entry for `"*"` does not count as the principal's own: a notice goes only to
a principal the list names. A principal may be told about a space in which they
hold any level.

The two checks on the access list run only at the send, after the handler's
own `grantSpaceAccess()` and `revokeSpaceAccess()` changes and its other writes
have committed, against the list caught up with the memory server. So a
handler can admit someone and tell them in one run, and a principal whose entry
is gone by then is not told. The list checked is that of the space `entry` lives
in, so a grant counts only when its `target` is in that same space.

The call does not check the list. The list this runtime holds may be behind the
memory server's, for instance just after another client granted the principal
access, and a refusal at the call would throw and cost the handler its whole
transaction for the sake of a notice that is best-effort anyway. A notice the
send refuses is dropped, and only the sending runtime's log shows it.

No trusted gesture is required. The call adds no power to send: anyone holding
a key can already put a message in an enabled inbox, within the inbox's limits.
The checks keep a pattern honest about whom it tells, and bound nothing else.
The inbox's per-sender and per-recipient limits, and the recipient's choice to
enable it, are what bound unwanted messages.

## How the message is sent

A refusal at the call throws before anything is staged, so a handler that
catches one sends nothing for that call, and one it lets escape drops the
handler's whole transaction. Only mistakes in the call itself are refused
there: where it runs, and what `principal` and `entry` are.

Otherwise the call stages the send as a post-commit effect on the handler's
transaction. It runs once the memory server accepts the handler's commit, and
never if the commit is refused or the transaction aborted. A handler that runs
again for a conflict stages it again, and only the run that commits sends. A
handler that also changes the space's access list commits that change first,
as [`space-access-changes.md`](space-access-changes.md) describes, so the send
reads a list that holds it.

The message goes to the inbox at the host this runtime's `apiUrl` names, the
host a client of the same deployment reads its own inbox from.

An event sends a principal at most one notice. The inbox operation id is
derived from `eventKey()` and `principal` alone, so every run of one event
sends the same operation id, and the inbox keeps the first message it receives
under one. A later run that sends the same payload gets the first message's
receipt back. A later run whose `entry` resolved to another document, as it
can when a linked cell changes between runs, sends a different payload under
the same operation id, which the inbox refuses as an operation conflict; the
refusal is logged, and the first message stands. A second call for the same
principal in one run stages nothing more.

A second delivery of the same event may be refused at its commit, or, once the
stream has handled the first, admitted again and committed as a new run of the
same event, as [`event-key.md`](event-key.md#re-admission-of-the-same-id)
describes. Either way it sends the same operation id, so the notice stays
single.

Nothing retries a send that fails. A refusal at the send, an inbox that is not
enabled or is full, a network failure, and a tab closed between the commit and
the send all leave the handler's writes committed and the notice unsent. The
failure is logged on the sending runtime and reaches neither the handler nor
the recipient. A notice may therefore not arrive, and a pattern that depends on
one arriving needs another way for the recipient to find the space.

## Serving runtimes

The call throws on a serving runtime. A serving runtime holds no key of the
event's actor, and the inbox authenticates a sender by the signature on the
request, so a notice sent there could name only the service as its sender.

Under server execution a client's run of a handler is speculative, and its
post-commit effects that send anything outside the runtime are dropped in
favor of the serving runtime's run, which throws. So a notice is sent only
where handlers run on the client.

## In a pattern test

A runtime `cf test` builds, for a single-user test and for each participant
of a multi-user one, has an inbox of its own: `FakeInbox`, from
`@commonfabric/runner/fake-inbox.deno`, answers the inbox `send` operation
over an in-memory `InboxStore` as the runtime's `fetch`, at the origin the
runtime's `apiUrl` names. It verifies each request's signature as the toolshed
does, so a message's sender is the identity that signed it, and it refuses what
the store refuses, so two runs of one event still send one message. A notice
is therefore delivered in-process, with no server and nothing logged.

Every recipient counts as having enabled their inbox there. Whether a person
has opened their inbox is a fact about the person, which the pattern under
test cannot know and the test has no way to arrange, so the lane assumes the
answer that lets the pattern's own behavior be checked. The checks on the
access list are not relaxed: a notice to a principal without an entry of their
own, or from an actor without `OWNER`, is refused at the send and logged at
error level, and `cf test` fails a file on an error-level log.

What a run sent is reported to the test pattern as an input,
`spaceAccessNotices: SentSpaceAccessNotice[]`, one record per notice the
inbox accepted, holding `sender`, `recipient`, `space` and `entry`. A send is a
post-commit effect, which only full settlement waits for, so the list is
brought up to date at each `{ settle: true }` step and nowhere else: an
assertion on it follows one. Each participant of a multi-user test is handed
what its own runtime sent, which is a list of notices from that participant's
user. [Pattern testing](../common/workflows/pattern-testing.md#notices-a-handler-sends)
shows a test reading it.

A run against a caller-supplied storage host, which names its own `apiUrl`,
sends its notices to the inbox at that host, as a deployed runtime would.
