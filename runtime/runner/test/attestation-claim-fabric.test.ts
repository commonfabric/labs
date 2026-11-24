// Covers the consistency check in `claim()`: it compares a stored attested
// value (`expected`) against the replica's current value (`actual`) with
// `valueEqual`, the `Fabric`-aware content equality. A `FabricPrimitive`
// keeps its state in private `#fields` with zero enumerable own-props, so
// only a content-aware comparison can tell two distinct same-class instances
// apart; these tests pin the verdicts that depend on that.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { claim } from "../src/storage/transaction/attestation.ts";
import type {
  IAttestation,
  ISpaceReplica,
  State,
} from "../src/storage/interface.ts";

// A replica whose stored state carries `storedValue`. `getDocument` is
// deliberately absent so `claim()` takes its `read`-based `actual` path (the
// `typeof replica.getDocument === "function"` guard is false), reading the
// stored value straight off the attested state rather than an entity document.
const replicaHolding = (storedValue: FabricValue): ISpaceReplica => {
  const state: State = {
    the: "application/json",
    of: "of:attest-claim-fabric",
    is: storedValue,
  };
  return {
    did: () => "did:test:attest" as ReturnType<ISpaceReplica["did"]>,
    get: () => state,
  } as unknown as ISpaceReplica;
};

describe("attestation claim(): Fabric-aware consistency check", () => {
  const address = {
    id: "of:attest-claim-fabric" as const,
    type: "application/json" as const,
    path: [] as string[],
  };

  it("reports ok when the attested value matches the stored value", () => {
    // Two distinct same-content `FabricBytes`: no real change, so the state is
    // consistent.
    const attestation: IAttestation = {
      address,
      value: new FabricBytes(new Uint8Array([1, 2, 3])),
    };
    const replica = replicaHolding(new FabricBytes(new Uint8Array([1, 2, 3])));

    const result = claim(attestation, replica);
    expect(result.ok).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it("reports StateInconsistency when the `FabricValue` actually changed", () => {
    // The attested value and the stored value are distinct `FabricBytes` that
    // differ only in their (private `#fields`) byte content: a genuine change,
    // which must surface as the `StorageTransactionInconsistent` error the
    // check exists to raise.
    const attestation: IAttestation = {
      address,
      value: new FabricBytes(new Uint8Array([1, 2, 3])),
    };
    const replica = replicaHolding(new FabricBytes(new Uint8Array([4, 5, 6])));

    const result = claim(attestation, replica);
    expect(result.error).toBeDefined();
    expect(result.error?.name).toBe("StorageTransactionInconsistent");
  });

  it("treats +0 and -0 as distinct stored values (Object.is semantics)", () => {
    // Stored values are compared with `Object.is` semantics (via
    // `valueEqual`), under which `+0` and `-0` are distinct -- IEEE754 `===`,
    // which conflates them, must play no part in this check.
    const attestation: IAttestation = { address, value: 0 };
    const replica = replicaHolding(-0);

    const result = claim(attestation, replica);
    expect(result.error).toBeDefined();
    expect(result.error?.name).toBe("StorageTransactionInconsistent");
  });
});
