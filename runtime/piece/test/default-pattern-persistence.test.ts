import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { entityIdFrom, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { RuntimeProgram } from "../../runner/src/harness/types.ts";
import { createBuilder } from "../../runner/src/builder/factory.ts";
import type { Cell } from "../../runner/src/builder/types.ts";
import { pieceId } from "../src/piece-id.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase(
  "test default pattern persistence",
);

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

const persistedPieceProgram: RuntimeProgram = {
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

async function createDefaultPatternPieceWithResult(pieces: PiecesController) {
  const { commonfabric } = createBuilder();
  const { handler, pattern } = commonfabric;

  const addPiece = handler<
    { piece: Cell<unknown> },
    { pieceRegistry: Cell<Cell<unknown>[]> }
  >(
    true,
    {
      type: "object",
      properties: { pieceRegistry: { type: "array", asCell: ["cell"] } },
    },
    ({ piece }, { pieceRegistry }) => {
      pieceRegistry.push(piece);
    },
  );
  const defaultPattern = pattern<{ pieceRegistry: Cell<unknown>[] }>(
    ({ pieceRegistry }) => ({
      pieceRegistry,
      addPiece: addPiece({ pieceRegistry }),
    }),
  );

  const defaultPatternPiece = await pieces.runPersistent(
    defaultPattern,
    { pieceRegistry: [] },
    "default-pattern-persistence",
  );
  await pieces.linkDefaultPattern(defaultPatternPiece);
  await pieces.runtime.idle();
  await pieces.synced();

  const persistedPattern = pattern<{ value: number }>(({ value }) => ({
    value,
    nested: { value },
  }));
  const persistedPiece = await pieces.runPersistent(
    persistedPattern,
    { value: 42 },
    "persisted-piece",
  );
  await pieces.add([persistedPiece]);
  await pieces.runtime.idle();
  await pieces.synced();

  return persistedPiece;
}

describe("PiecesController default pattern persistence", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const session = createSession({
      identity: signer,
      spaceDid: await runtime.createSpace(),
    });
    pieces = new PiecesController(session, runtime);
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("reads the persisted registry without restarting the default pattern", async () => {
    const { commonfabric } = createBuilder();
    const { handler, pattern } = commonfabric;

    const addPiece = handler<
      { piece: Cell<unknown> },
      { pieceRegistry: Cell<Cell<unknown>[]> }
    >(
      true,
      {
        type: "object",
        properties: { pieceRegistry: { type: "array", asCell: ["cell"] } },
      },
      ({ piece }, { pieceRegistry }) => {
        pieceRegistry.push(piece);
      },
    );
    const defaultPattern = pattern<{ pieceRegistry: Cell<unknown>[] }>(
      ({ pieceRegistry }) => ({
        pieceRegistry,
        addPiece: addPiece({ pieceRegistry }),
      }),
    );

    const defaultPatternPiece = await pieces.runPersistent(
      defaultPattern,
      { pieceRegistry: [] },
      "default-pattern-persistence",
    );
    await pieces.linkDefaultPattern(defaultPatternPiece);
    await pieces.runtime.idle();
    await pieces.synced();

    const persistedPattern = pattern<{ value: number }>(({ value }) => ({
      value,
    }));
    const persistedPiece = await pieces.runPersistent(
      persistedPattern,
      { value: 1 },
      "persisted-piece",
    );
    await pieces.add([persistedPiece]);
    await pieces.stopPiece(defaultPatternPiece);

    // What this test is named for, pinned rather than assumed. `start()` is
    // idempotent and a restarted root serves the same listing, so a restart
    // is invisible in the rows and has to be observed at the call.
    type Startable = { start: (piece: Cell<unknown>) => unknown };
    const startable = runtime as unknown as Startable;
    const realStart = startable.start.bind(runtime);
    const started: Cell<unknown>[] = [];
    startable.start = (piece: Cell<unknown>) => {
      started.push(piece);
      return realStart(piece);
    };

    try {
      const piecesCell = await pieces.getPieceRegistry();
      const ids = piecesCell.get().map((piece) => pieceId(piece)).filter(
        Boolean,
      );

      expect(ids).toContain(pieceId(persistedPiece));
      expect(started).toEqual([]);
    } finally {
      startable.start = realStart;
    }
  });

  it("adds a persisted piece from a fresh runtime", async () => {
    const compiledDefaultPattern = await runtime.patternManager.compilePattern(
      defaultPatternProgram,
      { space: pieces.getSpace() },
    );
    const defaultPatternPiece = await pieces.runPersistent(
      compiledDefaultPattern,
      { pieceRegistry: [] },
      "default-pattern-persistence-fresh",
    );
    await pieces.linkDefaultPattern(defaultPatternPiece);
    await pieces.runtime.idle();
    await pieces.synced();

    // Compile INTO the space so the content-addressed source + compiled docs
    // persist — a fresh runtime recovers the pattern by its `{ identity, symbol }`
    // pointer (there is no longer a meta cell holding the program).
    const compiledPiecePattern = await runtime.patternManager.compilePattern(
      persistedPieceProgram,
      { space: pieces.getSpace() },
    );
    const persistedPiece = await pieces.runPersistent(
      compiledPiecePattern,
      { value: 2 },
      "persisted-piece-fresh",
    );
    await pieces.runtime.idle();
    await pieces.synced();

    const session = createSession({
      identity: signer,
      spaceDid: pieces.getSpace(),
    });
    const freshRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const freshPieces = new PiecesController(session, freshRuntime);

    try {
      await freshPieces.synced();
      const freshPiece = freshRuntime.getCellFromEntityId(
        freshPieces.getSpace(),
        entityIdFrom(pieceId(persistedPiece)!),
      );

      await freshPieces.add([freshPiece]);
      await freshPieces.stopPiece(defaultPatternPiece);

      const piecesCell = await freshPieces.getPieceRegistry();
      const ids = piecesCell.get().map((piece) => pieceId(piece)).filter(
        Boolean,
      );
      const listedPiece = (await freshPieces.getRegisteredPieces()).find((
        piece,
      ) => piece.id === pieceId(persistedPiece));
      const directPiece = await freshPieces.get(
        pieceId(persistedPiece)!,
        false,
      );

      expect(ids.filter((id) => id === pieceId(persistedPiece))).toHaveLength(
        1,
      );
      expect(listedPiece).toBeDefined();
      expect(await listedPiece!.result.get()).toEqual(
        await directPiece.result.get(),
      );
    } finally {
      await freshRuntime.dispose();
    }
  });

  it("registered piece controllers expose the same result root as direct cold lookup", async () => {
    const persistedPiece = await createDefaultPatternPieceWithResult(pieces);
    const id = pieceId(persistedPiece)!;

    const listedPiece = (await pieces.getRegisteredPieces()).find((piece) =>
      piece.id === id
    );
    expect(listedPiece).toBeDefined();

    const directPiece = await pieces.get(id, false);

    expect(await listedPiece!.result.get()).toEqual(
      await directPiece.result.get(),
    );
  });

  it("registered piece controllers resolve result paths like direct cold lookup", async () => {
    const persistedPiece = await createDefaultPatternPieceWithResult(pieces);
    const id = pieceId(persistedPiece)!;

    const listedPiece = (await pieces.getRegisteredPieces()).find((piece) =>
      piece.id === id
    );
    expect(listedPiece).toBeDefined();

    const directPiece = await pieces.get(id, false);

    expect(await listedPiece!.result.get(["value"])).toEqual(
      await directPiece.result.get(["value"]),
    );
    expect(await listedPiece!.result.get(["nested", "value"])).toEqual(
      await directPiece.result.get(["nested", "value"]),
    );
  });
});
