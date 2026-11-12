import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";

import { uiVariant } from "../../src/builder/built-in.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("built-in");
const space = signer.did();

describe("built-in", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  describe("uiVariant()", () => {
    it("returns a `cf-render` node bound to the piece, for the full variant unless told another", () => {
      const piece = runtime.getCell(space, "built-in piece");
      const link = piece.getAsLink({ includeSchema: true });

      expect(uiVariant(piece)).toEqual({
        type: "vnode",
        name: "cf-render",
        props: { variant: "full", $cell: link },
        children: [],
      });
      expect(uiVariant(piece, "chip").props).toEqual({
        variant: "chip",
        $cell: link,
      });
    });

    it("throws for a piece that is not a cell", () => {
      expect(() => uiVariant({ title: "not a cell" })).toThrow(
        "Bidirectionally bound property $cell is not reactive",
      );
    });
  });
});
