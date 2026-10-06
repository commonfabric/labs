import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("resume list children x-space");
const space = signer.did();

// A host whose list holds cross-space `inSpace` children and whose rows map
// over them reading a child field — the profile picker's shape: `profiles`
// holds `ProfileHome.inSpace()` pieces, the rows render each profile, and a
// handler pushes a new one.
const CHILD_SRC = [
  "import { pattern, computed } from 'commonfabric';",
  "export default pattern<{ seed: string }, { label: unknown }>(({ seed }) => {",
  "  const label = computed(() => `child-${seed}`);",
  "  return { label };",
  "});",
].join("\n");

const HOST_SRC = [
  "import { pattern, handler, Writable } from 'commonfabric';",
  "import Child from './child.tsx';",
  "",
  "const addItem = handler<{ seed: string }, {",
  "  items: Writable<unknown[]>;",
  "}>((event, { items }) => {",
  "  items.push(Child.inSpace()({ seed: event.seed }));",
  "});",
  "",
  "export default pattern(() => {",
  "  const items = new Writable<{ label: string }[]>([]).for('items');",
  "  const rows = items.map((item) => ({ label: item.label }));",
  "  return { items, rows, addItem: addItem({ items }) };",
  "});",
].join("\n");

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    { name: "/main.tsx", contents: HOST_SRC },
    { name: "/child.tsx", contents: CHILD_SRC },
  ],
};

const RESULT_CAUSE = "resume list children x-space host";

type EventCommitMarker = {
  type: "scheduler.event.commit";
  error?: string;
};

function waitForEventCommit(runtime: Runtime): Promise<EventCommitMarker> {
  return new Promise((resolve) => {
    const listener = (event: Event) => {
      const marker = (event as CustomEvent<{ marker: EventCommitMarker }>)
        .detail.marker;
      if (marker.type !== "scheduler.event.commit" || marker.error) return;
      runtime.telemetry.removeEventListener("telemetry", listener);
      resolve(marker);
    };
    runtime.telemetry.addEventListener("telemetry", listener);
  });
}

const rowLabels = (
  handle: { key: (k: string) => { getAsQueryResult: () => unknown } },
): unknown[] => {
  const rows = handle.key("rows").getAsQueryResult();
  return Array.isArray(rows)
    ? rows.map((row) => (row as { label?: unknown } | undefined)?.label)
    : [];
};

describe("resume-list-children-cross-space-append", () => {
  let server: MemoryV2Server.Server;
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

  async function settle(
    runtime: Runtime,
    handle: { pull: () => Promise<unknown> },
  ) {
    for (let i = 0; i < 8; i++) {
      await handle.pull();
      await runtime.idle();
      await runtime.storageManager.synced();
    }
  }

  it("keeps a child appended right after a cold resume durable", async () => {
    // BUILD: one cross-space child, rows rendered.
    const a = replica();
    const txA = a.edit();
    const compiledA = await a.patternManager.compilePattern(PROGRAM, {
      space,
      tx: txA,
    });
    const rcA = a.getCell<Record<string, unknown>>(
      space,
      RESULT_CAUSE,
      undefined,
      txA,
    );
    // deno-lint-ignore no-explicit-any
    const handleA = a.run(txA, compiledA as any, {}, rcA);
    a.prepareTxForCommit(txA);
    expect((await txA.commit().settled).error).toBeUndefined();
    await handleA.pull();
    await a.idle();
    await a.storageManager.synced();
    const addA = a.edit();
    const committedA = waitForEventCommit(a);
    handleA.withTx(addA).key("addItem").send({ seed: "1" });
    await addA.commit().settled;
    await committedA;
    await settle(a, handleA);
    expect(rowLabels(handleA)).toEqual(["child-1"]);
    await a.patternManager.flushCompileCacheWrites();
    await a.storageManager.synced();
    await a.dispose({ closeStorage: false });
    runtimes.splice(runtimes.indexOf(a), 1);

    // RESUME + RACY ADD: a cold replica starts the host and appends a second
    // child immediately, settling only on idle — the post-reload window.
    const b = replica();
    await b.patternManager.compilePattern(PROGRAM, { space });
    const rcB = b.getCell<Record<string, unknown>>(
      space,
      RESULT_CAUSE,
      undefined,
    );
    expect(await b.start(rcB)).toBe(true);
    const addB = b.edit();
    const committedB = waitForEventCommit(b);
    rcB.withTx(addB).key("addItem").send({ seed: "2" });
    await addB.commit().settled;
    await committedB;
    // The cross-space child's own run and the row over it land through
    // pending/retry cycles; settle them as the build did before leaving.
    await settle(b, rcB);
    // The appended child renders on the page that appended it, without a
    // reload.
    expect(rowLabels(rcB)).toEqual(["child-1", "child-2"]);
    await b.dispose({ closeStorage: false });
    runtimes.splice(runtimes.indexOf(b), 1);

    // RELOAD: a third cold replica must see both children, durably, and both
    // rows rendered.
    const c = replica();
    await c.patternManager.compilePattern(PROGRAM, { space });
    const rcC = c.getCell<Record<string, unknown>>(
      space,
      RESULT_CAUSE,
      undefined,
    );
    expect(await c.start(rcC)).toBe(true);
    await settle(c, rcC);
    const items = rcC.key("items").getAsQueryResult();
    expect(Array.isArray(items) ? items.length : 0).toBe(2);
    expect(rowLabels(rcC)).toEqual(["child-1", "child-2"]);
  });
});
