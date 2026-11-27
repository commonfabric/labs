import { expect } from "@std/expect";
import * as Path from "@std/path";

import { describe, it } from "@commonfabric/test-support/test";

import { resolveListedFiles } from "../listed-files.ts";

describe("listed-files", () => {
  describe("resolveListedFiles()", () => {
    it("returns each file with its real path and size, leaving out one that is gone", async () => {
      const dir = await Deno.realPath(
        await Deno.makeTempDir({ prefix: "state-inspector-listed-" }),
      );
      try {
        const kept = Path.join(dir, "kept.sqlite");
        const gone = Path.join(dir, "gone.sqlite");
        const linked = Path.join(dir, "linked.sqlite");
        await Deno.writeTextFile(kept, "kept");
        await Deno.writeTextFile(gone, "gone");
        await Deno.symlink(kept, linked);
        await Deno.remove(gone);

        const resolved = [...resolveListedFiles([gone, kept, linked])].map((
          { path, real, stat },
        ) => ({ path, real, size: stat.size }));
        expect(resolved).toEqual([
          { path: kept, real: kept, size: 4 },
          { path: linked, real: kept, size: 4 },
        ]);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });
});
