import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { type Cell, hasInlineCellScheme, Runtime } from "@commonfabric/runner";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../runner/test/cfc-seed-envelope.ts";
import { patchableCell } from "../../runner/test/support/patchable-cell.ts";
import type { VDomOp } from "../src/vdom-ops.ts";
import { cellLabelSources } from "../src/worker/display-fit.ts";
import type { WorkerVNode } from "../src/worker/types.ts";
import { WorkerReconciler } from "../src/worker/reconciler.ts";

/** The texts `ops` create, in the order they are created. */
function createdTexts(ops: readonly VDomOp[]): string[] {
  return ops.flatMap((op) => op.op === "create-text" ? [op.text] : []);
}

/**
 * A copy of `cell` that counts how many of its `resolveAsCell()` calls
 * returned a handle to an inline snapshot rather than to a stored position.
 */
function countingSnapshotHandles<T>(
  cell: Cell<T>,
): { cell: Cell<T>; snapshotHandles: () => number } {
  const counting = patchableCell(cell);
  const resolve = counting.resolveAsCell.bind(counting);
  let count = 0;
  counting.resolveAsCell = (...args: Parameters<typeof resolve>) => {
    const resolved = resolve(...args);
    if (hasInlineCellScheme(resolved.getAsNormalizedFullLink().id)) count += 1;
    return resolved;
  };
  return { cell: counting, snapshotHandles: () => count };
}

/** A stored view node showing `text`, as a plain value a raw write takes. */
const vnode = (
  text: string,
): {
  type: "vnode";
  name: string;
  props: Record<string, never>;
  children: string[];
} => ({
  type: "vnode",
  name: "span",
  props: {},
  children: [text],
});

describe("worker reconciler link resolution", () => {
  // The cells rendered here link into an inline array element, the shape
  // every position of a stored view tree has. `resolveAsCell()` names such
  // an element by a snapshot of its content, minted per call from a hash of
  // the element, which a read that only looks the target up does not need.

  it("renders a cell child linking into another space's inline array element, hidden while that space is refused, without resolving a snapshot handle per read", async () => {
    const owner = await Identity.fromPassphrase("link resolution owner");
    const foreign = await Identity.fromPassphrase("link resolution foreign");
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({ as: owner }),
    });
    let denied = false;
    const listeners = new Map<string, Set<() => void>>();
    const ops: VDomOp[] = [];
    const reconciler = new WorkerReconciler({
      onOps: (batch) => {
        for (const op of batch) ops.push(op);
      },
      spaceAccess: {
        error: (space) =>
          space === foreign.did() && denied
            ? new Error("Access revoked")
            : undefined,
        subscribe: (space, onChange) => {
          const forSpace = listeners.get(space) ?? new Set();
          listeners.set(space, forSpace);
          forSpace.add(onChange);
          return () => forSpace.delete(onChange);
        },
      },
    });
    const notify = (space: string) => {
      for (const onChange of listeners.get(space) ?? []) onChange();
    };
    const holder = runtime.getCell<{ items: unknown[] }>(
      foreign.did(),
      "link resolution holder",
    );
    const pointer = countingSnapshotHandles(
      runtime.getCell<unknown>(owner.did(), "link resolution pointer"),
    );
    const handlesPerPhase: Record<string, number> = {};
    let seen = 0;
    const settle = async (phase: string) => {
      await runtime.idle();
      await runtime.storageManager.synced();
      await runtime.idle();
      reconciler.flush();
      handlesPerPhase[phase] = pointer.snapshotHandles() - seen;
      seen = pointer.snapshotHandles();
    };
    try {
      const seededHolder = await runtime.editWithRetry((tx) => {
        holder.withTx(tx).set({ items: [vnode("Foreign text")] });
      });
      expect(seededHolder.error).toBeUndefined();
      const seededPointer = await runtime.editWithRetry((tx) => {
        pointer.cell.withTx(tx).set(holder.key("items").key(0));
      });
      expect(seededPointer.error).toBeUndefined();

      reconciler.mount({
        type: "vnode",
        name: "div",
        props: {},
        children: [pointer.cell as Cell<WorkerVNode>],
      });
      await settle("mount");
      expect(createdTexts(ops)).toEqual(["Foreign text"]);

      const updated = await runtime.editWithRetry((tx) => {
        holder.withTx(tx).key("items").key(0).set(vnode("Updated text"));
      });
      expect(updated.error).toBeUndefined();
      await settle("update");
      expect(createdTexts(ops)).toEqual(["Foreign text", "Updated text"]);

      denied = true;
      notify(foreign.did());
      await settle("access lost");
      expect(createdTexts(ops)).toEqual([
        "Foreign text",
        "Updated text",
        "Access unavailable",
      ]);

      denied = false;
      notify(foreign.did());
      await settle("access regained");
      expect(createdTexts(ops)).toEqual([
        "Foreign text",
        "Updated text",
        "Access unavailable",
        "Updated text",
      ]);

      expect(handlesPerPhase).toEqual({
        mount: 0,
        update: 0,
        "access lost": 0,
        "access regained": 0,
      });
    } finally {
      reconciler.unmount();
      await runtime.dispose();
    }
  });

  it("renders a root cell naming an inline array element without resolving a snapshot handle per read", async () => {
    const owner = await Identity.fromPassphrase("link resolution root owner");
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({ as: owner }),
    });
    const ops: VDomOp[] = [];
    const reconciler = new WorkerReconciler({
      onOps: (batch) => {
        for (const op of batch) ops.push(op);
      },
      spaceAccess: {
        error: () => undefined,
        subscribe: () => () => {},
      },
    });
    const holder = runtime.getCell<{ items: unknown[] }>(
      owner.did(),
      "link resolution root holder",
    );
    const root = countingSnapshotHandles(
      holder.key("items").key(0).asSchema(rendererVDOMSchema),
    );
    try {
      const seeded = await runtime.editWithRetry((tx) => {
        holder.withTx(tx).set({ items: [vnode("Root text")] });
      });
      expect(seeded.error).toBeUndefined();

      reconciler.mount(root.cell);
      await runtime.idle();
      reconciler.flush();
      expect(createdTexts(ops)).toEqual(["Root text"]);
      const atMount = root.snapshotHandles();

      const updated = await runtime.editWithRetry((tx) => {
        holder.withTx(tx).key("items").key(0).set(vnode("Updated root"));
      });
      expect(updated.error).toBeUndefined();
      await runtime.idle();
      await runtime.storageManager.synced();
      await runtime.idle();
      reconciler.flush();
      expect(createdTexts(ops)).toEqual(["Root text", "Updated root"]);

      expect({ mount: atMount, update: root.snapshotHandles() - atMount })
        .toEqual({ mount: 0, update: 0 });
    } finally {
      reconciler.unmount();
      await runtime.dispose();
    }
  });

  it("marks a piece boundary on a child resolving to a pattern result's root, and none on a field inside the result that carries its own `$UI`", async () => {
    const owner = await Identity.fromPassphrase("link resolution piece owner");
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({ as: owner }),
    });
    const ops: VDomOp[] = [];
    const reconciler = new WorkerReconciler({
      onOps: (batch) => {
        for (const op of batch) ops.push(op);
      },
    });
    const result = runtime.getCell<unknown>(
      owner.did(),
      "link resolution piece result",
    );
    try {
      const seeded = await runtime.editWithRetry((tx) => {
        const writable = result.withTx(tx);
        writable.setMetaRaw("patternIdentity", {
          identity: "link-resolution-piece",
          symbol: "default",
        }, rawMetaWriteAuthorization);
        // A raw write stores the row inline in the result document, where a
        // value write would store it as a document of its own.
        writable.setRaw({
          $UI: vnode("Piece"),
          rows: [{ $UI: vnode("Field") }],
        });
      });
      expect(seeded.error).toBeUndefined();

      reconciler.mount({
        type: "vnode",
        name: "div",
        props: {},
        children: [
          result as Cell<WorkerVNode>,
          result.key("rows").key(0) as Cell<WorkerVNode>,
        ],
      });
      await runtime.idle();
      reconciler.flush();
      expect(createdTexts(ops)).toEqual(["Piece", "Field"]);
      const boundaries = ops.flatMap((op) =>
        op.op === "set-piece-boundary" ? [op.cellRef.path] : []
      );
      expect(boundaries).toEqual([[]]);
    } finally {
      reconciler.unmount();
      await runtime.dispose();
    }
  });

  it("reads the target's stored labels into the resolved label source for a link into an inline array element, as for a link to a document's root, without resolving a snapshot handle", async () => {
    // A dereference consumes the current labels of its target (CFC §8.2.4),
    // read where the value is stored. The holder's element and the holder's
    // root each carry a label the pointer's own document does not, so the
    // resolved source shows whether the target's labels were read.

    const owner = await Identity.fromPassphrase("link resolution label owner");
    const foreign = await Identity.fromPassphrase(
      "link resolution label holder",
    );
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({ as: owner }),
    });
    const target = cfcAtom.space(foreign.did());
    try {
      const inlineHolder = runtime.getCell<unknown>(
        foreign.did(),
        "link resolution labeled inline holder",
      );
      const rootHolder = runtime.getCell<unknown>(
        foreign.did(),
        "link resolution labeled root holder",
      );
      const seedTx = runtime.edit();
      writeSeedEnvelopeDoc(seedTx, foreign.did());
      const envelope = (path: string[]) => ({
        version: 1 as const,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1 as const,
          entries: [{
            path,
            origin: "derived" as const,
            observes: "value" as const,
            label: { confidentiality: [target], integrity: [] },
          }],
        },
      });
      seedStoredEnvelope(seedTx, {
        ...inlineHolder.getAsNormalizedFullLink(),
        path: [],
      }, {
        value: { items: [vnode("Inline")] },
        cfc: envelope(["items", "0"]),
      });
      seedStoredEnvelope(seedTx, {
        ...rootHolder.getAsNormalizedFullLink(),
        path: [],
      }, { value: vnode("Root"), cfc: envelope([]) });
      expect((await seedTx.commit().settled).error).toBeUndefined();

      const inlinePointer = countingSnapshotHandles(
        runtime.getCell<unknown>(owner.did(), "link resolution inline pointer"),
      );
      const rootPointer = countingSnapshotHandles(
        runtime.getCell<unknown>(owner.did(), "link resolution root pointer"),
      );
      const seeded = await runtime.editWithRetry((tx) => {
        inlinePointer.cell.withTx(tx).set(inlineHolder.key("items").key(0));
        rootPointer.cell.withTx(tx).set(rootHolder);
      });
      expect(seeded.error).toBeUndefined();

      const resolvedSourceLabels = (cell: Cell<unknown>) => {
        const sources = cellLabelSources(cell);
        expect(sources).toHaveLength(2);
        return sources![1].view?.entries.flatMap((entry) =>
          entry.label.confidentiality ?? []
        );
      };
      expect({
        inline: resolvedSourceLabels(inlinePointer.cell),
        root: resolvedSourceLabels(rootPointer.cell),
        snapshotHandles: inlinePointer.snapshotHandles() +
          rootPointer.snapshotHandles(),
      }).toEqual({ inline: [target], root: [target], snapshotHandles: 0 });
    } finally {
      await runtime.dispose();
    }
  });
});
