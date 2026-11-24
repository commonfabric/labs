import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { basename } from "@std/path";

import { Identity } from "@commonfabric/identity";

import {
  IDENTITY_KEYFILE_PREFIX,
  writeTempIdentity,
} from "../temp-identity.ts";

describe("temp-identity", () => {
  // Every test runs against a temporary root of its own, which makes "what
  // this left behind" the entire content of one directory rather than a
  // search through the machine's shared one. `Deno.makeTempFile` reads
  // `TMPDIR` on each call, so redirecting it reaches the keyfile.

  let tempRoot = "";
  let outerTempDir: string | undefined;

  beforeEach(async () => {
    tempRoot = await Deno.makeTempDir({ prefix: "temp-identity-test-" });
    outerTempDir = Deno.env.get("TMPDIR");
    Deno.env.set("TMPDIR", tempRoot);
  });

  afterEach(async () => {
    if (outerTempDir === undefined) {
      Deno.env.delete("TMPDIR");
    } else {
      Deno.env.set("TMPDIR", outerTempDir);
    }
    await Deno.remove(tempRoot, { recursive: true });
  });

  const namesUnderTempRoot = async (): Promise<string[]> => {
    const names: string[] = [];
    for await (const entry of Deno.readDir(tempRoot)) names.push(entry.name);
    return names.sort();
  };

  describe("writeTempIdentity()", () => {
    it("writes a keyfile the identity parses back out of", async () => {
      await using temp = await writeTempIdentity();

      const reloaded = await Identity.fromPkcs8(await Deno.readFile(temp.path));
      expect(reloaded.did()).toBe(temp.identity.did());
    });

    it("names the keyfile after the shared prefix", async () => {
      await using temp = await writeTempIdentity();

      expect(basename(temp.path).startsWith(IDENTITY_KEYFILE_PREFIX)).toBe(
        true,
      );
    });

    it("leaves the temporary directory empty once the binding goes", async () => {
      {
        await using temp = await writeTempIdentity();
        expect(await namesUnderTempRoot()).toEqual([basename(temp.path)]);
      }

      expect(await namesUnderTempRoot()).toEqual([]);
    });

    it("leaves the temporary directory empty after `remove()`", async () => {
      const temp = await writeTempIdentity();
      expect(await namesUnderTempRoot()).toEqual([basename(temp.path)]);

      await temp.remove();

      expect(await namesUnderTempRoot()).toEqual([]);
    });

    it("succeeds on a `remove()` of a keyfile already gone", async () => {
      await using temp = await writeTempIdentity();
      expect(await namesUnderTempRoot()).toEqual([basename(temp.path)]);

      await temp.remove();
      await temp.remove();

      expect(await namesUnderTempRoot()).toEqual([]);
    });

    it("leaves the temporary directory empty when the write fails", async () => {
      // The names are read from inside the failing write, where the keyfile
      // the removal has to reclaim is the one entry under the root.
      const failure = new Error("no space left on device");
      let namesWhileWriting: string[] = [];
      const write = stub(Deno, "writeFile", async () => {
        namesWhileWriting = await namesUnderTempRoot();
        throw failure;
      });
      try {
        await expect(writeTempIdentity()).rejects.toThrow(failure);
      } finally {
        write.restore();
      }

      expect(namesWhileWriting.length).toBe(1);
      expect(await namesUnderTempRoot()).toEqual([]);
    });

    it("reports a removal that fails and lets the caller carry on", async () => {
      const temp = await writeTempIdentity();
      const failure = new Deno.errors.PermissionDenied("read-only file system");
      const remove = stub(Deno, "remove", () => Promise.reject(failure));
      const warn = stub(console, "warn", () => {});
      try {
        await temp.remove();
      } finally {
        remove.restore();
        warn.restore();
      }

      expect(warn.calls.length).toBe(1);
      expect(String(warn.calls[0].args[0])).toContain(temp.path);
      expect(await namesUnderTempRoot()).toEqual([basename(temp.path)]);
    });
  });
});
