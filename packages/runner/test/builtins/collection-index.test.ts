import { cloneWithoutValueAtPath } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { createNodeFactory } from "../../src/builder/module.ts";
import { SpaceReplica } from "../../src/storage/v2.ts";
import {
  collectionIndex,
  type CollectionIndexInput,
} from "../../src/builtins/collection-index.ts";
import { collectionKeyBucket } from "../../src/builtins/collection-index-key.ts";
import type { MaintainedCollectionIndex } from "../../src/builtins/collection-index-membership.ts";
import { useCancelGroup } from "../../src/cancel.ts";
import { Runtime } from "../../src/runtime.ts";
import { RuntimeTelemetryEvent } from "../../src/telemetry.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../../src/storage/v2-emulate.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

describe("collection-index", () => {
  it("rejects malformed source slots and an absent output binding before publication", async () => {
    await using cleanup = new AsyncDisposableStack();
    const signer = await Identity.fromPassphrase("index-invalid-coordinator");
    const storage = EmulatedStorageManager.emulate({ as: signer });
    cleanup.defer(() => storage.close());
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    cleanup.defer(() => runtime.dispose({ closeStorage: false }));
    for (const invalid of ["list", "elements", "binding"] as const) {
      const tx = runtime.edit();
      const [cancel, addCancel] = useCancelGroup();
      try {
        const inputs = runtime.getCell<CollectionIndexInput>(
          signer.did(),
          `invalid-${invalid}`,
          undefined,
          tx,
        );
        inputs.set({ list: [], elements: [], mode: "group" });
        if (invalid !== "binding") inputs.key(invalid).asSchema(true).set(42);
        const output = runtime.getCell(
          signer.did(),
          `output-${invalid}`,
          undefined,
          tx,
        );
        let publications = 0;
        const coordinator = collectionIndex(
          inputs,
          () => {
            publications++;
          },
          addCancel,
          {},
          runtime.getCell(signer.did(), "parent"),
          runtime,
          invalid === "binding" ? undefined : output.getAsNormalizedFullLink(),
        );
        if (typeof coordinator === "function") {
          throw new Error("Expected coordinator wrapper");
        }
        expect(() => coordinator.action(tx)).toThrow(
          invalid === "binding"
            ? "Collection indexing requires an output binding"
            : "Collection indexing requires arrays",
        );
        expect(publications).toBe(0);
        expect(output.getRaw()).toBeUndefined();
      } finally {
        tx.abort();
        cancel();
      }
    }
  });

  it("reconciles original linked occurrences while only one bucket is observed", async () => {
    const signer = await Identity.fromPassphrase("index-coordinator");
    const storage = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    let cancel: (() => void) | undefined;
    try {
      const { pattern } = createTrustedBuilder(runtime).commonfabric;
      const build = createNodeFactory({
        type: "ref",
        implementation: "collectionIndex",
      });
      const producer = pattern<
        { list: unknown[]; elements: unknown[]; mode: "group" | "key" }
      >(
        ({ list, elements, mode }) => ({
          index: build({ list, elements, mode }),
        }),
      );
      let tx = runtime.edit();
      const first = runtime.getCell<{ title: string }>(
        signer.did(),
        "first",
        undefined,
        tx,
      );
      first.set({ title: "First" });
      const second = runtime.getCell<{ title: string }>(
        signer.did(),
        "second",
        undefined,
        tx,
      );
      second.set({ title: "Second" });
      const firstKey = runtime.getCell<{ isCell: boolean; value: string }>(
        signer.did(),
        "first-key",
        undefined,
        tx,
      );
      firstKey.set({ isCell: false, value: "B" });
      const secondKey = runtime.getCell<{ isCell: boolean; value: string }>(
        signer.did(),
        "second-key",
        undefined,
        tx,
      );
      secondKey.set({ isCell: false, value: "A" });
      const list = runtime.getCell<unknown[]>(
        signer.did(),
        "keys",
        undefined,
        tx,
      );
      list.set([firstKey, secondKey]);
      const elements = runtime.getCell<unknown[]>(
        signer.did(),
        "elements",
        undefined,
        tx,
      );
      elements.set([first, second]);
      const mode = runtime.getCell<"group" | "key">(
        signer.did(),
        "mode",
        undefined,
        tx,
      );
      mode.set("group");
      const result = runtime.run(
        tx,
        producer,
        { list, elements, mode },
        runtime.getCell<{ index: MaintainedCollectionIndex }>(
          signer.did(),
          "result",
          undefined,
          tx,
        ),
      );
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      const bucket = collectionKeyBucket({ kind: "string", value: "A" });
      const observed: unknown[] = [];
      cancel = result.key("index").key("buckets").key(bucket).sink((value) => {
        observed.push(value);
      });
      await runtime.idle();
      expect(observed.at(-1)).toEqual([{ title: "Second" }]);
      tx = runtime.edit();
      elements.withTx(tx).set([second, first]);
      list.withTx(tx).set([secondKey, firstKey]);
      expect((await tx.commit()).error).toBeUndefined();
      await runtime.idle();
      expect(observed.at(-1)).toEqual([{ title: "Second" }]);
      tx = runtime.edit();
      firstKey.withTx(tx).key("value").set("A");
      expect((await tx.commit()).error).toBeUndefined();
      await runtime.idle();
      expect(observed.at(-1)).toEqual(
        expect.arrayContaining([{ title: "First" }, { title: "Second" }]),
      );
      expect(observed.at(-1)).toHaveLength(2);
      tx = runtime.edit();
      elements.withTx(tx).set([first]);
      list.withTx(tx).set([firstKey]);
      expect((await tx.commit()).error).toBeUndefined();
      await runtime.idle();
      expect(observed.at(-1)).toEqual([{ title: "First" }]);
      tx = runtime.edit();
      first.withTx(tx).key("title").set("Changed");
      expect((await tx.commit()).error).toBeUndefined();
      await runtime.idle();
      expect(observed.at(-1)).toEqual([{ title: "Changed" }]);
      tx = runtime.edit();
      elements.withTx(tx).set([]);
      list.withTx(tx).set([]);
      expect((await tx.commit()).error).toBeUndefined();
      await runtime.idle();
      expect(observed.at(-1)).toBeUndefined();
      expect(await result.key("index").key("keys").pull()).toEqual([]);
      tx = runtime.edit();
      elements.withTx(tx).set([first]);
      list.withTx(tx).set([firstKey]);
      expect((await tx.commit()).error).toBeUndefined();
      await runtime.idle();
      expect(observed.at(-1)).toEqual([{ title: "Changed" }]);
      for (const nextMode of ["key", "group"] as const) {
        tx = runtime.edit();
        mode.withTx(tx).set(nextMode);
        expect((await tx.commit()).error).toBeUndefined();
        await runtime.idle();
        expect(observed.at(-1)).toEqual(
          nextMode === "key" ? { title: "Changed" } : [{ title: "Changed" }],
        );
        expect(await result.key("index").key("keys").pull()).toEqual(["A"]);
        for (const missing of [list, elements]) {
          tx = runtime.edit();
          missing.withTx(tx).asSchema(true).set(undefined);
          expect((await tx.commit()).error).toBeUndefined();
          await runtime.idle();
          expect(observed.at(-1)).toBeUndefined();
          expect(await result.key("index").key("keys").pull()).toEqual([]);
          tx = runtime.edit();
          firstKey.withTx(tx).key("value").set("B");
          expect((await tx.commit()).error).toBeUndefined();
          await runtime.idle();
          expect(await result.key("index").key("keys").pull()).toEqual([]);
          tx = runtime.edit();
          firstKey.withTx(tx).key("value").set("A");
          list.withTx(tx).set([firstKey]);
          elements.withTx(tx).set([first]);
          expect((await tx.commit()).error).toBeUndefined();
          await runtime.idle();
          expect(observed.at(-1)).toEqual(
            nextMode === "key" ? { title: "Changed" } : [{ title: "Changed" }],
          );
          expect(await result.key("index").key("keys").pull()).toEqual(["A"]);
        }
      }
    } finally {
      cancel?.();
      await storage.synced();
      await runtime.dispose({ closeStorage: false });
      await storage.close();
    }
  });
  it("resumes compiled membership in a fresh runtime and removes a durable member", async () => {
    const signer = await Identity.fromPassphrase("index-coordinator-resume");
    const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    const storages = [0, 1].map(() =>
      EmulatedStorageManager.connectTo(server, { as: signer })
    );
    const runtimes = storages.map((storageManager) =>
      new Runtime({ apiUrl: new URL(import.meta.url), storageManager })
    );
    const [first, second] = runtimes;
    const keyRuns = [0, 0];
    const collectors = runtimes.map((runtime, index) => {
      runtime.scheduler.setReadStatsEnabled(true);
      const collect = (event: Event) => {
        const marker = (event as RuntimeTelemetryEvent).marker;
        if (
          marker.type === "scheduler.run.complete" &&
          marker.actionId.includes("collectionIndexKeys")
        ) keyRuns[index]++;
      };
      runtime.telemetry.addEventListener("telemetry", collect);
      return collect;
    });
    const program = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
        import {pattern, Writable} from "commonfabric";
        interface Row { title: string; category: string }
        export default pattern<{rows: Writable<Row[]>}>(({rows}) => {
          return { rows, index: rows.groupBy(row => row.category) };
        });
      `,
      }],
    };
    const cancellations: (() => void)[] = [];
    try {
      const compiled = await first.patternManager.compilePattern(program);
      const tx = first.edit();
      const result = first.run(
        tx,
        compiled,
        {
          rows: [{ title: "First", category: "A" }, {
            title: "Second",
            category: "A",
          }],
        },
        first.getCell<
          {
            index: MaintainedCollectionIndex;
            rows: { title: string; category: string }[];
          }
        >(signer.did(), "compiled-result", compiled.resultSchema, tx),
      );
      first.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      const bucket = collectionKeyBucket({ kind: "string", value: "A" });
      const cancel = result.key("index").key("buckets").key(bucket).sink(
        () => {},
      );
      cancellations.push(cancel);
      await first.idle();
      expect(keyRuns[0]).toBe(0);
      expect(await result.key("index").key("buckets").key(bucket).pull())
        .toHaveLength(2);
      const legacyEdit = first.edit();
      const legacyIndex = result.withTx(legacyEdit).key("index")
        .resolveAsCell();
      const descriptor = legacyIndex.getRawUntyped();
      expect(descriptor).toHaveProperty("keyEntries");
      legacyIndex.setRawUntyped(
        cloneWithoutValueAtPath(descriptor, ["keyEntries"]),
      );
      expect((await legacyEdit.commit()).error).toBeUndefined();
      await storages[0].synced();
      cancel();
      first.runner.stop(result);
      await first.dispose({ closeStorage: false });
      await storages[0].close();
      await second.patternManager.compilePattern(program, {
        space: signer.did(),
      });
      const restored = second.getCellFromLink<
        {
          index: MaintainedCollectionIndex;
          rows: { title: string; category: string }[];
        }
      >(result.getAsNormalizedFullLink());
      cancellations.push(
        restored.key("index").key("buckets").key(bucket).sink(() => {}),
      );
      expect(await second.start(restored)).toBe(true);
      await second.idle();
      // The coordinator holds its resume reconciliation until each durable
      // input has confirmed, one round of syncs per input group, and re-runs
      // when each round lands. idle() waits for reactive quiescence only, so
      // it can return between a round's confirmations and the re-run they
      // schedule (docs/development/waiting-in-tests.md). The repair the
      // reconciliation makes is a write to the descriptor document, so a
      // document sink is the event to wait on; a pull would force the keys
      // enumeration this case expects not to run.
      const indexCell = restored.key("index").resolveAsCell();
      const hasKeyEntries = (value: unknown): boolean =>
        isObjectOrArray(value) &&
        Object.hasOwn(value, "keyEntries");
      const repaired = Promise.withResolvers<void>();
      if (hasKeyEntries(indexCell.getRawUntyped())) repaired.resolve();
      cancellations.push(
        (second.storageManager.open(signer.did()).replica as SpaceReplica)
          .sinkDocument(
            indexCell.getAsNormalizedFullLink().id,
            (document) => {
              if (hasKeyEntries(document?.value)) repaired.resolve();
            },
          ),
      );
      await repaired.promise;
      await second.idle();
      expect(keyRuns[1]).toBe(0);
      expect(restored.key("index").resolveAsCell().getRawUntyped())
        .toHaveProperty("keyEntries");
      expect(await restored.key("index").key("buckets").key(bucket).pull())
        .toHaveLength(2);
      const edit = second.edit();
      restored.withTx(edit).key("rows").set([{
        title: "Second",
        category: "A",
      }]);
      expect((await edit.commit()).error).toBeUndefined();
      await second.idle();
      expect(await restored.key("index").key("buckets").key(bucket).pull())
        .toEqual([{ title: "Second", category: "A" }]);
      expect(keyRuns[1]).toBe(0);
      expect(await restored.key("index").key("keys").pull()).toEqual(["A"]);
      expect(keyRuns[1]).toBeGreaterThan(0);
      expect(await restored.key("index").key("keyEntries").pull()).toEqual([
        { kind: "value", value: "A" },
      ]);
    } finally {
      for (const cancel of cancellations) cancel();
      runtimes.forEach((runtime, index) =>
        runtime.telemetry.removeEventListener("telemetry", collectors[index])
      );
      for (const runtime of runtimes) {
        await runtime.dispose({ closeStorage: false });
      }
      for (const storage of storages) await storage.close();
      await server.close();
    }
  });
});
