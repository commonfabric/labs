# Policy secrets

A module policy can have a key: a random value the runtime mints once per space
and policy, stores under that policy's clause, and lets no code read. The
`policySecretHash` builtin computes keyed hashes under it and hands them to
pattern code, still under the policy's clause, so that only the policy's own
exchange rules release anything computed from them.

Pattern code has no other secret source. A lift gets no entropy at all, and a
handler gets only the host's `Math.random`, one stream that every pattern
compartment in a runtime shares (`packages/runner/src/builder/safe-builtins.ts`).
The uses all have one shape: a decision that turns on a value its observers must
not learn, such as a randomized per-item threshold for releasing an item once
enough people contributed it, noise that cannot be averaged away, or a
tie-break. In each, pattern code needs a value that looks random to everyone and
is the same for every runtime that computes it, and the policy decides what
leaves.

The key generalizes the space's SQLite row salt
([06-cfc.md](sqlite-builtin/06-cfc.md)). Both are runtime secrets
(`packages/runner/src/runtime-secret.ts`): one document per space and name in a
reserved namespace no code writes or reads, minted by the runtime, trusted only
under the runtime's writer claim. They differ in what the runtime derives from
them. The salt is stored under the read-failed atom and read verifier-
internally, so the row ids the SQLite builtin hashes it into carry none of its
label. A policy's key is stored under the policy's clause and read into the flow
of the transaction that hashes with it, so every hash carries the clause.

## What the specification decides, and what it does not

Everything a hash does once written is the existing calculus applied to a value
whose label holds the policy's clause:

- **The clause.** A module-policy reference binds its manifest and its subject
  at label creation, and the transaction that persists it installs the
  manifest in the destination (§4.4.1, §4.4.2). The key's clause is the
  policy's reference with its subject bound to the space it is stored in.
- **Who reads.** A policy principal is interpreted only at trusted boundary
  points (§3.2), and no access context equals one (§3.1.4), so a clause holding
  only the reference admits no reader until a rule of that policy rewrites it.
  A rule rewrites only its home clause (§4.4.5), so another policy's rules
  never reach it.
- **The derivation.** A hash joins the labels of both its inputs, the key's and
  the hashed value's (§2.4), and carries `TransformedBy` of the builtin that
  computed it (§8.9.3).
- **What releases.** An authored rule needs a non-empty integrity or durable
  policy-state guard (§4.3.6). A value that decides whether a release fires is
  a parameter that release must find integrity on (§3.8.4).

The specification has no runtime secret, and so nothing on minting one: the
reserved store, the runtime's write authority over it, that a stored key never
changes, that a value planted there without that authority is replaced, and
that the mint attributes the value to no principal (§8.15.4 lists the
initializations a runtime performs, and this is not one of them). specs#58
proposes these as a ruling. This runtime's arrangement stores something new,
so it waits on that ruling.

## The key

A policy is named by its manifest digest, `policyDigest` (§4.3.6). The digest
is computed over the manifest body, which holds the defining module's identity,
the rule set's export name and the lowered rules, so it identifies all three.
The key for a policy in space `S` is the runtime secret named
`policy:<policyDigest>` (`modulePolicySecret()`), stored in `S` at
`of:runtime-secret:policy:<policyDigest>`.

`IExtendedStorageTransaction.ensureRuntimeSecret()` mints it as it mints the
salt: with the runtime's in-package authorization, 32 bytes from the platform's
CSPRNG, written only when no trusted value is stored, under the builtin identity
`runtime-secret`. Its schema is `{ type: "string", ifc: { confidentiality:
[<the policy's PolicyOf marker>], writeAuthorizedBy: ["runtime-secret"] } }`,
whose subject placeholder commit preparation binds to `S`, installing the
policy's manifest in `S` in the same transaction; a runtime that cannot supply
the manifest refuses the commit, and nothing is stored.

The namespace is the runtime's:

- The write chokepoint refuses every write into it but the mint's.
- The read chokepoint refuses every read of a secret's value through
  `IExtendedStorageTransaction` but the reads `runtime-secret.ts` makes, whose
  marker is private to that module, and reads inside the runtime's own
  privileged write. A pattern, a handler, and a host read through a cell are
  refused, whatever link or id names the document. A read of the document's
  label envelope holds nothing secret and is not refused. The scheduler's
  diagnosis, which records what an action read, skips the namespace.

A key never changes once a trusted one is stored:

- `ensureRuntimeSecret()` writes only when the stored value is absent or
  untrusted. A value is trusted when its stored schema carries the writer
  claim. A value with no stored schema, or whose stored schema carries no
  claim, is untrusted: it was planted through a runtime without the
  chokepoint, and the mint replaces it.
- A value whose stored schema is named but resolves neither in the replica nor
  in the schema registry is neither trusted nor untrusted, and the mint refuses
  rather than writing over it, as §8.15.4 has an unreadable stored label
  envelope never treated as absent. A replica can hold a document before the
  schema document its metadata names, and nothing in the commit would catch an
  overwrite: the schema read is not a commit precondition, and the value read
  is of the current version.
- A value carrying the claim over another confidentiality is untrusted too,
  and so is a value stored without the claim under a label stronger than the
  policy's clause; the mint cannot replace either, since a stored label never
  weakens. The key then stays unusable in that space, no hash is handed out,
  and each runtime reports it once. Anyone who can write the space's storage
  below the runtime can cause this, and the only recovery is a new policy
  digest.
- Two runtimes that mint concurrently both read the absence, and the commit
  that lands second conflicts on that read. Its retry finds the stored key and
  writes nothing.

A new policy digest is a new policy and gets a new key. The module identity in
the digest is the content identity of the whole file that defines the rules,
so any edit to that file, a rule or not, draws a new key; so does a change to
how this runtime lowers rules, so a runtime release that lowers rules
differently redraws every policy's key in every space. Hashes computed under
the old key keep the old clause, and the old policy's rules keep governing
them. An observer who saw what
the old policy released and then sees what the new one releases has seen two
independent draws over the same data. A policy whose releases must not be
redrawn belongs in a module of its own that holds the rules and the code they
endorse and nothing else, and its rules have to carry forward the outcomes the
old draw already released rather than recompute them.

## `policySecretHash`

A pattern names the policy through the type of the hash it wants. Here a policy
draws a winner between two candidates by the order of their hashes, and releases
the winner:

```ts
// Shown at module scope.
import { type Confidential, lift, pattern, policySecretHash } from "commonfabric";
import {
  exchangeRule,
  exchangeRules,
  type PolicyOf,
  THIS_POLICY,
} from "commonfabric/cfc";

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
        identity: { kind: "builtin", builtinId: "policySecretHash" },
      },
    }],
  },
  post: { dropClause: true },
});

export const drawRules = exchangeRules([releaseDraw]);

export type DrawHash = Confidential<
  string,
  readonly [PolicyOf<typeof drawRules>]
>;

/** The candidate whose hash sorts first, once every hash is in. */
export const drawWinner = lift(
  (draw: { candidates: string[]; hashes: (string | undefined)[] }): string => {
    const { candidates, hashes } = draw;
    if (hashes.some((hash) => hash === undefined)) return "";
    let first = 0;
    hashes.forEach((hash, index) => {
      if (hash! < hashes[first]!) first = index;
    });
    return candidates[first];
  },
);

export default pattern(() => ({
  winner: drawWinner({
    candidates: ["alice", "bob"],
    hashes: [
      policySecretHash<DrawHash>({ input: "alice" }),
      policySecretHash<DrawHash>({ input: "bob" }),
    ],
  }),
}));
```

The transformer lowers the type argument to the schema it injects into the
call, as it does for `fetchJson<T>()`, and refuses the call without one.
`PolicyOf<typeof drawRules>` lowers to the compiled marker that names the rule
set's module, export name and digest. The builtin refuses, and leaves its result
unset, unless:

- the schema describes a string whose confidentiality is exactly one clause
  holding exactly one compiled module-policy marker;
- the input is a string;
- the runtime enforces CFC (`enforce-explicit` or `enforce-strict`) and
  persists flow labels. Below either, nothing would refuse a hash written
  where its label does not fit, or the hash would be written without the
  flow that carries the clause.

The manifest is not checked up front: the commit that first carries the
policy's clause installs it or refuses.

The result is the lowercase hex of HMAC-SHA-256, keyed with the key's 32 bytes,
over the input's UTF-8 bytes (`policySecretHashOf()`); a lone surrogate encodes
as U+FFFD, so strings differing only there hash alike. It is the same for every
runtime of the space and every run given the same input, so the lifts that
consume it stay deterministic. Until the
key is available, and while the input is unset, the result is `undefined`, and
code consuming it has to decide nothing then.

The builtin writes the hash as its result, under its own builtin identity, in a
transaction that read the key with `readRuntimeSecretIntoFlow()` and the input
with an ordinary read. The result therefore carries what that transaction's flow
carries: the policy's clause, every label the input carried, and
`TransformedBy{builtin policySecretHash}`. A hash of an input another policy
governs carries both clauses, and each policy's rules can drop only their own.

When no trusted key is readable, the builtin obtains one before it computes:

1. it syncs the key's document, which brings the schema document its metadata
   names, so that a key another runtime minted is the one found;
2. it mints in a transaction of its own and waits for that commit to settle,
   so that the key it computes from is confirmed, not a local draw a
   concurrent mint could still reject. Every instance of the builtin on a
   runtime that needs the same key while a mint is in flight waits for that
   mint, and none computes from it before it settles;
3. it runs again, and computes.

## How a policy uses it

The policy's endorsed function, `drawWinner` above, reads hashes like any other
input and computes its decision. It reads each hash as an input of its own: a
list `.map()` builds carries no witness (see below). The rule releases the
decision because the endorsed function computed it, and requires, through its
input witness, that every confidential input the function read was a hash the
builtin wrote.

The witness is what refuses a stand-in. Code can derive from a hash a value that
selects one of two outcomes by one bit of the hash, and feed it to the endorsed
function in the hash's place; under a rule guarded on the endorsed function's
identity alone, whether the release fired reads out the bit, one run at a time.
The stand-in carries its own code's `TransformedBy`, not the builtin's, so a
rule requiring the builtin as a witness refuses it
([input witnesses](cfc-transformed-by-input-witnesses.md)). `dropClause` makes the decision
public; a rule that should keep it among the space's readers adds them as
alternatives instead, as `direct-release.tsx` does for its readers.

## What this does not cover

No code reads the key, so the gaps below reach a hash, not the key, except
where the first says otherwise. A hash is protected as any value under its
policy's clause is, and no better.

- **Storage and replicas.** The key is stored in plaintext in the space, as
  every value is. The space's service, every replica of the space, a modified
  runtime of any member, and anything that reads below
  `IExtendedStorageTransaction` (its inner storage transaction, or `cf inspect`,
  which reads the space's SQLite file) can read it, and a modified runtime can
  write a key of its choosing under a forged writer claim. The key hides what it
  protects from pattern code and from what the runtime renders, not from a
  member with raw access to the space's storage, who can compute every hash
  offline. A crowd release whose prober can join as a contributor therefore
  needs a key in a space its contributors do not read, with their
  contributions reaching it through ingest rather than membership.
- **The sandbox.** No code reads the key only as long as pattern code cannot
  reach a runtime transaction or the storage beneath it. The pattern sandbox's
  isolation from host objects is that boundary.
- **A list of hashes built by `.map()`.** Mapping `policySecretHash` over items
  builds a list of references. The `map` builtin writes each slot in a
  transaction that read nothing labeled, under the clause the list's type
  declares for its members, and a per-item result holding a reference sits
  between the slot and the hash. Each is a confidential input whose writer is
  unattributed, so a rule requiring the builtin's witness refuses whatever the
  endorsed function computes over the list
  ([input witnesses](cfc-transformed-by-input-witnesses.md), "An unattributed
  input"). A decision over hashes is witness-guarded only when the endorsed
  function takes each hash as an input of its own, so a fixed set of
  candidates rather than a list.
- **Chosen inputs.** The builtin hashes any input any code passes it, so any
  code holds the hash of any input it can name, under the policy's clause. An
  endorsed function that compares a hash against a caller-chosen number is an
  oracle for that hash, the boundary-probing attack among chapter 10's attack
  examples; a hash of a low-entropy value is a dictionary oracle for the value
  wherever a rule releases hashes themselves. Such a rule needs integrity on
  its other inputs (§3.8.4).
- **A second confidential input.** This runtime's input witness holds only
  when every confidential input the endorsed function read carried it. A
  release that compares a secret threshold with a confidential count written
  by the policy's own code reads two confidential inputs with two different
  writers, so no witness holds, and a rule requiring one never fires. The
  specification's per-input witnesses (§8.7.1, §8.9.3) and per-field input
  requirements (§8.10.3) express what such a rule needs, and this runtime does
  not implement them for lift arguments. Until it does, a randomized threshold
  over a confidential count, and noise over a confidential aggregate, can
  require only the endorsed function's identity, and are open to stand-ins.
- **Which value a consumer reads.** Pattern wiring decides which hash an
  endorsed function reads, and a public value put in a hash's place is no
  confidential input at all, so no witness refuses it.
- **A runtime that does not enforce.** The builtin's mode gate binds only the
  runtime that computes a hash. A runtime of the same space that runs below an
  enforcing mode, as a host may configure a browser or remote client, refuses
  nothing its patterns do with a hash they read.
- **A pattern updated onto an edited policy.** A hash computed under the old
  policy stays at its result location with the old clause until the builtin
  writes there again; where the store-label monotonicity check is enforced, a
  location may refuse the new clause, and the new policy's releases then stall.
- **A stamp that outlives its value.** An output written unchanged is not
  written again, so it keeps the stamp an earlier run left; a run over a
  stand-in that happens to compute the same decision is released on the
  earlier run's witness, and whether it is reads out whether the two agree
  ([input witnesses](cfc-transformed-by-input-witnesses.md)).
- **What every confidential value leaks.** Code that reads a hash can end its
  transaction early, run longer, fail, or write a runtime-owned store whose
  label then rises, depending on the hash; it can log it to the host's console;
  it can derive a document id from it, and use it where no render ceiling, LLM
  observation ceiling or sink ceiling is declared, as this runtime's default
  posture declares none for the network. A sink request that reads a hash
  beside a value the endorsed function computed is measured against the
  integrity of both together, so the release the endorsed value earns reaches
  the hash too. These are the gaps every value under a policy's clause has
  here, and the hashes add none.
- **Whether a policy has a key.** The key's label envelope is readable, so code
  learns whether a policy has been used in the space.
- **A handler's `Math.random`.** It is unchanged.
