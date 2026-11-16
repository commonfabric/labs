import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { PatternIndexStore } from "../src/store.ts";

const signer = await Identity.fromPassphrase("store signer");

describe("store", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await Deno.makeTempDir();
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true });
  });

  describe("PatternIndexStore", () => {
    it("throws reading or writing a store directory others can read", async () => {
      const open = join(dir, "open");
      await Deno.mkdir(open, { mode: 0o755 });
      await Deno.chmod(open, 0o755);
      const store = new PatternIndexStore(open);
      await expect(store.membership()).rejects.toThrow("0700");
      await expect(store.createRootKey()).rejects.toThrow("0700");
    });

    it("throws for a store directory that is a symbolic link", async () => {
      const real = join(dir, "real");
      await Deno.mkdir(real, { mode: 0o700 });
      await Deno.symlink(real, join(dir, "link"));
      await expect(new PatternIndexStore(join(dir, "link")).rootKey()).rejects
        .toThrow("symbolic link");
    });

    it("drops the chains held when the membership's root changes, and keeps them otherwise", async () => {
      const store = new PatternIndexStore(join(dir, "store"));
      const first = await Identity.fromPassphrase("store root one");
      const second = await Identity.fromPassphrase("store root two");
      await store.recordMembership({
        handle: "p-1",
        role: "user",
        root: first.did(),
      });
      await store.recordChain(signer.did(), [new Uint8Array([1])]);
      await store.recordMembership({
        handle: "p-1",
        role: "user",
        root: first.did(),
      });
      expect(await store.chainFor(signer.did())).toHaveLength(1);
      await store.recordMembership({
        handle: "p-1",
        role: "user",
        root: second.did(),
      });
      expect(await store.chainFor(signer.did())).toBeUndefined();
    });

    it("returns the source of an entry only for a file recorded as fetched", async () => {
      const store = new PatternIndexStore(join(dir, "store"));
      await store.recordSource([join(dir, "src", "main.tsx")], "id-1");
      expect(await store.sourceOf(join(dir, "src", "main.tsx"))).toBe("id-1");
      expect(await store.sourceOf(join(dir, "src", "other.tsx")))
        .toBeUndefined();
    });
  });
});
