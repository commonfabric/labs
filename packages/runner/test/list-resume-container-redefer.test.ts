// The wait a resuming list coordinator takes on its result container.
//
// A resume reconcile that reads an undefined container waits rather than
// reconcile against a value that has not arrived: it pulls the container, and
// the recovery re-arms the coordinator once that pull settles, whatever the
// container turned out to hold. The re-armed reconcile reads the container
// again, and a read that has not changed sends it into the same wait, whose
// recovery re-arms it again. Every turn of that cycle leaves the list rendering
// nothing.
//
// A read that does not change is an ordinary state for a client running under
// server-side execution. Such a client keeps its own writes in a process-local
// speculation overlay, and a layer standing on the container's document that
// carries no value for the container answers every ordinary read of it with
// undefined while it stands. The seed reads the durable replica, so a container
// another writer has already filled stands it down — overwriting it would
// discard those elements — and what that container holds sits beneath the
// layer, where no read the coordinator takes reaches it. The value the
// coordinator can read comes from its own ordinary write, which lands above the
// layer, so the reconcile after the wait is the one that produces it.
//
// A first runtime persists the aggregate. A second resumes it under
// server-side execution, once on its own and once with the value-less layer
// standing on the container before the resume starts, and the aggregate is
// expected to render either way. The ordinary resume is what makes a failure
// the layer's: it renders the same aggregate through the same code.
//
// The waits here are counted in reconcile rounds rather than in elapsed time. A
// coordinator that keeps waiting renders nothing however many rounds it is
// given, so the bound decides how long the test takes and not what it
// concludes.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { SealedCommitVerdict } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("list resume container redefer");
const space = signer.did();

const MAP_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { n: number }[] }>(({ items }) => {",
      "  return { doubled: items.map((item) => item.n * 2) };",
      "});",
    ].join("\n"),
  }],
};

const MAP_ITEMS = [{ n: 1 }, { n: 2 }, { n: 3 }];
const MAP_DOUBLED = [2, 4, 6];
const RESULT_KEY = "redefer-map-result";

/** How many reconcile rounds the resume is driven for before it is read. */
const RESUME_ROUNDS = 25;

const readDoubled = (rc: Cell<any>): number[] | undefined =>
  rc.get()?.doubled as number[] | undefined;

describe("list resume container re-defer", () => {
  let server: MemoryV2Server.Server;
  let writerManager: EmulatedStorageManager;
  let resumeManager: EmulatedStorageManager;

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    writerManager = EmulatedStorageManager.connectTo(server, { as: signer });
    resumeManager = EmulatedStorageManager.connectTo(server, { as: signer });
  });

  afterEach(async () => {
    await writerManager?.close();
    await resumeManager?.close();
    await server?.close();
  });

  /**
   * Persists the map's aggregate with one runtime, then resumes it with a
   * second under server-side execution and requires it to render. With
   * `standLayer`, a speculative layer carrying the container's document and no
   * value for it is standing before the resume starts.
   */
  const persistThenResume = async (standLayer: boolean) => {
    // Server-side execution is off for the writer, so the input list, the
    // per-element results and the container itself all reach the store.
    const writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerManager,
    });
    let containerId: URI;
    let resultSchema;
    try {
      const compiled = await writer.patternManager.compilePattern(
        MAP_PROGRAM,
        { space },
      );
      resultSchema = compiled.resultSchema;
      const tx = writer.edit();
      const rc = writer.getCell(space, RESULT_KEY, resultSchema, tx);
      const handle = writer.run(tx, compiled, { items: MAP_ITEMS }, rc);
      expect((await tx.commit()).error).toBeUndefined();
      for (let round = 0; round < 10; round++) {
        await handle.pull();
        await writer.idle();
      }
      await writer.patternManager.flushCompileCacheWrites();
      await writerManager.synced();
      expect(readDoubled(rc)).toEqual(MAP_DOUBLED);

      // The container is the document the result's `doubled` field
      // write-redirects to, which is what the coordinator holds and what the
      // layer has to cover.
      const resolveTx = writer.edit();
      containerId = rc.key("doubled").withTx(resolveTx).resolveAsCell()
        .getAsNormalizedFullLink().id;
      resolveTx.abort("resolved the container id");
    } finally {
      await writer.dispose({ closeStorage: false });
    }

    const resumed = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: resumeManager,
      experimental: { serverExecution: true },
    });
    const verdict = Promise.withResolvers<SealedCommitVerdict>();
    let sealed;
    try {
      await resumed.patternManager.compilePattern(MAP_PROGRAM, { space });
      const tx = resumed.edit();
      const rc = resumed.getCell(space, RESULT_KEY, resultSchema, tx);
      expect((await tx.commit()).error).toBeUndefined();

      if (standLayer) {
        // Setting the document to `{}` leaves it holding no `value`, which is
        // what every ordinary read of the container resolves through while the
        // layer stands.
        sealed = resumeManager.open(space).replica.sealNative!(
          {
            operations: [{
              op: "set",
              id: containerId,
              type: "application/json",
              value: {},
            }],
          },
          undefined,
          verdict.promise,
          { speculative: true },
        );
      }

      expect(await resumed.start(rc)).toBe(true);
      for (let round = 0; round < RESUME_ROUNDS; round++) {
        await rc.pull();
        await resumed.idle();
      }

      expect(readDoubled(rc)).toEqual(MAP_DOUBLED);
    } finally {
      verdict.resolve({ withdrawn: { message: "test complete" } });
      await sealed?.settled.catch(() => {});
      await resumed.dispose({ closeStorage: false });
    }
  };

  it("renders a resumed map's elements on an ordinary resume", () =>
    persistThenResume(false));

  it("renders a resumed map's elements while a value-less speculative layer stands on its result container", () =>
    persistThenResume(true));
});
