import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("protected-binding-builtins");
const space = signer.did();

// The list's protection: its writer alone, or its writer and its owner.
const protections = {
  writer: "WriteAuthorizedBy<string[], typeof edit>",
  owner: `RepresentsCurrentUser<
    Cfc<
      WriteAuthorizedBy<string[], typeof edit>,
      { ownerPrincipal: CurrentPrincipal }
    >
  >`,
};

// A sub-pattern whose argument repeats the list's policy, as one a pattern
// composes over the list does.
const rowDeclaration = `
  const Row = pattern<{ item: string; items: Writable<Items> }>(
    ({ item, items }) => ({ item, remove: edit({ items }) }),
  );`;

// Each builtin the probe runs over the protected list, the expression that
// runs it, and what the probe reads once two items are added. A callback that
// binds the list's writer captures the list, so the list reaches the
// sub-pattern a list builtin sets up for each entry as a captured binding.
const probes: Record<string, {
  expression: string;
  expected: unknown;
  read?: (probe: unknown) => unknown;
  declarations?: string;
}> = {
  "`ifElse()` choosing the list": {
    expression: "ifElse(on, items, [])",
    expected: ["a", "b"],
  },
  "`when()` passing the list": {
    expression: "when(on, items)",
    expected: ["a", "b"],
  },
  "`unless()` falling back to the list": {
    expression: "unless(off, items)",
    expected: ["a", "b"],
  },
  "`computed()` capturing the list": {
    expression: "computed(() => items.get().length)",
    expected: 2,
  },
  "a nested `map()` whose callbacks both capture the list": {
    expression: `items.map((item) =>
        items.map((other) => ({ item, other, remove: edit({ items }) }))
      ).map((rows) => rows.length)`,
    expected: [2, 2],
  },
  "a sub-pattern composed in a `map()` callback over the list": {
    expression:
      "items.map((item) => Row({ item, items })).map((row) => row.item)",
    expected: ["a", "b"],
    declarations: rowDeclaration,
  },
  "`minBy()` with a callback capturing the list": {
    expression: `items.minBy((item) => {
        const remove = edit({ items });
        return item === "a" ? 0 : 1;
      })`,
    expected: "a",
  },
  "`count()` with a callback capturing the list": {
    expression: `items.count((item) => {
        const remove = edit({ items });
        return item === "a";
      })`,
    expected: 1,
  },
  "`groupBy()` with a callback capturing the list": {
    expression: `items.groupBy((item) => {
        const remove = edit({ items });
        return item;
      })`,
    expected: ["a", "b"],
    read: (probe) => (probe as { keys?: unknown }).keys,
  },
};

describe("protected-binding-builtins", () => {
  let runtime: Runtime;
  let manager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    manager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: manager,
      trustSnapshotProvider: () => ({
        id: signer.did(),
        actingPrincipal: signer.did(),
      }),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  /**
   * Runs a pattern holding a list under `protection`, whose result's `probe`
   * is `expression` over that list, adds two items through the list's
   * writer, and returns the setup's refusal, if any, every error the
   * scheduler reported, and the probe's value. `declarations` are added at
   * module level before the pattern.
   */
  async function runProbe(
    expression: string,
    protection: keyof typeof protections,
    declarations = "",
  ) {
    const errors: unknown[] = [];
    runtime.scheduler.onError((error) => errors.push(error));
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `/// <cts-enable />
          import {
            Cfc,
            computed,
            CurrentPrincipal,
            handler,
            ifElse,
            pattern,
            RepresentsCurrentUser,
            unless,
            when,
            Writable,
            WriteAuthorizedBy,
          } from "commonfabric";
          const edit = handler<
            { add?: string; remove?: string },
            { items: Writable<string[]> }
          >((event, { items }) => {
            const kept = items.get().filter((item) => item !== event.remove);
            items.set(event.add === undefined ? kept : [...kept, event.add]);
          });
          type Items = ${protections[protection]};
          ${declarations}
          export default pattern<Record<string, never>>(() => {
            const items = new Writable<Items>([]).for("items");
            const on = new Writable<boolean>(true).for("on");
            const off = new Writable<boolean>(false).for("off");
            return {
              items,
              probe: ${expression},
              add: edit({ items }),
            };
          });
        `,
      }],
    });
    const tx = runtime.edit();
    const output = runtime.getCell<{ probe: unknown; add: unknown }>(
      space,
      "output",
      compiled.resultSchema,
      tx,
    );
    const result = runtime.run(tx, compiled, {}, output);
    runtime.prepareTxForCommit(tx);
    const setupError = (await tx.commit()).error?.message;
    const cancel = result.sink(() => {});
    await runtime.idle();
    result.key("add").send({ add: "a" });
    await runtime.idle();
    result.key("add").send({ add: "b" });
    await runtime.idle();
    // The second write's commit can still be in flight once the scheduler is
    // idle; settling it keeps teardown from cutting it off.
    await manager.synced();
    const probe = await result.key("probe").pull();
    cancel();
    return { setupError, errors: errors.map(String), probe };
  }

  for (const [name, probe] of Object.entries(probes)) {
    describe(name, () => {
      for (const protection of ["writer", "owner"] as const) {
        it(`sets up and settles without a refusal over a list protected by its ${protection}`, async () => {
          const { setupError, errors, probe: value } = await runProbe(
            probe.expression,
            protection,
            probe.declarations,
          );
          expect(setupError).toBeUndefined();
          expect(errors).toEqual([]);
          expect(probe.read ? probe.read(value) : value).toEqual(
            probe.expected,
          );
        });
      }
    });
  }
});
