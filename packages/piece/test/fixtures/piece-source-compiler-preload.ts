import { createSession, Identity } from "@commonfabric/identity";
import { getPieceSourceRevisions, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { holdWorkerLifetimeLock } from "@commonfabric/utils/worker-lifetime";
import { pattern } from "../../../runner/src/builder/pattern.ts";
import { setArtifactEntryRef } from "../../../runner/src/builder/pattern-metadata.ts";
import { sourceDocKey } from "../../../runner/src/compilation-cache/cell-cache.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";

const SOURCE = "export default 1;\n";
const SOURCE_IDENTITY = "Qxkzi6OeLOLPP3A3-e-8kLe0DyNgoDZMZVIKr4PLz3w";
const worker = globalThis as unknown as {
  postMessage(value: unknown): void;
  close(): void;
};

const storageManager = StorageManager.emulate({
  as: await Identity.fromPassphrase("piece source compiler preload"),
});
const runtime = new Runtime({
  apiUrl: new URL("http://toolshed.test"),
  storageManager,
});

let outcome: { history?: string[]; error?: string };
try {
  const pieces = new PiecesController(
    createSession({
      identity: storageManager.as as Identity,
      spaceDid: await runtime.createSpace(),
    }),
    runtime,
  );
  await pieces.synced();

  const sourceTx = runtime.edit();
  runtime.getCell(
    pieces.getSpace(),
    sourceDocKey(SOURCE_IDENTITY),
    undefined,
    sourceTx,
  ).set({
    kind: "source",
    identity: SOURCE_IDENTITY,
    code: SOURCE,
    filename: "/main.tsx",
    imports: [],
  });
  runtime.prepareTxForCommit(sourceTx);
  const sourceCommit = await sourceTx.commit();
  if (sourceCommit.error !== undefined) throw sourceCommit.error;

  const cachedPattern = pattern(() => ({}));
  setArtifactEntryRef(cachedPattern, {
    identity: SOURCE_IDENTITY,
    symbol: "default",
  });
  pieces.syncPatternByIdentity = () => Promise.resolve(cachedPattern);

  const piece = await pieces.setupPersistent(
    cachedPattern,
    {},
    "source-backed-piece",
  );
  outcome = {
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
