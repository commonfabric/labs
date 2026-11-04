import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { resolveCollectionKey } from "../src/builtins/collection-index-key.ts";
import { isCell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { RuntimeTelemetryEvent } from "../src/telemetry.ts";

const signer = await Identity.fromPassphrase("collection-key-extraction");
const space = signer.did();

describe("collection key extraction", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
  });

  afterEach(async () => {
    await storage.synced();
    await runtime.dispose({ closeStorage: false });
    await storage.close();
  });

  it("preserves mixed primitive and Cell keys through compiled selector results", async () => {
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
          import { pattern, Writable, Cell, tagCollectionKey } from "commonfabric";
          export default pattern<{
            rows: Writable<{ owner: Cell<string>; label: string; useOwner: boolean }[]>
          }>(({ rows }) => ({
            keys: rows.map(row => tagCollectionKey(row.useOwner ? row.owner : row.label))
          }));
        `,
      }],
    });
    let tx = runtime.edit();
    const first = runtime.getCell<string>(space, "first", undefined, tx);
    const second = runtime.getCell<string>(space, "second", undefined, tx);
    first.set("equal");
    second.set("equal");
    const rows = runtime.getCell<{
      owner: typeof first;
      label: string;
      useOwner: boolean;
    }[]>(space, "rows", undefined, tx);
    rows.set([
      { owner: first, label: "equal", useOwner: true },
      { owner: second, label: "equal", useOwner: true },
      { owner: first, label: "equal", useOwner: false },
    ]);
    const result = runtime.run(
      tx,
      compiled,
      { rows },
      runtime.getCell<{ keys: { isCell: boolean; value: unknown }[] }>(
        space,
        "output",
        compiled.resultSchema,
        tx,
      ),
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    const cancel = result.sink(() => {});
    let writingRuns = 0;
    const collect = (event: Event) => {
      const marker = (event as RuntimeTelemetryEvent).marker;
      if (
        marker.type === "scheduler.run.complete" &&
        marker.actionInfo?.writes?.length
      ) {
        writingRuns++;
      }
    };
    const readKeys = () => {
      const read = runtime.edit();
      try {
        return [0, 1, 2].map((index) => {
          const slot = result.withTx(read).key("keys").key(index);
          const value = slot.key("isCell").get() === true
            ? slot.key("value").asSchema({ asCell: ["cell"] }).get()
            : slot.key("value").get();
          return {
            cell: isCell(value),
            identity: resolveCollectionKey(runtime, read, value)?.identity,
          };
        });
      } finally {
        read.abort("key extraction assertions");
      }
    };
    try {
      await runtime.idle();
      tx = runtime.edit();
      const identities = [first, second].map((cell) =>
        resolveCollectionKey(runtime, tx, cell)?.identity
      );
      tx.abort("expected key identities");
      expect(identities[0]).not.toEqual(identities[1]);
      const expected = [
        { cell: true, identity: identities[0] },
        { cell: true, identity: identities[1] },
        { cell: false, identity: { kind: "string", value: "equal" } },
      ];
      expect(readKeys()).toEqual(expected);

      tx = runtime.edit();
      runtime.telemetry.addEventListener("telemetry", collect);
      first.withTx(tx).set("changed contents");
      await tx.commit().settled;
      await runtime.idle();
      expect(readKeys()).toEqual(expected);
      expect(writingRuns).toBe(0);

      tx = runtime.edit();
      rows.withTx(tx).key(2).key("useOwner").set(true);
      await tx.commit().settled;
      await runtime.idle();
      expect(readKeys()).toEqual([expected[0], expected[1], expected[0]]);
      expect(writingRuns).toBeGreaterThan(0);
    } finally {
      runtime.telemetry.removeEventListener("telemetry", collect);
      cancel();
    }
  });
});
