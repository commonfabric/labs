// A `State` is an address — its media type `the` and its entity `of` — plus
// `is`, the value the address holds. An address holding nothing is that same
// record with `is` absent, which is what the storage layer builds whenever a
// replica has no document for an address it was asked about. These tests pin
// the three places that record is built or read: checking an absent address
// out of a replica so a later write shows up as a change, claiming an absent
// address during transaction consistency checking, and attesting one.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import * as Differential from "../src/storage/differential.ts";
import { attest, claim } from "../src/storage/transaction/attestation.ts";
import type {
  IAttestation,
  IMemoryAddress,
  ISpaceReplica,
  State,
} from "../src/storage/interface.ts";

const TYPE = "application/json" as const;
const ENTITY = "of:address-without-value" as const;

// The identity of the session the checkout batch belongs to — `checkout`'s
// third argument since the differential keys changes per scope INSTANCE, and
// a batch's scope names resolve through its owning session's identity.
const IDENTITY = {
  principal: "did:test:alice",
  sessionId: "session-1",
};

const addressKey = (address: IMemoryAddress) =>
  `${address.scope ?? "space"}:${address.type}:${address.id}`;

// A replica backed by a plain map, holding whatever the caller puts in it.
// `getDocument` is deliberately absent so `claim()` reads the value straight
// off the attested state rather than through an entity document.
const replicaOver = (held: Map<string, State>): ISpaceReplica =>
  ({
    did: () => "did:test:address-without-value",
    get: (address: IMemoryAddress) => held.get(addressKey(address)),
  }) as unknown as ISpaceReplica;

describe("state for an address that holds no value", () => {
  describe("Differential.checkout()", () => {
    it("reports the first write to an absent address as a change from `undefined`", () => {
      const held = new Map<string, State>();
      const memory = {
        get: (address: IMemoryAddress) => held.get(addressKey(address)),
      };
      const written: State = {
        the: TYPE,
        of: ENTITY,
        is: { value: "written" },
      };

      const before = Differential.checkout(memory, [written], IDENTITY);
      held.set(
        addressKey({ id: ENTITY, type: TYPE, path: [] }),
        written,
      );
      const changes = [...before.compare(memory)];

      expect(changes.length).toBe(1);
      expect(changes[0]!.before).toBeUndefined();
      expect(changes[0]!.after).toEqual({ value: "written" });
      expect(changes[0]!.address.id).toBe(ENTITY);
      expect(changes[0]!.address.type).toBe(TYPE);
    });

    it("carries the scope of an absent address into the change it reports", () => {
      const held = new Map<string, State>();
      const memory = {
        get: (address: IMemoryAddress) => held.get(addressKey(address)),
      };
      const written = {
        the: TYPE,
        of: ENTITY,
        scope: "user",
        is: { value: "written" },
      } as State & { scope: "user" };

      const before = Differential.checkout(memory, [written], IDENTITY);
      held.set(
        addressKey({ id: ENTITY, type: TYPE, scope: "user", path: [] }),
        written,
      );
      const changes = [...before.compare(memory)];

      expect(changes.length).toBe(1);
      expect(changes[0]!.address.scope).toBe("user");
      expect(changes[0]!.after).toEqual({ value: "written" });
    });

    it("reports no change when the address holds nothing before and after", () => {
      const held = new Map<string, State>();
      const memory = {
        get: (address: IMemoryAddress) => held.get(addressKey(address)),
      };

      const before = Differential.checkout(
        memory,
        [{ the: TYPE, of: ENTITY }],
        IDENTITY,
      );

      expect([...before.compare(memory)].length).toBe(0);
    });
  });

  describe("claim()", () => {
    const address = { id: ENTITY, type: TYPE, path: [] as string[] };

    it("returns a valueless state when the replica holds nothing and the claim expects nothing", () => {
      const attestation: IAttestation = { address, value: undefined };

      const result = claim(attestation, replicaOver(new Map()));

      expect(result.error).toBeUndefined();
      expect(result.ok).toEqual({ the: TYPE, of: ENTITY });
    });

    it("returns StateInconsistency when the replica holds nothing but the claim expects a value", () => {
      const attestation: IAttestation = {
        address,
        value: { value: "expected" },
      };

      const result = claim(attestation, replicaOver(new Map()));

      expect(result.ok).toBeUndefined();
      expect(result.error?.name).toBe("StorageTransactionInconsistent");
    });
  });

  describe("attest()", () => {
    it("returns an attestation with no value for an address that holds none", () => {
      expect(attest({ the: TYPE, of: ENTITY, scope: "user" })).toEqual({
        address: { id: ENTITY, type: TYPE, path: [], scope: "user" },
        value: undefined,
      });
    });
  });
});
