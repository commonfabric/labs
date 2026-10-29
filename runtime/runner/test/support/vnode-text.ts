/**
 * Reads a rendered VNode tree the way a test asserts on it: the text it
 * shows, and the element that shows a given label, and clicks such an
 * element. Only `children` are walked, so text a prop holds is not read.
 */

import {
  isObjectNotArray,
  type ReadonlyRecord,
} from "@commonfabric/js-values/types";
import { isCell } from "../../src/cell.ts";
import type { Runtime } from "../../src/runtime.ts";

/**
 * A VNode as a test reads it: its `props`, a handler under `onClick` among
 * them, and its `children`.
 */
export type VNodeLike = ReadonlyRecord;

/** The string leaves of the rendered VNode tree `node`, in document order. */
export function textLeaves(
  node: unknown,
  out: string[] = [],
  depth = 0,
): string[] {
  if (depth > 40 || node === null || node === undefined) return out;
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) textLeaves(child, out, depth + 1);
    return out;
  }
  if (isObjectNotArray(node)) textLeaves(node.children, out, depth + 1);
  return out;
}

/**
 * The elements of the tree `node` that hold `label`, trimmed, as a child of
 * their own, in document order.
 */
export function elementsLabeled(
  node: unknown,
  label: string,
  out: VNodeLike[] = [],
  depth = 0,
): VNodeLike[] {
  if (depth > 40) return out;
  if (Array.isArray(node)) {
    for (const child of node) elementsLabeled(child, label, out, depth + 1);
    return out;
  }
  if (!isObjectNotArray(node)) return out;
  const children = node.children;
  const own = Array.isArray(children) ? children : [children];
  if (
    own.some((child) => typeof child === "string" && child.trim() === label)
  ) {
    out.push(node);
  }
  elementsLabeled(children, label, out, depth + 1);
  return out;
}

/**
 * Sends `event`, a plain click unless given, to the handler `element` binds
 * as `onClick`, commits it, and waits for `runtime` to be idle.
 *
 * @throws Error when `element` binds no handler.
 */
export async function click(
  runtime: Runtime,
  element: VNodeLike | undefined,
  event: unknown = { type: "click" },
): Promise<void> {
  const props = element?.props;
  const onClick = isObjectNotArray(props) ? props.onClick : undefined;
  if (!isCell(onClick)) throw new Error("The element binds no click handler.");
  const tx = runtime.edit();
  onClick.withTx(tx).send(event);
  await tx.commit().settled;
  await runtime.idle();
}
