import { createSession, Identity } from "@commonfabric/identity";
import {
  applyPieceSourceTransition,
  getPieceSourceRevisions,
  getPieceSourceSnapshot,
  preparePieceSourceTransitionBaseline,
  Runtime,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { holdWorkerLifetimeLock } from "@commonfabric/utils/worker-lifetime";
import { sourceDocKey } from "../../../runner/src/compilation-cache/cell-cache.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";

const SOURCE = "export default 1;\n";
const SOURCE_IDENTITY = "Qxkzi6OeLOLPP3A3-e-8kLe0DyNgoDZMZVIKr4PLz3w";
const MISSING_IDENTITY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const worker = globalThis as unknown as {
  postMessage(value: unknown): void;
  close(): void;
};

const storageManager = StorageManager.emulate({
  as: await Identity.fromPassphrase("piece source transition compiler preload"),
});
const runtime = new Runtime({
  apiUrl: new URL("http://toolshed.test"),
  storageManager,
});

let outcome: { baseline?: string; history?: string[]; error?: string };
try {
  const pieces = new PiecesController(
    createSession({
      identity: storageManager.as as Identity,
      spaceDid: await runtime.createSpace(),
    }),
    runtime,
  );
  await pieces.synced();

  const currentPattern = {
    identity: MISSING_IDENTITY,
    symbol: "default",
  };
  const nextPattern = {
    identity: SOURCE_IDENTITY,
    symbol: "default",
  };
  const piece = runtime.getCell(
    pieces.getSpace(),
    "source-transition-compiler-preload",
  );
  const seedTx = runtime.edit();
  const seededPiece = piece.withTx(seedTx);
  seededPiece.set({});
  seededPiece.setMetaRaw(
    "patternIdentity",
    currentPattern,
    rawMetaWriteAuthorization,
  );
  seededPiece.setMetaRaw(
    "patternSource",
    "https://example.test/missing-pattern.tsx",
    rawMetaWriteAuthorization,
  );
  runtime.getCell(
    pieces.getSpace(),
    sourceDocKey(SOURCE_IDENTITY),
    undefined,
    seedTx,
  ).set({
    kind: "source",
    identity: SOURCE_IDENTITY,
    code: SOURCE,
    filename: "/main.tsx",
    imports: [],
  });
  runtime.prepareTxForCommit(seedTx);
  const seedCommit = await seedTx.commit().settled;
  if (seedCommit.error !== undefined) throw seedCommit.error;

  const expected = getPieceSourceSnapshot(piece);
  if (expected === undefined) throw new Error("piece source snapshot missing");
  const baseline = await preparePieceSourceTransitionBaseline(
    runtime,
    piece,
    expected,
    { allowUnavailable: true },
  );

  const transitionTx = runtime.edit();
  applyPieceSourceTransition(
    runtime,
    piece,
    transitionTx,
    nextPattern,
    {
      revisionId: crypto.randomUUID(),
      baseline,
      timestamp: Date.now(),
      operation: "repoint",
      origin: null,
      expected,
    },
  );
  piece.withTx(transitionTx).setMetaRaw(
    "patternIdentity",
    nextPattern,
    rawMetaWriteAuthorization,
  );
  runtime.prepareTxForCommit(transitionTx);
  const transitionCommit = await transitionTx.commit().settled;
  if (transitionCommit.error !== undefined) throw transitionCommit.error;

  outcome = {
    baseline: baseline.kind,
    history: getPieceSourceRevisions(piece).map((revision) =>
      revision.operation
    ),
  };
} catch (error) {
  outcome = {
    error: error instanceof Error ? error.message : String(error),
  };
}
await runtime.dispose();
await storageManager.close();
worker.postMessage({
  ...outcome,
  lifetimeLock: await holdWorkerLifetimeLock(),
});
worker.close();
