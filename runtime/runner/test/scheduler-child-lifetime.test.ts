import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { NodeRegistry } from "../src/scheduler/node-record.ts";
import type { Action } from "../src/scheduler/types.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

// A parent action keeps an index of the children that subscribed while it ran.
// The index holds action closures strongly, and an action holds the frame of
// its last run, which holds that run's storage transaction and the values the
// transaction read. A child that stays in the index after it is unsubscribed
// therefore keeps a transaction alive for as long as the parent lives. A list
// projecting a window that slides starts and stops a child run per element on
// every move, so it accumulates one such transaction per element per move.

const signer = await Identity.fromPassphrase("scheduler child lifetime");
const space = signer.did();

function retainedChildCount(registry: NodeRegistry): number {
  let total = 0;
  for (const action of [...registry.effects, ...registry.computations]) {
    total += registry.childrenOf(action)?.size ?? 0;
  }
  return total;
}

function registryOf(runtime: Runtime): NodeRegistry {
  return runtime.scheduler.accessForTestingOnly.nodes;
}

const WINDOW_SIZE = 5;

// Each element of the projected window runs a child pattern, so moving the
// window starts and stops a child run per element, exactly as the session
// table's row projection does.
const SLIDING_WINDOW_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern } from 'commonfabric';",
      "",
      "const Detail = pattern<{ label: string }, { text: string }>(",
      "  ({ label }) => ({ text: computed(() => `detail for ${label}`) }),",
      ");",
      "",
      "const Row = pattern<",
      "  { label: string },",
      "  { label: string; shout: string; detail: { text: string } }",
      ">(({ label }) => {",
      "  const detail = Detail({ label });",
      "  return { label, shout: computed(() => `${label}!`), detail };",
      "});",
      "",
      "export default pattern<",
      "  { items: { label: string }[]; start: number; size: number }",
      ">(({ items, start, size }) => {",
      "  const shown = computed(() => items.slice(start, start + size));",
      "  return { rows: shown.map((item) => Row({ label: item.label })) };",
      "});",
    ].join("\n"),
  }],
};

describe("scheduler child action lifetime", () => {
  it("drops an unsubscribed child from its parent's child index", () => {
    const registry = new NodeRegistry();
    const parent: Action = () => {};
    const child: Action = () => {};
    registry.register(parent, "effect");
    registry.register(child, "computation");
    registry.linkParent(child, parent);
    expect(registry.childrenOf(parent)?.size).toBe(1);

    registry.remove(child);

    expect(registry.childrenOf(parent)?.size ?? 0).toBe(0);
  });

  it("drops a child subscribed during a parent's run when it unsubscribes", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const child: Action = () => {};
      let subscribedChild = false;
      const parent: Action = () => {
        if (subscribedChild) return;
        subscribedChild = true;
        runtime.scheduler.subscribe(
          child,
          { reads: [], shallowReads: [], writes: [] },
          { isEffect: true },
        );
      };
      runtime.scheduler.subscribe(
        parent,
        { reads: [], shallowReads: [], writes: [] },
        { isEffect: true },
      );
      await runtime.idle();

      const registry = registryOf(runtime);
      expect(registry.childrenOf(parent)?.size).toBe(1);

      runtime.scheduler.unsubscribe(child);

      expect(registry.childrenOf(parent)?.size ?? 0).toBe(0);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps retained children bounded while a projection window slides", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const compiled = await runtime.patternManager.compilePattern(
        SLIDING_WINDOW_PROGRAM,
        { space },
      );
      const items = Array.from(
        { length: WINDOW_SIZE * 4 },
        (_, index) => ({ label: `row-${index}` }),
      );

      const tx = runtime.edit();
      const result = runtime.getCell<{ rows: unknown[] }>(
        space,
        "sliding-window-result",
        compiled.resultSchema,
        tx,
      );
      const argument = runtime.getCell<
        { items: typeof items; start: number; size: number }
      >(space, "sliding-window-argument", undefined, tx);
      argument.set({ items, start: 0, size: WINDOW_SIZE });
      runtime.run(tx, compiled, argument, result);
      await tx.commit().settled;
      // The list projects on demand, so hold a reader open for the whole run.
      const stopReading = result.key("rows").sink(() => {});
      await runtime.idle();

      const registry = registryOf(runtime);
      const moveWindow = async (start: number) => {
        const moveTx = runtime.edit();
        argument.withTx(moveTx).key("start").set(start);
        await moveTx.commit().settled;
        await runtime.idle();
      };

      // The window alternates between two positions, so the same two sets of
      // element runs recur. Whatever the scheduler retains after the window
      // has been in both positions is all it ever needs to retain.
      await moveWindow(WINDOW_SIZE);
      await moveWindow(0);
      const settled = retainedChildCount(registry);

      for (let move = 0; move < 8; move++) {
        await moveWindow(move % 2 === 0 ? WINDOW_SIZE : 0);
      }

      expect(retainedChildCount(registry)).toBe(settled);
      stopReading();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
