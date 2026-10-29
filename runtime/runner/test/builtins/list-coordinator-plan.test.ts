import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import { listSlotResolutions } from "../../src/builtins/list-coordinator-plan.ts";
import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../../src/storage/v2-emulate.ts";

const signer = await Identity.fromPassphrase("list-coordinator-plan");
const space = signer.did();

describe("list-coordinator-plan", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let runtime: Runtime;
  let errors: string[];
  const runtimes: Runtime[] = [];

  /** A runtime of its own over the shared server, its errors in `errors`. */
  function open(): Runtime {
    const opened = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
    });
    opened.scheduler.onError((error) => errors.push(error.message));
    runtimes.push(opened);
    return opened;
  }

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    errors = [];
    runtime = open();
  });

  afterEach(async () => {
    for (const opened of runtimes.splice(0)) await opened.dispose();
    await server.close();
  });

  /**
   * The ways a list's middle element can link so that its links run in a
   * cycle, each given the list's own cell: back to its own place, and into a
   * subpath of its own place. Each list builtin resolves its list's slots
   * through `listSlotResolutions()`, by the input keys `list` and, for an
   * aggregate selecting an element and a collection index, `elements`, as
   * the resume pre-sync does by `list`.
   */
  const cycles: [string, (list: Cell<FabricValue>) => FabricValue][] = [
    ["to its own place", (list) => list.key(1).getAsLink()],
    ["into its own subpath", (list) => list.key(1).key("x").getAsLink()],
  ];

  /**
   * A list `["a", <middle>, "c"]` committed under `name`, with `middle`
   * built from the list's own cell, and a cell holding it under `list` and
   * `elements`, as a list builtin's inputs hold their lists.
   */
  async function listWith(
    name: string,
    middle: (list: Cell<FabricValue>) => FabricValue,
  ): Promise<{ list: Cell<FabricValue>; inputs: Cell<unknown> }> {
    const tx = runtime.edit();
    const list = runtime.getCell<FabricValue>(space, name, undefined, tx);
    list.setRaw(["a", middle(list), "c"]);
    const inputs = runtime.getCell<unknown>(
      space,
      `${name} inputs`,
      undefined,
      tx,
    );
    inputs.setRawUntyped({
      list: list.getAsLink(),
      elements: list.getAsLink(),
    });
    expect((await tx.commit().settled).error).toBeUndefined();
    return { list, inputs };
  }

  /**
   * Runs the pattern `source` over `list` as its argument `list`, and
   * returns its result once it has settled.
   */
  async function runOver(
    source: string,
    list: Cell<FabricValue>,
  ): Promise<Cell<Record<string, unknown>>> {
    const tx = runtime.edit();
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: source }],
    }, { space, tx });
    const output = runtime.getCell<Record<string, unknown>>(
      space,
      `output over ${crypto.randomUUID()}`,
      compiled.resultSchema,
      tx,
    );
    const result = runtime.run(tx, compiled, { list }, output);
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    await result.pull();
    await runtime.idle();
    return result;
  }

  for (const [kind, middle] of cycles) {
    describe(`over a list an element of which links ${kind}`, () => {
      it("resolves that element's slot to its place in the list, and each other slot to its value", async () => {
        const { list, inputs } = await listWith(`slots ${kind}`, middle);
        const base = list.getAsNormalizedFullLink();

        for (const key of ["list", "elements"]) {
          const tx = runtime.edit();
          const { slots } = listSlotResolutions(runtime, tx, inputs, key);
          tx.abort();

          expect(slots.map(({ id, path }) => ({ id, path }))).toEqual(
            ["0", "1", "2"].map((index) => ({
              id: base.id,
              path: [index],
            })),
          );
        }
      });

      it("maps the list, its own place standing in for that element", async () => {
        const { list } = await listWith(`map ${kind}`, middle);

        const result = await runOver(
          `
          import { pattern } from "commonfabric";
          export default pattern<{ list: string[] }>(({ list }) => ({
            out: list.map((_, index) => index * 10),
          }));
        `,
          list,
        );

        expect(result.key("out").get()).toEqual([0, 10, 20]);
        expect(errors).toEqual([]);
      });
    });
  }

  for (
    const [op, call] of [
      ["map", "list.map((_, index) => index)"],
      ["filter", "list.filter((_, index) => index > 0)"],
      ["flatMap", "list.flatMap((_, index) => [index])"],
    ]
  ) {
    it(`leaves a ${op} that fails holding no list, rather than an empty one`, async () => {
      const tx = runtime.edit();
      const list = runtime.getCell<FabricValue>(
        space,
        `not a list for ${op}`,
        undefined,
        tx,
      );
      list.setRaw("not a list");
      expect((await tx.commit().settled).error).toBeUndefined();

      const result = await runOver(
        `
        import { pattern } from "commonfabric";
        export default pattern<{ list: string[] }>(({ list }) => ({
          out: ${call},
        }));
      `,
        list,
      );

      expect(errors.join("\n")).toContain("only supports arrays");
      expect(result.key("out").get()).toBeUndefined();
    });
  }

  it("leaves a map that failed holding no list once it resumes on another runtime", async () => {
    const tx = runtime.edit();
    const list = runtime.getCell<FabricValue>(
      space,
      "not a list to resume over",
      undefined,
      tx,
    );
    list.setRaw("not a list");
    expect((await tx.commit().settled).error).toBeUndefined();
    const result = await runOver(
      `
      import { pattern } from "commonfabric";
      export default pattern<{ list: string[] }>(({ list }) => ({
        out: list.map((_, index) => index),
      }));
    `,
      list,
    );
    runtime.runner.stop(result);
    await runtime.storageManager.synced();

    const resuming = open();
    const resumed = resuming.getCellFromLink(result.getAsNormalizedFullLink());
    await resumed.sync();
    await resuming.runner.start(resumed);
    await resuming.idle();
    await resuming.storageManager.synced();
    await resuming.idle();

    expect(await resumed.key("out").pull()).toBeUndefined();
    resuming.runner.stop(resumed);
  });
});
