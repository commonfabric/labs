import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/logger";
import {
  convertibleJsFromFabricValue,
  fabricFromConvertibleJsValue,
} from "@commonfabric/data-model";

import type { Pattern } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("runner start owes");
const space = signer.did();

// Two derived cells and a writable inside the view tree: positional cells,
// one of which holds state that recomputing does not restore.
const STATEFUL: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern, UI, Writable } from 'commonfabric';",
      "export default pattern<{ input: Writable<number> }>(({ input }) => ({",
      "  [UI]: (",
      "    <div>",
      "      {computed(() => input.get() * 2)}",
      "      {computed(() => input.get() * 3)}",
      "      <span>{new Writable('draft')}</span>",
      "    </div>",
      "  ),",
      "}));",
      "",
    ].join("\n"),
  }],
};

type ManifestEntry = { partialCause: unknown };

describe("runner", () => {
  describe("start of a piece whose manifest lacks one of its cells", () => {
    // A piece with no record of the build that set it up, whose build has a
    // cell holding state, is held over its stored setup. A manifest lacking
    // one of the build's cells is the exception when the completion marker
    // does not name this version: that is a version whose setup never ran
    // over the document, and the start repairs it.

    let server: ReturnType<typeof newLoopbackServer>;
    let rt: Runtime;

    beforeEach(() => {
      server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
      rt = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: EmulatedStorageManager.connectTo(server, {
          as: signer,
        }),
      });
    });

    afterEach(async () => {
      await rt.idle();
      await rt.patternManager.flushCompileCacheWrites();
      await rt.storageManager.synced();
      await rt.dispose();
      await server.close();
    });

    const settled = async () => {
      await rt.idle();
      await rt.storageManager.synced();
      await rt.idle();
    };

    const manifestOf = (cell: Cell<unknown>): ManifestEntry[] =>
      convertibleJsFromFabricValue(
        cell.getMetaRaw("internal"),
      ) as ManifestEntry[];

    const holdsLogged = (): number =>
      getLoggerCountsBreakdown().runner?.["piece-start-repair-held"]?.warn ?? 0;

    /**
     * Sets a piece up from `STATEFUL` and stops it, then drops its record and
     * the last entry of its manifest, and sets its completion marker to
     * `marker`. Returns the piece and the manifest setup wrote.
     */
    const setUpLacking = async (
      name: string,
      marker: (ref: { identity: string; symbol: string }) => unknown,
    ) => {
      const tx = rt.edit();
      const pattern = await rt.patternManager.compilePattern(STATEFUL, {
        space,
        tx,
      }) as Pattern;
      const cell = rt.getCell<unknown>(space, name, undefined, tx);
      const running = rt.run(tx, pattern, { input: 5 }, cell);
      expect((await tx.commit().settled).error).toBeUndefined();
      await running.pull();
      await settled();
      rt.runner.stop(cell);
      const ref = rt.patternManager.getLeastArtifactEntryRef(pattern)!;
      const full = manifestOf(cell);

      const edit = rt.edit();
      const withTx = cell.withTx(edit);
      withTx.setMetaRaw(
        "internal",
        fabricFromConvertibleJsValue(full.slice(0, -1) as never),
        rawMetaWriteAuthorization,
      );
      withTx.setMetaRaw(
        "patternSetupBuild",
        undefined,
        rawMetaWriteAuthorization,
      );
      withTx.setMetaRaw(
        "patternSetupIdentity",
        marker(ref) as never,
        rawMetaWriteAuthorization,
      );
      expect((await edit.commit().settled).error).toBeUndefined();
      expect(manifestOf(cell)).toHaveLength(full.length - 1);
      return { cell, full };
    };

    const startAndSettle = async (cell: Cell<unknown>) => {
      expect(await rt.start(cell)).toBe(true);
      await cell.pull();
      await settled();
    };

    it("repairs the manifest when the completion marker is absent", async () => {
      const { cell, full } = await setUpLacking(
        "marker-absent",
        () => undefined,
      );
      const holds = holdsLogged();

      await startAndSettle(cell);

      expect(manifestOf(cell).map((entry) => entry.partialCause)).toEqual(
        full.map((entry) => entry.partialCause),
      );
      expect(holdsLogged()).toBe(holds);
    });

    it("repairs the manifest when the completion marker names another version", async () => {
      const { cell, full } = await setUpLacking("marker-other", (ref) => ({
        identity: `${ref.identity}-other`,
        symbol: ref.symbol,
      }));
      const holds = holdsLogged();

      await startAndSettle(cell);

      expect(manifestOf(cell).map((entry) => entry.partialCause)).toEqual(
        full.map((entry) => entry.partialCause),
      );
      expect(holdsLogged()).toBe(holds);
    });

    it("holds the manifest as it is when the completion marker names this version", async () => {
      const { cell, full } = await setUpLacking("marker-matches", (ref) => ref);
      const holds = holdsLogged();

      await startAndSettle(cell);

      expect(manifestOf(cell)).toHaveLength(full.length - 1);
      expect(holdsLogged()).toBe(holds + 1);
    });
  });
});
