import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import { getDerivedInternalCellLink, parseLink } from "../src/link-utils.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { Pattern } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("resume list children presync");
const space = signer.did();

// A map over a durable list: each element runs as a child piece of its own,
// resumed by the coordinator from inside its scheduler run.
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { n: number }[] }>(({ items }) => {",
      "  return { doubled: items.map((item) => ({ value: item.n * 2 })) };",
      "});",
    ].join("\n"),
  }],
};

describe("resume-list-children-presync", () => {
  // A coordinator's children arrive at a cold replica without their execution
  // families, and the coordinator instantiates them synchronously inside its
  // own run — so the resume pre-sync must name each child, and the cells the
  // child owns (its element pattern's derived internal cells, which its first
  // run reads), before the parent instantiates. The spy records every cell
  // sync a replica issues; the assertions are on the children and owned cells
  // the pre-sync named, and on those being exactly the ones the coordinator
  // itself mints.

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

  function replica(): { runtime: Runtime; syncedIds: string[] } {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    const syncedIds: string[] = [];
    const original = manager.syncCell.bind(manager);
    manager.syncCell = ((cell, options) => {
      syncedIds.push(cell.getAsNormalizedFullLink().id);
      return original(cell, options);
    }) as typeof manager.syncCell;
    managers.push(manager);
    runtimes.push(runtime);
    return { runtime, syncedIds };
  }

  it("names every list child before a cold resume instantiates the parent", async () => {
    const cellId = "resume-list-children-parent";

    // CREATE: build the durable list and its children on one replica.
    const author = replica();
    const compiled = await author.runtime.patternManager.compilePattern(
      PROGRAM,
      { space },
    );
    const tx = author.runtime.edit();
    const authored = author.runtime.getCell<{ doubled: { value: number }[] }>(
      space,
      cellId,
      compiled.resultSchema,
      tx,
    );
    author.runtime.run(tx, compiled, { items: [{ n: 1 }, { n: 2 }] }, authored);
    await tx.commit().settled;
    await authored.pull();
    await author.runtime.settled();
    await author.runtime.patternManager.flushCompileCacheWrites();
    await author.runtime.storageManager.synced();
    expect(
      (authored.key("doubled").getAsQueryResult() as { value: number }[])
        .map((row) => row.value),
    ).toEqual([2, 4]);
    // The children the coordinator minted: the result container's slots
    // link each element's result document.
    const container = authored.key("doubled").resolveAsCell();
    const slots = container.getRaw() as unknown[];
    const childIds: string[] = slots.flatMap((slot) => {
      const id = parseLink(slot, container)?.id;
      return id === undefined ? [] : [id as string];
    });
    expect(childIds.length).toBe(2);
    // The cell each child owns: the element pattern's one derived internal
    // cell (`item.n * 2`), minted from the child's result cell exactly as
    // the child's own setup mints it. Index-aligned with `childIds`.
    const elementPattern = (compiled.nodes[0].inputs as { op: Pattern }).op;
    expect(elementPattern.derivedInternalCells?.length).toBe(1);
    const ownedIds: string[] = slots.flatMap((slot) => {
      const childLink = parseLink(slot, container);
      if (childLink === undefined) return [];
      const childCell = author.runtime.getCellFromLink(childLink);
      return (elementPattern.derivedInternalCells ?? []).map((descriptor) =>
        getDerivedInternalCellLink(childCell, descriptor).id as string
      );
    });
    expect(ownedIds.length).toBe(2);
    const childOfOwned = new Map(
      ownedIds.map((ownedId, index) => [ownedId, childIds[index]]),
    );
    await author.runtime.dispose({ closeStorage: false });
    runtimes.splice(runtimes.indexOf(author.runtime), 1);

    // RESUME: a cold replica starts the parent; the pre-sync names both
    // children, and does so before the coordinator has instantiated either.
    const resumer = replica();
    await resumer.runtime.patternManager.compilePattern(PROGRAM, { space });
    const resumed = resumer.runtime.getCell<{ doubled: { value: number }[] }>(
      space,
      cellId,
      compiled.resultSchema,
    );
    const registeredWhenNamed = new Map<string, boolean>();
    const original = resumer.runtime.storageManager.syncCell.bind(
      resumer.runtime.storageManager,
    );
    resumer.runtime.storageManager.syncCell = ((cell, options) => {
      const id = cell.getAsNormalizedFullLink().id;
      // An owned cell counts as named "while running" once ITS child is.
      const pieceId = childOfOwned.get(id) ?? id;
      if (
        (childIds.includes(id) || ownedIds.includes(id)) &&
        !registeredWhenNamed.has(id)
      ) {
        registeredWhenNamed.set(
          id,
          [...resumer.runtime.runner.cancels.keys()].some((key) =>
            key.endsWith(`/${pieceId}`)
          ),
        );
      }
      return original(cell, options);
    }) as typeof resumer.runtime.storageManager.syncCell;

    expect(await resumer.runtime.runner.start(resumed)).toBe(true);
    await resumer.runtime.settled();
    await resumer.runtime.storageManager.synced();

    // Both children were named (mutation: without the children wave the
    // coordinator's own run is the first thing to touch them)...
    for (const id of childIds) {
      expect(resumer.syncedIds).toContain(id);
    }
    // ...and each was named while it was not yet running — the pre-sync
    // ran ahead of the coordinator's instantiation.
    for (const id of childIds) {
      expect(registeredWhenNamed.get(id)).toBe(false);
    }
    // The cell each child owns was named the same way (mutation: without the
    // owned-cell collection the child's first run is the first thing to
    // touch it, after the child has registered — or nothing syncs it at all
    // and the map holds no entry).
    for (const id of ownedIds) {
      expect(resumer.syncedIds).toContain(id);
      expect(registeredWhenNamed.get(id)).toBe(false);
    }
    expect(
      (resumed.key("doubled").getAsQueryResult() as { value: number }[])
        .map((row) => row.value),
    ).toEqual([2, 4]);
  });
});
