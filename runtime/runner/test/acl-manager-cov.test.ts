import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { describe, it } from "@commonfabric/test-support/test";
import { ACLManager, SpaceMembersRemainError } from "../src/acl-manager.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("acl manager refusals");
const reader = (await Identity.fromPassphrase("acl manager reader")).did();

/** Runs `body` with an `ACLManager` for a fresh space holding no list. */
const withManager = async (
  body: (acl: ACLManager) => Promise<void>,
): Promise<void> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const space = (await Identity.fromPassphrase(crypto.randomUUID())).did();
    await body(new ACLManager(runtime, space));
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

describe("ACLManager", () => {
  describe("instance members", () => {
    describe("grant()", () => {
      it("throws, and writes no list, for a space with no list", async () => {
        await withManager(async (acl) => {
          await expect(acl.grant(reader, "READ")).rejects.toThrow(
            /^No ACL initialized for space\.$/,
          );
          expect(await acl.get()).toBeNull();
        });
      });

      it("adds the grant to a space's list", async () => {
        await withManager(async (acl) => {
          await acl.set(signer.did(), "OWNER");
          expect(await acl.grant(reader, "READ")).toEqual({
            [signer.did()]: "OWNER",
            [reader]: "READ",
          });
        });
      });
    });

    describe("remove()", () => {
      it("throws, and writes no list, for a space with no list", async () => {
        await withManager(async (acl) => {
          await expect(acl.remove(reader)).rejects.toThrow(
            /^No ACL initialized for space\.$/,
          );
          expect(await acl.get()).toBeNull();
        });
      });
    });

    describe("delete()", () => {
      it("throws, and writes nothing, for a space with no list", async () => {
        await withManager(async (acl) => {
          const error = await acl.delete(signer.did()).catch((e: unknown) => e);
          expect(error).toBeInstanceOf(Error);
          expect(error).not.toBeInstanceOf(SpaceMembersRemainError);
          expect((error as Error).message).toBe(
            "No ACL initialized for space.",
          );
          expect(await acl.getStored()).toBeUndefined();
        });
      });

      it("throws `SpaceMembersRemainError` when the list names another member", async () => {
        await withManager(async (acl) => {
          await acl.set(signer.did(), "OWNER");
          await acl.set(reader, "READ");

          const error = await acl.delete(signer.did()).catch((e: unknown) => e);

          expect(error).toBeInstanceOf(SpaceMembersRemainError);
          expect((error as Error).message).toContain(reader);
          expect(await acl.get()).toEqual({
            [signer.did()]: "OWNER",
            [reader]: "READ",
          });
        });
      });
    });
  });
});
