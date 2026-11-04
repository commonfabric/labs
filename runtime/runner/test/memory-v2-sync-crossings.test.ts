import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";
import { entityKey } from "../src/scheduler/keys.ts";
import type {
  IStorageProvider,
  MemorySpace,
} from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("memory v2 sync crossings");
const space = signer.did();
const farSpace = (await Identity.fromPassphrase("memory v2 sync crossings far"))
  .did();

const leafSchema = {
  type: "object",
  properties: { name: { type: "string" } },
} as const;
const topSchema = {
  type: "object",
  properties: { next: leafSchema },
} as const;

// A piece whose handler binds the far document as a value: the runner
// resolves the argument before the body runs, and withdraws the dispatch
// while a document it reaches is still loading.
const RECORDER_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { handler, pattern, Stream, Writable } from 'commonfabric';",
      "type Target = { next: { name: string } };",
      "const record = handler<",
      "  { tag: string },",
      "  { target: Target; log: Writable<string[]> }",
      ">((event, { target, log }) => {",
      "  log.push(`${event.tag}:${target.next.name}`);",
      "});",
      "export default pattern<",
      "  { target: Target },",
      "  { log: string[]; record: Stream<{ tag: string }> }",
      ">(({ target }) => {",
      "  const log = Writable.of<string[]>([]);",
      "  return { log, record: record({ target, log }) };",
      "});",
    ].join("\n"),
  }],
};

describe("memory-v2-sync-crossings", () => {
  let server: MemoryV2Server.Server;
  let managerA: EmulatedStorageManager;
  let managerB: EmulatedStorageManager;
  let rt1: Runtime;
  let rt2: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    managerA = EmulatedStorageManager.connectTo(server, { as: signer });
    managerB = EmulatedStorageManager.connectTo(server, { as: signer });
    rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerA,
    });
    rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerB,
    });
  });

  afterEach(async () => {
    await rt1.dispose();
    await rt2.dispose();
    await managerA.close();
    await managerB.close();
    await server.close();
  });

  /** Whether replica B holds the document `cell` names, in `inSpace`. */
  function localOnB(cell: Cell<unknown>, inSpace: MemorySpace): boolean {
    const link = cell.getAsNormalizedFullLink();
    const replica = managerB.open(inSpace) as unknown as {
      get?: (uri: string, scope?: unknown) => unknown;
    };
    return replica.get?.(link.id, link.scope) !== undefined;
  }

  /** Writes a leaf in the far space and a document here whose `next` links to it. */
  async function writeCrossing(cause: string) {
    const txFar = rt1.edit();
    const leaf = rt1.getCell<{ name?: string }>(
      farSpace,
      `${cause} leaf`,
      undefined,
      txFar,
    );
    leaf.withTx(txFar).set({ name: "Ada" });
    rt1.prepareTxForCommit(txFar);
    expect((await txFar.commit().settled).error).toBeUndefined();
    const tx = rt1.edit();
    const top = rt1.getCell<{ next?: unknown }>(
      space,
      `${cause} top`,
      undefined,
      tx,
    );
    top.withTx(tx).set({ next: leaf });
    rt1.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await rt1.storageManager.synced();
    return { leaf, top };
  }

  it("kicks the far document's load from the crossing a sync's frame carries", async () => {
    const { leaf, top } = await writeCrossing("resolved sync");
    const top2 = rt2.getCellFromLink<{ next?: { name?: string } }>({
      ...top.getAsNormalizedFullLink(),
      schema: topSchema,
    });
    expect(localOnB(leaf, farSpace)).toBe(false);
    await top2.sync();
    // Nothing read through the link: the frame's crossing kicked the far
    // load, which the manager lists until it lands, and reports following
    // once its session has negotiated the capability.
    expect(managerB.followsCrossings?.(space)).toBe(true);
    const leafLink = leaf.getAsNormalizedFullLink();
    const pending = managerB.pendingCrossingLoadAddresses?.() ?? [];
    expect(pending.map((address) => [address.space, address.id])).toEqual([
      [farSpace, leafLink.id],
    ]);
    await managerB.loadsSettled(
      pending.map((address) => entityKey(address, managerB.scopeKeyIdentity())),
    );
    expect(managerB.pendingCrossingLoadAddresses?.()).toEqual([]);
    expect(localOnB(leaf, farSpace)).toBe(true);
    expect(top2.get()).toEqual({ next: { name: "Ada" } });
  });

  it("runs a handler parked on a document whose crossing load failed, once the handler's own load lands", async () => {
    // The crossing load is a prefetch no reader asked for, so its failure
    // fails no reader's wait: the parked event wakes when the document's
    // loads settle and runs on what its own load brought. Were the failure
    // to reach the event's wait, the scheduler would drop the event before
    // its handler ran. A runtime that finds the link by reading never kicks
    // a crossing load at all, and runs the handler the same way.
    const { leaf, top } = await writeCrossing("failed crossing");
    const leafKey = entityKey(
      leaf.getAsNormalizedFullLink(),
      managerB.scopeKeyIdentity(),
    );

    // Every load of the far document is held until the event has parked:
    // then the crossing's load fails and the others go through.
    const provider = managerB.open(farSpace);
    const realSync = provider.sync.bind(provider);
    let crossingLoad = true;
    let crossingLoads = 0;
    const { promise: released, resolve: release } = Promise.withResolvers<
      void
    >();
    provider.sync = (async (...args: Parameters<IStorageProvider["sync"]>) => {
      const [uri] = args;
      if (uri !== leaf.getAsNormalizedFullLink().id) return realSync(...args);
      const failing = crossingLoad;
      if (failing) crossingLoads++;
      await released;
      return failing
        ? { error: new Error("crossing load refused") }
        : realSync(...args);
    }) as IStorageProvider["sync"];

    const top2 = rt2.getCellFromLink<{ next?: { name?: string } }>({
      ...top.getAsNormalizedFullLink(),
      schema: topSchema,
    });
    await top2.sync();
    crossingLoad = false;
    expect(crossingLoads).toBe(1);
    expect(managerB.pendingCrossingLoadAddresses?.()).toEqual([
      {
        space: farSpace,
        scope: "space",
        id: leaf.getAsNormalizedFullLink().id,
      },
    ]);

    // The event parks on the far document's loads: the scheduler's park
    // waits on them through `loadsSettled()`.
    const realLoadsSettled = managerB.loadsSettled.bind(managerB);
    const { promise: parked, resolve: park } = Promise.withResolvers<void>();
    managerB.loadsSettled = (keys) => {
      if (keys.includes(leafKey)) park();
      return realLoadsSettled(keys);
    };

    const compiled = await rt2.patternManager.compilePattern(
      RECORDER_PROGRAM,
      { space },
    );
    const tx = rt2.edit();
    const recorder = rt2.getCell<{ log: string[] }>(
      space,
      "failed crossing recorder",
      compiled.resultSchema,
      tx,
    );
    rt2.run(tx, compiled, { target: top }, recorder);
    expect((await tx.commit().settled).error).toBeUndefined();
    const { promise: handled, resolve: handle } = Promise.withResolvers<
      void
    >();
    rt2.scheduler.queueEvent(
      recorder.key("record").resolveAsCell().getAsNormalizedFullLink(),
      { tag: "first" },
      true,
      () => handle(),
    );
    await parked;
    release();
    await handled;
    expect(await recorder.key("log").pull()).toEqual(["first:Ada"]);
  });

  it("reports no load recovery for a document whose only load, its crossing load, failed", async () => {
    const { leaf, top } = await writeCrossing("failed crossing recovery");
    const leafLink = leaf.getAsNormalizedFullLink();
    const leafKey = entityKey(leafLink, managerB.scopeKeyIdentity());
    const provider = managerB.open(farSpace);
    const realSync = provider.sync.bind(provider);
    provider.sync =
      (async (...args: Parameters<IStorageProvider["sync"]>) =>
        args[0] === leafLink.id
          ? { error: new Error("crossing load refused") }
          : await realSync(...args)) as IStorageProvider["sync"];
    const recovered: string[] = [];
    managerB.loadRecoveryObserver = ({ failedEpoch }) => {
      recovered.push(failedEpoch);
    };

    const top2 = rt2.getCellFromLink<{ next?: { name?: string } }>({
      ...top.getAsNormalizedFullLink(),
      schema: topSchema,
    });
    await top2.sync();
    await managerB.loadsSettled([leafKey]);
    // The top document's own load reports its recovery, so the observer is
    // live; the far document's failed crossing load reports none.
    expect(recovered).toContain(
      `load-key:${
        entityKey(top.getAsNormalizedFullLink(), managerB.scopeKeyIdentity())
      }`,
    );
    expect(recovered).not.toContain(`load-key:${leafKey}`);
    expect(localOnB(leaf, farSpace)).toBe(false);
  });

  it("leaves a link the schema does not follow unloaded", async () => {
    const { leaf, top } = await writeCrossing("unfollowed link");
    const top2 = rt2.getCellFromLink<{ next?: unknown }>({
      ...top.getAsNormalizedFullLink(),
      schema: { type: "object", properties: {} },
    });
    await top2.sync();
    expect(localOnB(top, space)).toBe(true);
    expect(localOnB(leaf, farSpace)).toBe(false);
  });
});
