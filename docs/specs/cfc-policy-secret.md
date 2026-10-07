# Policy secrets

A module policy can have a secret: a random key the runtime mints once per
space and policy, which no code reads, and under which the `policySecretHash`
builtin computes keyed hashes that it hands to pattern code in the policy's
custody. Pattern code has no other secret source. A lift gets no entropy at
all, and a handler gets only the host's `Math.random`, one stream that every
pattern compartment in a runtime shares
(`packages/runner/src/builder/safe-builtins.ts`). The uses all have one shape:
a decision that turns on a value its observers must not learn, such as a
randomized per-item threshold for releasing an item once enough people
contributed it, noise that cannot be averaged away, or a tie-break. In each,
pattern code needs a value that looks random to everyone and is the same for
every runtime that computes it, and the policy decides what leaves.

The key generalizes the space's SQLite row salt
([06-cfc.md](sqlite-builtin/06-cfc.md)). Both are runtime secrets
(`packages/runner/src/runtime-secret.ts`): one document per space and name in
a reserved namespace that no code writes or reads, labeled with the read-failed
atom, which no ceiling admits, and read by the runtime through
verifier-internal reads that join nothing. The salt's builtin hashes it into
row document ids. The policy secret's builtin hashes it with a pattern's input
and declares the result in the policy's custody, so that the policy's own
exchange rules, rather than the builtin, decide what leaves.

## What the specification decides, and what it does not

The specification has no runtime secret. Everything a hash does once written
is the existing calculus applied to a value whose label holds the policy's
clause:

- **The clause.** A module-policy reference binds its manifest and its subject
  at label creation, and the transaction that persists it installs the
  manifest in the destination (§4.4.1, §4.4.2). The hash's clause is the
  policy's reference with its subject bound to the space the hash is stored
  in.
- **Who reads.** A policy principal is interpreted only at trusted boundary
  points (§3.2), and no access context equals one (§3.1.4), so a clause
  holding only the reference admits no reader until a rule of that policy
  rewrites it. A rule rewrites only its home clause (§4.4.5), so another
  policy's rules never reach it.
- **What releases.** An authored rule needs a non-empty integrity or durable
  policy-state guard (§4.3.6), and every rule of the policy applies to its
  hashes as to anything else under its clause.

What the specification does not decide is the step from the key to the hash.
§2.4 has a derived identifier join the labels of every input it is derived
from; the key's label is not joined, because the key is not data any code
reads, and the builtin declares the policy's clause in its place. That is the
same step the SQLite builtin takes when it hashes the salt into row ids. specs#NN
proposes it as a ruling, together with the reserved store and its lifetime
rules, and this runtime's arrangement waits on that ruling.

## The key

A policy is named by its manifest digest, `policyDigest` (§4.3.6). The digest
is computed over the manifest body, which holds the defining module's identity,
the rule set's export name and the lowered rules, so it identifies all three.
The key for a policy in space `S` is the runtime secret named
`policy:<policyDigest>`, stored in `S` at
`of:runtime-secret:policy:<policyDigest>`.

`IExtendedStorageTransaction.ensureRuntimeSecret()` mints it as it mints the
salt: with the runtime's in-package authorization, 32 bytes from the platform's
CSPRNG, written only when no trusted value is stored, under the schema
`{ type: "string", ifc: { confidentiality: [<read-failed>],
writeAuthorizedBy: ["runtime-secret"] } }`. The runtime mints it under its own
authority, which attributes the value to no principal (§8.15.4, "Attribution
is separate from initialization authority").

The namespace is the runtime's:

- The write chokepoint refuses every write into it but the mint's.
- The read chokepoint refuses every read of it but the runtime's own
  verifier-internal reads. A pattern, a handler, a host read and the CLI read a
  runtime secret through ordinary transaction reads, and each is refused,
  whatever link or id names the document.

A key never changes once a trusted one is stored:

- `ensureRuntimeSecret()` writes only when the stored value is absent or
  untrusted. A value is trusted when its stored schema carries the writer
  claim. A value with no stored schema, or whose stored schema carries no
  claim, is untrusted: it was planted through a runtime without the
  chokepoint, and the mint replaces it.
- A value whose stored schema is named but cannot be resolved, neither in the
  replica nor in the schema registry, is neither trusted nor untrusted, and
  the mint refuses rather than writing over it. A replica can hold a document
  before the schema document its metadata names, and nothing in the commit
  would catch an overwrite: the schema read is not a commit precondition, and
  the value read is of the current version.
- Two runtimes that mint concurrently both read the absence, and the commit
  that lands second conflicts on that read. Its retry finds the stored key and
  writes nothing.

A new policy digest is a new policy and gets a new key. The module identity in
the digest is the content identity of the whole file that defines the rules,
so any edit to that file, a rule or not, draws a new key; so does a change to
how this runtime lowers rules. Hashes computed under the old key keep their old
clause, and the old policy's rules keep governing them. An observer who saw
what the old policy released and then sees what the new one releases has seen
two independent draws over the same data. A policy whose releases must not be
redrawn belongs in a module of its own that holds the rules and the code they
endorse and nothing else, and its rules have to carry forward the outcomes the
old draw already released rather than recompute them.

## `policySecretHash`

A pattern names the policy through the type of the hash it wants:

```ts
// Shown for illustration only.
import { type Confidential, policySecretHash } from "commonfabric";
import { exchangeRules, type PolicyOf } from "commonfabric/cfc";

export const drawRules = exchangeRules([releaseDraw]);
export type DrawHash = Confidential<
  string,
  readonly [PolicyOf<typeof drawRules>]
>;

const hash = policySecretHash<DrawHash>({ input: itemId });
```

The transformer lowers the type argument to the schema it injects into the
call, as it does for `fetchJson<T>()`, and refuses the call without one.
`PolicyOf<typeof drawRules>` lowers to the compiled marker that names the rule
set's module, export name and digest. The builtin refuses, and leaves its result
unset, unless:

- the schema describes a string whose confidentiality is exactly one clause
  holding exactly one compiled module-policy marker;
- the runtime can resolve that policy's manifest, registered or installed in
  the space, under the marker's module and export name;
- the runtime enforces CFC (`enforce-explicit` or `enforce-strict`) and
  persists flow labels. Below either, a declared label is not stored, and the
  hash would be written as public data.

The result is the lowercase hex of the general content hash (`hashOf()` in
`@commonfabric/data-model`, SHA-256 over the canonical encoding) of
`{ policySecretHash: { key, input } }`, with the input as stored. It is the same
for every runtime and every run given the same input, so the lifts that consume
it stay deterministic. Until the key is available the result is `undefined`,
and code consuming it has to decide nothing then.

The builtin writes the result into a store of its own, under the schema
`{ type: "string", ifc: { confidentiality: [<the policy's marker>],
writeAuthorizedBy: ["policySecretHash"] } }`. The store therefore holds the
policy's clause, joined with whatever labels the input carried, since the
builtin reads the input with an ordinary read; and no code other than the
builtin writes it.

When no trusted key is readable, the builtin obtains one before it writes:

1. it syncs the key's document, which brings the schema document its metadata
   names, so that a key another runtime minted is the one found;
2. it mints in a transaction of its own and waits for that commit to settle,
   so that the key the next step reads is confirmed, not a local draw a
   concurrent mint could still reject. Every instance of the builtin on a
   runtime that needs the same key while a mint is in flight waits for that
   mint, and none computes a hash from it before it settles;
3. it computes and writes its result in a further transaction, under its own
   builtin identity.

## How a policy uses it

The policy's endorsed function reads hashes like any other input and computes
its decision. A rule releases the decision because the endorsed function
computed it:

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
    }],
  },
  post: { dropClause: true },
});
```

`dropClause` makes the decision public. A rule that should keep it among the
space's readers adds them as alternatives instead, as `direct-release.tsx` does
for its readers. A guard on the endorsed function's identity
releases whatever that function computes over any input a caller chooses, which
bounds how much a policy can claim; see the next section.

## What this does not cover

The key is outside every gap below but the first: no code reads it, and what
the builtin derives from it is a keyed hash of an input the caller chose. Each
hash is protected as any value under the policy's clause is, and no better.

- **Storage and replicas.** The key is stored in plaintext in the space, as
  every value is: the space's service, every replica of the space, and a
  modified runtime of any member can read it, and a modified runtime can also
  write a key of its choosing under a forged writer claim. The protection is
  the honest runtime's.
- **Chosen inputs.** The builtin hashes any input any code passes it, so any
  code holds the hash of any input it can name, under the policy's clause. An
  endorsed function that compares a hash against a caller-chosen number is an
  oracle for that hash, which is chapter 10's boundary-probing attack; a hash
  of a low-entropy value is a dictionary oracle for the value wherever a rule
  releases hashes themselves. Such a rule needs integrity on its other inputs
  (§3.8.4).
- **Stand-ins.** Code can derive from a hash a value that selects one of two
  outcomes by one bit of the hash, and feed it to the endorsed function in the
  hash's place, which reads the bit from whether the release fired. A rule
  refuses a stand-in only by requiring the provenance of its inputs. This
  runtime's input witness (`cfc-transformed-by-input-witnesses.md`) holds only
  when every confidential input carried the same witness, so a release reading a
  hash and a confidential count written by different code cannot require one;
  the specification's per-input witnesses (§8.7.1, §8.9.3) and per-field input
  requirements (§8.10.3) can, and this runtime does not implement them for lift
  arguments. Until it does, a randomized threshold over a confidential count,
  and noise over a confidential aggregate, are open to stand-ins. The hash
  carries no `TransformedBy` of the builtin for such a requirement to name yet;
  the stamp belongs on the builtin's output, which is recomputed on every run,
  so adding it redraws nothing.
- **Which value a consumer reads.** Pattern wiring decides which hash an
  endorsed function reads, and a public value put in a hash's place is no
  confidential input at all, so no witness refuses it.
- **What every confidential value leaks.** Code that reads a hash can end its
  transaction early, run longer, fail, or write a runtime-owned store whose
  label then rises, depending on the hash; it can log it to the host's console;
  and where the deployment declares no sink ceilings, it can send it. These
  are the gaps every label leaves open in this runtime, and the hashes add
  none.
- **A handler's `Math.random`.** It is unchanged.
