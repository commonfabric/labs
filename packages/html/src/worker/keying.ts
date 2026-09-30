/**
 * Key generation utilities for worker VDOM reconciliation.
 *
 * Keys are used to stably identify children across renders,
 * enabling efficient diffing and reuse of DOM nodes.
 */

import { type FabricValue, hashStringOf } from "@commonfabric/data-model";
import { isCell } from "@commonfabric/runner";
import { isObjectOrArray } from "@commonfabric/utils/types";

/**
 * Stands in for a value with no identity of its own to key by. A record cannot
 * collide with the strings, numbers, and booleans a render node otherwise
 * holds.
 */
const OPAQUE: FabricValue = { "@@vdom-key": "opaque" };

/**
 * Replaces, in a render node, the two things it can hold that are not
 * `FabricValue`s: a `Cell`, by the link it names, and a function, by a
 * stand-in.
 *
 * Everything else a render node may carry is a `JSONValue` (see `WorkerProps`),
 * and every one of those is a `FabricValue` already, so it is returned by
 * identity -- which also leaves a subtree carrying neither of the two shared
 * rather than rebuilt.
 *
 * A function is an event handler, and one render's is not the next render's
 * though they mean the same thing, so all of them stand alike. A cell is
 * replaced by its link, which is what stays put while the payload behind it
 * moves.
 *
 * @param node The render node to project.
 * @param seen Ancestors of `node`, so a cycle ends the walk rather than
 *   running it forever.
 */
function keyProjection(node: unknown, seen: Set<object>): unknown {
  if (typeof node === "function") return OPAQUE;
  if (!isObjectOrArray(node)) return node;
  if (isCell(node)) return node.toSigilLinkOrNull() ?? OPAQUE;

  if (seen.has(node)) return OPAQUE;
  seen.add(node);
  try {
    if (Array.isArray(node)) {
      // `map()` skips a hole and leaves one in its place, which is what the
      // hash wants: a hole is not the `undefined` that reading one reports.
      let changed = false;
      const projected = node.map((element) => {
        const value = keyProjection(element, seen);
        if (value !== element) changed = true;
        return value;
      });
      return changed ? projected : node;
    }

    const entries = Object.entries(node);
    let changed = false;
    for (const entry of entries) {
      const value = keyProjection(entry[1], seen);
      if (value === entry[1]) continue;
      entry[1] = value;
      changed = true;
    }
    return changed ? Object.fromEntries(entries) : node;
  } finally {
    seen.delete(node);
  }
}

/**
 * Generate a stable key for a render node.
 *
 * Two nodes key alike exactly when they carry the same content, so a member the
 * hash tells apart -- a present `undefined` from an absent one, a hole from an
 * `undefined` element, `NaN` from `null`, `-0` from `0` -- keys them apart too.
 *
 * A node holding something no render node may hold can have no such key, and
 * returns a coarse one instead. Keying is on the render path, where a key is
 * needed more than a precise one is.
 *
 * @param node - The render node to generate a key for
 * @returns A stable string key
 */
export function generateKey(node: unknown): string {
  try {
    return hashStringOf(keyProjection(node, new Set()) as FabricValue);
  } catch {
    return generateFallbackKey(node);
  }
}

/**
 * Helper for `generateKey()`, which keys a node the hash refuses.
 * Nodes sharing a fallback key are told apart only by their position among
 * their siblings, so what it costs is the reuse of a DOM node that moved.
 */
function generateFallbackKey(node: unknown): string {
  if (node === null || node === undefined) return "@@null";
  if (typeof node !== "object") return `@@${typeof node}:${String(node)}`;
  if (Array.isArray(node)) return `@@array:${node.length}`;
  if (isCell(node)) return "@@cell";
  const name = (node as { name?: unknown }).name;
  return typeof name === "string" ? `@@vnode:${name}` : "@@object";
}

/**
 * Generate unique keys for a list of children.
 *
 * Handles duplicate keys by appending an occurrence count,
 * ensuring each child has a unique key while maintaining stability
 * for identical structures.
 *
 * @param children - Array of child nodes
 * @returns Array of unique keys in the same order as children
 */
export function generateChildKeys(children: readonly unknown[]): string[] {
  const keys: string[] = [];
  const occurrence = new Map<string, number>();

  for (const child of children) {
    const rawKey = generateKey(child);
    const count = occurrence.get(rawKey) ?? 0;
    occurrence.set(rawKey, count + 1);

    // Composite key ensures uniqueness for structurally identical children
    keys.push(`${rawKey}-${count}`);
  }

  return keys;
}
