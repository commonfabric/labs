# CF Protocol: Commit Model (Section 5)

See the [verifiable-execution document map](README.md) for navigation.

## 5. Commit Structure

**Current implementation note:** In the current system, the
`application/commit+json` fact is the primary “receipt” for a transaction. A
richer receipt object (with additional computation metadata) is described as
future work in Section 7.

### 5.1 What is a Commit?

A **Commit** is a special fact type that records a complete transaction for
audit purposes. Every transaction that modifies state also creates a commit
record.

```typescript
// Shown at module scope.
// The commit media type
const COMMIT_LOG_TYPE = "application/commit+json";

// Commit data structure
interface CommitData {
  since: number; // Lamport clock / sequence number
  transaction: Transaction; // The complete transaction that was applied
  labels?: FactSelection; // Optional label facts used for redaction/access control
}

// A commit is stored as a Fact
type CommitFact = Assertion<
  "application/commit+json", // the
  MemorySpace, // of (the space DID)
  CommitData // is
>;
```

### 5.2 Commit Creation

When a transaction is processed:

```typescript
// Shown inside a pattern body.
// Create a commit record
const commit = {
  the: "application/commit+json",
  of: space, // The space DID (e.g., "did:key:z6Mk...")
  is: {
    since: nextSequenceNumber,
    transaction: transaction, // Full transaction including all changes
    labels: extractedLabels, // Optional label facts for redaction/access control
  },
  cause: previousCommitReference, // Or unclaimed for first commit
};
```

### 5.3 Genesis Commit

The **first commit** in a space has special significance:

1. Its `cause` field points to the Unclaimed reference for the space:
   ```typescript
   // Shown inside a pattern body.
   const genesisCause = refer({
     the: "application/commit+json",
     of: spaceDID,
   });
   ```

2. This establishes the **root of trust** for the space. The genesis commit
   effectively bootstraps the space's history.

3. For full trust anchoring, the genesis commit SHOULD be signed by the space
   DID itself (not a delegated signer).

### 5.4 Commit Chain

Commits form a chain just like regular facts:

```
Genesis Commit (cause: unclaimed)
    ↓
Commit #1 (cause: genesis)
    ↓
Commit #2 (cause: commit #1)
    ↓
   ...
```

This chain provides:
- **Total ordering** of all transactions in the space
- **Audit trail** - every transaction is recorded with its full content
- **Consistency anchor** - verifiers can trace the complete history

### 5.5 Wire Format

The commit structure on the wire (e.g., in responses):

```typescript
// Shown for illustration only.
type Commit<Subject extends MemorySpace> = {
  [space in Subject]: {
    ["application/commit+json"]: {
      [cause: CauseString]: {
        is: CommitData;
      };
    };
  };
};

// Example:
{
  "did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi": {
    "application/commit+json": {
      "baedreigv6dnlwjzyyzk2z2ld2kapmu6hvqp46f3axmgdowebqgbts5jksi": {
        "is": {
          "since": 42,
          "transaction": { /* ... */ }
        }
      }
    }
  }
}
```

### 5.6 Transaction Structure (Current Implementation)

The current implementation uses strict CAS (compare-and-swap) semantics at the
entity level:

```typescript
// Shown for illustration only.
type Transaction = {
  cmd: "/memory/transact";
  sub: MemorySpace; // Space DID
  args: {
    changes: Changes;
  };
};

type Changes = {
  [of: URI]: {
    [the: MIME]: {
      [cause: CauseString]: Assert | Retract | Claim;
    };
  };
};

type Assert = { is: JSONValue }; // Add or update
type Retract = { is?: undefined }; // Delete
type Claim = true; // Verify without modifying
```

**Conflict semantics:** If any asserted/claimed `cause` does not match the
replica’s current state for that `(of, the)` pair, the transaction is rejected
atomically (no partial application). The resulting error SHOULD include both
the client’s expected state and the replica’s actual state (see 5.9).

**The Claim variant** is key for consistency: it validates that a fact's current
state matches the specified cause *without modifying it*. This enables
STM-style (Software Transactional Memory) transactions where you list all facts
you read to produce an update, ensuring none have changed.

```typescript
// Example: Update user age, but only if name hasn't changed
const transaction = {
  changes: {
    "user:alice": {
      "application/json": {
        // Claim: verify name fact still has this cause (read dependency)
        "baedrei...nameHash": true,
        // Assert: update age fact
        "baedrei...ageHash": { is: { age: 31 } },
      },
    },
  },
};
```

**Relationship to activity tracking:** The `Claim` variant serves transaction
validation (CAS on reads), while activity tracking in commits (see 6.2) serves
scheduling and provenance. Current implementation uses Claims; future path-level
activity enables finer-grained invalidation.

### 5.7 Concurrent Transaction Handling (Current CAS Model)

The current implementation uses strict CAS semantics. When concurrent updates
target the same entity, only one succeeds:

```
Timeline:
─────────────────────────────────────────────────────────────────────

Client A                    Server                    Client B
    │                          │                          │
    │  Read user:alice         │                          │
    │  ───────────────────────>│                          │
    │  {name: 'Alice'}         │                          │
    │  cause: H1               │                          │
    │  <───────────────────────│                          │
    │                          │                          │
    │                          │    Read user:alice       │
    │                          │<─────────────────────────│
    │                          │    {name: 'Alice'}       │
    │                          │    cause: H1             │
    │                          │─────────────────────────>│
    │                          │                          │
    │  Update: add job         │                          │
    │  cause: H1               │                          │
    │  ───────────────────────>│                          │
    │  ✅ Success              │                          │
    │  <───────────────────────│                          │
    │                          │                          │
    │                          │    Update: add age       │
    │                          │    cause: H1             │
    │                          │<─────────────────────────│
    │                          │    ❌ Rejected           │
    │                          │    (conflict / cause mismatch)      │
    │                          │─────────────────────────>│
    │                          │                          │
    │                          │    Re-read user:alice    │
    │                          │<─────────────────────────│
    │                          │    {name: 'Alice',       │
    │                          │     job: 'Engineer'}     │
    │                          │    cause: H2             │
    │                          │─────────────────────────>│
    │                          │                          │
    │                          │    Update: add age       │
    │                          │    cause: H2             │
    │                          │<─────────────────────────│
    │                          │    ✅ Success            │
    │                          │─────────────────────────>│
```

**Key points:**
- Each change must reference the current `cause` hash
- If cause doesn't match current state → transaction rejected
- Client must re-read and retry with updated cause
- Non-conflicting updates (different entities) proceed independently

### 5.8 Client State: Nursery and Heap (Current CAS Model)

Clients maintain two areas for tracking state:

- **Heap**: Confirmed state from server (has real `cause` hashes)
- **Nursery**: Pending/unconfirmed writes (optimistic, may be rejected)

With current CAS semantics, the flow is:

```
1. Client reads entity from heap (cause: H1)
2. Client computes update locally → nursery
3. Client sends transaction with cause: H1
4. If accepted: nursery state moves to heap
5. If rejected (conflict): discard nursery, re-read, retry
```

**Stacked pending commits** can reference nursery state:

```
C1 sent → nursery (writes X with cause H1)
C2 created (reads X from nursery) → sent → nursery
C1 confirmed → X moves to heap
C2 depends on C1's success
```

If C1 fails (conflict), C2 also fails. The client must re-read and rebuild
both transactions.

### 5.9 Server Processing (Current CAS Model)

When the server processes a transaction:

1. **Validate all cause references**: Each must match current state
2. **If any mismatch**: Reject entire transaction
3. **If all match**: Apply atomically, assign next `since`, record commit

```typescript
// Shown for illustration only.
// Server validation pseudocode
for (const [of, types] of Object.entries(changes)) {
  for (const [the, revisions] of Object.entries(types)) {
    for (const [cause, change] of Object.entries(revisions)) {
      const current = getCurrentFact(of, the);
      if (hash(current) !== cause) {
        return {
          error: "ConflictError",
          conflict: {
            of,
            the,
            expected: cause, // the cause the client asserted was current
            actual: hash(current), // the replica's current state
          },
        };
      }
    }
  }
}
// All causes match - apply transaction atomically
```

**Retry guidance:** On conflict, clients SHOULD re-read the conflicting facts
and rebuild the transaction using the new causes (and re-issue any dependent
`Claim`s), then retry.

**Current implementation:** Conflicts are returned as a structured
`ConflictError` including `expected` and `actual` facts (and may include a
history) as defined in `runtime/memory/interface.ts`.

---

### 5.10 Future: Enhanced Commit Model

The following sections describe planned enhancements to support offline
operation, stacked commits, and relaxed validation. These build on the current
CAS model.

#### 5.10.1 Client Commit Structure (Enhanced)

Future commits explicitly track confirmed vs pending references:

```typescript
// Shown at module scope.
interface ClientCommit {
  reads: {
    // From heap - confirmed, has real since
    confirmed: Array<{
      address: Address;
      hash: Hash;
      since: number;
    }>;

    // From nursery - pending, referenced by commit hash
    pending: Array<{
      address: Address;
      hash: Hash; // Provisional (may change)
      fromCommit: Reference<Commit>;
    }>;
  };

  writes: Array<{
    address: Address;
    value: JSONValue;
    cause: Hash;
  }>;

  codeCID?: Reference<CodeBundle>;
  activity?: ReceiptActivity;
}
```

#### 5.10.2 Relaxed Validation Rules (Future)

**Relaxed validation** allows `since`-based comparison instead of strict CAS:

1. **For reads**: Record hash AND `since` of what was read
2. **For writes**: CAS only when causally dependent on prior value

**Validation rule:**

```
A commit is valid if for all overlapping entities:
  new_commit.reads[entity].since >= prior_commit.writes[entity].since
```

This means: "my inputs are at least as fresh as whatever the current state was
based on." Freshness is determined by `since`, not hash ancestry.

#### 5.10.3 Commit Log Entry Structure (Future)

The commit log preserves both original submission and server resolution:

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

**Why hashes can differ:** The hash of a fact includes its `cause`. If the cause
was provisional (from nursery), the final hash changes when resolved.

### 5.11 Document → Commit Provenance

Clients must always know which commit produced any document they receive. This
enables:

- **Auditability**: Trace how any data was computed
- **Verification**: Check the authorization and code that produced the data
- **Reactivity**: Know when upstream data has changed

**The `since` field as provenance link:**

All facts produced by a commit share the same `since` value. This creates a
direct relationship:

```
Document (fact) → since=N → Commit with since=N
```

Given any fact, the client can find the producing commit by querying for the
commit fact with matching `since`:

```sql
SELECT * FROM fact
WHERE the = 'application/commit+json' AND of = :space AND since = :fact_since
```

**Subscription and query protocol:**

Implementations SHOULD ensure that when data is returned, the client can also
obtain the commit(s) that produced it without requiring an additional bespoke
API:

- **Subscription updates** MAY deliver the producing commit alongside data
  changes.
- **Query responses** MAY include producing commits, or clients MAY look them up
  by `since`.

When provided, this property means clients have provenance for data they
receive without needing a separate commit-fetching API.

**Scheduler staleness detection:**

The scheduler uses commit activity (path-level reads/writes) to determine
whether data is current:

1. **Path-level `since` tracking**: The scheduler tracks `since` for each path
   it reads. When a commit arrives with writes to a specific path, only
   computations reading that exact path are invalidated.

2. **Compare `since` values**: If the scheduler has data at path P with
   `since=N`, and sees a commit with `since=M` where `M > N` that writes to
   path P, only that path is stale.

3. **Efficient invalidation**: Without path-level granularity, any change to
   entity X would invalidate ALL computations touching ANY part of X. Path
   tracking enables precise, minimal re-computation.

This works with the current CAS-based commit semantics. The key requirement is
activity tracking in commits (address-level reads/writes) to know which paths
changed.

**Client verification:**

For any document received, the client can:

1. Look up the commit by `since`
2. Verify the commit's signature and authorization
3. Check the `codeCID` to see what code produced it
4. Examine the commit's `reads` to trace input provenance

This gives clients end-to-end visibility into how their data was computed.

### 5.12 Efficient Commit Lookup

To efficiently find commits by `since`, the storage layer should maintain:

1. **Index on `(the, since)`**: For fast commit lookup by sequence number
2. **Or a dedicated commit table**: Mapping `since → commit reference`

Current implementation uses SQLite with an index on `since`. Adding a compound
index optimizes the common query pattern:

```sql
-- Fast commit lookup
CREATE INDEX fact_the_since ON fact (the, since);
```

This enables O(log n) lookup of any commit by its `since` value.

---

Prev: `docs/specs/verifiable-execution/01-foundations.md`  
Next: `docs/specs/verifiable-execution/03-capabilities-api.md`
