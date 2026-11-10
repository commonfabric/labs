import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type Delegation,
  DelegationError,
  type DelegationFields,
  Identity,
  issueDelegation,
} from "@commonfabric/identity";

import { DelegationStore } from "../../src/storage/delegation-store.ts";

const space = await Identity.fromPassphrase("delegation-store space");
const owner = await Identity.fromPassphrase("delegation-store owner");
const alice = await Identity.fromPassphrase("delegation-store alice");
const bob = await Identity.fromPassphrase("delegation-store bob");
const carol = await Identity.fromPassphrase("delegation-store carol");

const now = 1_000_000;

const delegate = (
  issuer: Identity,
  aud: Identity,
  fields: Partial<DelegationFields> = {},
) =>
  issueDelegation(issuer, {
    aud: aud.did(),
    sub: space.did(),
    cmd: "/memory",
    pol: [],
    ...fields,
  });

const cids = (chain: readonly { cid: string }[] | undefined) =>
  chain?.map((d) => d.cid);

describe("DelegationStore", () => {
  describe("add()", () => {
    it("returns the decoded chain and holds it once however often it is added", async () => {
      const store = new DelegationStore();
      const root = await delegate(space, alice);
      expect(cids(await store.add([root.bytes]))).toEqual([root.cid]);
      await store.add([root.bytes]);
      expect(cids(store.chainFor(space.did(), alice.did(), now))).toEqual([
        root.cid,
      ]);
    });

    it("returns a chain the caller may change without changing what is held", async () => {
      const store = new DelegationStore();
      const root = await delegate(space, alice);
      // The type says the caller may not; the store does not rely on that.
      const returned = await store.add([root.bytes]) as Delegation[];
      returned.length = 0;
      expect(cids(store.chainFor(space.did(), alice.did(), now))).toEqual([
        root.cid,
      ]);
    });

    it("throws for a chain with a delegation that does not verify", async () => {
      const store = new DelegationStore();
      const root = await delegate(space, alice);
      const forged = root.bytes.slice();
      forged[10] ^= 0xff;
      await expect(store.add([forged])).rejects.toThrow(DelegationError);
    });

    it("throws for a chain whose links do not meet", async () => {
      const store = new DelegationStore();
      const root = await delegate(space, alice);
      const stray = await delegate(carol, bob);
      await expect(store.add([root.bytes, stray.bytes])).rejects.toThrow(
        "not issued by the previous audience",
      );
    });

    it("throws for a chain over no space, or over more than one", async () => {
      const store = new DelegationStore();
      const anywhere = await delegate(space, alice, { sub: null });
      await expect(store.add([anywhere.bytes])).rejects.toThrow(
        "over no space",
      );
      const root = await delegate(space, alice);
      const elsewhere = await delegate(alice, bob, { sub: owner.did() });
      await expect(store.add([root.bytes, elsewhere.bytes])).rejects.toThrow(
        "more than one space",
      );
    });

    it("throws for an empty chain", async () => {
      await expect(new DelegationStore().add([])).rejects.toThrow(
        "the chain is empty",
      );
    });

    it("keeps the bytes it was given, whatever the caller does with its array after", async () => {
      const store = new DelegationStore();
      const root = await delegate(space, alice);
      const bytes = root.bytes.slice();
      await store.add([bytes]);
      bytes.fill(0);
      const [held] = store.chainFor(space.did(), alice.did(), now)!;
      expect(held.bytes).toEqual(root.bytes);
    });
  });

  describe("chainFor()", () => {
    it("returns `undefined` for a space it holds nothing over, or a principal no chain ends at", async () => {
      const store = new DelegationStore();
      expect(store.chainFor(space.did(), alice.did(), now)).toBeUndefined();
      await store.add([(await delegate(space, alice)).bytes]);
      expect(store.chainFor(space.did(), bob.did(), now)).toBeUndefined();
      expect(store.chainFor(alice.did(), alice.did(), now)).toBeUndefined();
    });

    it("returns a chain of two as it was added, root first", async () => {
      const store = new DelegationStore();
      const root = await delegate(space, alice);
      const onward = await delegate(alice, bob);
      await store.add([root.bytes, onward.bytes]);
      expect(cids(store.chainFor(space.did(), bob.did(), now))).toEqual([
        root.cid,
        onward.cid,
      ]);
    });

    it("returns the chain the space itself rooted over one added later that another principal rooted", async () => {
      const store = new DelegationStore();
      const rooted = await delegate(space, alice);
      const viaCarol = await delegate(carol, alice);
      await store.add([rooted.bytes]);
      await store.add([viaCarol.bytes]);
      expect(cids(store.chainFor(space.did(), alice.did(), now))).toEqual([
        rooted.cid,
      ]);
    });

    it("returns the chain added last where none is rooted at the space", async () => {
      // Which of two chains rooted elsewhere the access list grants is the
      // server's to know; the holder's latest addition is taken as its
      // intent, whichever was added first.
      const store = new DelegationStore();
      const viaCarol = await delegate(carol, bob);
      const fromOwner = await delegate(owner, alice);
      const onward = await delegate(alice, bob);
      await store.add([viaCarol.bytes]);
      await store.add([fromOwner.bytes, onward.bytes]);
      expect(cids(store.chainFor(space.did(), bob.did(), now))).toEqual([
        fromOwner.cid,
        onward.cid,
      ]);
      const later = new DelegationStore();
      await later.add([fromOwner.bytes, onward.bytes]);
      await later.add([viaCarol.bytes]);
      expect(cids(later.chainFor(space.did(), bob.did(), now))).toEqual([
        viaCarol.cid,
      ]);
    });

    it("leaves out a chain with a link that has expired, is not yet valid, or does not cover opening a session", async () => {
      const store = new DelegationStore();
      const expired = await delegate(space, alice, { exp: now - 1 });
      const early = await delegate(space, alice, { nbf: now + 100 });
      const transactOnly = await delegate(space, alice, {
        cmd: "/memory/transact",
      });
      await store.add([expired.bytes]);
      await store.add([early.bytes]);
      await store.add([transactOnly.bytes]);
      expect(store.chainFor(space.did(), alice.did(), now)).toBeUndefined();
      expect(cids(store.chainFor(space.did(), alice.did(), now + 100)))
        .toEqual([early.cid]);
    });
  });
});
