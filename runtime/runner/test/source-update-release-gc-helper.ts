/**
 * Helper for `module-delegation.test.ts`. Runs in its own process so that it
 * can force a collection (`--v8-flags=--expose-gc`) and cross a real task
 * boundary, which a `WeakRef` needs before it can report its target
 * collected; the package's fake-clock preload would freeze that boundary.
 *
 * A writer stores two source closures, a predecessor and its successor. A
 * reader prepares the source update between them, which loads both closures,
 * and then, with nothing else holding what that load read, collects and runs
 * the two release passes that drop a document nothing holds. It then stages
 * the prepared update, as a source reconciliation's commit does, drops the
 * preparation, and collects and runs two passes again. It prints one line of
 * JSON: whether the successor's source document was still loaded after the
 * first passes (`keptThroughRelease`), the error staging returned, if any
 * (`stageError`), and whether the document was gone after the second
 * (`releasedOnceDone`).
 */

import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";
import type { PreparedSourceUpdate } from "../src/pattern-manager.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import {
  sourceDocKey,
  writeSourceDocs,
} from "../src/compilation-cache/cell-cache.ts";
import type { CacheableModule, RuntimeProgram } from "../src/harness/types.ts";
import { computeModuleHashes } from "../src/harness/module-identity.ts";
import { ensureCompilerStack } from "../src/harness/deferred-compiler-stack.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with --v8-flags=--expose-gc");

// Hashing a module and verifying a closure parse it.
await ensureCompilerStack();

const signer = await Identity.fromPassphrase("source-update-release-gc");
const space = signer.did();

const moduleFor = (revision: string): CacheableModule => {
  const program: RuntimeProgram = {
    main: "/writer.ts",
    files: [{
      name: "/writer.ts",
      contents: `export const revision = ${JSON.stringify(revision)};`,
    }],
  };
  return {
    identity: computeModuleHashes(program).get(program.main)!,
    filename: program.main,
    source: program.files[0].contents,
    js: "export const revision = 'compiled';",
    imports: [],
  };
};

const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
const writerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
const readerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
const writer = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager: writerStorage,
});
const reader = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager: readerStorage,
});

try {
  const previous = moduleFor("old");
  const candidate = moduleFor("new");
  const written = await writer.editWithRetry((tx) => {
    writeSourceDocs(writer, space, [previous], previous.identity, tx);
    writeSourceDocs(writer, space, [candidate], candidate.identity, tx);
  });
  if (written.error) throw written.error;
  await writerStorage.synced();
  await server.flushSessions();

  // The preparation lives only in `holder`, filled by a function that has
  // returned: a suspended async frame can keep the temporaries it used.
  const holder: { prepared?: PreparedSourceUpdate } = {};
  await (async () => {
    holder.prepared = await reader.patternManager.prepareSourceUpdate(
      space,
      previous.identity,
      candidate.identity,
    );
  })();
  const id = reader.getCell(space, sourceDocKey(candidate.identity))
    .getAsNormalizedFullLink().id as URI;
  const loaded = () =>
    readerStorage.open(space).replica.hasLocalDocumentCoverage?.(id) === true;

  const releaseTwice = async () => {
    // A `WeakRef` target reached in a turn survives that turn whatever holds
    // it, so cross one task boundary before collecting. This is an
    // event-loop yield, not a wait.
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
    gc();
    await reader.scheduler.idle();
    await readerStorage.releaseUnreadDocuments();
    await readerStorage.releaseUnreadDocuments();
  };

  await releaseTwice();
  const keptThroughRelease = loaded();

  const stageError = await (async () => {
    const prepared = holder.prepared!;
    const staged = await reader.editWithRetry(
      (tx) =>
        reader.patternManager.stageSourceUpdate(
          prepared,
          space,
          previous.identity,
          candidate.identity,
          tx,
        ),
      undefined,
      { sourceUpdate: prepared },
    );
    return staged.error?.message ?? null;
  })();
  await readerStorage.synced();

  // Once the update is done with its preparation, nothing holds the
  // documents, and release passes drop them as they would any other.
  delete holder.prepared;
  await releaseTwice();
  const releasedOnceDone = !loaded();

  console.log(
    JSON.stringify({ keptThroughRelease, stageError, releasedOnceDone }),
  );
} finally {
  await reader.dispose();
  await writer.dispose();
  await readerStorage.close();
  await writerStorage.close();
  await server.close();
}
