import { createSession, type DID, Identity } from "@commonfabric/identity";
import { entityIdFrom, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { RuntimeProgram } from "../../runner/src/harness/types.ts";
import { pieceId } from "../src/piece-id.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("piece cold runtime bench");

const defaultPatternProgram: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { handler, pattern, type Writable } from 'commonfabric';",
        "const addPiece = handler<{ piece: unknown }, { pieceRegistry: Writable<unknown[]> }>(",
        "  ({ piece }, { pieceRegistry }) => {",
        "    pieceRegistry.push(piece);",
        "  },",
        ");",
        "export default pattern<{ pieceRegistry: unknown[] }>(({ pieceRegistry }) => ({",
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

type Seed = {
  storageManager: ReturnType<typeof StorageManager.emulate>;
  space: DID;
};

async function createSeed(): Promise<Seed> {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const session = createSession({
    identity: signer,
    spaceDid: await runtime.createSpace(),
  });
  const pieces = new PiecesController(session, runtime);
  await pieces.synced();

  const compiledDefaultPattern = await runtime.patternManager.compilePattern(
    defaultPatternProgram,
  );
  const defaultPatternPiece = await pieces.runPersistent(
    compiledDefaultPattern,
    { pieceRegistry: [] },
    "piece-cold-runtime-default-pattern",
  );
  await pieces.linkDefaultPattern(defaultPatternPiece);
  await pieces.runtime.idle();
  await pieces.synced();

  const compiledPiecePattern = await runtime.patternManager.compilePattern(
    persistedPieceProgram,
  );
  for (let index = 0; index < 128; index++) {
    await pieces.runPersistent(
      compiledPiecePattern,
      { value: index },
      `piece-cold-runtime-${index}`,
    );
  }

  await runtime.dispose();
  return {
    storageManager,
    space: session.space,
  };
}

async function withFreshPieces<T>(
  seed: Seed,
  run: (env: { runtime: Runtime; pieces: PiecesController }) => Promise<T>,
): Promise<T> {
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: seed.storageManager,
  });
  const session = createSession({
    identity: signer,
    spaceDid: seed.space,
  });
  const pieces = new PiecesController(session, runtime);
  await pieces.synced();
  try {
    return await run({ runtime, pieces });
  } finally {
    await runtime.idle();
    await pieces.synced();
    await runtime.dispose();
  }
}

let nextPieceIndex = 0;

Deno.bench({
  name: "PiecesController.getDefaultPattern(runIt=true, fresh runtime)",
  async fn(b) {
    const seed = await createSeed();
    try {
      await withFreshPieces(seed, async ({ pieces }) => {
        b.start();
        try {
          await pieces.getDefaultPattern(true);
        } finally {
          b.end();
        }
      });
    } finally {
      await seed.storageManager.close();
    }
  },
});

Deno.bench({
  name: "PiecesController.add(single persisted piece, fresh runtime)",
  async fn(b) {
    const storageManager = StorageManager.emulate({
      as: signer,
    });
    const seedRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const seedSession = createSession({
      identity: signer,
      spaceDid: await seedRuntime.createSpace(),
    });
    const seedPieces = new PiecesController(seedSession, seedRuntime);
    await seedPieces.synced();

    try {
      const compiledDefaultPattern = await seedRuntime.patternManager
        .compilePattern(
          defaultPatternProgram,
        );
      const defaultPatternPiece = await seedPieces.runPersistent(
        compiledDefaultPattern,
        { pieceRegistry: [] },
        "piece-cold-runtime-default-pattern",
      );
      await seedPieces.linkDefaultPattern(defaultPatternPiece);
      await seedPieces.runtime.idle();
      await seedPieces.synced();

      const compiledPiecePattern = await seedRuntime.patternManager
        .compilePattern(
          persistedPieceProgram,
        );
      const persistedPiece = await seedPieces.runPersistent(
        compiledPiecePattern,
        { value: nextPieceIndex++ },
        "piece-cold-runtime-add-piece",
      );
      await seedPieces.runtime.idle();
      await seedPieces.synced();

      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const session = createSession({
        identity: signer,
        spaceDid: seedSession.space,
      });
      const pieces = new PiecesController(session, runtime);
      await pieces.synced();

      try {
        const piece = runtime.getCellFromEntityId(
          pieces.getSpace(),
          entityIdFrom(pieceId(persistedPiece)!),
        );
        b.start();
        try {
          await pieces.add([piece]);
        } finally {
          b.end();
        }
      } finally {
        await runtime.idle();
        await pieces.synced();
        await runtime.dispose();
      }
    } finally {
      await seedRuntime.dispose();
      await storageManager.close();
    }
  },
});
