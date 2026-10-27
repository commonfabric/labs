import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  DelegationError,
  type DelegationFields,
  Identity,
  issueDelegation,
} from "@commonfabric/identity";

import { DelegationStore } from "../../src/storage/delegation-store.ts";

const space = await Identity.fromPassphrase("delegation-store space");
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

const cids = (chain: { cid: string }[] | undefined) => chain?.map((d) => d.cid);

describe("DelegationStore", () => {
  describe("add()", () => {
    it("returns the decoded delegation and holds it once however often it is added", async () => {
      const store = new DelegationStore();
      const root = await delegate(space, alice);
      expect((await store.add(root.bytes)).cid).toBe(root.cid);
      await store.add(root.bytes);
      expect(cids(store.chainFor(space.did(), alice.did(), now))).toEqual([
        root.cid,
      ]);
    });

    it("throws for a delegation over no space", async () => {
      const store = new DelegationStore();
      const anywhere = await issueDelegation(space, {
        aud: alice.did(),
        sub: null,
        cmd: "/memory",
        pol: [],
      });
      await expect(store.add(anywhere.bytes)).rejects.toThrow(
        "over no space",
      );
    });

    it("throws for bytes that do not verify", async () => {
      const store = new DelegationStore();
      const root = await delegate(space, alice);
      const forged = root.bytes.slice();
      forged[10] ^= 0xff;
      await expect(store.add(forged)).rejects.toThrow(DelegationError);
    });
  });

  describe("chainFor()", () => {
    it("returns `undefined` for a space it holds nothing over, or a principal nothing reaches", async () => {
      const store = new DelegationStore();
      expect(store.chainFor(space.did(), alice.did(), now)).toBeUndefined();
      await store.add((await delegate(space, alice)).bytes);
      expect(store.chainFor(space.did(), bob.did(), now)).toBeUndefined();
      expect(store.chainFor(alice.did(), alice.did(), now)).toBeUndefined();
    });

    it("returns a chain of two, root first, for a principal reached through another", async () => {
      const store = new DelegationStore();
      const root = await delegate(space, alice);
      const onward = await delegate(alice, bob);
      await store.add(onward.bytes);
      await store.add(root.bytes);
      expect(cids(store.chainFor(space.did(), bob.did(), now))).toEqual([
        root.cid,
        onward.cid,
      ]);
    });

    it("prefers the delegation the space itself issued when several reach the principal", async () => {
      const store = new DelegationStore();
      const viaCarol = await delegate(carol, alice);
      const root = await delegate(space, alice);
      await store.add(viaCarol.bytes);
      await store.add(root.bytes);
      expect(cids(store.chainFor(space.did(), alice.did(), now))).toEqual([
        root.cid,
      ]);
    });

    it("returns a chain that ends at a principal the space did not delegate to, for the server to judge", async () => {
      const store = new DelegationStore();
      const onward = await delegate(alice, bob);
      await store.add(onward.bytes);
      expect(cids(store.chainFor(space.did(), bob.did(), now))).toEqual([
        onward.cid,
      ]);
    });

    it("leaves out a delegation that is not yet valid, or whose command does not cover opening a session", async () => {
      const store = new DelegationStore();
      const early = await delegate(space, alice, { nbf: now + 100 });
      const transactOnly = await delegate(space, alice, {
        cmd: "/memory/transact",
      });
      await store.add(early.bytes);
      await store.add(transactOnly.bytes);
      expect(store.chainFor(space.did(), alice.did(), now)).toBeUndefined();
      expect(cids(store.chainFor(space.did(), alice.did(), now + 100)))
        .toEqual([early.cid]);
    });

    it("keeps the bytes it was given, whatever the caller does with its array after", async () => {
      const store = new DelegationStore();
      const root = await delegate(space, alice);
      const bytes = root.bytes.slice();
      await store.add(bytes);
      bytes.fill(0);
      const [held] = store.chainFor(space.did(), alice.did(), now)!;
      expect(held.bytes).toEqual(root.bytes);
    });

    it("leaves out a delegation that has expired", async () => {
      const store = new DelegationStore();
      const expired = await delegate(space, alice, { exp: now - 1 });
      const current = await delegate(space, alice, { exp: now + 100 });
      await store.add(expired.bytes);
      await store.add(current.bytes);
      expect(cids(store.chainFor(space.did(), alice.did(), now))).toEqual([
        current.cid,
      ]);
    });
  });
});
