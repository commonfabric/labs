/**
 * Worker-reconciler mount/remount benchmarks.
 *
 * CPU profiles of the default-app shell integration test
 * (docs/history/development/performance/default-app-note-create.md) show that the
 * single largest runtime-worker phase in a steady-state note-create cycle is
 * `handleVDomMount` → `WorkerReconciler.mount` → per-child cell subscription
 * and render: ~37% of busy worker CPU. Navigating back to the home view
 * re-MOUNTS the whole list, so each child cell is re-read (link resolution,
 * schema traversal, hashing, freeze checks) even though nothing changed.
 *
 * These benches reproduce that shape headlessly: a list vdom whose children
 * live in real runtime cells (like piece [UI] links), mounted through
 * `rendererVDOMSchema` with the ops sink discarded.
 *
 * Run with:
 *   deno bench --allow-read --allow-write --allow-net --allow-ffi \
 *     --allow-env --no-check bench/worker-reconciler-mount.bench.ts
 */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime, runtimePresets } from "@commonfabric/runner";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import type { Cell } from "@commonfabric/runner";
import { WorkerReconciler } from "../src/worker/reconciler.ts";

const signer = await Identity.fromPassphrase("bench worker reconciler");
const space = signer.did();

type BenchEnv = {
  runtime: Runtime;
  storageManager: ReturnType<typeof StorageManager.emulate>;
};

function createEnv(): BenchEnv {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime(runtimePresets.unitTest({
    apiUrl: new URL(import.meta.url),
    storageManager,
  }));
  return { runtime, storageManager };
}

/** A "note chip" vnode subtree, ~the size of a list row in the home view. */
function noteChipVNode(i: number): unknown {
  return {
    type: "vnode",
    name: "cf-chip",
    props: {
      label: `📝 New Note #${i.toString(36)}`,
      title: `note ${i}`,
      variant: i % 2 === 0 ? "default" : "accent",
    },
    children: [
      {
        type: "vnode",
        name: "span",
        props: { class: "subtitle" },
        children: [`updated ${i} minutes ago`],
      },
    ],
  };
}

type ListEnv = {
  env: BenchEnv;
  rootCell: Cell<unknown>;
  childCells: Cell<unknown>[];
};

/**
 * Build a home-like list: a root vnode whose children are LINKS to per-note
 * cells, each holding its own chip subtree (like per-piece [UI] cells).
 */
async function setupList(prefix: string, size: number): Promise<ListEnv> {
  const env = createEnv();
  const { runtime } = env;
  const tx = runtime.edit();

  const childCells: Cell<unknown>[] = [];
  for (let i = 0; i < size; i++) {
    const child = runtime.getCell<unknown>(
      space,
      `${prefix}:chip:${i}`,
      undefined,
      tx,
    );
    child.set(noteChipVNode(i));
    childCells.push(child);
  }

  const rootCell = runtime.getCell<unknown>(
    space,
    `${prefix}:root`,
    undefined,
    tx,
  );
  rootCell.set({
    type: "vnode",
    name: "div",
    props: { class: "note-list" },
    children: childCells,
  });

  await tx.commit().settled;
  await runtime.idle();
  return { env, rootCell, childCells };
}

function mountOnce(listEnv: ListEnv): Promise<void> {
  const reconciler = new WorkerReconciler({
    onOps: () => {},
    onError: (error) => {
      throw error;
    },
  });
  const cell = listEnv.rootCell.asSchema(rendererVDOMSchema);
  const cancel = reconciler.mount(cell as Cell<never>);
  return listEnv.env.runtime.idle().then(() => {
    cancel();
    return listEnv.env.runtime.idle();
  });
}

for (const size of [8, 32, 128]) {
  const listEnvPromise = setupList(`mount:${size}`, size);
  Deno.bench({
    name: `reconciler mount+unmount @${size} cell children`,
    group: "reconciler mount",
    baseline: size === 8,
  }, async () => {
    const listEnv = await listEnvPromise;
    await mountOnce(listEnv);
  });
}

// Re-mount of an already-mounted tree (the "navigate back to home" shape):
// the second mount pays the full per-child resubscribe + re-render cost even
// though no cell changed.
{
  const listEnvPromise = setupList("remount:32", 32);
  Deno.bench({
    name: "reconciler re-mount unchanged tree @32 cell children",
    group: "reconciler remount",
  }, async () => {
    const listEnv = await listEnvPromise;
    await mountOnce(listEnv);
    await mountOnce(listEnv);
  });
}

// Single-child update under a live mount (the "title edited" shape) — should
// be O(1), not O(list).
{
  const listEnvPromise = (async () => {
    const listEnv = await setupList("update:32", 32);
    const reconciler = new WorkerReconciler({
      onOps: () => {},
      onError: (error) => {
        throw error;
      },
    });
    reconciler.mount(
      listEnv.rootCell.asSchema(rendererVDOMSchema) as Cell<never>,
    );
    await listEnv.env.runtime.idle();
    return listEnv;
  })();
  let revision = 0;
  Deno.bench({
    name: "reconciler single-child update under live mount @32 children",
    group: "reconciler update",
  }, async () => {
    const listEnv = await listEnvPromise;
    const tx = listEnv.env.runtime.edit();
    const target = listEnv.childCells[revision++ % listEnv.childCells.length];
    target.withTx(tx).set(noteChipVNode(1000 + revision));
    await tx.commit().settled;
    await listEnv.env.runtime.idle();
  });
}
