# Redactor

## Why

People want to ask a language model about something personal: a note to a
landlord, a dispute with a bank, a medical question about a relative. Today that
means pasting real names, numbers and addresses into a model's prompt, or
scrubbing them by hand. The Redactor swaps every personal value for a realistic
stand-in before anything reaches the model, then swaps the originals back into
the reply for the owner alone.

It is also a showcase for Contextual Flow Control. The promise "only the
redacted draft leaves" is kept by the runtime, not by this pattern's good
behavior: the runtime refuses to write the raw draft, or anything else computed
from it, into the model's prompt.

## Using it

1. Optionally store the people and details you care about in the vault (they are
   always replaced, even in forms detection would miss, like "Rivera" on its
   own).
2. Type the draft. The chips show what will be replaced; the second card shows
   exactly what the model will see.
3. **Send to model.** The reply comes back in stand-ins and the third card shows
   it with your originals restored. Asked another model yourself? Copy the
   redacted draft out and paste its reply back in.

Files: `redaction.ts` (pure matching, detection, stand-ins, restore),
`policy.tsx` (the policy and the computations over secret data), `vault.tsx`
(the PII vault, standalone or embedded), `redactor.tsx` (the app).

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

**Who may learn what.** The owner sees everything in their own space. The model
may learn the redacted draft and nothing else.

**What is released, and how.** `redactionRules` holds one exchange rule. It
drops the policy's clause from a value only when the runtime attests
(`TransformedBy`, bound to `policy.tsx`'s content identity) that the exported
lift `redactDraft` alone computed it — the idiom of
`examples/cfc-exchange-rules/blessed-computation.tsx`. The release discloses how
many distinct values of each category the draft held and where they sat, and no
part of any value. Anything detection misses is disclosed as written; the vault
and the "Still visible" check narrow that.

**The sink.** The model's prompt is a `MaxConfidentiality<string, []>` input
(`modelPrompt`), which admits only public values. "Send to model" copies
`redacted` into it; `sendRawDraft` copies the draft and is refused with
`maxConfidentiality failed at /modelPrompt`. `redactor.test.tsx` pins both.

## CFC debt

No corner of the pattern is enforced by ordinary pattern logic in place of CFC.
Two runtime gaps shape it, and one is a workaround:

1. **The model call is not itself a sink.** `generateText`, `generateObject`,
   `llm` and `llmDialog` are `ungatedSink` today
   (`runtime/runner/src/runtime-presets.ts`;
   `docs/plans/cfc-llm-sink-admission.md`: "Nothing is built"). The runtime
   refuses the raw draft at `modelPrompt`, but it would not refuse
   `generateText({ prompt: draft })`. The guarantee therefore rests on
   `generateText`'s prompt being read from `modelPrompt` and nothing else.
   Principled CFC: an LLM prompt is a sink whose ceiling is the provider's
   clearance (public, here), so passing the draft straight to the model is
   refused at the call, and `modelPrompt` becomes a convenience rather than the
   enforcement point.
2. **`draft` has no `Default` (workaround).** A confidential scalar input with a
   schema default makes the piece-start commit refuse to install `modelPrompt`'s
   own `""` default: the setup transaction's machinery reads the labeled
   `/draft` slot (the handle-binding probe in `runtime/runner/src/schema.ts`),
   the write-attempt log is empty at piece start so the `maxConfidentiality`
   gate in `runtime/runner/src/cfc/prepare.ts` measures the constant default
   against every labeled read in the transaction, and initial schema defaults
   are exempt only from writer policies. Array inputs that default to `[]`, as
   in every existing `MaxConfidentiality` demo, never hit it. With no default
   the draft reads as unset until typed in. To be filed as a runtime topic;
   remove the workaround when it is fixed.
3. **Stand-in key in memory.** The key maps stand-ins back to originals and
   stays secret, but it is recomputed from the draft rather than stored, so a
   reply can be restored only while the draft that produced it is unchanged. A
   stored, secret per-send key would let several sends' replies be restored
   later; it needs no new CFC, only a list of secret records.
