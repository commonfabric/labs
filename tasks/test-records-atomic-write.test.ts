import { expect } from "@std/expect";
import { join } from "@std/path";

import { replaceFile } from "./test-records-atomic-write.ts";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

describe("test-records-atomic-write", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "test-records-atomic-" });
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  });

  describe("replaceFile()", () => {
    it("writes a file that is not there yet", async () => {
      const path = join(dir, "fresh.txt");

      await replaceFile(path, "hello\n");

      expect(await Deno.readTextFile(path)).toBe("hello\n");
    });

    it("replaces what a file held", async () => {
      const path = join(dir, "held.txt");
      await Deno.writeTextFile(path, "before\n");

      await replaceFile(path, "after\n");

      expect(await Deno.readTextFile(path)).toBe("after\n");
    });

    it("keeps the permissions a file already had", async () => {
      const path = join(dir, "private.txt");
      await Deno.writeTextFile(path, "before\n");
      await Deno.chmod(path, 0o600);

      await replaceFile(path, "after\n");

      expect((await Deno.stat(path)).mode! & 0o777).toBe(0o600);
    });

    it("writes through a link rather than over it", async () => {
      const real = join(dir, "real.txt");
      const link = join(dir, "link.txt");
      await Deno.writeTextFile(real, "before\n");
      await Deno.symlink(real, link);

      await replaceFile(link, "after\n");

      // The link is still a link, and what it points at is what changed.
      expect((await Deno.lstat(link)).isSymlink).toBe(true);
      expect(await Deno.readTextFile(real)).toBe("after\n");
    });

    it("writes what a link with nothing at the end of it names", async () => {
      const missing = join(dir, "missing.txt");
      const link = join(dir, "dangling.txt");
      await Deno.symlink(missing, link);

      await replaceFile(link, "after\n");

      expect((await Deno.lstat(link)).isSymlink).toBe(true);
      expect(await Deno.readTextFile(missing)).toBe("after\n");
    });

    it("creates a file only its owner can read", async () => {
      const path = join(dir, "new.txt");

      await replaceFile(path, "hello\n");

      expect((await Deno.stat(path)).mode! & 0o777).toBe(0o600);
    });

    it("refuses a path it cannot read the state of", async () => {
      const closed = join(dir, "closed");
      await Deno.mkdir(closed);
      await Deno.chmod(closed, 0o000);

      try {
        // Not "there is no file": there is no answer, and writing would
        // be a guess about a file somebody has closed off.
        await expect(replaceFile(join(closed, "f.txt"), "x\n")).rejects
          .toThrow();
      } finally {
        await Deno.chmod(closed, 0o700);
      }
    });

    it("leaves nothing beside the file it wrote", async () => {
      const path = join(dir, "tidy.txt");

      await replaceFile(path, "hello\n");

      const names: string[] = [];
      for await (const entry of Deno.readDir(dir)) names.push(entry.name);
      expect(names).toEqual(["tidy.txt"]);
    });

    it("leaves the file alone when the replacement cannot be written", async () => {
      const path = join(dir, "kept.txt");
      await Deno.writeTextFile(path, "before\n");
      await Deno.chmod(dir, 0o500);

      try {
        await expect(replaceFile(path, "after\n")).rejects.toThrow();
        expect(await Deno.readTextFile(path)).toBe("before\n");
      } finally {
        await Deno.chmod(dir, 0o700);
      }
    });
  });
});
