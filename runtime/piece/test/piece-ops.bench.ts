import { createSession, Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createBuilder } from "../../runner/src/builder/factory.ts";
import type { Cell } from "../../runner/src/builder/types.ts";
import { pieceId } from "../src/piece-id.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("piece bench");

type BenchEnv = {
  storageManager: ReturnType<typeof StorageManager.emulate>;
  runtime: Runtime;
  pieces: PiecesController;
  piece: Cell<unknown>;
};

async function createBenchEnv(): Promise<BenchEnv> {
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
    "piece-bench-default-pattern",
  );
  await pieces.linkDefaultPattern(defaultPatternPiece);
  await pieces.runtime.idle();
  await pieces.synced();

  const increment = handler<void, { value: number }>(
    true,
    true,
    (_, { value }) => {
      value++;
    },
  );
  const counterPattern = pattern<{ value: number }>(
    ({ value }) => ({
      value,
      increment: increment({ value }),
    }),
  );
  const piece = await pieces.runPersistent(
    counterPattern,
    { value: 0 },
    "piece-bench-counter",
  );
  await pieces.add([piece]);

  return { storageManager, runtime, pieces, piece };
}

const env = await createBenchEnv();

Deno.bench(
  "PiecesController.ensureDefaultPattern(existing)",
  async () => {
    await env.pieces.ensureDefaultPattern();
  },
);

Deno.bench(
  "PiecesController.startPiece(existing)",
  async () => {
    await env.pieces.stopPiece(env.piece);
    await env.pieces.startPiece(env.piece);
  },
);

Deno.bench(
  "PiecesController.get(runIt=true)",
  async () => {
    await env.pieces.stopPiece(env.piece);
    await env.pieces.get(pieceId(env.piece)!, true);
  },
);
