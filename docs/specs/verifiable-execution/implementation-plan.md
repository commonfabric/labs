# CF Protocol Implementation Plan

This document tracks implementation status of the CF Protocol specification.
See the [verifiable-execution document map](README.md) for the spec index.

## Status Legend

- [x] Done
- [ ] Not started
- [~] Partial / in progress

---

## Phase 1: Core Infrastructure (Mostly Complete)

### 1.1 Append-Only Log

- [x] SQLite-based revision storage (`packages/memory/v2/engine.ts`)
- [x] Lamport clock sequencing (`seq` field)
- [ ] Content-addressed entity revisions. Only blobs are content-addressed;
      the JSON write path stores revisions inline, keyed by branch, entity and
      seq
- [ ] Causal chains linking one revision to its parent. A commit is validated
      against the sequence numbers in its read set rather than against a
      client-supplied parent hash
- [ ] Merkle inclusion proofs for log entries
- [ ] Log root computation (MMR or equivalent)
- [ ] Checkpoint generation with signed log roots

### 1.2 Identity & Authorization

- [x] DID-based principals (`Principal`, `Signer`, `Verifier` interfaces)
- [x] Space identification via `did:key` (`MemorySpace` type)
- [x] ACL with capability levels (`READ`, `WRITE`, `OWNER`)
- [x] UCAN-based authorization structure
- [x] Signature verification via `Verifier` interface
- [x] Access checking in `packages/memory/acl.ts`
- [ ] ACL state stored as receipts in the log
- [ ] Authorization binding in commit records

### 1.3 Transaction System

- [x] Storage transactions (`IStorageTransaction`)
- [x] Read/write tracking in `V2StorageTransaction`
- [x] Activity recording (`Activity` type with read/write variants)
- [x] Path-level addressing (`IMemoryAddress` with `{id, type, path}`)
- [x] Consistency checking via attestations
- [x] Commit records with transaction data

### 1.4 Document → Commit Provenance

- [x] `seq` orders every revision and names its producing commit
- [x] Revisions are keyed by branch, entity and `seq`, so a range of history
      reads as a range of sequence numbers
- [ ] Query and watch responses include the commits for the revisions they
      return
- [ ] Include older commits if client hasn't seen them yet

**Files to modify:**

- `packages/memory/v2/engine.ts` - the revision and commit tables, and the
  lookup that joins them
- `packages/memory/v2/server.ts` - include producing commits in responses

### 1.5 Scheduler Staleness Detection

Works with current CAS semantics - no commit model changes required.
**Requires activity tracking (2.1)** for path-level granularity.

**Required changes:**

- [ ] Scheduler tracks the `seq` of each path it reads (from commit activity)
- [ ] On incoming commit, compare commit's write paths against tracked inputs
- [ ] Mark computation stale if `commit.seq > tracked_input.seq` for same path
- [ ] Re-run only stale computations

```typescript
// Shown at module scope.
interface TrackedInput {
  address: IMemoryAddress; // {id, type, path} - path-level!
  since: number; // When this input was read
}

// On commit received (using activity from 2.1):
for (const writePath of commit.activity.writes) {
  if (trackedInputs.has(writePath) &&
      commit.since > trackedInputs.get(writePath).since) {
    markStale(computationsUsing(writePath));
  }
}
```

Without path-level tracking, any change to entity X invalidates ALL computations
reading ANY part of X - too coarse for efficient scheduling.

**Files to modify:**

- `packages/runner/src/scheduler/` - staleness tracking and comparison
- `packages/runner/src/storage/v2-transaction.ts` - expose `since` with reads

---

## Phase 2: Enhanced Receipts (Priority: High)

This is the next major milestone. The goal is to enhance commit/receipt
structure to capture computation metadata for verifiability and reactive
scheduling.

### 2.1 Address-Level Activity in Receipts

`V2StorageTransaction` tracks read and write activity with `IMemoryAddress`
including paths, but this is not persisted in the commit structure. The
transaction exposes that activity through `getReadActivities()`,
`getReactivityLog()`, and `getWriteDetails()`. Its journal does not: the
`activity()` member of `ITransactionJournal` is unimplemented on
`V2TransactionJournal` and throws, so serialization work starts by giving it
an implementation.

**Required changes:**

- [ ] Extend `CommitData` to include address-level reads/writes:

```typescript
// Shown at module scope.
interface CommitData {
  since: number;
  transaction: Transaction;
  labels?: FactSelection;
  // NEW: Activity tracking
  activity?: {
    reads: SerializedAddress[]; // [{id, type, path}]
    writes: SerializedAddress[];
  };
}
```

- [ ] Serialize `IMemoryAddress` in commit creation
      (`packages/runner/src/storage/v2-transaction.ts`)
- [ ] Capture journal activity when creating commits
- [ ] Add activity to `ITransactionJournal.activity()` serialization

**Files to modify:**

- `packages/memory/v2.ts` - extend the committed shape carried over the wire
- `packages/runner/src/storage/interface.ts` - activity export
- `packages/runner/src/storage/v2-transaction.ts` - activity serialization in
  `V2TransactionJournal`

### 2.2 Code Bundle References

Track which code produced each computation.

**Required changes:**

- [ ] Define `CodeBundle` reference type
- [ ] Add `codeCID` field to receipt structure
- [ ] Capture pattern/handler identifier during execution
- [ ] Pass code reference through transaction pipeline

```typescript
// Shown at module scope.
interface ComputationContext {
  codeCID: Reference<CodeBundle>; // Hash of code that ran
  handlerId?: string; // Handler name within bundle
  version?: string; // Code version
}
```

**Files to modify:**

- `packages/memory/interface.ts` - add computation context types
- `packages/runner/src/storage/v2-transaction.ts` - capture code context
- `packages/runner/src/runtime.ts` - pass code identity to transactions

### 2.3 Input Provenance References

Link outputs to their input sources for provenance chains.

**Required changes:**

- [ ] Capture `inputRefs` as references to source facts
- [ ] Distinguish between:
  - Direct reads (facts read during computation)
  - Derived inputs (computed from other sources)
- [ ] Add input references to commit structure

```typescript
// Shown at module scope.
interface ProvenanceData {
  inputRefs: Reference<Fact>[]; // Source facts
  inputCommitments?: Hash[]; // H(salt || input) for privacy
}
```

**Files to modify:**

- `packages/memory/interface.ts` - provenance types
- `packages/runner/src/storage/v2-transaction.ts` - track input sources

### 2.4 Receipt Serialization

Create a unified receipt format that combines current structures.

**Required changes:**

- [ ] Define `Receipt` type combining Fact + computation metadata
- [ ] Implement receipt creation from transaction + journal
- [ ] Add receipt verification functions

```typescript
// Shown at module scope.
interface Receipt {
  // Core fact
  fact: Fact;

  // Computation metadata
  computation?: {
    codeCID: Reference<CodeBundle>;
    activity: { reads: Address[]; writes: Address[] };
    inputRefs: Reference<Fact>[];
  };

  // Signature
  signature: Signature<Receipt>;
  issuer: DID;
}
```

**Files to modify:**

- `packages/memory/v2.ts` - receipt type definition, and the receipt
  implementation this phase adds

### 2.5 Client State & Commit Validation

Implement the nursery/heap model for client-side state and relaxed commit
validation.

**Required changes:**

- [ ] Define `ClientCommit` structure with confirmed/pending read separation:

```typescript
// Shown at module scope.
interface ClientCommit {
  reads: {
    confirmed: Array<{ address: Address; hash: Hash; since: number }>;
    pending: Array<{ address: Address; hash: Hash; fromCommit: Reference<Commit> }>;
  };
  writes: Array<{ address: Address; value: JSONValue; cause: Hash }>;
  codeCID?: Reference<CodeBundle>;
  activity?: ReceiptActivity;
}
```

- [ ] Define `CommitLogEntry` structure preserving original + resolution:

```typescript
// Shown at module scope.
interface CommitLogEntry {
  original: SignedClientCommit;
  resolution: {
    since: number;
    commitResolutions: Map<Reference<Commit>, number>;
    hashMappings?: Map<Hash, Hash>; // provisional → final
  };
}
```

- [ ] Implement `since`-based validation (not hash-chain validation):
  - Reads must record `since` of what was read
  - Validation: `new_commit.reads[entity].since >= prior_commit.writes[entity].since`

- [ ] Track hash mappings when provisional hashes differ from final

- [ ] Implement server-side commit processing:
  - Validate confirmed reads against current `since`
  - Resolve pending reads via `fromCommit` → assigned `since`
  - Assign next `since` to commit
  - Compute final hashes and record mappings
  - Store both original and resolution

**Files to modify:**

- `packages/memory/v2.ts` - `ClientCommit`, `CommitLogEntry` types
- `packages/memory/v2/server.ts` - commit processing with validation
- `packages/memory/v2/engine.ts` - commit log storage with original +
  resolution
- `packages/runner/src/storage/v2-transaction.ts` - client-side commit building

---

## Phase 3: Reactive Scheduling Integration

The activity tracking from Phase 2 enables intelligent reactive scheduling.

### 3.1 Dependency Graph

- [ ] Build dependency graph from receipt activity
- [ ] Track which addresses each computation reads/writes
- [ ] Compute transitive dependencies

### 3.2 Minimal Invalidation

- [ ] On a revision landing, identify affected computations via read
      addresses
- [ ] Use path-level granularity for precise invalidation
- [ ] Only re-run computations whose inputs changed

### 3.3 Scheduler Hooks

- [ ] Integrate with pull-based scheduler (see `docs/specs/scheduler-v2/README.md`)
- [ ] Provide activity data to scheduler for dependency tracking
- [ ] Support partial re-execution based on changed paths

---

## Phase 4: IFC Labels (Future)

### 4.1 Label Infrastructure

- [~] Basic label type exists (`Labels` with `classification`)
- [ ] Full IFC label model (confidentiality + integrity)
- [ ] Label commitment hashing
- [ ] Policy CID references

### 4.2 Label Propagation

- [ ] Track labels through computations
- [ ] Verify label constraints at commit time
- [ ] Label-based access control

### 4.3 Attested Enforcement

- [ ] TEE integration for policy enforcement
- [ ] IFC result generation
- [ ] Attestation binding

---

## Phase 5: Merkle Proofs & Checkpoints (Future)

### 5.1 Log Proofs

- [ ] Merkle tree or MMR for log structure
- [ ] Inclusion proof generation
- [ ] Proof verification API

### 5.2 Checkpoints

- [ ] Checkpoint generation (periodic or on-demand)
- [ ] Signed checkpoint structure
- [ ] Checkpoint chain verification

### 5.3 Latest Entity Map

- [ ] Sparse Merkle Tree for heads
- [ ] Heads inclusion proofs
- [ ] Efficient latest-state queries

---

## Phase 6: Verifiable Credentials (Future)

- [ ] VC issuance from receipts
- [ ] Trust profile verification
- [ ] VC serialization (JWT/CBOR)

---

## Phase 7: Domain Bootstrap (Future)

- [ ] DNS TXT record support (`_ct.domain.com`)
- [ ] Well-known endpoint (`/.well-known/cf-space-did`)
- [ ] did:web document generation
- [ ] Domain verification algorithm

---

## Phase 8: Time Bounds (Future)

- [ ] Beacon integration for lower bounds
- [ ] RFC 3161 timestamp support for upper bounds
- [ ] Time-bound verification

---

## Implementation Priority

### Immediate - Quick Wins (works with current CAS semantics)

1. **Document → Commit provenance** (Phase 1.4)
   - Add compound index `(the, since)` for fast commit lookup
   - Query/subscription responses include producing commits
   - Foundation for scheduler and client verification

2. **Activity in receipts** (Phase 2.1)
   - Extend `CommitData` with address-level reads/writes
   - Serialize journal activity to commits
   - **Required for efficient scheduler** - without paths, any entity change
     invalidates all computations touching that entity

3. **Scheduler staleness detection** (Phase 1.5 + 3)
   - Compare `since` values at path level to detect stale data
   - Scheduler tracks `since` of each path it reads
   - Re-run computations only when their specific paths are newer
   - **High impact**: Efficient invalidation with path granularity

### Then - Enhanced Commit Model (Phase 2.5)

4. **Client state & commit validation**
   - Nursery/heap model for pending vs confirmed commits
   - `since`-based validation rules (relaxed from strict CAS)
   - CommitLogEntry with original + resolution
   - Hash mapping for provisional → final resolution
   - Enables offline operation and stacked commits

### Later - Auditing & Reproducibility (Phase 2.2-2.3)

5. **Code bundle references**
   - Track which code produced each output
   - Essential for reproducibility and auditing

6. **Input provenance**
   - Link outputs to input sources
   - Enables provenance chain verification

### Medium-term (Phases 4-5)

7. **IFC labels** - Build on existing `Labels` type
8. **Merkle proofs** - Enable verification without full log

### Long-term (Phases 6-8)

9. **VCs, Domain bootstrap, Time bounds** - Optional add-ons

---

## Key Files Reference

| Area | Primary Files |
|------|---------------|
| Commit model | `packages/memory/v2.ts` |
| Merkle hashing | `packages/data-model/src/value-hash/` |
| Transaction interface | `packages/runner/src/storage/interface.ts` |
| Transaction impl | `packages/runner/src/storage/v2-transaction.ts` |
| Address operations | `packages/runner/src/storage/transaction/address.ts` |
| Attestation | `packages/runner/src/storage/transaction/attestation.ts` |
| ACL | `packages/memory/acl.ts` |
| Space/SQLite | `packages/memory/v2/engine.ts` |
