import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { type DIDKey, Identity, issueDelegation } from "@commonfabric/identity";

import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";

const owner = await Identity.fromPassphrase("v2-emulate owner");
const guest = await Identity.fromPassphrase("v2-emulate guest");
const spaceKey = await Identity.fromPassphrase("v2-emulate space");
const space = spaceKey.did();

describe("EmulatedStorageManager", () => {
  describe("instance members", () => {
    describe("delegationChainFor()", () => {
      it("returns a copy of the chain added over a space, and nothing for another space", async () => {
        const toOwner = await issueDelegation(spaceKey, {
          aud: owner.did(),
          sub: space as DIDKey,
          cmd: "/memory",
          pol: [],
        });
        const toGuest = await issueDelegation(owner, {
          aud: guest.did(),
          sub: space as DIDKey,
          cmd: "/memory",
          pol: [],
        });
        const chain = [toOwner.bytes, toGuest.bytes];
        const storage = EmulatedStorageManager.emulate({ as: guest });
        try {
          expect(storage.delegationChainFor(space)).toBeUndefined();
          await storage.addDelegationChain(chain);

          const held = storage.delegationChainFor(space);
          expect(held).toEqual(chain);
          held?.[0].fill(0);
          expect(storage.delegationChainFor(space)).toEqual(chain);
          expect(storage.delegationChainFor(owner.did())).toBeUndefined();
        } finally {
          await storage.close();
        }
      });
    });
  });
});
