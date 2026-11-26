import { expect } from "@std/expect";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import {
  findIndexedPiece,
  PatternIndexStore,
  patternIndexStoreDir,
  patternIndexStoreRoot,
} from "../src/store.ts";

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

    it("throws recording a chain before any membership", async () => {
      const store = new PatternIndexStore(join(dir, "store"));
      await expect(store.recordChain(signer.did(), [])).rejects.toThrow(
        "No index membership",
      );
    });

    it("answers one 32-byte slot key however often or concurrently it is asked", async () => {
      const store = new PatternIndexStore(join(dir, "slots"));

      const [a, b] = await Promise.all([store.slotKey(), store.slotKey()]);
      const again = await store.slotKey();

      expect(a.length).toBe(32);
      expect(b).toEqual(a);
      expect(again).toEqual(a);
      expect([...Deno.readDirSync(join(dir, "slots"))].map((e) => e.name))
        .toEqual(["slot.key"]);
    });

    it("throws for a slot key file that is not 32 bytes", async () => {
      const store = new PatternIndexStore(join(dir, "short"));
      await store.slotKey();
      await Deno.writeFile(join(dir, "short", "slot.key"), new Uint8Array(3));

      await expect(store.slotKey()).rejects.toThrow("is not a slot key");
    });

    it("remembers that it told the person this machine has not joined, and that the index keeps versions", async () => {
      const store = new PatternIndexStore(join(dir, "markers"));

      expect(await store.notedNotJoined()).toBe(false);
      expect(await store.keepsVersions()).toBe(false);
      await store.recordNotedNotJoined();
      await store.recordKeepsVersions();

      expect(await store.notedNotJoined()).toBe(true);
      expect(await store.keepsVersions()).toBe(true);
    });

    it("throws, making no key, when the slot key's place holds a link to nothing", async () => {
      const store = new PatternIndexStore(join(dir, "dangling"));
      await store.slotKey();
      await Deno.remove(join(dir, "dangling", "slot.key"));
      await Deno.symlink(
        join(dir, "nowhere"),
        join(dir, "dangling", "slot.key"),
      );

      await expect(store.slotKey()).rejects.toThrow(Deno.errors.AlreadyExists);
      expect([...Deno.readDirSync(join(dir, "dangling"))].map((e) => e.name))
        .toEqual(["slot.key"]);
    });

    it("throws, rather than answering no, when its markers or slot key cannot be read", async () => {
      const store = new PatternIndexStore(join(dir, "locked"));
      await store.slotKey();
      await Deno.chmod(join(dir, "locked"), 0o000);
      try {
        await expect(store.notedNotJoined()).rejects.toThrow(
          Deno.errors.PermissionDenied,
        );
        await expect(store.keepsVersions()).rejects.toThrow(
          Deno.errors.PermissionDenied,
        );
        await expect(store.slotKey()).rejects.toThrow(
          Deno.errors.PermissionDenied,
        );
      } finally {
        await Deno.chmod(join(dir, "locked"), 0o700);
      }
    });

    it("returns the root key it created, and none before", async () => {
      const store = new PatternIndexStore(join(dir, "store"));
      expect(await store.rootKey()).toBeUndefined();
      const created = await store.createRootKey();
      expect((await store.rootKey())?.did()).toBe(created.did());
    });

    it("returns the pending root move it recorded until it is cleared", async () => {
      const store = new PatternIndexStore(join(dir, "store"));
      expect(await store.pendingRootMove()).toBeUndefined();
      await store.recordPendingRootMove("bafy-move");
      expect(await store.pendingRootMove()).toBe("bafy-move");
      await store.recordPendingRootMove(undefined);
      expect(await store.pendingRootMove()).toBeUndefined();
      // Clearing what is already clear is not an error.
      await store.recordPendingRootMove(undefined);
    });

    it("returns each entry's latest published id and the entry behind any of its ids", async () => {
      const store = new PatternIndexStore(join(dir, "store"));
      const entry = join(dir, "src", "main.tsx");
      expect(await store.lastPublished(entry)).toBeUndefined();
      await store.recordPublished(entry, "id-1");
      await store.recordPublished(entry, "id-2");
      await store.recordPublished(entry, "id-2");
      expect(await store.lastPublished(entry)).toBe("id-2");
      expect(await store.entryFor("id-1")).toBe(entry);
      expect(await store.entryFor("id-none")).toBeUndefined();
      const published = JSON.parse(
        await Deno.readTextFile(join(dir, "store", "published.json")),
      );
      expect(published.entries[entry]).toEqual(["id-1", "id-2"]);
    });

    it("throws for a membership record of another shape", async () => {
      const store = new PatternIndexStore(join(dir, "store"));
      await Deno.mkdir(store.dir, { mode: 0o700 });
      await Deno.writeTextFile(
        join(store.dir, "membership.json"),
        JSON.stringify({ format: "other" }),
      );
      await expect(store.membership()).rejects.toThrow(
        "not a pattern index membership record",
      );
    });

    it("throws for a publish record of another shape", async () => {
      const store = new PatternIndexStore(join(dir, "store"));
      await Deno.mkdir(store.dir, { mode: 0o700 });
      await Deno.writeTextFile(join(store.dir, "published.json"), "[]");
      await expect(store.lastPublished("x")).rejects.toThrow(
        "not a pattern index publish record",
      );
    });

    it("throws for a record that is not JSON", async () => {
      const store = new PatternIndexStore(join(dir, "store"));
      await Deno.mkdir(store.dir, { mode: 0o700 });
      await Deno.writeTextFile(join(store.dir, "published.json"), "{");
      await expect(store.indexedPiece("p")).rejects.toThrow("is not JSON");
    });

    it("throws, rather than reading nothing, where a record is unreadable", async () => {
      // Each record is a directory here, which no read of a file gets past.
      const store = new PatternIndexStore(join(dir, "store"));
      for (
        const name of [
          "root.key",
          "published.json",
          join("pending-root-move", "inside"),
        ]
      ) {
        await Deno.mkdir(join(store.dir, name), {
          recursive: true,
          mode: 0o700,
        });
      }
      await Deno.chmod(store.dir, 0o700);
      await expect(store.rootKey()).rejects.toThrow();
      await expect(store.lastPublished("x")).rejects.toThrow();
      await expect(store.pendingRootMove()).rejects.toThrow();
      await expect(store.recordPendingRootMove(undefined)).rejects.toThrow();
    });

    it("throws for a store path below a file", async () => {
      const file = join(dir, "file");
      await Deno.writeTextFile(file, "");
      await expect(new PatternIndexStore(join(file, "store")).membership())
        .rejects.toThrow();
    });

    it("throws for a store path that is a file", async () => {
      const file = join(dir, "file");
      await Deno.writeTextFile(file, "");
      await expect(new PatternIndexStore(file).pendingRootMove()).rejects
        .toThrow("must be a directory");
    });
  });

  describe("patternIndexStoreRoot()", () => {
    it("returns the XDG state directory, then the home state directory", () => {
      expect(
        patternIndexStoreRoot((key) =>
          key === "XDG_STATE_HOME"
            ? "/xdg"
            : key === "HOME"
            ? "/home/u"
            : undefined
        ),
      ).toBe("/xdg/commonfabric/pattern-index");
      expect(
        patternIndexStoreRoot((key) => key === "HOME" ? "/home/u" : undefined),
      ).toBe("/home/u/.local/state/commonfabric/pattern-index");
    });

    it("throws with no variable to place it by", () => {
      expect(() => patternIndexStoreRoot(() => undefined)).toThrow(
        "CF_PATTERN_INDEX_HOME",
      );
    });
  });

  describe("patternIndexStoreDir()", () => {
    it("returns one directory per index host under the store root", () => {
      const env = (key: string) =>
        key === "CF_PATTERN_INDEX_HOME" ? "/state/index" : undefined;
      expect(patternIndexStoreRoot(env)).toBe("/state/index");
      expect(patternIndexStoreDir("https://index.test:8443/api", env)).toBe(
        "/state/index/index.test:8443",
      );
    });
  });

  describe("findIndexedPiece()", () => {
    it("returns undefined for a store root that does not exist", async () => {
      expect(await findIndexedPiece(join(dir, "absent"), "fid1:p"))
        .toBeUndefined();
    });

    it("throws for a store root that is a file", async () => {
      const file = join(dir, "file");
      await Deno.writeTextFile(file, "");
      await expect(findIndexedPiece(file, "fid1:p")).rejects.toThrow();
    });

    it("returns the store of whichever index recorded the piece", async () => {
      const staging = new PatternIndexStore(join(dir, "staging.test"));
      await new PatternIndexStore(join(dir, "index.test")).recordIndexedPiece(
        "fid1:other",
        "id-other",
      );
      await staging.recordIndexedPiece("fid1:piece", "id-1");
      // A file beside the stores is not one.
      await Deno.writeTextFile(join(dir, "notes.txt"), "");
      const found = await findIndexedPiece(dir, "fid1:piece");
      expect(found?.patternId).toBe("id-1");
      expect(found?.store.dir).toBe(staging.dir);
      expect(await findIndexedPiece(dir, "fid1:none")).toBeUndefined();
    });
  });
});
