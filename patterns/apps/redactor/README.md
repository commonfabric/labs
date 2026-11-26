# Redactor

## Why

People want to ask a language model about something personal: a note to a
landlord, a dispute with a bank, a medical question about a relative. Today that
means pasting real names, numbers and addresses into a model's prompt, or
scrubbing them by hand. The Redactor swaps every personal value for a realistic
stand-in before anything reaches the model, then swaps the originals back into
the reply for the owner alone.

It is also a showcase for Contextual Flow Control. The runtime, not this
pattern's good behavior, refuses to write the raw draft, or anything else
computed from it, into `modelPrompt`, the public store the model's prompt is
read from; only the redacted draft may be written there. The model call itself
is not yet a gated sink, so that promise also rests on the prompt being read
from `modelPrompt` alone (CFC debt 2).

## Using it

1. Optionally store the people and details you care about in the vault (they are
   always replaced, even in forms detection would miss, like "Rivera" on its
   own).
2. Type the draft. The chips show what will be replaced; the second card shows
   exactly what the model will see. (In the live browser these two derived views
   do not render yet, a runtime issue tracked as top/3113; the pattern computes
   them correctly and its tests check them.)
3. **Send to model.** The reply comes back in stand-ins and the third card shows
   it with your originals restored. Asked another model yourself? Copy the
   redacted draft out and paste its reply back in.

Files: `redaction.ts` (pure matching, detection, stand-ins, restore),
`policy.tsx` (the policy and the computations over secret data), `main.tsx` (the
PII vault, standalone or embedded), `redactor.tsx` (the app).

Ported from jkomoros/community-patterns `redactor.tsx` and
`simple-pii-vault.tsx`. Changes: the model call is built in (the original relied
on copy and paste), stand-ins are deterministic and never collide with a value
already in the draft, a name's parts map to the parts of its stand-in ("Rivera"
→ "Brown" when "Jordan Rivera" → "Bob Brown"), and restoring replaces whole
words only.

## CFC design

**What is secret.** Every vault entry and the draft. Both are
`Confidential<…, [PolicyOf<typeof redactionRules>]>` (`Secret<T>` in
`policy.tsx`), so everything computed from them carries that clause: the
detections, the stand-in key, the restored reply.

**Who may learn what.** Readers of the space that holds the data, which in a
personal space is the owner, may see all of it: `releaseToSpaceReader` adds them
as an alternative, so the owner's display may render it (values derived from the
secrets, like the chips and the redacted preview, do not render in the live
browser yet: top/3113). That makes it readable by those users, not public, so it
still cannot be written to a public store. The model may learn the redacted
draft and nothing else.

**What is released to the model, and how.** `releaseRedactedDraft` drops the
policy's clause from a value only when the runtime attests (`TransformedBy`,
bound to `policy.tsx`'s content identity) that the exported lift `redactDraft`
alone computed it — the idiom of
`patterns/examples/cfc-exchange-rules/blessed-computation.tsx`. Format detection
always runs inside `redactDraft`, so no caller can switch it off. The release
discloses how many distinct values of each category the draft held and where
they sat. A stand-in is chosen only against text that stays visible and other
stand-ins, never against a hidden value, so it carries no hint of one, and a
vault entry the draft never mentions changes nothing (`redaction.test.ts` pins
both).

**The sink.** The model's prompt is a `MaxConfidentiality<string, []>` input
(`modelPrompt`), which admits only public values. "Send to model" copies
`redacted` into it; `sendRawDraft` copies the draft and is refused with
`maxConfidentiality failed at /modelPrompt`. `redactor.test.tsx` pins both,
before any send and after one (the raw send cannot overwrite what was sent).
Sending also keeps the stand-in key (secret) beside the reply, in a separate
event: a transaction that reads the secret key may not also write the public
prompt.

**Scope.** The inputs carry no scope wrapper, so they live at the piece's own
scope: everyone with access to the space sees the vault and the draft, which
matches the reader rule above. Keep a redactor in a personal space; a shared,
per-user vault would want `PerUser` and is not attempted here.

## CFC debt

No corner of the pattern is enforced by ordinary pattern logic in place of CFC.
Five gaps shape it:

1. **The release trusts a caller-supplied vault.**
   `redactDraft({ draft,
   vault })` releases whatever it computes, and the
   caller picks the vault. A pattern holding a draft under this policy can pass
   an empty vault, and a name the format detectors cannot recognize is then
   released as written. Principled CFC would bind that argument by provenance:
   release only when `vault` is this owner's labeled vault (an input-witness or
   argument-provenance condition on the rule, in the spirit of `inputWitness` in
   `patterns/examples/cfc-exchange-rules/witnessed-chain.tsx`). This is the
   semantic to raise with Berni.
2. **The model call is not itself a sink.** `generateText`, `generateObject`,
   `llm` and `llmDialog` are `ungatedSink` today
   (`runtime/runner/src/runtime-presets.ts`;
   `docs/plans/cfc-llm-sink-admission.md`: "Nothing is built"). The runtime
   refuses the raw draft at `modelPrompt`, but it would not refuse
   `generateText({ prompt: draft })`. The guarantee therefore rests on
   `generateText`'s prompt being read from `modelPrompt` and nothing else.
   Principled CFC: an LLM prompt is a sink whose ceiling is the provider's
   clearance (public, here), so the call itself refuses the draft.
3. **Scalar secrets with a value break piece start (workaround).** A
   confidential scalar holding a value at piece start makes the runtime refuse
   to install `modelPrompt`'s own `""` default: the setup transaction's
   machinery reads the labeled slot (the handle-binding probe in
   `runtime/runner/src/schema.ts`), the write-attempt log is empty at piece
   start so the `maxConfidentiality` gate in `runtime/runner/src/cfc/prepare.ts`
   measures the constant default against every labeled read in the transaction,
   and initial schema defaults are exempt only from writer policies. Lists that
   start empty never hit it, which is why every existing `MaxConfidentiality`
   demo works. Consequences here: `draft` has no `Default`, and an unset secret
   cannot be typed into: the owner's display fits a cell that holds nothing by
   its schema's label alone, which no exchange rule rewrites, so it refuses the
   read, and a bound input whose read is refused writes nothing. Focusing the
   textarea therefore sets an unset draft to `""` through a handler
   (`startDraft`), after which the draft carries a stored label the reader rule
   admits. A caller cannot pass a prefilled draft (a "redact this note" launcher
   fails to start); the vault's in-progress entry field is a plain per-session
   cell rather than `Secret`; and the sent key is a list of secret items. To be
   filed as a runtime topic; remove the workarounds when it is fixed.
4. **A pasted reply uses the current key.** A reply from the model is restored
   with the key kept when it was sent. A pasted reply is restored with the
   current draft's key, so editing the draft before pasting can mis-restore. A
   per-copy key would need the copy button to run a handler.

5. **Only the first send lands (runtime bug).** A public store that once took an
   exchange-rule release refuses every later write, even a constant (top/2502:
   the release persists the pre-exchange label at the destination, and the next
   write's destination probe consumes it). So after the first "Send to model",
   later sends are refused with `maxConfidentiality failed at /modelPrompt`;
   appending each send to a list of public prompts is refused too. Workaround
   until it is fixed: start a new redactor per question. The access-time idiom
   top/2502 suggests (hand the lift's output straight to the model) would work,
   but only because model calls are ungated (debt 2), so it would drop the one
   refusal this pattern exists to show.

## The leak check

"Still visible" runs a deliberately looser matcher than redaction over the
redacted draft, with the stand-ins removed: any word of a found value (case and
accents folded) and any run of four of its digits. It catches what whole-value
matching missed in forms like "Garcia" for a vault entry "José García" written
differently, but it can only check values that were found; a name that is in
neither the vault nor a detectable format cannot be checked.
