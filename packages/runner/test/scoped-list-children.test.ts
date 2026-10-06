/** Exercises compiled scoped list callbacks across scope changes and runtime reloads. */

import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/utils/logger";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";

const signer = await Identity.fromPassphrase("scoped-list-children");

/** Builds a compiled fixture whose row computations observe viewer-local state. */
function program(scope: "user" | "session") {
  const wrapper = scope === "user" ? "PerUser" : "PerSession";
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: `
        import {pattern, computed, Writable, ${wrapper}} from "commonfabric";
        export default pattern<{source:number[]; viewer:${wrapper}<Writable<number>>}>(
          ({source,viewer})=>{
            const ranked=computed(()=>source.map(value=>({value,self:value===viewer.get()})));
            return {
              selected: viewer,
              mapped: ranked.map(row=><span>{row.value}:{row.self}</span>),
              filtered: ranked.filter(row=>row.self),
              flat: ranked.flatMap(row=>row.self?[row.value]:[]),
            };
          }
        );
      `,
    }],
  };
}

describe("scoped-list-children", () => {
  it("replaces filter and flatMap children when scope changes with stable element identities", async () => {
    const storage = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    let cancel: (() => void) | undefined;
    try {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: `
          import {pattern, Writable} from "commonfabric";
          export default pattern<{items:Writable<{n:number}[]>}>(({items})=>({
            mapped:items.map(row=>row.n+0),
            filtered:items.filter(row=>row.n===1),
            flat:items.flatMap(row=>[row.n]),
          }));
        `,
        }],
      });
      let tx = runtime.edit();
      const first = runtime.getCell<{ n: number }>(
        signer.did(),
        "first-element",
        undefined,
        tx,
      );
      const second = runtime.getCell<{ n: number }>(
        signer.did(),
        "second-element",
        undefined,
        tx,
      );
      first.set({ n: 1 });
      second.set({ n: 2 });
      const lists = (["space", "user", "session"] as const).map((scope) =>
        runtime.getCell<unknown[]>(
          signer.did(),
          "scope-list",
          undefined,
          tx,
          scope,
        )
      );
      for (const list of lists) list.set([first, second]);
      const selected = runtime.getCell<unknown>(
        signer.did(),
        "selected-list",
        undefined,
        tx,
      );
      selected.set(lists[0]);
      const result = runtime.run(
        tx,
        compiled,
        { items: selected },
        runtime.getCell<Record<string, unknown>>(
          signer.did(),
          "scope-output",
          compiled.resultSchema,
          tx,
        ),
      );
      runtime.prepareTxForCommit(tx);
      await tx.commit().settled;
      cancel = result.sink(() => {});
      await runtime.idle();
      const childScopes: string[] = [];
      const run = runtime.runner.run;
      runtime.runner.run = (...args: Parameters<typeof run>) => {
        if (args[4]?.doNotUpdateOnPatternChange) {
          childScopes.push(
            (args[3] as Cell<unknown>).getAsNormalizedFullLink().scope,
          );
        }
        return Reflect.apply(run, runtime.runner, args);
      };
      const values = { mapped: [1, 2], filtered: [{ n: 1 }], flat: [1, 2] };
      expect(await result.pull()).toEqual(values);
      for (const index of [1, 2, 0]) {
        childScopes.length = 0;
        tx = runtime.edit();
        selected.withTx(tx).set(lists[index]);
        await tx.commit().settled;
        await runtime.idle();
        expect(await result.pull()).toEqual(values);
        expect(childScopes).toEqual(
          Array(4).fill(lists[index].getAsNormalizedFullLink().scope),
        );
        for (const operation of ["filtered", "flat"]) {
          expect(
            result.key(operation).resolveAsCell().getAsNormalizedFullLink()
              .scope,
          )
            .toBe(lists[index].getAsNormalizedFullLink().scope);
        }
      }
      tx = runtime.edit();
      first.withTx(tx).key("n").set(3);
      await tx.commit().settled;
      await runtime.idle();
      expect(await result.pull()).toEqual({
        mapped: [3, 2],
        filtered: [],
        flat: [3, 2],
      });
    } finally {
      cancel?.();
      await storage.synced();
      await runtime.dispose();
      await storage.close();
    }
  });

  it("keeps viewers independent and resumes their user-scoped children", async () => {
    const other = await Identity.fromPassphrase("scoped-list-other-viewer");
    const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    const storages = [signer, other, signer].map((as) =>
      EmulatedStorageManager.connectTo(server, { as })
    );
    const runtimes = storages.map((storageManager) =>
      new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      })
    );
    const [first, second, resumed] = runtimes;
    const cancellations: (() => void)[] = [];
    try {
      const compiled = await first.patternManager.compilePattern(
        program("user"),
      );
      let tx = first.edit();
      const result = first.run(
        tx,
        compiled,
        { source: [1, 2], viewer: 1 },
        first.getCell<Record<string, unknown>>(
          signer.did(),
          "shared-output",
          compiled.resultSchema,
          tx,
        ),
      );
      first.prepareTxForCommit(tx);
      await tx.commit().settled;
      const cancelFirst = result.sink(() => {});
      cancellations.push(cancelFirst);
      await first.idle();
      expect(await result.key("flat").pull()).toEqual([1]);
      await storages[0].synced();
      const link = result.getAsNormalizedFullLink();

      await second.patternManager.compilePattern(program("user"), {
        space: signer.did(),
      });
      const otherResult = second.getCellFromLink<Record<string, unknown>>(link);
      await otherResult.sync();
      tx = second.edit();
      otherResult.key("selected").withTx(tx).set(2);
      await tx.commit().settled;
      cancellations.push(otherResult.sink(() => {}));
      expect(await second.start(otherResult)).toBe(true);
      await second.idle();
      expect(await otherResult.key("flat").pull()).toEqual([2]);
      await storages[1].synced();
      await first.idle();
      expect(await result.key("flat").pull()).toEqual([1]);

      cancelFirst();
      first.runner.stop(result);
      await first.dispose({ closeStorage: false });
      await storages[0].close();
      await resumed.patternManager.compilePattern(program("user"), {
        space: signer.did(),
      });
      const restored = resumed.getCellFromLink<Record<string, unknown>>(link);
      cancellations.push(restored.sink(() => {}));
      expect(await resumed.start(restored)).toBe(true);
      await resumed.idle();
      expect(await restored.key("flat").pull()).toEqual([1]);
      tx = resumed.edit();
      restored.key("selected").withTx(tx).set(2);
      await tx.commit().settled;
      await resumed.idle();
      expect(await restored.key("flat").pull()).toEqual([2]);
    } finally {
      for (const cancel of cancellations) cancel();
      for (const runtime of runtimes) {
        await runtime.dispose({ closeStorage: false });
      }
      for (const storage of storages) await storage.close();
      await server.close();
    }
  });

  for (const scope of ["user", "session"] as const) {
    it(`maps, filters and flattens ${scope} results without sharing scoped arguments`, async () => {
      const storage = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
      let cancel: (() => void) | undefined;
      try {
        const compiled = await runtime.patternManager.compilePattern(
          program(scope),
        );
        let tx = runtime.edit();
        const warnings = getLogger("normalizeAndDiff").counts.warn;
        const result = runtime.run(
          tx,
          compiled,
          { source: [1, 2], viewer: 1 },
          runtime.getCell<Record<string, unknown>>(
            signer.did(),
            "output",
            compiled.resultSchema,
            tx,
          ),
        );
        runtime.prepareTxForCommit(tx);
        await tx.commit().settled;
        cancel = result.sink(() => {});
        const expected = (selected: number) => ({
          selected,
          mapped: [1, 2].map((value) => ({
            type: "vnode",
            name: "span",
            props: {},
            children: [value, ":", value === selected],
          })),
          filtered: [{ value: selected, self: true }],
          flat: [selected],
        });
        await runtime.idle();
        expect(await result.pull()).toEqual(expected(1));
        expect(getLogger("normalizeAndDiff").counts.warn).toBe(warnings);
        tx = runtime.edit();
        result.key("selected").withTx(tx).set(2);
        await tx.commit().settled;
        await runtime.idle();
        expect(await result.pull()).toEqual(expected(2));
        expect(getLogger("normalizeAndDiff").counts.warn).toBe(warnings);
      } finally {
        cancel?.();
        await storage.synced();
        await runtime.dispose();
        await storage.close();
      }
    });
  }
});
