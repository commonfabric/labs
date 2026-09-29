---
status: historical
created: 2026-09-29
archived: 2026-09-29
reason: "Decision record for replacing the FabriChat example with the specified room and manager protocol."
---

# FabriChat protocol replacement

Dan requested implementation of the full `docs/specs/fabrichat` system,
replacing `packages/patterns/fabrichat`, with implementation decisions made by
the agent and recorded in its summary. This change deliberately replaces the
example's input and output contract. The entry point now exposes `room`, whose
message list, reviewed writers, activity, and membership conform to the new
protocol. Its own state is created by a reviewed Start conversation gesture.

The twelve recorded contracts of `fabrichat/main.tsx` exposed `messages`
directly and accepted the example's inputs. Their replacement is accepted only
at `argument` and `result.messages`, the paths named by the compatibility gate.
The old contract files remain as evidence; the new baseline has no exemption.
Home's required contract remains backward compatible.

No migration of old example message storage is included. Existing pieces must
retain their old source to keep the old presentation, or start a new room with
the replacement. Applying the replacement to an old piece does not translate
its old messages into protocol records; no message author labels are invented.
This is the implementation decision taken under the request to replace the
example, rather than an assertion that deployed old state was migrated.
