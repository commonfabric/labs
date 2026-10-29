import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("resume list children slot chain");
const space = signer.did();
const otherSpace = (await Identity.fromPassphrase(
  "resume list children slot chain, other space",
)).did();

// A list whose one slot reaches its element through a chain of link-valued
// documents that alternate spaces, so no traversal delivers the next hop
// alongside the last (a metadata family is same-space, and a crossing is
// not followed into another space): on a cold replica every hop is cold
// until something names it. A coordinator keys the element on where the
// slot's VALUE resolution ends, so the pre-sync must follow the chain to
// that same end before deriving the child — however long the chain — or it
// names a child the coordinator never mints and the real one resumes cold.
const CHAIN_HOPS = 8;
const hopSpace = (hop: number) => (hop % 2 === 0 ? otherSpace : space);

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { n: number }[] }>(({ items }) => {",
      "  return { rows: items.map((item) => ({ n: item.n })) };",
      "});",
    ].join("\n"),
  }],
};

describe("resume-list-children-slot-chain-presync", () => {
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

  function replica(): { runtime: Runtime; manager: EmulatedStorageManager } {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    managers.push(manager);
    runtimes.push(runtime);
    return { runtime, manager };
  }

  it("names the coordinator's child for a slot whose value chain is longer than a round warms", async () => {
    const cellId = "slot-chain-host";

    // BUILD: the chain — `hop-1` holds a link to `hop-2`, … , the last hop
    // holds the element's value — one transaction per hop, since a hop's
    // document and the document it links to live in different spaces; then
    // a host whose list holds `hop-1`.
    const author = replica();
    let next = author.runtime.getCell<unknown>(
      hopSpace(CHAIN_HOPS),
      `slot-chain-hop-${CHAIN_HOPS}`,
    );
    {
      const hopTx = author.runtime.edit();
      next.withTx(hopTx).set({ n: 7 });
      expect((await hopTx.commit().settled).error).toBeUndefined();
    }
    for (let hop = CHAIN_HOPS - 1; hop >= 1; hop--) {
      const cell = author.runtime.getCell<unknown>(
        hopSpace(hop),
        `slot-chain-hop-${hop}`,
      );
      const hopTx = author.runtime.edit();
      cell.withTx(hopTx).set(next);
      expect((await hopTx.commit().settled).error).toBeUndefined();
      next = cell;
    }
    const tx = author.runtime.edit();
    const compiled = await author.runtime.patternManager.compilePattern(
      PROGRAM,
      { space, tx },
    );
    const authored = author.runtime.getCell<{ rows: { n: number }[] }>(
      space,
      cellId,
      compiled.resultSchema,
      tx,
    );
    author.runtime.run(tx, compiled, { items: [next] }, authored);
    author.runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await authored.pull();
    await author.runtime.settled();
    await author.runtime.patternManager.flushCompileCacheWrites();
    await author.runtime.storageManager.synced();
    expect(
      (authored.key("rows").getAsQueryResult() as { n: number }[])
        .map((row) => row.n),
    ).toEqual([7]);
    // The child the coordinator minted for the slot, keyed on the chain's end.
    const container = authored.key("rows").resolveAsCell();
    const slots = container.getRaw() as unknown[];
    const childIds: string[] = slots.flatMap((slot) => {
      const id = parseLink(slot, container)?.id;
      return id === undefined ? [] : [id as string];
    });
    expect(childIds.length).toBe(1);
    await author.runtime.dispose({ closeStorage: false });
    runtimes.splice(runtimes.indexOf(author.runtime), 1);

    // RESUME: the cold replica's pre-sync must name that same child before
    // the coordinator instantiates it (mutation: a pre-sync that stops
    // following the chain after a fixed number of pulls keys the element on
    // a cold hop and names a child that exists nowhere; the real one is
    // first touched by the coordinator's own run, after it registered).
    const resumer = replica();
    await resumer.runtime.patternManager.compilePattern(PROGRAM, { space });
    const resumed = resumer.runtime.getCell<{ rows: { n: number }[] }>(
      space,
      cellId,
      compiled.resultSchema,
    );
    const registeredWhenNamed = new Map<string, boolean>();
    const original = resumer.manager.syncCell.bind(resumer.manager);
    resumer.manager.syncCell = ((cell, options) => {
      const id = cell.getAsNormalizedFullLink().id;
      if (childIds.includes(id) && !registeredWhenNamed.has(id)) {
        registeredWhenNamed.set(
          id,
          [...resumer.runtime.runner.cancels.keys()].some((key) =>
            key.endsWith(`/${id}`)
          ),
        );
      }
      return original(cell, options);
    }) as typeof resumer.manager.syncCell;

    expect(await resumer.runtime.runner.start(resumed)).toBe(true);
    await resumer.runtime.settled();
    await resumer.runtime.storageManager.synced();
    for (const id of childIds) {
      expect(registeredWhenNamed.get(id)).toBe(false);
    }
    await resumed.pull();
    expect(
      (resumed.key("rows").getAsQueryResult() as { n: number }[])
        .map((row) => row.n),
    ).toEqual([7]);
  });
});
