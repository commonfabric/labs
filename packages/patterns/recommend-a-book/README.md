# Recommend me a book

This is a demonstration with a documented server-to-client confidentiality
limit. Its confidentiality tests configure authenticated, bounded runtime read
ceilings. The normal shell does not configure that ceiling, and the memory
server grants reads through space ACLs without enforcing per-cell labels.
Consequently, a shared-space member using an unbounded client can read private
books; use disposable demonstration data rather than private reading history.
Closing this gap is gated on server-side execution and reader authorization.

This pair demonstrates a personal reading shelf and a recommendation invitation.
Start with `library.tsx`. Its agent uses the reader's Loom context to suggest
books they may have read and authors they may like. The shelf also accepts
manual books and authors. These are suggestions to review, not verified reading
history.

The shelf composes `shared-invitation.tsx`; both live in the same dedicated
space. `main.tsx` remains an independent invitation entrypoint for pieces that
use it. **Ask for recommendations** makes the invitation and its sharing
controls available. The native sharing dialog previews the exact shelf snapshot
and its destination. Confirming publishes that copy to the invitation's shared
library slot; the personal shelf remains a separate `PerUser` value. Grant each
visitor WRITE in the space's Access panel so their private state and agent
requests can run. Because WRITE covers the whole space, use disposable demo
data. Another member with WRITE can replace the published library slot directly.

The invitation shows a few favorite authors and a collapsed list of the
originator's books. The visitor's agent proposes books from that visitor's Loom
context. The invitation then removes titles already on the published shelf and
puts suggestions by favorite authors first. The model receives shelf handles,
not shelf plaintext. Selecting suggestions or entering a book manually prepares
a private selection. The native dialog shows the exact titles and authors and
the verified recipient before the visitor confirms. Private agent explanations
are not included in that selection.

Confirmation creates a separate shared copy. References to its books are
appended by the trusted host to the visitor's `PerUser` recommendation history
and the originator's `PerSpace` inbox in the same transaction. The originator
sees all received recommendations. Other visitors cannot read that inbox,
another visitor's history, or their drafts. Each submitted book is readable by
its sender and the originator.

For a two-person demonstration:

1. In a dedicated demo space, open `library.tsx`, add a book and favorite author
   or run its agent, and click **Ask for recommendations**. Confirm the native
   snapshot preview, then click **Open recommendation invitation**. The shelf
   and invitation stay in that space.
2. In the invitation's Access panel, grant the visitor WRITE and share the
   invitation link. The visitor opens that link under their own identity and
   sees the collapsed shelf and favorite authors.
3. The visitor selects a private suggestion or enters a title and author, clicks
   **Review selected recommendations** or **Review recommendation**, and
   confirms the native preview naming the owner.
4. The visitor sees the book under **Books you have recommended**. When the
   owner opens the invitation, it appears under **Your recommendations**.

## Privacy boundaries

The following boundaries require the bounded host used by the privacy tests;
they are not a server-enforced protection against another space member's client.

Scopes select state; confidentiality labels restrict reads. Fresh private stores
bind `User(CurrentPrincipal)` to their authenticated creator and retain that
identity on later writes. The inbox supports appending references without
reading its existing entries. The invitation's originator descriptor carries a
persisted principal attestation. The published shelf slot has space-wide WRITE
authority, so it does not enforce owner-only updates.

`cf-share-snapshot` is a trusted host component. Its own modal displays the full
JSON snapshot and verified audience and requires a genuine user confirmation.
The runner checks the source, recipient, and consent again when creating the
copy. Consent is single-use. Only the confirming user's own `User` clause can be
widened; other confidentiality clauses must already admit the recipient and are
retained. A copied snapshot does not inherit source integrity endorsements.

The original private cells are not relabeled. The owner/visitor UI branch is a
presentation choice; stored labels enforce who can read the data. This demo does
not claim protection against a malicious host controlling the trusted renderer
or its runtime transport.

A visitor with WRITE access can also write directly to shared invitation state.
An inbox entry alone is not proof that its sender used the review dialog, and
the inbox does not prevent spam or forged unreviewed entries. A raw reference to
an unreleased private draft does not grant the originator read access to that
draft under the bounded runtime. Such an unreadable entry can prevent the
originator's inbox view from rendering until it is removed. Treat the inbox as a
demonstration feed, not as an authenticated submission record.

The owner view uses `cf-owner-view` to compare the runtime's acting principal
with the originator's stored root attestation. Changing the selected `#profile`
does not change ownership. The component chooses the visible branch; the
originator-only inbox label still controls its reads. The invitation waits for a
committed owner check before showing either branch or starting a visitor agent.

## Running and testing

At the start of each visitor agent run, the runner checks the invitation space's
declared ACL as the authenticated requester. A verified reader may observe the
published `Space(invitation)` shelf alongside their own `User(requester)` data.
Literal request clauses can only narrow this host ceiling; they do not prove
membership. A missing or denied ACL leaves the run personal-only. Membership is
not rechecked within an already-running model session, so revoking a reader
takes effect for its next run rather than interrupting that session.

For bounded-host development, run a configured `cf agent runner` for each
participating user's home queue. The `agentBuiltin` flag is on by default. See
the
[agent request demo](../book-recommendations/README.md#run-against-disposable-dev-local)
for disposable server and runner setup. Use a nonzero port offset for local
servers. The existing harness retrieval enforcement limits apply: the default
strict harness mode refuses retrieval by a task in the `context` role. A demo
using Loom retrieval needs the documented explicit override. Fabric clients can
still enforce strict CFC with persisted flow labels.

The current Estuary shell supplies a render ceiling but no runtime-wide read
ceiling. Its native snapshot dialog therefore reports “Snapshot sharing requires
a bounded runtime read ceiling.” The same-space integration test configures that
ceiling and verifies publication. A hosted two-person demo needs a bounded shell
runtime or a pre-published disposable shelf copy before opening the invitation.

For a disposable hosted fixture, find the shared slot's `/of:fid1:…` address and
write a JSON object with `books` and `favoriteAuthors` to its `value` path:

```bash
PUBLISHED_LIBRARY_CELL="$(
  cf cell get --url "$SHELF_URL" --select 'publishedLibrary@' |
    jq -r '.publishedLibrary["$link"]'
)"
cf cell set --api-url "$CF_API_URL" --space "$CF_SPACE" \
  --cell "$PUBLISHED_LIBRARY_CELL" value < shelf.json
cf piece step --url "$SHELF_URL"
```

The first command extracts the slot address from the JSON response. This direct
fixture write is not a native reviewed share; writing through the shelf result
path can carry the private shelf's label into the transaction and fail
writer-fit. Use only disposable book data.

The authored tests exercise manual entry, private selection, rendering, and
selection changes without a live model:

```bash
deno task cf test \
  packages/patterns/recommend-a-book/library.test.tsx \
  packages/patterns/recommend-a-book/main.test.tsx \
  packages/patterns/recommend-a-book/shared-invitation.test.tsx \
  packages/patterns/recommend-a-book/views.test.tsx \
  --cfc-enforcement-mode enforce-strict --cfc-flow-labels persist
```

Attach the matching authored test with `--test` when deploying either entrypoint
with `cf piece new` or `cf piece setsrc`. The integration test exercises the
compiled pair and its runtime state transitions. Its host supplies agent
results; it does not measure recommendation quality or make real Loom calls.

The conditional live integration exercises ACL genesis, the visitor WRITE grant,
a real home queue, the agent runner, a scripted model response, and per-reader
result visibility against a disposable `dev-local` toolshed:

Set `CF_HARNESS_RUNSC_CFC_RESULT_DIR` and
`CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR` to the host directories registered
for `runsc-cfc` in `docker info`. Strict CFC runs refuse to start without both
transports; the paths must match the runtime registration.

```bash
AGENT_DEMO_API_URL=http://localhost:8432 \
  deno test -A packages/patterns/integration/recommend-a-book-agent.test.ts
```

Start `dev-local` with port offset 432 first and stop it afterward. This
scripted model returns fixed suggestions: it verifies request delivery, shelf
filtering and ranking, and result isolation, not that a model consumed the
linked shelf or queried Loom. The supplied shelf is an input handle; a model
that needs its contents must call a tool that accepts the handle and observes
the result's CFC egress policy.
