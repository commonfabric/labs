/** Validates session-owned view interests at the Memory protocol boundary. */

import { cloneIfNecessary } from "@commonfabric/data-model";
import { isPlainObject } from "@commonfabric/utils/types";

import {
  DEFAULT_BRANCH,
  type ViewInterest,
  type ViewQuery,
  type WatchSpec,
} from "../v2.ts";

/** Parses a live query; explicit foreign instances and historical reads refuse. */
export function parseViewQuery(value: unknown): ViewQuery | null {
  if (
    !isPlainObject(value) || !Array.isArray(value.roots) ||
    value.atSeq !== undefined || value.excludeSent !== undefined ||
    (value.branch !== undefined && value.branch !== DEFAULT_BRANCH)
  ) return null;
  for (const root of value.roots) {
    if (
      !isPlainObject(root) || typeof root.id !== "string" ||
      root.id.length === 0 ||
      root.entityScopeKey !== undefined ||
      (root.scope !== undefined && root.scope !== "space" &&
        root.scope !== "user" && root.scope !== "session") ||
      !isPlainObject(root.selector) || !Array.isArray(root.selector.path) ||
      !root.selector.path.every((part) => typeof part === "string") ||
      !(root.selector.schema === undefined ||
        typeof root.selector.schema === "boolean" ||
        isPlainObject(root.selector.schema))
    ) return null;
  }
  return cloneIfNecessary(value as ViewQuery, { frozen: false });
}

/** Parses a replacement set, preserving omission as independent watch ownership. */
export function parseViewInterests(
  value: unknown,
): ViewInterest[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  const result: ViewInterest[] = [];
  for (const view of value) {
    if (
      !isPlainObject(view) || typeof view.id !== "string" ||
      view.id.length === 0 ||
      ids.has(view.id) || !Number.isSafeInteger(view.revision) ||
      (view.revision as number) < 0 ||
      (view.mode !== "render" && view.mode !== "speculate") ||
      typeof view.componentContractVersion !== "string"
    ) return null;
    const query = parseViewQuery(view.query);
    if (query === null) return null;
    ids.add(view.id);
    result.push({
      id: view.id,
      revision: view.revision as number,
      mode: view.mode,
      componentContractVersion: view.componentContractVersion,
      query,
    });
  }
  return result;
}

/** Represents render roots as ordinary identity-scoped graph evaluations. */
export function viewWatches(views: readonly ViewInterest[]): WatchSpec[] {
  return views.map((view) => ({
    id: `view:${view.id}`,
    kind: "graph",
    query: view.query,
  }));
}
