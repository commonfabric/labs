/**
 * VDOM debug helpers for browser console inspection.
 *
 * Usage: commonfabric.vdom.dump()   — pretty-print the VDOM tree
 *        commonfabric.vdom.renders() — list all active renderings
 *        commonfabric.vdom.stats()   — node/listener counts
 */

import {
  type CellHandle,
  CellReadRefusedError,
  isCellHandle,
} from "@commonfabric/runtime-client";
import {
  isFabricSpecialObject,
  toCompactDebugString,
} from "@commonfabric/data-model";
import { debugVDOMSchema } from "@commonfabric/runner/schemas";
import { type ActiveRender, getActiveRenders } from "./render.ts";

/**
 * Resolve an optional element-or-index argument to an ActiveRender entry.
 * - undefined → first (or only) entry
 * - number   → entry at that index
 * - element  → entry keyed by that element
 */
function resolveTarget(
  elementOrIndex?: HTMLElement | number,
): ActiveRender | undefined {
  const renders = getActiveRenders();
  if (renders.size === 0) return undefined;

  if (elementOrIndex === undefined) {
    return renders.values().next().value;
  }

  if (typeof elementOrIndex === "number") {
    let i = 0;
    for (const entry of renders.values()) {
      if (i === elementOrIndex) return entry;
      i++;
    }
    return undefined;
  }

  return renders.get(elementOrIndex);
}

/**
 * Subscribe to a cell and resolve with the first defined value, or reject
 * with the refusal when the worker refuses the read, so that a refused tree
 * never reads as an empty one.
 * CellHandle.get() only returns cached values; asSchema() creates a new handle
 * with no cache, so we subscribe and wait for the runtime to deliver the value.
 */
function readCellAsync<T>(cell: CellHandle<T>): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cancel = cell.subscribe((v) => {
      if (v !== undefined && !settled) {
        settled = true;
        // Defer cancel to avoid unsubscribe during callback
        queueMicrotask(() => cancel());
        resolve(v);
      }
    }, {
      onRefused: (refusal) => {
        if (settled) return;
        settled = true;
        queueMicrotask(() => cancel());
        reject(new CellReadRefusedError(refusal));
      },
    });
    // If the callback fired synchronously with a defined value, we're done.
    // Otherwise set a timeout so we don't hang forever.
    if (!settled) {
      setTimeout(() => {
        if (!settled) {
          settled = true;
          cancel();
          resolve(undefined);
        }
      }, 30000);
    }
  });
}

/**
 * Recursively format a VDOM tree node into a readable string.
 * CellHandle props are shown as `<cell>`.
 */
export function formatTree(node: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);

  if (node == null) return `${pad}(null)`;
  if (typeof node === "string") return `${pad}"${node}"`;
  if (typeof node === "number" || typeof node === "boolean") {
    return `${pad}${String(node)}`;
  }
  if (Array.isArray(node)) {
    return node.map((child) => formatTree(child, indent)).join("\n");
  }
  if (typeof node !== "object") return `${pad}${String(node)}`;

  // A `FabricSpecialObject` is rendered before the vdom-node check below
  // reads it: one can carry a `name` of its own, as a `FabricError` does,
  // which would pass for a node's.
  if (isFabricSpecialObject(node)) {
    return `${pad}${toCompactDebugString(node)}`;
  }

  const obj = node as Record<string, unknown>;

  // Always follow $UI indirection, matching the render code's behavior
  // (render.ts follows the [UI] chain unconditionally before processing)
  if ("$UI" in obj && obj.$UI) {
    return formatTree(obj.$UI, indent);
  }

  const name = obj.name as string | undefined;
  if (!name) {
    // Not a vdom node.
    return `${pad}${toCompactDebugString(node)}`;
  }

  // Format props
  const props = obj.props as Record<string, unknown> | undefined;
  let propsStr = "";
  if (props && typeof props === "object") {
    const propParts: string[] = [];
    for (const [key, value] of Object.entries(props)) {
      if (isCellHandle(value)) {
        propParts.push(`${key}=<cell>`);
      } else {
        propParts.push(`${key}=${toCompactDebugString(value)}`);
      }
    }
    if (propParts.length > 0) {
      propsStr = " " + propParts.join(" ");
    }
  }

  // Format children
  const children = obj.children as unknown[] | undefined;
  if (!children || (Array.isArray(children) && children.length === 0)) {
    return `${pad}<${name}${propsStr} />`;
  }

  const childLines = Array.isArray(children)
    ? children.map((child) => formatTree(child, indent + 1)).join("\n")
    : formatTree(children, indent + 1);

  return `${pad}<${name}${propsStr}>\n${childLines}\n${pad}</${name}>`;
}

/**
 * Walk every active render's DOM subtree, descending through shadow roots, and
 * await `updateComplete` on each Lit element. Returns `churned` — true if any
 * element was mid-update (pending when scanned, or resolving its
 * `updateComplete` to a re-triggered or thrown update during the drain), which
 * signals the view was not yet settled and the caller should drain again — and
 * `errors`, the reasons of any updates that threw, so a give-up can name the
 * actual failure rather than blame re-rendering.
 *
 * This closes the gap between "the worker is reactively idle" and "the DOM is
 * interactive": custom elements such as cf-modal enable pointer events and bind
 * handlers in their Lit `updated()` callback, one update cycle after the
 * property that drives them is set.
 *
 * `roots` defaults to every active render's container; pass explicit roots to
 * scope the drain (used by tests).
 */
export async function drainViewUpdates(
  roots: Iterable<Element> = activeRenderRoots(),
): Promise<{ churned: boolean; errors: unknown[] }> {
  const pending: Promise<unknown>[] = [];
  let sawPending = false;

  const visit = (node: Element) => {
    const el = node as Element & {
      updateComplete?: Promise<unknown>;
      isUpdatePending?: boolean;
    };
    if (el.updateComplete && typeof el.updateComplete.then === "function") {
      if (el.isUpdatePending) sawPending = true;
      pending.push(el.updateComplete);
    }
    for (const child of node.children) visit(child);
    if (node.shadowRoot) {
      for (const child of node.shadowRoot.children) visit(child);
    }
  };

  for (const root of roots) {
    visit(root);
  }

  // updateComplete resolves true once the element settles, false when the
  // element re-triggered its own update during the cycle (a property set in
  // updated(), as cf-modal does when toggling open), and rejects when the
  // update threw. Treat false and rejected as still-churning so the loop drains
  // again instead of exiting a cycle early; allSettled keeps a thrown update
  // from aborting the check. Collect rejection reasons so a give-up after
  // maxPasses can name the throwing update instead of blaming re-rendering. An
  // element that never stops churning trips viewSettled's maxPasses warning
  // rather than spinning forever.
  const results = await Promise.allSettled(pending);
  const errors: unknown[] = [];
  let churned = sawPending;
  for (const r of results) {
    if (r.status === "rejected") {
      errors.push(r.reason);
      churned = true;
    } else if (r.value === false) {
      churned = true;
    }
  }
  return { churned, errors };
}

function activeRenderRoots(): Element[] {
  return Array.from(getActiveRenders().values(), ({ parent }) => parent);
}

/**
 * Resolve once the worker is reactively idle AND the rendered view has caught
 * up to that state: vdom batches applied to the DOM and Lit elements finished
 * updating, so event handlers are bound and modal/overlay interactivity is on.
 *
 * Each pass waits for worker idle, yields a macrotask so any in-flight
 * worker-to-main vdom batch messages are delivered and applied, then drains
 * pending Lit updates. When a full pass finds nothing pending the view is
 * settled. The loop converges because draining cannot, on a quiet runtime,
 * produce new work indefinitely.
 *
 * A view that re-renders on every cycle (an animation that requests Lit updates
 * on a timer) never reports settled. Rather than fail such a view, the loop
 * gives up after maxPasses and warns: by then the view is interactive even
 * though it is still updating. If the churn was a thrown update rather than
 * benign re-rendering, the warning names that error so a real failure is not
 * misread as animation.
 *
 * `roots` is forwarded to drainViewUpdates to scope the drain (used by tests);
 * it defaults to every active render's container.
 */
export async function viewSettled(
  idle: () => Promise<void>,
  options: { maxPasses?: number; roots?: Iterable<Element> } = {},
): Promise<void> {
  const maxPasses = options.maxPasses ?? 50;
  let lastErrors: unknown[] = [];
  for (let pass = 0; pass < maxPasses; pass++) {
    await idle();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const { churned, errors } = await drainViewUpdates(options.roots);
    lastErrors = errors;
    if (!churned) return;
  }
  if (lastErrors.length > 0) {
    console.warn(
      `viewSettled: gave up after ${maxPasses} passes; a view update threw ` +
        `during the final drain (folded into churn, not re-thrown). Last of ` +
        `${lastErrors.length} error(s):`,
      lastErrors[lastErrors.length - 1],
    );
  } else {
    console.warn(
      `viewSettled: view still reported pending updates after ${maxPasses} ` +
        `passes; proceeding. A perpetually re-rendering element can cause this.`,
    );
  }
}

/**
 * Create the debug helpers object to register on globalThis.commonfabric.vdom.
 */
export function createVDomDebugHelpers() {
  return {
    /**
     * List all active renderings in a console.table.
     */
    renders() {
      const renders = getActiveRenders();
      if (renders.size === 0) {
        console.log("No active renders.");
        return;
      }
      const rows: Record<string, unknown>[] = [];
      let i = 0;
      for (const [parent, entry] of renders) {
        rows.push({
          index: i++,
          container: parent,
          cellId: entry.cell.ref()?.id ?? "(none)",
        });
      }
      console.table(rows);
    },

    /**
     * Read the VDOM tree using the debug schema (children expanded inline).
     * Returns the raw tree object for inspection.
     */
    async tree(el?: HTMLElement | number) {
      const target = resolveTarget(el);
      if (!target) {
        console.warn("No active render found.");
        return undefined;
      }
      return await readCellAsync(target.cell.asSchema(debugVDOMSchema));
    },

    /**
     * Pretty-print the VDOM tree to the console.
     */
    async dump(el?: HTMLElement | number) {
      const target = resolveTarget(el);
      if (!target) {
        console.warn("No active render found.");
        return;
      }
      const tree = await readCellAsync(
        target.cell.asSchema(debugVDOMSchema),
      );
      if (!tree) {
        console.warn("Tree is empty.");
        return;
      }
      console.log(formatTree(tree));
    },

    /**
     * Show node/listener counts per active renderer.
     */
    stats() {
      const renders = getActiveRenders();
      if (renders.size === 0) {
        console.log("No active renders.");
        return;
      }
      const rows: Record<string, unknown>[] = [];
      let i = 0;
      for (const [parent, entry] of renders) {
        const info = entry.renderer.getApplicator().getDebugInfo();
        rows.push({
          index: i,
          container: parent,
          nodeCount: info.nodeCount,
          listenerCount: info.listenerCount,
          totalListeners: info.totalListeners,
          rootNodeId: info.rootNodeId,
        });
        i++;
      }
      console.table(rows);
    },

    /**
     * Look up a DOM node from an applicator node ID.
     */
    nodeForId(id: number, el?: HTMLElement | number): Node | undefined {
      const target = resolveTarget(el);
      if (!target) {
        console.warn("No active render found.");
        return undefined;
      }
      return target.renderer.getApplicator().getNode(id);
    },

    /**
     * Raw access to the active renders registry.
     */
    get registry() {
      return getActiveRenders();
    },
  };
}
