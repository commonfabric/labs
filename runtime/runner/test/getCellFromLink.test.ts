import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("runner-get-cell-from-link");
const space = signer.did();

describe("getCellFromLink()", () => {
  // The entry point every caller holding a link reaches a cell through. It
  // accepts three shapes — a sigil `CellLink`, a `NormalizedFullLink`, and a
  // plain object carrying a full link's fields — and turns anything else into
  // a throw. These cases pin that admission rule from both sides, because
  // whether the rejecting branches run is otherwise a property of which other
  // tests happen to share the process rather than of the code.

  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const fullLink = () => ({
    space,
    id: "of:get-cell-from-link" as `${string}:${string}`,
    path: [] as string[],
    type: "application/json",
  });

  describe("the shapes it admits", () => {
    it("returns a cell for a normalized full link", () => {
      const cell = runtime.getCellFromLink({ ...fullLink(), scope: "space" });
      expect(cell.getAsNormalizedFullLink().id).toBe("of:get-cell-from-link");
      expect(cell.getAsNormalizedFullLink().space).toBe(space);
    });

    it("returns a cell for a link-shaped object that names no scope", () => {
      // A plain object carrying the link's fields is admitted, and an absent
      // scope takes the default rather than travelling as `undefined`. That
      // is the only scope the shape test lets through besides a cell scope,
      // so it is the only way the defaulting arm is reached.
      const cell = runtime.getCellFromLink(fullLink());
      expect(cell.getAsNormalizedFullLink().scope).toBe("space");
    });

    it("returns a cell for a sigil link", () => {
      const source = runtime.getCellFromLink({ ...fullLink(), scope: "space" });
      const cell = runtime.getCellFromLink(source.getAsLink());
      expect(cell.getAsNormalizedFullLink().id).toBe("of:get-cell-from-link");
    });
  });

  describe("the shapes it refuses", () => {
    // Each of these reaches the link-shape test with something it cannot
    // read, so the shape test returns false and no branch produces a link.

    it("throws for a string", () => {
      expect(() =>
        runtime.getCellFromLink(
          "of:get-cell-from-link" as unknown as Parameters<
            Runtime["getCellFromLink"]
          >[0],
        )
      ).toThrow("Invalid cell link");
    });

    it("throws for `null`", () => {
      expect(() =>
        runtime.getCellFromLink(
          null as unknown as Parameters<Runtime["getCellFromLink"]>[0],
        )
      ).toThrow("Invalid cell link");
    });

    it("throws for an object carrying none of a link's fields", () => {
      expect(() =>
        runtime.getCellFromLink(
          { nothing: "here" } as unknown as Parameters<
            Runtime["getCellFromLink"]
          >[0],
        )
      ).toThrow("Invalid cell link");
    });

    it("throws for a link-shaped object whose scope is not a cell scope", () => {
      // `any` is a schema scope rather than a cell scope, so the shape test
      // does not read this as a link at all.
      expect(() =>
        runtime.getCellFromLink(
          { ...fullLink(), scope: "any" } as unknown as Parameters<
            Runtime["getCellFromLink"]
          >[0],
        )
      ).toThrow("Invalid cell link");
    });

    it("throws for a link-shaped object whose `path` is not an array", () => {
      expect(() =>
        runtime.getCellFromLink(
          { ...fullLink(), path: "value" } as unknown as Parameters<
            Runtime["getCellFromLink"]
          >[0],
        )
      ).toThrow("Invalid cell link");
    });

    it("throws for a link-shaped object whose scope is `inherit`", () => {
      // Distinct from the refusals above: an unresolved scope is a caller
      // mistake the shape test names rather than a shape it cannot read, so
      // it reports what is wrong instead of the generic refusal.
      expect(() =>
        runtime.getCellFromLink(
          { ...fullLink(), scope: "inherit" } as unknown as Parameters<
            Runtime["getCellFromLink"]
          >[0],
        )
      ).toThrow("resolve scope before creating a full link");
    });
  });
});
