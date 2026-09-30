# CF Protocol: Extensions & Appendices (Sections 13–17)

See the [verifiable-execution document map](README.md) for navigation.

## 13. Trusted UI and Interaction Integrity

### 13.1 Why UI Is Part of the Trusted Computing Base

Many failures of trust occur at the boundary between system and human. Messages
are spoofed, prompts injected, consent manufactured.

The CF Protocol addresses this by extending verifiability to **interaction
itself**: if user actions materially affect system behavior, then those actions
belong in the provenance chain.

### 13.2 Trusted Input UI

A **Trusted Input UI** is a measured interface whose code identity is known.
When a user types, clicks, or submits, the event is captured as an input with
explicit integrity labels.

This reframes familiar acts as verifiable events. A receipt can support:

> "This message was typed by the user using the approved UI."

The goal is not surveillance, but provenance.

### 13.3 Trusted Render UI

A **Trusted Render UI** verifies receipts before displaying content:

- Refuses to render unverifiable content
- Displays verification badges derived from receipts
- Enforces CFC disclosure rules at render time

---

## 14. Verifiable Credentials

### 14.1 From Receipts to Claims

Receipts are precise but low-level. **Verifiable Credentials (VCs)** summarize
them into portable objects.

A VC does not replace receipts; it packages one or more receipts with inclusion
proofs, policy identifiers, and optional enforcement evidence.

### 14.2 The Critical Constraint

A CF Protocol–backed credential must not invent facts. Every assertion must be
reducible to receipts and verification steps that can be replayed.

### 14.3 Replayable Verification

A verifier need not trust the issuer's word. Given the credential, the verifier
can extract referenced receipts, check signatures, confirm log inclusion, and
verify policies.

---

## 15. Latest Entity Map (Optional)

### 15.1 Purpose

The **Latest Entity Map** enables efficient, verifiable answers to:

> "What is the latest state for entity E _as of checkpoint C_?"

### 15.2 Data Structure

- Implemented as a **Sparse Merkle Tree (SMT)** keyed by `H(of)`
- Each leaf commits to the latest known fact for that entity

### 15.3 Checkpoint

```typescript
// Shown at module scope.
interface UnsignedCheckpoint {
  epoch: number;
  headsRoot?: Hash; // OPTIONAL
  logRoot: Hash; // REQUIRED
  prev?: Reference<Checkpoint>;
  ts: number;
}
```

---

## 16. Domain and DID Bootstrap (DNS + did:web)

### 16.1 Three Identities

- **Space DID** (often `did:key`): Root authority for ACL and authorization
- **Server DID** (`did:web`): Represents the server hosting the log
- **Domain** (DNS name): Human-meaningful handle for discovery only

### 16.2 Domain → Space Binding

```
_ct.example.com TXT "did=did:key:z6M...SPACE..."
```

Or:
```
https://example.com/.well-known/cf-space-did
```

### 16.3 Security Properties

- **No naming trust escalation:** Domain bindings do not grant write authority
- **Auditability:** Historical facts remain valid even if bindings change

---

## 17. Philosophy: Dissolving Unnecessary Authority

The CF Protocol is not neutral about power. It begins from the observation that
many failures of trust are also failures of balance.

### 17.1 The Shift

Instead of replacing one authority with another, the CF Protocol seeks to
**dissolve unnecessary authority** by making evidence portable and verification
repeatable.

When claims are grounded in receipts, policies, and logs that anyone can
inspect:

- A server can order events without deciding what they mean
- An application can render information without inventing facts
- An issuer can package claims without inflating their scope
- A user can carry evidence without depending on a platform's memory

### 17.2 What This Enables

Authority becomes specific, bounded, and accountable to structure. No component
is asked to be omniscient. No component is allowed to be unquestionable.

---

## Appendix A: Glossary

**ACL (Access Control List)** State object defining which DIDs may act in a
space.

**Append-Only Log** A global, monotonically growing structure that establishes
total ordering.

**CFC (Contextual Flow Control)** An opinionated application of IFC treating
external inputs as untrusted by default.

**Commit** A special fact type (`application/commit+json`) recording a complete
transaction for audit purposes.

**Entity** A named object whose state evolves over time, identified by a URI.

**Fact** An atomic state record: Assertion (has value), Retraction (tombstone),
or Unclaimed (genesis).

**Genesis** The initial state of an entity or space, before any assertions.

**Pattern** A composable, reactive program defining how state evolves.

**Receipt** A content-addressed record with computation metadata, optionally signed.

**Space** A logical database namespace identified by a DID.

**Trust Profile** A named bundle of verification steps and guarantees.

---

## Appendix B: Threat–Invariant Matrix

| Threat                          | Invariant                              | Mechanism                          |
| ------------------------------- | -------------------------------------- | ---------------------------------- |
| Server forges authorization     | Authorization derives from space state | Authenticated invocations/receipts + ACL binding |
| Server reorders commits         | Log is append-only and checkpointed    | Log inclusion proofs + checkpoints |
| Signer writes without authority | Fact binds to ACL-at-commit-time       | `cause` chain + log ordering       |
| Replay of revoked authority     | Authorization evaluated at commit time | ACL evolution + log ordering       |
| Delegation forgery              | Only owners may modify delegation      | Signed delegation facts            |
| Domain hijack escalates         | Domains have no authorization power    | Space DID–rooted ACL               |
| Hidden data flow violation      | CFC label maps committed in receipts   | Label commitments + policy CID     |
| False policy compliance claim   | Enforcement evidence is explicit       | TEE attestation + `cfcResultHash`  |
| Tampering with history          | Content-addressed facts and log        | Hash chaining + signatures         |

---

## Appendix C: Mapping to Current Implementation

| CF Protocol Concept   | Current Implementation                           | Package |
| --------------------- | ------------------------------------------------ | ------- |
| Entity                | `URI` (`${string}:${string}`)                    | memory  |
| Fact                  | `Assertion \| Retraction`                        | memory  |
| Unclaimed             | `{the, of}` with no `is` or `cause`              | memory  |
| Commit                | `ClientCommit` (`packages/memory/v2.ts`)         | memory  |
| Space                 | `MemorySpace` (`did:${string}`)                  | memory  |
| Append-only log       | SQLite `fact` table                              | memory  |
| Current state         | SQLite `memory` table                            | memory  |
| ACL                   | `ACL` type with `Capability`                     | memory  |
| Signer                | `Signer` interface                               | memory  |
| Authorization         | Signed session open (`v2/session-open-auth.ts`)  | memory  |
| Address tracking      | `IMemoryAddress` (`{id, type, path}`)            | runner  |
| Read/Write tracking   | `Activity` type; `getReadActivities()`           | runner  |
| Transaction           | `IStorageTransaction` (`V2StorageTransaction`)   | runner  |
| Labels                | `Labels` type with `classification` (coarse)     | runner  |
| Genesis cause         | `refer({the, of})` - hash of unclaimed state     | memory  |

---

Prev: `docs/specs/verifiable-execution/06-cfc-and-trust.md`
