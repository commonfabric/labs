import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import {
  getPatternIdentityRef,
  type MemorySpace,
  Runtime,
} from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";
import type { RuntimeProgram } from "../../runner/src/harness/types.ts";
import { pieceId } from "../src/piece-id.ts";
import { PieceController } from "../src/ops/piece-controller.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("registered pieces fresh replica");

const rootProgram: RuntimeProgram = {
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

const pieceProgram: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "export default pattern<{ value: number }>(({ value }) => ({ value }));",
      ].join("\n"),
    },
  ],
};

describe("pieces-controller", () => {
  // Two sessions over one server, each with a replica of its own: the creator
  // registers a piece, and the reader has loaded nothing of that space when it
  // lists the registry. Its registry pull brings the root and the list, and
  // the piece's own document arrives only on the open that follows.

  let server: ReturnType<typeof newLoopbackServer>;
  let space: MemorySpace;
  let creatorStorage: EmulatedStorageManager;
  let creatorRuntime: Runtime;
  let creator: PiecesController;
  let readerStorage: EmulatedStorageManager;
  let readerRuntime: Runtime;
  let reader: PiecesController;

  beforeEach(async () => {
    server = newLoopbackServer();
    space = signer.did() as MemorySpace;
    creatorStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    creatorRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: creatorStorage,
    });
    creator = new PiecesController(
      createSession({ identity: signer, spaceDid: space }),
      creatorRuntime,
    );
    await creator.synced();
    readerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    readerRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerStorage,
      experimental: { serverExecution: false },
    });
    reader = new PiecesController(
      createSession({ identity: signer, spaceDid: space }),
      readerRuntime,
    );
  });

  afterEach(async () => {
    await readerRuntime?.dispose();
    await creatorRuntime?.dispose();
    await readerStorage?.close();
    await creatorStorage?.close();
    await server?.close();
  });

  it("opens a registered piece whose document a fresh replica loads after the registry", async () => {
    const root = await creator.runPersistent(
      await creatorRuntime.patternManager.compilePattern(rootProgram, {
        space,
      }),
      { pieceRegistry: [] },
      "fresh-replica-root",
    );
    await creator.linkDefaultPattern(root);
    const piece = await creator.runPersistent(
      await creatorRuntime.patternManager.compilePattern(pieceProgram, {
        space,
      }),
      { value: 2 },
      "fresh-replica-piece",
    );
    await creator.add([piece]);
    await creatorRuntime.idle();
    await creator.synced();
    const expected = getPatternIdentityRef(piece);
    expect(expected).toBeDefined();

    const listed = await reader.getRegisteredPieces();
    expect(listed.map((entry) => entry.id)).toEqual([pieceId(piece)]);
    const opened = await reader.getPieceCell(listed[0].getCell(), true);
    expect(getPatternIdentityRef(opened)).toEqual(expected);
    const patternRef = await new PieceController(reader, opened)
      .getPatternRef();
    expect(patternRef?.identity).toBe(expected!.identity);
  });
});
