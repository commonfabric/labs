# Policy secrets

A policy secret is a random value the runtime mints into a module policy's
custody: one per space and policy, stored under that policy's clause and
nothing else, so that the only way anything derived from it leaves is through
the policy's own exchange rules. Pattern code has no other secret source. A
lift gets no entropy at all, and a handler gets only the host's `Math.random`,
one stream that every pattern compartment in a runtime shares
(`packages/runner/src/builder/safe-builtins.ts`). The uses all have one shape:
a release that turns on a value its observers must not learn, such as a
randomized per-item threshold for releasing an item once enough people
contributed it, noise that cannot be averaged away, a salt for matching
low-entropy values, or a tie-break nobody can steer. In each, the secret feeds
a computation the policy endorses, and nothing shows the secret itself.

The secret generalizes the space's SQLite row salt
([06-cfc.md](sqlite-builtin/06-cfc.md)), which is confidential to everything
except the builtin that keys row documents with it. Both are runtime secrets
(`packages/runner/src/runtime-secret.ts`) and share the reserved namespace,
the write chokepoint and the writer claim. They differ in label: the salt's
label admits no release, and a policy secret's admits whatever its policy
releases.

## What the specification decides

The specification has no runtime secret; specs#NN proposes the reserved store
and its lifetime rules as a ruling. Everything a policy secret does once
stored is the existing calculus applied to a value whose label is one module
policy clause:

- **The label.** A module-policy reference binds its manifest and its subject
  at label creation, and the transaction that persists it installs the
  manifest in the destination (§4.4.1, §4.4.2). The secret's clause is the
  reference with its subject bound to the space it is stored in.
- **Who reads.** A policy principal is interpreted only at trusted boundary
  points (§3.2), and no access context equals one (§3.1.4), so a clause
  holding only the reference admits no reader until a rule of that policy
  rewrites it. A rule rewrites only its home clause (§4.4.5), so another
  policy's rules never reach it.
- **What releases.** An authored rule needs a non-empty integrity or durable
  policy-state guard (§4.3.6). A value that decides whether a release fires is
  a parameter the release must find integrity on (§3.8.4), and the secret is
  one: see [Provenance](#provenance).
- **The mint.** The runtime writes the secret under its own authority, and
  that authority attributes the value to no principal (§8.15.4, "Attribution
  is separate from initialization authority"): the secret carries no
  current-principal claim, whoever's runtime happened to mint it.

## The secret

A policy is named by its manifest digest, `policyDigest` (§4.3.6). The digest
is computed over the manifest body, which holds the defining module's identity,
the rule set's export name and the lowered rules, so it identifies all three.
The secret for a policy in space `S` is the runtime secret named
`policy:<policyDigest>`, stored in `S` at `of:runtime-secret:policy:<policyDigest>`.

`IExtendedStorageTransaction.ensureRuntimeSecret()` mints it as it mints the
salt. It runs with the runtime's in-package authorization, writes 32 bytes
from the platform's CSPRNG when no trusted value is stored, and records the
secret's schema under the builtin identity `runtime-secret`:

```ts
// Shown for illustration only.
const POLICY_SECRET_SCHEMA = {
  type: "string",
  ifc: {
    confidentiality: [{
      type: "https://commonfabric.org/cfc/atom/Policy",
      policyRefKind: "module",
      moduleIdentity: "<from the manifest>",
      symbol: "<from the manifest>",
      policyDigest: "<the digest>",
      subject: { __ctOwningSpace: true },
    }],
    writeAuthorizedBy: ["runtime-secret"],
  },
};
```

Commit preparation binds the subject placeholder to `S` and installs the
policy's manifest in `S` in the same transaction, as it does for any
`PolicyOf` a schema carries; a runtime that cannot supply the manifest refuses
the commit, and nothing is stored.

A secret never changes once a trusted one is stored:

- The write chokepoint refuses every write into the namespace except the
  mint's, so no executed code writes a secret.
- `ensureRuntimeSecret()` writes only when the stored value is absent or
  untrusted. A value is trusted when its stored schema carries the writer
  claim. A value with no stored schema, or whose stored schema carries no
  claim, is untrusted: it was planted through a runtime without the chokepoint,
  and the mint replaces it. A value whose stored schema is named but not yet
  loaded is neither, and the mint refuses rather than writing over it, so a
  replica that has the secret but not yet its schema document cannot re-roll
  it.
- Two runtimes that mint concurrently both read the absence, and the commit
  that lands second conflicts on that read. Its retry finds the stored secret
  and writes nothing.

A new policy digest is a new policy and gets a new secret. Editing the module
that defines the rules changes its identity and with it the digest, so the
first instance of the edited policy draws a secret independent of the old
one. Data labeled under the old policy keeps its old clause, and the old
policy's rules keep governing it. An observer who saw what the old policy
released and then sees what the new one releases has seen two independent
draws over the same data; where that matters, the release rules have to keep
the old draw's outcomes as the new policy's starting state rather than
recompute them.

## Handing the secret to a pattern

A pattern names the policy through the type of the cell it wants, and the
`policySecret` builtin hands back that cell:

```ts
// Shown for illustration only.
import { type Confidential, policySecret } from "commonfabric";
import { exchangeRules, type PolicyOf } from "commonfabric/cfc";

export const drawRules = exchangeRules([releaseDraw]);
export type DrawSecret = Confidential<
  string,
  readonly [PolicyOf<typeof drawRules>]
>;

const secret = policySecret<DrawSecret>();
```

The transformer lowers the type argument to the schema it injects into the
call, as it does for `fetchJson<T>()`, and `PolicyOf<typeof drawRules>` lowers
to the compiled marker that names the rule set's module, export name and
digest. The builtin requires the schema to describe a string whose
confidentiality is exactly one clause holding exactly one compiled module
policy marker, and requires the runtime to have that policy's manifest
registered under the marker's module and export name. Anything else is an
error, and the result stays unset.

The builtin then:

1. syncs the secret's document, which brings its schema document with it, so
   a secret another runtime minted is the one found;
2. mints the secret in a transaction of its own and waits for that commit to
   settle, so the value the next step reads is confirmed rather than a local
   draw a concurrent mint could still reject;
3. in a second transaction, under its own builtin identity `policySecret`,
   reads the secret with an ordinary read and writes it as its result.

The ordinary read joins the secret's stored clause into that transaction's
flow label, so the result is stored under the policy's clause as well. A read
inside the minting transaction would not: a document's label is stored when
its transaction commits, so a value read where it was minted carries none yet.
That is why the mint and the hand-off are separate transactions, and why the
mint runs only with the runtime's authorization.

The result is unset until the third step commits. Code reading it sees
`undefined` first, and an endorsed function has to release nothing then.

A handle to a policy secret confers nothing. Any pattern may call
`policySecret` for any policy whose manifest the runtime has, and any code may
link to the reserved document. What it reads carries the policy's clause, and
only that policy's rules release anything derived from it.

## Provenance

The result transaction reads one labeled document and writes as one builtin,
so the flow stage stamps the result `TransformedBy{builtin policySecret}`, the
mint every attributed derivation gets
([input witnesses](cfc-transformed-by-input-witnesses.md)). The stored secret
itself carries no stamp: its minting transaction reads nothing labeled. A
transformation by any other code writes a value carrying that code's identity
instead, so the stamp is how a rule tells the secret the runtime handed out
from a value some other code derived from it.

That difference is what §3.8.4 needs. A rule guarded on the endorsed function
alone releases whatever that function computes over any input a caller
chooses, and a caller holding the secret can derive from it a stand-in that
selects one of two outcomes by one bit of the secret, feed the stand-in to the
endorsed function in its place, and read the bit from whether the release
fired. A rule whose guard carries the builtin as an input witness refuses the
stand-in, because the witness holds only when every confidential input the
endorsed function read carried it:

```ts
// Shown for illustration only.
export const releaseDraw = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: {
    integrity: [{
      type: "https://commonfabric.org/cfc/atom/TransformedBy",
      identity: {
        kind: "verified",
        moduleIdentity: THIS_POLICY.moduleIdentity,
        symbol: "drawWinner",
      },
      inputWitness: {
        type: "https://commonfabric.org/cfc/atom/TransformedBy",
        identity: { kind: "builtin", builtinId: "policySecret" },
      },
    }],
  },
  post: { dropClause: true },
});
```

The endorsed function is ordinary deterministic pattern code: given the same
secret and the same inputs, it computes the same output on every runtime and
every run. It derives what it needs from the secret with a keyed hash of its
own; the runtime offers pattern code no hash function.

## What this does not cover

- **Storage and replicas.** The secret is stored in plaintext in the space,
  as every labeled value is: the space's service, every replica of the space,
  and a modified runtime of any member can read it, and a modified runtime can
  forge the writer claim. The protection is the label, enforced by honest
  runtimes. Against an observer outside that tier, a threshold drawn from the
  secret is as good as a public one.
- **Inputs other than the secret.** The witness says the secret was the one
  the runtime handed out. It says nothing about the endorsed function's other
  inputs. A caller who chooses the public ones, such as the item a threshold
  is drawn for or the candidates a tie-break picks among, learns the function's
  output for that choice, which the rule releases. An endorsed function that
  compares the secret against a caller-chosen number is an oracle for the
  secret's threshold, the boundary-probing attack among chapter 10's attack
  examples. Such a rule needs integrity on that input as well (§3.8.4).
- **A second confidential input.** The witness holds only when every
  confidential input carried it. A release that compares a secret threshold
  against a confidential count, written by the policy's own code, reads two
  confidential inputs with two different writers, so no witness holds, and a
  rule requiring one never fires. Requiring each input's own provenance in one
  rule is the declassifier input-integrity question the specification has not
  settled. Until it is, a release of that shape can require the witness on
  neither input, and is open to the stand-in above.
- **What every confidential input leaks.** Code that reads the secret can
  still end its transaction early, run longer, or fail, depending on it, as
  it can on any confidential value. These channels are the ones every label
  leaves open, and the secret adds none.
- **A handler's `Math.random`.** It is unchanged and remains unsuitable for
  any of these uses.
