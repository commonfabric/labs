import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getPatternRepository,
  getPatternSource,
  isStream,
  NAME,
  Runtime,
} from "@commonfabric/runner";
import type { RuntimeProgram } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("test default pattern");

const defaultPatternProgram: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { handler, pattern, type Cell, type Stream } from 'commonfabric';",
        "const addPiece = handler<{ piece: unknown }, { pieceRegistry: Cell<unknown[]> }>(",
        "  true,",
        "  { type: 'object', properties: { pieceRegistry: { type: 'array', asCell: ['cell'] } } },",
        "  ({ piece }, { pieceRegistry }) => {",
        "    pieceRegistry.push(piece);",
        "  },",
        ");",
        "export default pattern<",
        "  { pieceRegistry: unknown[] },",
        "  { pieceRegistry: unknown[]; addPiece: Stream<{ piece: unknown }> }",
        ">(({ pieceRegistry }) => ({",
        "  pieceRegistry,",
        "  addPiece: addPiece({ pieceRegistry }),",
        "}));",
      ].join("\n"),
    },
  ],
};

describe("PiecesController.ensureDefaultPattern", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let controller: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      // Use a fake URL since we won't actually fetch patterns in unit tests
      apiUrl: new URL("http://localhost:9999"),
      storageManager,
    });

    const session = await createSession({
      identity: signer,
      spaceName: "test-space-" + crypto.randomUUID(),
    });
    controller = new PiecesController(session, runtime);
    await controller.synced();
  });

  afterEach(async () => {
    try {
      await controller?.dispose();
    } catch {
      // Already disposed
    }
    await storageManager?.close();
  });

  it("should throw if pattern server is unavailable", async () => {
    // The fake URL should cause pattern loading to fail
    // The error can be either a network error or our wrapped error
    await expect(controller.ensureDefaultPattern()).rejects.toThrow();
  });

  it("should not have defaultPattern initially", async () => {
    const pattern = await controller.getDefaultPattern();
    expect(pattern).toBeUndefined();
  });

  it("should link defaultPattern cell successfully", async () => {
    // This test verifies that linkDefaultPattern works correctly
    // Note: Creating an actual working pattern requires the pattern server

    // Create a mock piece cell
    const mockPieceCell = runtime.getImmutableCell(
      controller.getSpace(),
      { name: "MockDefaultPattern" },
    );

    // Link it as the default pattern
    await controller.linkDefaultPattern(mockPieceCell);

    // Verify the link exists by checking the space cell directly
    const spaceCell = runtime.getCell(
      controller.getSpace(),
      controller.getSpace(),
    );
    const defaultPatternCell = spaceCell.key("defaultPattern");
    // The cell should have a reference linked
    const value = defaultPatternCell.get();
    expect(value).toBeDefined();
    expect(
      defaultPatternCell.asSchema<{ name?: string }>().key("name").get(),
    ).toBe("MockDefaultPattern");
  });

  it("finds the defaultPattern when the schema view projects none of its data", async () => {
    // The stored link's schema requires a field the pattern doc lacks. The
    // space cell's own shaped reader takes precedence over that link schema,
    // and projects none of the doc's data — nothing the reader names is
    // present. The controller's found-decision must not trust such a view: it
    // reads raw.
    const schema = {
      type: "object",
      properties: {
        [NAME]: { type: "string" },
        missing: { type: "string" },
      },
      required: ["missing"],
    } as const;
    const mockPieceCell = runtime.getCell(
      controller.getSpace(),
      "schema-invalid-default-pattern",
      schema,
    );

    await runtime.editWithRetry((tx) => {
      mockPieceCell.withTx(tx).setRawUntyped({
        [NAME]: "MockDefaultPattern",
      });
    });
    await controller.linkDefaultPattern(mockPieceCell);

    // The reader here is the runtime's own `spaceCellSchema` (the
    // controller builds its space cell with no explicit schema): its
    // `defaultPattern` property is a shaped asCell fetch-shape naming only
    // `spaces`/`defaultAppUrl`/`suggestionHistory`/`recordSuggestion`,
    // with no `additionalProperties`. That shape wins the crossing, and the
    // pattern doc carries none of those properties ([NAME] is not among
    // them). `recordSuggestion` is a declared stream, whose handle is minted
    // from the schema alone, so it is the one key the projection holds.
    const linked = controller.getSpaceCellContents().key("defaultPattern")
      .get();
    const projected = linked?.get() as Record<string, unknown> | undefined;
    expect(Object.keys(projected ?? {})).toEqual(["recordSuggestion"]);
    expect(isStream(projected?.recordSuggestion)).toBe(true);

    const defaultPattern = await controller.getDefaultPattern(false);
    expect(defaultPattern).toBeDefined();
    expect(defaultPattern?.get()?.[NAME]).toBe("MockDefaultPattern");
  });

  describe("initial state", () => {
    it("should have no defaultPattern in space cell initially", () => {
      // The space cell should initially have no defaultPattern
      const spaceCell = runtime.getCell(
        controller.getSpace(),
        controller.getSpace(),
      );
      const defaultPatternCell = spaceCell.key("defaultPattern");

      // Initially should be undefined/null
      const initialValue = defaultPatternCell.get();
      expect(initialValue?.get()).toBeUndefined();
    });
  });

  describe("linkDefaultPattern idempotence", () => {
    it("should succeed when linking the same pattern twice", async () => {
      // Create a mock piece cell
      const mockPieceCell = runtime.getImmutableCell(
        controller.getSpace(),
        { name: "MockDefaultPattern" },
      );

      // Link it as the default pattern
      await controller.linkDefaultPattern(mockPieceCell);

      // Link the same pattern again - should be idempotent (no error)
      await controller.linkDefaultPattern(mockPieceCell);

      // Verify the pattern is still linked correctly by checking space cell
      const spaceCell = runtime.getCell(
        controller.getSpace(),
        controller.getSpace(),
      );
      const defaultPatternCell = spaceCell.key("defaultPattern");
      const value = defaultPatternCell.get();
      expect(value).toBeDefined();
      expect(
        defaultPatternCell.asSchema<{ name?: string }>().key("name").get(),
      ).toBe("MockDefaultPattern");
    });

    it("should replace existing pattern when linking a different one", async () => {
      // Create first mock piece cell
      const mockPieceCell1 = runtime.getImmutableCell(
        controller.getSpace(),
        { name: "MockDefaultPattern1" },
      );

      // Create second mock piece cell
      const mockPieceCell2 = runtime.getImmutableCell(
        controller.getSpace(),
        { name: "MockDefaultPattern2" },
      );

      // Link first pattern
      await controller.linkDefaultPattern(mockPieceCell1);

      // Capture first link by serializing
      const spaceCell = runtime.getCell(
        controller.getSpace(),
        controller.getSpace(),
      );
      const defaultPatternCell = spaceCell.key("defaultPattern");
      const firstValue = defaultPatternCell.get();
      expect(firstValue).toBeDefined();
      expect(
        defaultPatternCell.asSchema<{ name?: string }>().key("name").get(),
      ).toBe("MockDefaultPattern1");
      const firstJson = JSON.stringify(firstValue);

      // Link second pattern (replacing first)
      await controller.linkDefaultPattern(mockPieceCell2);

      // Verify second pattern is now linked
      const secondValue = defaultPatternCell.get();
      expect(secondValue).toBeDefined();
      expect(
        defaultPatternCell.asSchema<{ name?: string }>().key("name").get(),
      ).toBe("MockDefaultPattern2");
      const secondJson = JSON.stringify(secondValue);

      // The links should be different (different patterns)
      expect(firstJson).not.toEqual(secondJson);
    });
  });
});

describe("PiecesController.recreateDefaultPattern", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let controller: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      // Use a fake URL since we won't actually fetch patterns in unit tests
      apiUrl: new URL("http://localhost:9999"),
      storageManager,
    });

    const session = await createSession({
      identity: signer,
      spaceName: "test-space-" + crypto.randomUUID(),
    });
    controller = new PiecesController(session, runtime);
    await controller.synced();
  });

  afterEach(async () => {
    try {
      await controller?.dispose();
    } catch {
      // Already disposed
    }
    await storageManager?.close();
  });

  it("should throw if pattern server is unavailable", async () => {
    // The fake URL should cause pattern loading to fail
    await expect(controller.recreateDefaultPattern()).rejects.toThrow();
  });

  it("should unlink existing defaultPattern before creating new one", async () => {
    // Create a mock piece cell and link it as the default pattern
    const mockPieceCell = runtime.getImmutableCell(
      controller.getSpace(),
      { name: "MockDefaultPattern" },
    );
    await controller.linkDefaultPattern(mockPieceCell);

    // Verify it's linked by checking the space cell directly
    const spaceCell = runtime.getCell(
      controller.getSpace(),
      controller.getSpace(),
    );
    const defaultPatternCell = spaceCell.key("defaultPattern");
    expect(defaultPatternCell.get()).toBeDefined();

    // recreateDefaultPattern will fail (no server) but should unlink first
    await expect(controller.recreateDefaultPattern()).rejects.toThrow();

    // Pattern should be unlinked now (unlink happens before the network call)
    // After unlinking, the cell value is set to undefined
    const afterValue = defaultPatternCell.get();
    expect(afterValue).toBeUndefined();
  });

  it("should work even when no defaultPattern exists initially", async () => {
    // Verify no pattern exists by checking the space cell directly
    const spaceCell = runtime.getCell(
      controller.getSpace(),
      controller.getSpace(),
    );
    const defaultPatternCell = spaceCell.key("defaultPattern");
    expect(defaultPatternCell.get()?.get()).toBeUndefined();

    // Should still attempt to create (and fail due to fake server)
    await expect(controller.recreateDefaultPattern()).rejects.toThrow();
  });

  it("should explain storage transaction errors when updating defaultPattern fails", async () => {
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    const storageError = {
      name: "StorageTransactionAborted" as const,
      message: "commit rejected for test",
      reason: new Error("storage reason"),
    };
    let editWithRetryCalls = 0;
    runtime.editWithRetry = ((fn, maxRetries) => {
      editWithRetryCalls++;
      // recreateDefaultPattern first unlinks any existing default, then cold
      // compile writes its cache. This test targets the following transaction:
      // linking the newly-created piece as defaultPattern.
      if (editWithRetryCalls < 3) {
        return originalEditWithRetry(fn, maxRetries);
      }
      return Promise.resolve({
        error: storageError,
      });
    }) as typeof runtime.editWithRetry;

    try {
      await controller.recreateDefaultPattern({
        customProgram: defaultPatternProgram,
      });
      throw new Error("Expected recreateDefaultPattern to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "Updating the default pattern failed",
      );
      expect((error as Error).message).toContain(
        "StorageTransactionAborted",
      );
      expect((error as Error).cause).toBe(storageError);
    } finally {
      runtime.editWithRetry = originalEditWithRetry;
    }
  });

  it("stores an explicitly supplied repository for a custom root", async () => {
    const repository = "https://github.com/commonfabric/labs";
    const piece = await controller.recreateDefaultPattern({
      customProgram: defaultPatternProgram,
      repository,
    });

    expect(getPatternRepository(piece.getCell())).toBe(repository);
    expect((await piece.getPatternRef())?.source.repository).toBe(repository);
    // The repository locator is the custom root's provenance; patternSource
    // stays absent (there is no URL the auto-updater could re-fetch).
    expect(getPatternSource(piece.getCell())).toBeUndefined();
  });

  it("rejects a repository locator without a custom root program", async () => {
    await expect(controller.recreateDefaultPattern({
      repository: "https://github.com/commonfabric/labs",
    })).rejects.toThrow(/only be supplied with a custom program/);
  });

  it("does not stamp patternSource for a custom root without a repository", async () => {
    // A custom program has no URL the auto-updater could re-fetch, and there
    // is no locator to record. Stamping the "custom" placeholder would poison
    // the updater's URL resolution, so the root intentionally stays
    // unstamped (CT-1890).
    const piece = await controller.recreateDefaultPattern({
      customProgram: defaultPatternProgram,
    });

    expect(getPatternSource(piece.getCell())).toBeUndefined();
  });
});
