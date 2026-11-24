/**
 * The `Runtime` methods that reach a capability `IStorageManager` declares
 * optional, over a storage manager with the capability and over one without
 * it.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { delegationsCause, Runtime } from "../src/runtime.ts";
import type { IStorageManager } from "../src/storage/interface.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";

const signer = await Identity.fromPassphrase("runtime storage capabilities");

describe("runtime storage capabilities", () => {
  let server: MemoryV2Server.Server;
  let storageManager: EmulatedStorageManager;
  let runtime: Runtime;

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    storageManager = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
    await server.close();
  });

  /** The storage manager, typed as the interface that makes its
   * capabilities optional, so a case can take one away. */
  const capabilities = (): IStorageManager => storageManager;

  describe("createSpace()", () => {
    it("returns a new space, and throws once the storage manager cannot create one", async () => {
      const space = await runtime.createSpace();
      expect(space.startsWith("did:key:")).toBe(true);

      capabilities().createSpace = undefined;
      await expect(runtime.createSpace()).rejects.toThrow(
        "This storage manager cannot create spaces",
      );
    });
  });

  describe("createSelfOwnedSpace()", () => {
    it("throws for an owner that is not a `did:key`, and not for one that is", async () => {
      await expect(
        runtime.createSelfOwnedSpace({ owner: "did:web:example.test" }),
      ).rejects.toThrow("A delegation names a did:key");

      const { space } = await runtime.createSelfOwnedSpace({
        owner: signer.did(),
      });
      expect(space.startsWith("did:key:")).toBe(true);
    });

    it("throws once the storage manager cannot create a space that owns itself", async () => {
      capabilities().createSelfOwnedSpace = undefined;
      await expect(runtime.createSelfOwnedSpace()).rejects.toThrow(
        "This storage manager cannot create a space that owns itself",
      );
    });
  });

  describe("spaceKind()", () => {
    it("returns the kind a space declares, and throws once the storage manager cannot read one", async () => {
      const space = await runtime.createSpace({ spaceKind: "probe-kind" });
      expect(await runtime.spaceKind(space)).toBe("probe-kind");

      capabilities().spaceKind = undefined;
      await expect(runtime.spaceKind(space)).rejects.toThrow(
        "This storage manager cannot read a space's kind",
      );
    });
  });

  describe("loadProfileDelegations()", () => {
    /** Lists a self-owned space as a profile in Home after `others`, beside
     * the delegation its key issued to this runtime's, as `inSpace()`
     * records it. */
    const listSelfOwnedProfile = async (
      others: readonly unknown[] = [],
    ): Promise<void> => {
      const { space, delegation } = await runtime.createSelfOwnedSpace();
      const written = await runtime.editWithRetry((tx) => {
        const home = runtime.getHomeSpaceCell(tx);
        runtime.getCell(home.space, delegationsCause(space), undefined, tx)
          .set({ delegations: [new FabricBytes(delegation)] });
        home.key("defaultPattern").set({
          profiles: [
            ...others,
            runtime.getCell(space, "profile", undefined, tx),
          ],
        });
      });
      expect(written.error).toBeUndefined();
    };

    it("holds the delegation Home records for a profile", async () => {
      await listSelfOwnedProfile();
      expect(await runtime.loadProfileDelegations()).toBe(1);
    });

    it("passes over a profile entry that is not a link", async () => {
      await listSelfOwnedProfile([42]);
      expect(await runtime.loadProfileDelegations()).toBe(1);
    });

    it("returns 0 when the storage manager cannot hold a delegation", async () => {
      await listSelfOwnedProfile();
      capabilities().addDelegationChain = undefined;
      expect(await runtime.loadProfileDelegations()).toBe(0);
    });
  });

  describe("spaceExists()", () => {
    it("returns `true` for a DID the runtime is refused access to, and `false` for one it is not", async () => {
      const refused = (await Identity.fromPassphrase("refused space"))
        .did();
      const unknown = (await Identity.fromPassphrase("unknown space"))
        .did();
      capabilities().authorizationError = (space) =>
        space === refused ? new Error("refused") : undefined;

      expect(await runtime.spaceExists(unknown)).toBe(false);
      expect(await runtime.spaceExists(refused)).toBe(true);
    });
  });
});
