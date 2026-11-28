import { expect } from "@std/expect";
import * as Path from "@std/path";

import { describe, it } from "@commonfabric/test-support/test";

import { discoverSpaceDbs } from "../discover.ts";

const DID_1 = "did:key:zAlphaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const DID_2 = "did:key:zBetaBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("discoverSpaceDbs()", () => {
  // Two DBs in one store directory, the second modified later than the first.
  // Discovery goes by file name, so neither needs to hold a space.
  async function withStore(
    body: (store: string, path1: string, path2: string) => void | Promise<void>,
  ) {
    const store = await Deno.makeTempDir({ prefix: "state-inspector-store-" });
    try {
      const path1 = Path.join(store, `${DID_1}.sqlite`);
      const path2 = Path.join(store, `${DID_2}.sqlite`);
      await Deno.writeTextFile(path1, "");
      await Deno.writeTextFile(path2, "");
      Deno.utimeSync(path1, 1000, 1000);
      Deno.utimeSync(path2, 2000, 2000);
      await body(store, path1, path2);
    } finally {
      await Deno.remove(store, { recursive: true });
    }
  }

  it("lists a DB reached through two roots once, under the first", async () => {
    await withStore(async (store, path1, path2) => {
      const link = `${store}-link`;
      await Deno.symlink(store, link);
      try {
        const viaBoth = discoverSpaceDbs({
          dirs: [store, link],
          defaultRoots: false,
        });
        expect(viaBoth.map((s) => s.path)).toEqual([path2, path1]);
        const viaLink = discoverSpaceDbs({ dirs: [link], defaultRoots: false });
        expect(viaLink.map((s) => s.path)).toEqual([
          Path.join(link, `${DID_2}.sqlite`),
          Path.join(link, `${DID_1}.sqlite`),
        ]);
      } finally {
        await Deno.remove(link);
      }
    });
  });

  it("orders by modification time, newest first", async () => {
    await withStore((store, path1, path2) => {
      const listed = discoverSpaceDbs({ dirs: [store], defaultRoots: false });
      expect(listed.map((s) => [s.path, s.mtimeMs])).toEqual([
        [path2, 2_000_000],
        [path1, 1_000_000],
      ]);
      Deno.utimeSync(path1, 3000, 3000);
      const touched = discoverSpaceDbs({ dirs: [store], defaultRoots: false });
      expect(touched.map((s) => [s.path, s.mtimeMs])).toEqual([
        [path1, 3_000_000],
        [path2, 2_000_000],
      ]);
    });
  });
});
