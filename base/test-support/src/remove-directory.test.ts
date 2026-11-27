import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it } from "@commonfabric/test-support/test";
import { removeDirectory } from "./remove-directory.ts";

describe("remove-directory", () => {
  describe("removeDirectory()", () => {
    it("removes the directory and everything under it, leaving nothing beside it", async () => {
      const parent = await Deno.makeTempDir({ prefix: "remove-directory-" });
      try {
        const directory = join(parent, "tree");
        await Deno.mkdir(join(directory, "inner"), { recursive: true });
        await Deno.writeTextFile(join(directory, "inner", "file"), "x");
        await removeDirectory(directory);
        expect([...Deno.readDirSync(parent)]).toEqual([]);
      } finally {
        await Deno.remove(parent, { recursive: true });
      }
    });

    it("throws for a directory that is not there", async () => {
      const parent = await Deno.makeTempDir({ prefix: "remove-directory-" });
      try {
        await expect(removeDirectory(join(parent, "absent"))).rejects.toThrow(
          Deno.errors.NotFound,
        );
      } finally {
        await Deno.remove(parent, { recursive: true });
      }
    });
  });
});
