# Saying what a Contextual Flow Control gate turned away

Contextual Flow Control decides, twice, whether something may proceed. The
write gate decides whether a transaction may commit: the rules live in
`packages/runner/src/cfc/prepare.ts`, which produces the prepare reasons, and
`packages/runner/src/storage/extended-storage-transaction.ts` acts on them and
reports. The render gate in the worker reconciler,
`packages/html/src/worker/reconciler.ts`, decides whether a piece of content
may reach the document. Both fail closed.

A refusal shows up as a write that does not land or interface that is not
there, which points at the scheduler and the renderer. Neither made the
decision, so each gate says what it turned away at the moment it decides.

## The reporter

`packages/runner/src/cfc/denial-report.ts` holds the reporter, and both gates
call it where they block:

```ts
// docs-context: none
declare const reportCfcDenial: (
  code: string,
  summary: string,
  inputs: () => Record<string, unknown>,
) => void;

reportCfcDenial(
  "render-confidentiality-ceiling",
  "the render policy did not admit a cell's confidentiality label",
  () => ({ labelSource: "stored", ceiling: [] }),
);
```

`code` names the kind of decision, and is one of `CFC_DENIAL_CODES`:
`write-policy-gate`, `write-prepare-crashed`, `write-unprepared`,
`write-prepared-digest-mismatch`, `render-confidentiality-ceiling`,
`render-text-integrity`, and `render-literal-text-integrity`.

Only a decision that stopped something reports. Under `observe` the write gate
records its reasons and lets the commit through, so nothing was turned away and
nothing is reported; those reasons stay on the transaction's diagnostics,
reachable through `getCfcState()`. Under `disabled` the gate does not prepare at
all, so there are no reasons and nothing to read.

The write gate reports where prepare records its reasons, which is the point
the decision is made: an enforcing transaction can no longer commit, whether or
not it goes on to try. A refusal that only becomes one at commit, because a
later invalidation added a reason prepare never saw, is reported at commit.

## What may be said out loud

The **summary** is a fixed sentence chosen by the kind of decision. It carries
nothing assembled from a reason, a label, a value, or a path, and it goes to
the `cfc` logger at warning level.

The **inputs** are different, and they are where everything specific lives. A
confidentiality-ceiling denial's inputs name the label of content this viewer
was not cleared to see, and a label gives away the thing it protects:
`Space(the-acquisition-of-Acme)` is the secret, not a description of it. The
two text-integrity denials read the boundary's integrity floor rather than a
confidentiality label, and the literal-text one has no cell to read a label
from at all. A write denial's inputs carry the prepare reasons, and a prepare
reason may name the confidentiality atoms it refused over, rendered as JSON —
the sink-ceiling and writer-fit reasons both do. So the inputs go only to
debug and to a denial listener (below), and they are passed as a function so a
gate builds them only where something takes them.

Where a label is read, `labelSource` says where from: `stored` for the cell's
own label, `schema` for the information-flow constraint the gate falls back to,
and `unreadable` when reading it threw, which is the case the gate blocks on
without ever seeing a label.

A refused commit's message still quotes its first prepare reason. That message
is a value returned to the caller that asked for the commit; the log is read by
whoever holds the console, which in a worker is the page whose content the gate
scrubbed and on a server is a file spanning every space it serves.

Nothing else travels. The placeholder carries `data-cfc-blocked` and
`data-cfc-blocked-reason`. A prop feeding one of the text-integrity sinks is
turned away a third way — its value is replaced and the node is stamped
`data-cfc-blocked-props` naming the prop — and the report names that prop in
its inputs.

No identifier ties a report to the surface it explains. Reports are addressed
by their content, so an identifier stable enough to look one up is a function
of the decision: two placeholders sharing one would establish that the two
withheld things carry the same label, and across a list such identifiers would
partition withheld content by the principal protecting it.

## How often a gate reports

Both gates re-decide as often as their inputs change. The reconciler decides
again on each reactive update to a blocked cell and on each membership change
in a space it is labeled with; the write gate decides again on each retried
commit. Every one of those decisions reaches debug.

A summary is announced once per `code`. It has to be: the summary is a fixed
sentence, so a second one is the same line of text and carries nothing the
first did not. The repeats are its count — `code` is the logger's message key,
so `commonfabric.logger["cfc"].countsByKey` carries the per-kind totals and
`logCountEvery` emits a periodic summary. That is where to look to tell a write
refused once at startup from a write refused on every tick of a retry loop.

`resetCfcDenialAnnouncements()` forgets which codes have been announced; the
next denial of each announces again.

## Reading a denial

```text
[WARN][cfc::14:22:07.913] write-policy-gate a policy check refused the commit
```

That is the default, and it is the whole of it: which kind of decision, and
that it happened. For the reasons, the labels, and the dials behind it, raise
the `cfc` logger to debug and reproduce; the inputs ride the same key. In a
pattern test, `cf test --cfc-denials` prints every denial with its inputs, laid
out for reading, without raising any logger.

## Listening for denials

`addCfcDenialListener()` registers a function that is told of every denial from
then on — repeats included, with the inputs built — and returns the function
that unregisters it. It is how `cf test --cfc-denials` prints them. A listener
sees exactly what debug does, labels included, so only a diagnostic tool the
user asked for registers one. Registration is per module instance, so it
reaches the gates running in the same process or worker and no others.

## Adding a denial

A new gate decision that turns something away should report one.

The `code` is what a search, the logger's per-key counts, the once-per-kind
warning, and `cf test`'s hint to run again with `--cfc-denials` all match on,
so it is stable and names the kind of decision rather than the occasion. A new
one joins `CFC_DENIAL_CODES`, since `reportCfcDenial()` takes no other. The
`summary` is written without being asked for, so it is a fixed sentence: text
chosen by the kind of decision, never assembled from a reason, a label, a
value, or a path.

The inputs may name labels, policies, and values freely, because they reach
only debug and a denial listener. Nothing derived from them may reach the
surface the denial produced.

Report the decision's inputs rather than a conclusion drawn from them. Which
input decided is the gate's business, and a gate reads them together: the
render gate admits a clause outside the ceiling when an author declassification
or an admitted caveat kind covers it, it blocks the ungrantable read-failure
marker with no ceiling in force at all, and with an exchange resolver wired it
decides on a rewritten label. A field naming the offending clauses is a second
reading of all that, and it answers differently from the gate.
