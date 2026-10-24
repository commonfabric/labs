/**
 * Measures what a long-lived runtime holds after it opens and closes many
 * pieces. A creating runtime stores `PIECES` todo lists of `ITEMS` items
 * each. A second runtime, in the role of a host that shows one piece per
 * pane, then opens each piece (loads it, starts it, and subscribes to its
 * result, as a pane does) and closes it again (cancels the subscription,
 * stops it, and lets go of its cells). The storage sizes are read when every
 * piece is open, once half of them are closed, and once all of them are.
 * Before each of the last two reads the script collects garbage, so that the
 * closed panes' cells no longer hold their documents, and runs two release
 * passes, so that documents loaded before the first one go. With
 * `--no-release` the memory server does not advertise watch removal, so the
 * host keeps every watch, as it does against an older server.
 *
 * Run from the repository root:
 *
 *   deno run -A --v8-flags=--expose-gc \
 *     packages/runner/test/document-release.profile.ts [--no-release]
 */

import { Identity } from "@commonfabric/identity";
import { join } from "@std/path";
import { resolveLocalProgram } from "../src/harness/local-program.deno.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const PIECES = 40;
const ITEMS = 20;
const release = !Deno.args.includes("--no-release");

const collectGarbage = (globalThis as { gc?: () => void }).gc;
if (collectGarbage === undefined) {
  throw new Error("run with --v8-flags=--expose-gc");
}

/**
 * Collects garbage. A `WeakRef` target reached in a turn survives that turn
 * whatever holds it, so this crosses one task boundary first; that is an
 * event-loop yield, not a wait.
 */
const collect = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  collectGarbage();
  collectGarbage();
};

const signer = await Identity.fromPassphrase("document-release-workload");
const space = signer.did();
const patternsRoot = join(import.meta.dirname!, "..", "..", "patterns");

const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
if (!release) {
  const flags = server.memoryProtocolFlags.bind(server);
  server.memoryProtocolFlags = () => ({ ...flags(), watchRemoveV1: false });
}
const creatorStorage = EmulatedStorageManager.connectTo(server, {
  as: signer,
});
const hostStorage = EmulatedStorageManager.connectTo(server, { as: signer });
const creator = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager: creatorStorage,
});
const host = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager: hostStorage,
});

const report = (label: string, fields: Record<string, number> = {}) => {
  const storage = host.getSizes().storage!;
  console.log(JSON.stringify({
    label,
    documents: storage.documents,
    watchedDocuments: storage.watchedDocuments,
    approxBytes: storage.approxBytes,
    ...fields,
  }));
};

try {
  const tx = creator.edit();
  const program = await resolveLocalProgram(
    (resolver) => creator.harness.resolve(resolver),
    {
      main: join(patternsRoot, "todo-list", "todo-list.tsx"),
      root: patternsRoot,
    },
  );
  const pattern = await creator.patternManager.compilePattern(program, {
    space,
    tx,
  });
  const causes = Array.from({ length: PIECES }, (_, i) => `piece-${i}`);
  for (const cause of causes) {
    const cell = creator.getCell(space, cause, undefined, tx);
    creator.run(tx, pattern, {
      items: Array.from({ length: ITEMS }, (_, i) => ({
        title: `${cause} item ${i}`,
        done: i % 3 === 0,
      })),
    }, cell);
  }
  creator.prepareTxForCommit(tx);
  const created = await tx.commit().settled;
  if (created.error) throw created.error;
  await creator.idle();
  await creatorStorage.synced();
  for (const cause of causes) {
    creator.runner.stop(creator.getCell(space, cause));
  }
  await creator.idle();
  await creatorStorage.synced();
  await server.flushSessions();

  const panes = new Map<string, { cell: Cell<unknown>; cancel: () => void }>();
  for (const cause of causes) {
    const cell = host.getCell(space, cause);
    await cell.sync();
    await host.start(cell);
    const cancel = cell.sink(() => {});
    await cell.pull();
    panes.set(cause, { cell, cancel });
  }
  await host.idle();
  await hostStorage.synced();
  report("every piece open");

  const close = async (closing: string[], label: string) => {
    for (const cause of closing) {
      const { cell, cancel } = panes.get(cause)!;
      panes.delete(cause);
      cancel();
      host.runner.stop(cell);
    }
    await host.idle();
    await collect();
    const start = performance.now();
    await host.releaseUnreadDocuments();
    await host.releaseUnreadDocuments();
    const releaseMs = Math.round(performance.now() - start);
    await host.idle();
    report(label, { releaseMs });
  };
  await close(causes.slice(0, PIECES / 2), "half the pieces closed");
  await close(causes.slice(PIECES / 2), "every piece closed");
} finally {
  await host.dispose();
  await creator.dispose();
  await hostStorage.close();
  await creatorStorage.close();
  await server.close();
}
