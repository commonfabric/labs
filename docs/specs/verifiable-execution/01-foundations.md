# CF Protocol: Foundations (Sections 1–4)

See the [verifiable-execution document map](README.md) for navigation.

## Conventions

- **Normative language:** “MUST”, “SHOULD”, etc are used in the RFC 2119 sense.
- **Content addressing:** Hashes and references are computed via this project's
  `hashOf()` function.
- **Types:** Where practical, names and shapes align with the memory package: the fact model in `packages/memory/interface.ts`, and the commit and protocol shapes in `packages/memory/v2.ts`.

---

## 1. Introduction: From Asserted Trust to Verifiable Trust

Modern software systems often make claims before they make arguments. We are
told that a model was trained responsibly, that a score reflects genuine
activity, that a message really came from its purported author, that a user gave
meaningful consent. The evidence, when it exists at all, is usually indirect:
dashboards, PDFs, policy pages, institutional reputation. **Trust is asserted,
then defended socially rather than demonstrated structurally.**

This pattern no longer scales. Systems are larger, more automated, and more
intertwined; the consequences of error or misrepresentation are higher; and the
parties asked to trust them are often remote in space, time, and incentives.

The CF Protocol begins from a different premise: **trust should be _derivable_,
not declarative.** A claim should be accompanied by the evidence that produced
it, structured so that an independent verifier can replay the reasoning without
privileged access. Trust, in this view, is not a favor granted by authority, but
a property that emerges from how a system is built.

### 1.1 Core Features

- **Mandatory append-only log** maintained by a single server
- **Multi-signer receipts** with state-based authorization (ACL + delegation) (future)
- **Contextual Flow Control (CFC)** labels on data and computations, enabling
  end-to-end integrity and confidentiality guarantees

### 1.2 Optional Add-ons

- **Authenticated latest pointers** (verifiable entity → latest update mapping)
- **Verifiable Credentials (VCs)** issued on-demand for any data point
- **Trusted Execution Environment (TEE)** attestations for computation integrity
  and (when present) CFC compliance
- **Verifiable time bounds**, including cryptographic _lower bounds_ ("not
  before t")

The core system remains lightweight: it does **not** require maintaining a
mutable ordered keyspace (e.g., MST). Optional components are independently
verifiable and can be requested or omitted per use case.

---

## 2. Design Goals

- **Cheap verification:** Proof sizes and verification cost scale with _what is
  checked_, not total history.
- **Privacy by default:** Inputs and intermediate data are not exposed; only
  commitments and proofs are published.
- **Strong provenance:** Every update is cryptographically linked to its
  predecessors and inputs.
- **Policy-compliant computation:** CFC labels travel with data, and
  computations can be verified to respect integrity and confidentiality
  constraints.
- **Modular add-ons:** Latest-pointer maps and VCs are optional and orthogonal.
- **Non-equivocation ready:** Equivocation can be detected and constrained via
  checkpoint chains.
- **No unnecessary authority:** The system resists centralization by ensuring
  that servers order but do not authorize, policies constrain but do not
  execute, and UIs present but do not invent.

---

## 3. Core Concepts

### 3.1 Entity

An **Entity** identifies a named object whose state evolves over time.

- Examples: document URI (`of:ba4jc...`), object handle, dataset name, account
  DID
- Canonical form MUST be deterministic (URI format: `${scheme}:${identifier}`)
- In the current implementation, entities are identified by `URI` type
  (`${string}:${string}`)

### 3.2 Fact

Most systems treat state as something that simply _is_: a set of rows in a
database, a collection of files on disk, a snapshot held in memory. Changes
happen, but the change itself is rarely preserved as a first-class object. At
best, there is an audit log; at worst, only the latest value survives.

**The CF Protocol inverts this perspective.** A state change is not an
incidental side effect; it is the primary event. A **Fact** represents state at
a point in time:

- **Assertion**: Current state with value (`{the, of, is, cause}`)
- **Retraction**: Tombstone indicating prior state no longer holds
  (`{the, of, cause}`)
- **Unclaimed**: The initial/genesis state before any assertion
  (`{the, of}` with no `is` or `cause`)

State MAY be represented as:

- Full materialized state (content-addressed), or
- A patch applied to a prior state

Implementations MUST produce a deterministic hash for every update via this
project's `hashOf()` function, whose byte-level encoding is specified in
[`../space-model-formal-spec/2-hash-byte-format.md`](../space-model-formal-spec/2-hash-byte-format.md).

### 3.3 Receipt

A **Receipt** is the atomic, append-only record of a state update.

Receipts are deliberately precise—and deliberately limited. They bind to the
content they reference via cryptographic hashes and to the actor that produced
them via a signature. **They do not claim semantic correctness, moral
legitimacy, or future validity. They record _what happened_, not _what should
have happened_.** That discipline is what makes receipts composable and
verifiable.

Each receipt also serves as a **computation envelope**:

- commits to code and inputs
- commits to output state
- commits to CFC label commitments (schema-derived, path-granular) and a policy identifier

By treating receipts as the unit of history, the CF Protocol makes the past
inspectable. One can trace not just the current state of a system, but the
sequence of decisions and derivations that led there.

### 3.4 Pattern

A **Pattern** is the universal unit of executable logic in the fabric:
composable, reactive programs that define how state evolves and how users
interact with it. Patterns describe both application behavior and user
interfaces, and they react continuously to changes in fabric state and events.

Patterns are rarely retired; once instantiated they are woven into the fabric
and continue to react over time. Most reactions are pull-based—triggered when
state is observed or consulted—with optional periodic refresh for long-running
processes.

Because trust in the CF Protocol is narrow, explicit, and mechanically enforced,
**patterns do not need to be trusted in order to be run.** They are safe by
construction under Contextual Flow Control: they cannot exfiltrate data,
escalate privileges, or violate context without explicit policy. As a result,
patterns may be instantiated _speculatively_—woven into the fabric and allowed
to react to existing state before any user has explicitly engaged with them.

### 3.5 Space

A **Space** is a logical database/namespace whose state, policies, and
permissions evolve over time:

- Identified by a space DID (often `did:key` in practice) (`MemorySpace` type: `did:${string}`)
- Owns its ACL and delegation state
- The server maintains the append-only log but does NOT determine authorization

Each user operates a **personal fabric**: a collection of spaces, policies, and
running patterns that reflect their interests and intentions. The cryptographic
keys that anchor authorization ultimately live on the user's own devices.
Providers act only as delegated executors, operating under user-granted
authority that can be renewed or revoked.

---

## 4. Fact Structure

### 4.1 Core Fact Types

The fundamental data model uses `{the, of, is, cause}` tuples:

```typescript
// Shown at module scope.
// Media type - adds a dimension for different "views" of an entity
type MIME = `${string}/${string}`; // e.g., "application/json"

// Entity identifier
type URI = `${string}:${string}`; // e.g., "of:ba4jcbvpq3k5..."

// Merkle reference - content-addressed hash
type CauseString = `b${string}`; // multibase base32 digest (e.g. "baedrei...")
type Reference<T> = { "/": CauseString }; // e.g., { "/": "baedrei..." }

// An assertion - current state with value
interface Assertion {
  the: MIME; // Kind of fact (e.g., "application/json")
  of: URI; // Entity identifier
  is: JSONValue; // The actual state data
  cause: Reference<Fact> | Reference<Unclaimed>; // Prior state reference
}

// A retraction - tombstone for deleted state
interface Retraction {
  the: MIME;
  of: URI;
  is?: undefined; // No value - this is a deletion
  cause: Reference<Assertion>; // Must point to the assertion being retracted
}

// Unclaimed - represents non-existent/genesis state
interface Unclaimed {
  the: MIME;
  of: URI;
  is?: undefined;
  cause?: undefined; // No prior state
}

type Fact = Assertion | Retraction;
type State = Fact | Unclaimed;
```

### 4.2 Causality and Genesis

Every fact has a causal reference to the prior fact. This establishes linear
history of changes for each entity:

1. **Genesis State**: The first assertion for an entity has `cause` pointing to
   the hash of `{the, of}` (the Unclaimed state). This is computed as:
   ```typescript
   // Shown inside a pattern body.
   const genesisCause = refer({ the, of }); // Hash of unclaimed state
   ```

2. **Subsequent States**: Each subsequent assertion or retraction points to the
   hash of the previous fact, creating a chain.

3. **Compare-and-Swap (CAS)**: The `cause` field enables optimistic concurrency.
   A transaction is rejected if the provided `cause` doesn't match the current
   state.

### 4.3 The `the` Field (Media Type)

The `the` field adds a dimension for storing different "views" of an entity:

- `"application/json"` - Standard JSON data
- `"application/commit+json"` - Commit/audit records
- `"application/meta+json"` - Metadata about an entity
- `"application/acl+json"` - Access control lists

This allows multiple facts about the same entity (`of`) with different types
(`the`), each with its own causal chain.

---

Next: `docs/specs/verifiable-execution/02-commit-model.md`
