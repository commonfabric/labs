import { createSession, Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createBuilder } from "../../runner/src/builder/factory.ts";
import type { Cell } from "../../runner/src/builder/types.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("piece registration bench");

type BenchEnv = {
  storageManager: ReturnType<typeof StorageManager.emulate>;
  runtime: Runtime;
  pieces: PiecesController;
  detachedPieces: Cell<unknown>[];
};

const createDefaultPattern = () => {
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
  return pattern<{ pieceRegistry: Cell<unknown>[] }>(
    ({ pieceRegistry }) => ({
      pieceRegistry,
      addPiece: addPiece({ pieceRegistry }),
    }),
  );
};

const createCounterPattern = () => {
  const { commonfabric } = createBuilder();
  const { handler, pattern } = commonfabric;
  const increment = handler<void, { value: number }>(
    true,
    true,
    (_, { value }) => {
      value++;
    },
  );
  return pattern<{ value: number }>(
    ({ value }) => ({
      value,
      increment: increment({ value }),
    }),
  );
};

async function createBenchEnv(pieceCount: number): Promise<BenchEnv> {
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

  const defaultPatternPiece = await pieces.runPersistent(
    createDefaultPattern(),
    { pieceRegistry: [] },
    "piece-registration-default-pattern",
  );
  await pieces.linkDefaultPattern(defaultPatternPiece);
  await pieces.runtime.idle();
  await pieces.synced();

  const counterPattern = createCounterPattern();
  const detachedPieces: Cell<unknown>[] = [];
  for (let index = 0; index < pieceCount; index++) {
    const piece = await pieces.runPersistent(
      counterPattern,
      { value: index },
      `piece-registration-${index}`,
    );
    detachedPieces.push(piece);
  }

  await pieces.runtime.idle();
  await pieces.synced();

  return { storageManager, runtime, pieces, detachedPieces };
}

const cleanup = async (env: BenchEnv) => {
  await env.runtime.dispose();
  await env.storageManager.close();
};

Deno.bench("PiecesController.add(single detached piece)", async () => {
  const env = await createBenchEnv(1);
  try {
    await env.pieces.add([env.detachedPieces[0]!]);
  } finally {
    await cleanup(env);
  }
});

Deno.bench("PiecesController.add(four detached pieces)", async () => {
  const env = await createBenchEnv(4);
  try {
    await env.pieces.add(env.detachedPieces);
  } finally {
    await cleanup(env);
  }
});
