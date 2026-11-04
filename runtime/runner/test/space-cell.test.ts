/**
 * The space cell is the one cell a space always has. It is addressed
 * deterministically from the space DID rather than looked up in a registry, so
 * two requests for it name the same cell and a space that has never been
 * written to still has one.
 *
 * Its `defaultPattern` property is declared `asCell`, which means a read hands
 * back a cell reference whether or not anything was ever stored there. A fresh
 * space therefore has the reference in hand and nothing behind it, and that
 * gap -- between the reference existing and its target holding a value -- is
 * what the baseline cases distinguish.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime, spaceCellSchema } from "../src/runtime.ts";
import { isCell } from "../src/cell.ts";

const signer = await Identity.fromPassphrase("test space cell");
const space = signer.did();

describe("Runtime.getSpaceCell", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("baseline state for new space", () => {
    it("should return a cell with undefined value for a fresh space", () => {
      const spaceCell = runtime.getSpaceCell(space);
      // A fresh space cell should have no stored data yet
      const value = spaceCell.get();
      expect(value).toBeUndefined();
    });

    it("should return same cell link for same space (identity)", () => {
      const spaceCell1 = runtime.getSpaceCell(space);
      const spaceCell2 = runtime.getSpaceCell(space);
      // Same cell link expected since cause (space DID) is identical
      const link1 = spaceCell1.getAsNormalizedFullLink();
      const link2 = spaceCell2.getAsNormalizedFullLink();
      expect(link1.id).toEqual(link2.id);
      expect(link1.space).toEqual(link2.space);
    });

    it("should have no defaultPattern in a fresh space", () => {
      // When the space cell itself is undefined, accessing defaultPattern
      // via the schema (which has asCell: ["cell"]) returns a Cell reference,
      // but that cell's value should be undefined for a fresh space
      const spaceCell = runtime.getSpaceCell(space);
      const defaultPatternCell = spaceCell.key("defaultPattern");
      // The key accessor returns a cell (due to asCell schema)
      expect(isCell(defaultPatternCell)).toBe(true);
      // But its inner value (the actual referenced cell) should be undefined
      const value = defaultPatternCell.get();
      // In a fresh space, the cell reference exists but its target is undefined
      if (value && isCell(value)) {
        expect(value.get()).toBeUndefined();
      } else {
        // Or the whole value is undefined
        expect(value).toBeUndefined();
      }
    });

    it("should use space DID as both space and cause", () => {
      const spaceCell = runtime.getSpaceCell(space);
      const link = spaceCell.getAsNormalizedFullLink();
      // The space cell uses the space DID as its space
      expect(link.space).toBe(space);
      // The cell ID is deterministic (derived from space DID as cause)
      expect(link.id).toBeDefined();
      expect(typeof link.id).toBe("string");
    });
  });

  describe("persisting defaultPattern", () => {
    it("should persist defaultPattern when set", async () => {
      const spaceCell = runtime.getSpaceCell(space);
      const mockPiece = runtime.getCell(space, "mock-piece");

      // Write requires transaction
      const tx = runtime.edit();
      mockPiece.withTx(tx).set({ name: "TestDefaultPattern" });
      spaceCell.key("defaultPattern").withTx(tx).set(mockPiece);
      await tx.commit().settled;

      // Verify persistence (read doesn't need transaction)
      const spaceCell2 = runtime.getSpaceCell(space);
      const loadedDefaultPattern = spaceCell2.key("defaultPattern");
      const loadedValue = loadedDefaultPattern.get();
      expect(loadedValue).toBeDefined();
      expect(
        loadedDefaultPattern.asSchema<{ name?: string }>().key("name").get(),
      ).toBe("TestDefaultPattern");
    });

    it("should return different space cells for different spaces", async () => {
      // Note: We can only read from other spaces in the same transaction,
      // not write. So this test just verifies that different spaces
      // return cells with different links.
      const signer2 = await Identity.fromPassphrase("test space cell other");
      const space2 = signer2.did();

      const spaceCell1 = runtime.getSpaceCell(space);
      const spaceCell2 = runtime.getSpaceCell(space2);

      const link1 = spaceCell1.getAsNormalizedFullLink();
      const link2 = spaceCell2.getAsNormalizedFullLink();

      // Different spaces should have different links
      expect(link1.space).toBe(space);
      expect(link2.space).toBe(space2);
      expect(link1.space).not.toEqual(link2.space);
    });
  });

  describe("schema handling", () => {
    it("should expose defaultPattern in spaceCellSchema by default", () => {
      // Verify the default schema structure
      const schema = spaceCellSchema as {
        type: string;
        properties: Record<string, unknown>;
      };
      expect(schema.type).toBe("object");
      expect(schema.properties).toHaveProperty("defaultPattern");
      expect(schema.properties.defaultPattern).toHaveProperty("asCell", [
        "cell",
      ]);
    });

    it("should accept custom schema when provided", () => {
      const customSchema = {
        type: "object" as const,
        properties: {
          customField: { type: "string" as const },
        },
      };

      const spaceCell = runtime.getSpaceCell(space, customSchema);
      // Should not throw when using custom schema
      expect(spaceCell).toBeDefined();
    });
  });
});
