import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import { getMetaLink } from "../src/link-utils.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("list coordinator resume hold");
const space = signer.did();

type ListOp = "map" | "filter" | "flatMap";

// One coordinator of each kind over the argument's `items`, its container
// at the result's `rows`.
const body: Record<ListOp, string> = {
  map: "items.map((item) => ({ n: item.n }))",
  filter: "items.filter((item) => item.n > 0)",
  flatMap: "items.flatMap((item) => [{ n: item.n }])",
};

const program = (op: ListOp): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { n: number }[] }>(({ items }) => {",
      `  return { rows: ${body[op]} };`,
      "});",
    ].join("\n"),
  }],
});

describe("list-coordinator-resume-hold", () => {
  // A resumed coordinator whose durable container holds elements, meeting
  // an input that is empty or has no value: the input may be a transient
  // default standing in while the real list streams in, so the coordinator
  // holds the container rather than writing `[]` over it, awaits the input,
  // and clears the container only once the input confirms it is genuinely
  // empty.

  let server: ReturnType<typeof newSharedServer>;
  let managers: EmulatedStorageManager[];
  let runtimes: Runtime[];

  beforeEach(() => {
    server = newSharedServer();
    managers = [];
    runtimes = [];
  });

  afterEach(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    for (const manager of managers) await manager.close();
    await server.close();
  });

  function replica(): Runtime {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    managers.push(manager);
    runtimes.push(runtime);
    return runtime;
  }

  for (const op of ["map", "filter", "flatMap"] as const) {
    it(`holds a resumed ${op}'s durable container while its input is empty, then settles it empty once the input confirms`, async () => {
      const cellId = `list-coordinator-resume-hold-${op}`;

      // BUILD: one element, so the container holds a slot.
      const builder = replica();
      const compiled = await builder.patternManager.compilePattern(
        program(op),
        { space },
      );
      const tx = builder.edit();
      const built = builder.getCell<{ rows: { n: number }[] }>(
        space,
        cellId,
        compiled.resultSchema,
        tx,
      );
      builder.run(tx, compiled, { items: [{ n: 1 }] }, built);
      await tx.commit().settled;
      await built.pull();
      await builder.settled();
      await builder.patternManager.flushCompileCacheWrites();
      await builder.storageManager.synced();
      expect((built.key("rows").getAsQueryResult() as unknown[]).length)
        .toBe(1);
      // The input goes empty while nothing runs — the shape a resume meets
      // when the durable list has not confirmed yet.
      const argumentLink = getMetaLink(built, "argument");
      expect(argumentLink).toBeDefined();
      const emptying = builder.edit();
      builder.getCellFromLink(argumentLink!).withTx(emptying).key("items")
        .set([]);
      expect((await emptying.commit().settled).error).toBeUndefined();
      await builder.storageManager.synced();
      await builder.dispose({ closeStorage: false });
      runtimes.splice(runtimes.indexOf(builder), 1);

      // RESUME: a cold replica's coordinator sees a container with a slot
      // and an empty input, holds, and settles the container empty once the
      // input has confirmed.
      const resumer = replica();
      await resumer.patternManager.compilePattern(program(op), { space });
      const resumed = resumer.getCell<{ rows: { n: number }[] }>(
        space,
        cellId,
        compiled.resultSchema,
      );
      expect(await resumer.runner.start(resumed)).toBe(true);
      await resumer.settled();
      await resumer.storageManager.synced();
      await resumer.idle();
      await resumed.pull();
      expect(resumed.key("rows").getAsQueryResult()).toEqual([]);
    });
  }
});
