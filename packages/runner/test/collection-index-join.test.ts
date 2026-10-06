import { Identity } from "@commonfabric/identity";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

/** Source row whose payload stays linked through the join. */
interface Row {
  /** Primitive lookup key. */
  key: string;

  /** Payload observed independently of membership. */
  title: string;
}

/** Left occurrence and its optional original right match. */
interface JoinedRow {
  /** Original left source. */
  left: Row;

  /** Original matching right source. */
  right?: Row;
}

describe("collection-index-join", () => {
  for (const location of ["local", "cross-space"]) {
    it(`retains unmatched left rows and invalidates only changed matches with ${location} right rows`, async () => {
      const identity = await Identity.fromPassphrase(
        "left-lookup-join-acceptance",
      );
      await using cleanup = new AsyncDisposableStack();
      const storage = EmulatedStorageManager.emulate({ as: identity });
      cleanup.defer(() => storage.close());
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
      cleanup.defer(() => runtime.dispose({ closeStorage: false }));
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: `
          import { pattern, Writable } from "commonfabric";
          interface Row { key: string; title: string }
          export default pattern<{left: Writable<Row[]>; right: Writable<Row[]>}>(({left, right}) => {
            const index = right.keyBy(row => row.key);
            return {joined: left.map(row => ({left: row, right: index.lookup(row.key)}))};
          });
        `,
        }],
      });
      let tx = runtime.edit();
      const leftA = runtime.getCell<Row>(
        identity.did(),
        "left-a",
        undefined,
        tx,
      );
      const leftB = runtime.getCell<Row>(
        identity.did(),
        "left-b",
        undefined,
        tx,
      );
      const sourceSpace = location === "local"
        ? identity.did()
        : (await Identity.fromPassphrase("join-foreign-rows")).did();
      const rightA = runtime.getCell<Row>(
        sourceSpace,
        "right-a",
        undefined,
        tx,
      );
      const rightB = runtime.getCell<Row>(
        sourceSpace,
        "right-b",
        undefined,
        tx,
      );
      leftA.set({ key: "A", title: "Left A" });
      leftB.set({ key: "B", title: "Left B" });
      const sourceTx = runtime.edit();
      rightA.withTx(sourceTx).set({ key: "A", title: "Right A" });
      rightB.withTx(sourceTx).set({ key: "other", title: "Right B" });
      expect((await sourceTx.commit().settled).error).toBeUndefined();
      const left = runtime.getCell<Row[]>(
        identity.did(),
        "left",
        undefined,
        tx,
      );
      const right = runtime.getCell<Row[]>(
        identity.did(),
        "right",
        undefined,
        tx,
      );
      left.set([leftA, leftB]);
      right.set([rightA, rightB]);
      const result = runtime.run(
        tx,
        compiled,
        { left, right },
        runtime.getCell<{ joined: JoinedRow[] }>(
          identity.did(),
          "joined",
          compiled.resultSchema,
          tx,
        ),
      );
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      let runsA = 0;
      let runsB = 0;
      const { pattern, lift } = createTrustedBuilder(runtime).commonfabric;
      const observe = (count: () => void) =>
        pattern<{ row: JoinedRow }>(({ row }) =>
          lift(
            ({ row }) => {
              count();
              return row?.right?.title ?? "unmatched";
            },
            {
              type: "object",
              properties: {
                row: {
                  type: "object",
                  properties: {
                    right: {
                      type: "object",
                      properties: { title: { type: "string" } },
                    },
                  },
                },
              },
            },
            { type: "string" },
          )({ row })
        );
      tx = runtime.edit();
      const outputA = runtime.run(tx, observe(() => runsA++), {
        row: result.key("joined").key(0),
      }, runtime.getCell<string>(identity.did(), "observer-a", undefined, tx));
      const outputB = runtime.run(tx, observe(() => runsB++), {
        row: result.key("joined").key(1),
      }, runtime.getCell<string>(identity.did(), "observer-b", undefined, tx));
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      cleanup.defer(outputA.sink(() => {}));
      cleanup.defer(outputB.sink(() => {}));
      await runtime.idle();
      expect(outputA.get()).toBe("Right A");
      expect(outputB.get()).toBe("unmatched");
      expect(result.key("joined").get()).toHaveLength(2);
      runsA = 0;
      runsB = 0;
      tx = runtime.edit();
      rightB.withTx(tx).key("key").set("B");
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.idle();
      expect(outputA.get()).toBe("Right A");
      expect(outputB.get()).toBe("Right B");
      expect(runsA).toBe(0);
      expect(runsB).toBeGreaterThan(0);
      runsA = 0;
      runsB = 0;
      tx = runtime.edit();
      rightA.withTx(tx).key("title").set("Updated A");
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.idle();
      expect(outputA.get()).toBe("Updated A");
      expect(outputB.get()).toBe("Right B");
      expect(runsA).toBeGreaterThan(0);
      expect(runsB).toBe(0);
      runsA = 0;
      runsB = 0;
      tx = runtime.edit();
      leftA.withTx(tx).key("key").set("B");
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.idle();
      expect(outputA.get()).toBe("Right B");
      expect(outputB.get()).toBe("Right B");
      expect(runsA).toBeGreaterThan(0);
      expect(runsB).toBe(0);
      tx = runtime.edit();
      right.withTx(tx).set([rightA]);
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.idle();
      expect(outputA.get()).toBe("unmatched");
      expect(outputB.get()).toBe("unmatched");
      expect(result.key("joined").get()).toHaveLength(2);
    });
  }
  it("resumes both join sides in a fresh runtime and observes later matches", async () => {
    const identity = await Identity.fromPassphrase("left-join-resume");
    await using cleanup = new AsyncDisposableStack();
    const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    cleanup.defer(() => server.close());
    const storages = [0, 1].map(() => {
      const storage = EmulatedStorageManager.connectTo(server, {
        as: identity,
      });
      cleanup.defer(() => storage.close());
      return storage;
    });
    const runtimes = storages.map((storageManager) => {
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      cleanup.defer(() => runtime.dispose({ closeStorage: false }));
      return runtime;
    });
    const [first, second] = runtimes;
    const program = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
      import {pattern, Writable} from "commonfabric";
      interface Row {key: string; title: string}
      export default pattern<{left: Writable<Row[]>; right: Writable<Row[]>}>(({left, right}) => {
        const index = right.keyBy(row => row.key);
        return {left, right, joined: left.map(row => ({left: row, right: index.lookup(row.key)}))};
      });
    `,
      }],
    };
    const compiled = await first.patternManager.compilePattern(program);
    const tx = first.edit();
    const result = first.run(
      tx,
      compiled,
      {
        left: [{ key: "A", title: "Left A" }, { key: "B", title: "Left B" }],
        right: [{ key: "A", title: "Right A" }],
      },
      first.getCell<{ left: Row[]; right: Row[]; joined: JoinedRow[] }>(
        identity.did(),
        "result",
        compiled.resultSchema,
        tx,
      ),
    );
    first.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    const cancelFirst = result.key("joined").sink(() => {});
    cleanup.defer(cancelFirst);
    await first.idle();
    expect(result.key("joined").get().map((row) => row.right?.title)).toEqual(
      ["Right A", undefined],
    );
    await storages[0].synced();
    cancelFirst();
    first.runner.stop(result);
    await second.patternManager.compilePattern(program, {
      space: identity.did(),
    });
    const restored = second.getCellFromLink<
      { left: Row[]; right: Row[]; joined: JoinedRow[] }
    >(result.getAsNormalizedFullLink());
    cleanup.defer(restored.key("joined").sink(() => {}));
    expect(await second.start(restored)).toBe(true);
    await second.idle();
    expect(restored.key("joined").get().map((row) => row.right?.title))
      .toEqual(["Right A", undefined]);
    const edit = second.edit();
    restored.withTx(edit).key("right").set([{ key: "B", title: "Right B" }]);
    expect((await edit.commit().settled).error).toBeUndefined();
    await second.idle();
    expect(
      restored.key("joined").get().map((row) => ({
        left: row.left.title,
        right: row.right?.title,
      })),
    ).toEqual([
      { left: "Left A", right: undefined },
      { left: "Left B", right: "Right B" },
    ]);
  });
});
