import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("argument-default-seed");
const space = signer.did();

/** The argument list's protection: its writer alone, or with its owner. */
const protections = {
  "its writer": "WriteAuthorizedBy<string[], typeof edit>",
  "its writer and owner": `RepresentsCurrentUser<
    Cfc<
      WriteAuthorizedBy<string[], typeof edit>,
      { ownerPrincipal: CurrentPrincipal }
    >
  >`,
};

/** The result of either shape of the pattern below. */
type Counter = { add: { add?: string }; count: number };
type Result = Counter & { child: Counter };

/**
 * What the pattern does with the list its argument defaults, as the
 * expression it returns, and where the stream adding to the list and the
 * list's length sit in its result.
 */
const uses = {
  "passes to a sub-pattern": {
    returned: "{ child: Child({ items }) }",
    counter: (result: Cell<Result>) => result.key("child"),
  },
  "keeps to itself": {
    returned:
      "{ count: computed(() => items.get().length), add: edit({ items }) }",
    counter: (result: Cell<Result>): Cell<Counter> => result,
  },
  "returns": {
    returned:
      "{ items, count: computed(() => items.get().length), add: edit({ items }) }",
    counter: (result: Cell<Result>): Cell<Counter> => result,
  },
};

describe("argument-default-seed", () => {
  let runtime: Runtime;
  let manager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    manager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      trustSnapshotProvider: () => ({
        id: signer.did(),
        actingPrincipal: signer.did(),
      }),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await manager.close();
  });

  /**
   * Compiles the pattern whose argument defaults a list under `schemaType`
   * and returns `returned`.
   */
  function compile(schemaType: string, returned: string) {
    return runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `/// <cts-enable />
          import {
            Cfc,
            computed,
            CurrentPrincipal,
            Default,
            handler,
            pattern,
            RepresentsCurrentUser,
            Writable,
            WriteAuthorizedBy,
          } from "commonfabric";
          const edit = handler<
            { add?: string },
            { items: Writable<string[]> }
          >((event, { items }) => {
            if (event.add !== undefined) {
              items.set([...items.get(), event.add]);
            }
          });
          type Items = ${schemaType};
          const Child = pattern<{ items: Writable<Items> }>((
            { items },
          ) => ({
            add: edit({ items }),
            count: computed(() => items.get().length),
          }));
          export default pattern<{ items: Writable<Default<Items, []>> }>((
            { items },
          ) => (${returned}));
        `,
      }],
    });
  }

  for (const [protection, schemaType] of Object.entries(protections)) {
    for (const [use, { returned, counter }] of Object.entries(uses)) {
      it(`seeds the default of an argument list protected by ${protection} that the pattern ${use}, and the writer writes it`, async () => {
        const errors: unknown[] = [];
        runtime.scheduler.onError((error) => errors.push(error));
        const compiled = await compile(schemaType, returned);
        const tx = runtime.edit();
        const result = runtime.run(
          tx,
          compiled,
          {},
          runtime.getCell<Result>(space, "result", compiled.resultSchema, tx),
        );
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
        const cancel = result.sink(() => {});
        await runtime.idle();

        counter(result).key("add").send({ add: "a" });
        await runtime.idle();
        await manager.synced();

        expect(await counter(result).key("count").pull()).toBe(1);
        expect(errors).toEqual([]);
        cancel();
      });
    }
  }

  for (const [use, { returned }] of Object.entries(uses)) {
    it(`refuses a value the caller supplies in place of the default of a list the pattern ${use}`, async () => {
      const compiled = await compile(protections["its writer"], returned);
      const tx = runtime.edit();
      runtime.run(
        tx,
        compiled,
        { items: ["forged"] },
        runtime.getCell<Result>(space, "result", compiled.resultSchema, tx),
      );
      runtime.prepareTxForCommit(tx);

      expect((await tx.commit().settled).error?.message).toContain(
        "writeAuthorizedBy requires a trusted verified binding identity at /items",
      );
    });

    it(`refuses a value equal to the default that the caller supplies for a list the pattern ${use}`, async () => {
      // The caller wrote the field, so it is no setup seed, whatever it holds.
      const compiled = await compile(protections["its writer"], returned);
      const tx = runtime.edit();
      runtime.run(
        tx,
        compiled,
        { items: [] },
        runtime.getCell<Result>(space, "result", compiled.resultSchema, tx),
      );
      runtime.prepareTxForCommit(tx);

      expect((await tx.commit().settled).error?.message).toContain(
        "writeAuthorizedBy requires a trusted verified binding identity at /items",
      );
    });
  }

  it("seeds two argument slots of identical schemas as two lists, so a write to one leaves the other empty", async () => {
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `/// <cts-enable />
          import { Default, handler, pattern, Writable } from "commonfabric";
          const add = handler<{ item: string }, { list: Writable<string[]> }>(
            (event, { list }) => list.push(event.item),
          );
          export default pattern<{
            first: Writable<Default<string[], []>>;
            second: Writable<Default<string[], []>>;
          }>(({ first, second }) => ({
            first,
            second,
            addFirst: add({ list: first }),
          }));
        `,
      }],
    });
    type Twins = {
      first: string[];
      second: string[];
      addFirst: { item: string };
    };
    const tx = runtime.edit();
    const result = runtime.run(
      tx,
      compiled,
      {},
      runtime.getCell<Twins>(space, "twins", compiled.resultSchema, tx),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    const cancel = result.sink(() => {});
    await runtime.idle();

    result.key("addFirst").send({ item: "a" });
    await runtime.idle();
    await manager.synced();

    expect(await result.key("first").pull()).toEqual(["a"]);
    expect(await result.key("second").pull()).toEqual([]);
    cancel();
  });
});
