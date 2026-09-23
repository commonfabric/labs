import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { getMetaLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { entityKey } from "../src/scheduler/keys.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase(
  "generated-cell-metadata-prefetch",
);
const space = signer.did();
const program = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `
      import { pattern } from "commonfabric";
      import Child from "./child.tsx";
      export default pattern<Record<string, never>>(() => ({ child: Child({}) }));
    `,
  }, {
    name: "/child.tsx",
    contents: `
      import { pattern, Writable } from "commonfabric";
      export default pattern<Record<string, never>>(() => ({
        slots: [0].map(() => new Writable(1)),
      }));
    `,
  }],
};
type Result = { child: { slots: number[] } };

describe("generated-cell-metadata-prefetch", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let runtimes: Runtime[];

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    runtimes = [];
  });

  afterEach(async () => {
    for (const runtime of runtimes) {
      await runtime.idle();
      await runtime.storageManager.synced();
      await runtime.dispose();
    }
    await server.close();
  });

  function connect() {
    const storageManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    runtimes.push(runtime);
    return { runtime, storageManager };
  }

  async function coldReader() {
    const { runtime: author } = connect();
    const pattern = await author.patternManager.compilePattern(program, {
      space,
    });
    const authored = author.getCell<Result>(
      space,
      "nested-generated-state",
      pattern.resultSchema,
    );
    await author.setup(undefined, pattern, {}, authored);
    expect(await author.start(authored)).toBe(true);
    const cancel = authored.sink(() => {});
    try {
      await authored.pull();
      await author.settled();
      const owned = authored.key("child").key("slots").key(0).resolveAsCell();
      expect(owned.get()).toBe(1);
      const childLink = getMetaLink(owned, "result");
      const argumentLink = getMetaLink(authored, "argument");
      expect(childLink).toBeDefined();
      expect(argumentLink).toBeDefined();
      expect(childLink!.id).not.toBe(authored.getAsNormalizedFullLink().id);
      expect(
        (await author.editWithRetry((tx) => owned.withTx(tx).set(73))).error,
      ).toBeUndefined();
      await author.getCellFromLink(childLink!).sync();
      await author.runner.idlePointerMaintenance();
      await author.runner.idlePieceInstantiationSettlements();
      await author.patternManager.flushCompileCacheWrites();
      await author.storageManager.synced();

      const { runtime: reader, storageManager } = connect();
      const readerPattern = await reader.patternManager.compilePattern(
        program,
        {
          space,
        },
      );
      const resumed = reader.getCellFromLink<Result>(
        { ...authored.getAsNormalizedFullLink(), schema: undefined },
      );
      // The parent and its empty argument are local; the child's metadata
      // must arrive before its anonymous owned-cell address can be selected.
      await resumed.asSchema({ type: "object", properties: {} }).sync();
      await reader.getCellFromLink(argumentLink!).sync();
      const hasChildCoverage = () =>
        storageManager.open(space).replica.hasLocalDocumentCoverage?.(
          childLink!.id,
          childLink!.scope,
        );
      expect(hasChildCoverage()).toBe(false);
      return {
        reader,
        storageManager,
        readerPattern,
        resumed,
        childLink: childLink!,
        hasChildCoverage,
      };
    } finally {
      cancel();
      await author.idle();
      await author.storageManager.synced();
      await author.dispose();
      runtimes.splice(runtimes.indexOf(author), 1);
    }
  }

  it("defers a run until nested identity metadata arrives even when its arguments are local", async () => {
    const { reader, readerPattern, resumed, hasChildCoverage } =
      await coldReader();
    const key = entityKey(
      resumed.getAsNormalizedFullLink(),
      reader.scopeKeyIdentity,
    );
    const markers: { type: string; outcome?: string }[] = [];
    const settled = Promise.withResolvers<void>();
    const listener = (event: Event) => {
      const { marker } = (event as CustomEvent<{
        marker: { type: string; key?: string; outcome?: string };
      }>).detail;
      if (marker.key !== key) return;
      if (marker.type.startsWith("runner.deferred-start.")) {
        markers.push(marker);
      }
      if (marker.type === "runner.deferred-start.settled") settled.resolve();
    };
    reader.telemetry.addEventListener("telemetry", listener);
    try {
      const tx = reader.edit();
      reader.run(tx, readerPattern, {}, resumed);
      reader.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      expect(
        markers.some((marker) =>
          marker.type === "runner.deferred-start.pending"
        ),
      ).toBe(true);
      await settled.promise;
      expect(
        markers.find((marker) =>
          marker.type === "runner.deferred-start.settled"
        )?.outcome,
      ).toBe("installed");
      expect(hasChildCoverage()).toBe(true);
      expect(await resumed.asSchema(readerPattern.resultSchema).pull()).toEqual(
        {
          child: { slots: [73] },
        },
      );
    } finally {
      reader.telemetry.removeEventListener("telemetry", listener);
    }
  });

  it("refuses a fulfilled metadata sync without document coverage and resumes after coverage arrives", async () => {
    const {
      reader,
      readerPattern,
      storageManager,
      resumed,
      childLink,
      hasChildCoverage,
    } = await coldReader();
    const syncCell = storageManager.syncCell.bind(storageManager);
    let skipped = 0;
    storageManager.syncCell = (cell, options) => {
      if (cell.getAsNormalizedFullLink().id === childLink.id) {
        skipped++;
        return Promise.resolve(cell);
      }
      return syncCell(cell, options);
    };
    try {
      await expect(reader.start(resumed)).rejects.toThrow(
        `Generated cell identity metadata unavailable: ${childLink.id}`,
      );
      expect(skipped).toBeGreaterThan(0);
      expect(hasChildCoverage()).toBe(false);
    } finally {
      storageManager.syncCell = syncCell;
    }
    expect(await reader.start(resumed)).toBe(true);
    expect(hasChildCoverage()).toBe(true);
    expect(await resumed.asSchema(readerPattern.resultSchema).pull()).toEqual({
      child: { slots: [73] },
    });
  });
});
