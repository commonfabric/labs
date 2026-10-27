# CF Protocol: Receipt Object (Section 7)

See the [verifiable-execution document map](README.md) for navigation.

## 7. Receipt Object (Future Enhancement)

**Current implementation note:** Today, the system’s “receipt-like” artifact is
the `application/commit+json` fact produced by a transaction. This section
describes a richer receipt envelope intended for future enhancements (policy
commitments, provenance commitments, optional TEEs).

**Conventions:**

- Hash/commitment values are content-addressed digests (see `FabricHash` in
  `base/data-model/src/fabric-primitives/FabricHash.ts`, whose
  tagged string form reads `fid1:…`).
- `refer(x)` refers to the `merkle-reference` hashing function used elsewhere
  in this spec.

```typescript
type Hash = string;
type Bytes = Uint8Array;
```

### 7.1 UnsignedReceipt

The receipt structure extends the current `Fact` model with computation
metadata:

```typescript
// Shown at module scope.
interface UnsignedReceipt {
  // Core fact identity (existing)
  the: MIME;
  of: URI;
  cause: Reference<Fact>;

  // Computation identity (new)
  codeCID: Reference<CodeBundle>; // Content-addressed code bundle

  // Inputs (new)
  inputCommitments: Hash[]; // H(salt || canonical(input))
  inputRefs?: Reference<Fact>[]; // Optional provenance references
  inputLabelCommitments: Hash[]; // refer({ "CT/CFCLabelMap": labelMap })

  // Optional: schema identity for label derivation (new)
  // If label maps are derived from schemas, verifiers need a stable schema identifier.
  inputSchemaCommitments?: Hash[]; // refer({ "CT/Schema": schema })

  // CFC policy (new)
  cfcPolicyCID: Reference<CFCPolicy>; // Content-addressed policy identifier

  // Result
  is?: JSONValue;
  stateHash: Hash; // Hash of resulting state
  outputLabelCommitment: Hash; // refer({ "CT/CFCLabelMap": labelMap })

  // Optional: schema identity for output label derivation (new)
  outputSchemaCommitment?: Hash; // refer({ "CT/Schema": schema })

  // Optional: computation evidence commitments
  cfcResultHash?: Hash; // H("CT/CFCResult" || canonicalResult)
  teeBindingHash?: Hash; // Commitment bound into TEE attestation

  // Metadata
  since: number;
  ts?: number; // Claimed wall-clock time (informational)
  meta?: Record<string, unknown>;
}
```

**Label maps:** In this document, a “label map” is a canonical, path-addressed
representation of IFC labels (often derived from schema annotations such as
`ifc`). Receipts commit to label maps so verifiers can check policy/label
reasoning without requiring disclosure of the labeled values.

### 7.2 Signed Receipts (Future)

A receipt can be made verifiable beyond “server said so” by attaching one or
more signatures.

```typescript
// Shown at module scope.
type ReceiptSignature = {
  iss: DID; // signer identity
  sig: Bytes; // signature bytes (algorithm-specific)
  alg?: string; // optional algorithm identifier (e.g. "Ed25519")
  kid?: string; // optional key identifier
};

type SignedReceipt = {
  receipt: UnsignedReceipt;
  // A signature binds to the content-addressed identity of `receipt`.
  receiptRef: Reference<UnsignedReceipt>;
  signatures: ReceiptSignature[];
};
```

**Signing rule:** `receiptRef` MUST equal `refer(receipt)`. Each signature MUST
verify over the canonical bytes of `receiptRef` (or its string form), as defined
by the signature scheme.

Because `receiptRef` is computed over the entire receipt payload, signatures
bind to the committed `codeCID`, `cfcPolicyCID`, input commitments, and label
map commitments included in the receipt.

**Multi-signer receipts:** A `SignedReceipt` MAY include multiple signatures
from different principals (e.g. user signer, provider signer, policy authority,
TEE attester). Policy determines which signatures are required for a given trust
profile.

### 7.3 Address-Level Tracking

The receipt SHOULD include path-level read/write tracking:

```typescript
// Shown at module scope.
interface ReceiptActivity {
  reads: IMemoryAddress[]; // [{id, type, path}]
  writes: IMemoryAddress[]; // [{id, type, path}]
}

interface IMemoryAddress {
  id: URI; // Entity identifier (corresponds to `of`)
  type: MIME; // Media type (corresponds to `the`)
  path: readonly string[]; // JSON path within the value
}
```

This enables:
- Fine-grained dependency tracking for reactive scheduling
- Minimal invalidation on upstream changes
- Audit trail of exact data accessed

---

Prev: `docs/specs/verifiable-execution/03-capabilities-api.md`  
Next: `docs/specs/verifiable-execution/05-log-and-authorization.md`
