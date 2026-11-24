import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import {
  type Cell,
  isCell,
  type Pattern,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { cfcAtom } from "@commonfabric/api/cfc";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import { pieceId } from "../src/piece-id.ts";

const signer = await Identity.fromPassphrase("test sync pieces");

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

// A piece whose one result property carries a confidentiality atom. Listing the
// registry must not depend on being able to read that property.
function confidentialPattern(): Pattern {
  return {
    argumentSchema: {
      type: "object",
      properties: {
        value: { type: "number" },
      },
    },
    resultSchema: {
      type: "object",
      properties: {
        secret: {
          type: "number",
          ifc: { confidentiality: [cfcAtom.resource("SyncPiecesTestSecret")] },
        },
      },
    },
    derivedInternalCells: [{ partialCause: "secret" }],
    result: {
      secret: { $alias: { partialCause: "secret", path: [] } },
    },
    nodes: [
      {
        module: {
          type: "javascript",
          implementation: (value: number) => value * 2,
        },
        inputs: { $alias: { cell: "argument", path: ["value"] } },
        outputs: { $alias: { partialCause: "secret", path: [] } },
      },
    ],
  };
}

describe("syncPieces", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager,
    });
    const session = createSession({
      identity: signer,
      spaceDid: await runtime.createSpace(),
    });
    pieces = new PiecesController(session, runtime);
    await pieces.synced();

    const defaultPattern = await runtime.patternManager.compilePattern(
      defaultPatternProgram,
      { space: pieces.getSpace() },
    );
    const defaultPatternPiece = await pieces.runPersistent(
      defaultPattern,
      { pieceRegistry: [] },
      "sync-pieces-default-pattern",
    );
    await pieces.linkDefaultPattern(defaultPatternPiece);
    await runtime.idle();
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  async function registerConfidentialPiece(cause: string) {
    const piece = await pieces.runPersistent<{ secret: number }>(
      runtime.unsafeTrustPattern(confidentialPattern(), {
        reason: "sync-pieces test fixture",
      }),
      { value: 21 },
      cause,
    );
    await pieces.add([piece]);
    return piece;
  }

  it("returns a registered piece whose result schema carries a confidentiality atom", async () => {
    const piece = await registerConfidentialPiece("sync-pieces-confidential");

    const registry = await pieces.getPieceRegistry();
    const listed = await pieces.syncPieces(registry);

    expect(listed.map((entry) => pieceId(entry))).toContain(pieceId(piece));
  });

  it("returns the registry entries as cells rather than their values", async () => {
    const piece = await registerConfidentialPiece("sync-pieces-cells");

    const registry = await pieces.getPieceRegistry();
    const listed = await pieces.syncPieces(registry);

    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((entry: Cell<unknown>) => isCell(entry))).toBe(true);
    // Reading the labeled property is a separate act on the entry's own cell,
    // not something the listing carried along.
    expect(piece.get().secret).toBe(42);
  });
});
