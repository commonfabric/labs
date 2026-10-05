/**
 * Reuses label-view slices within one schema traversal. The traversal owns
 * the entry and label arrays; shared atoms must be immutable to reuse a slice.
 */
import { isDeepFrozen } from "@commonfabric/data-model";

import { isOrClause } from "./clause.ts";
import {
  type CfcLabelView,
  cfcLabelViewOriginSpaces,
  cloneCfcLabel,
  cloneCfcLabelView,
  rebaseCfcLabelView,
  withCfcLabelViewOrigins,
} from "./label-view-core.ts";

/** Owns a base view and its canonical slices until the base is replaced. */
export class CfcLabelViewRebaser {
  #view: CfcLabelView | undefined;
  #cacheable = false;
  #slices = new Map<string, CfcLabelView | undefined>();

  /** Constructs an instance owning the base arrays and sharing its atoms. */
  constructor(view: CfcLabelView | undefined) {
    this.setView(view);
  }

  /** Replaces the base and discards every slice, including cached misses. */
  setView(view: CfcLabelView | undefined): void {
    this.#slices.clear();
    this.#view = cloneCfcLabelView(view);
    this.#cacheable =
      this.#view?.entries.every(({ label }) =>
        (label.confidentiality ?? []).every(isDeepFrozen) &&
        (label.integrity ?? []).every(isDeepFrozen)
      ) ?? false;
  }

  /** Returns a slice with independently owned entry, path, and label arrays. */
  rebase(path: readonly string[]): CfcLabelView | undefined {
    if (!this.#cacheable) return rebaseCfcLabelView(this.#view, path);
    // JSON arrays preserve segment boundaries, including slash-bearing names.
    const key = JSON.stringify(path);
    if (!this.#slices.has(key)) {
      this.#slices.set(key, rebaseCfcLabelView(this.#view, path));
    }
    const slice = this.#slices.get(key);
    if (slice === undefined) return undefined;
    return withCfcLabelViewOrigins({
      version: 1,
      entries: slice.entries.map((entry) => {
        const label = cloneCfcLabel(entry.label);
        if (label.confidentiality !== undefined) {
          // Normalization creates mutable OR wrappers. Each result owns those
          // arrays too; their already-canonical alternatives need no sorting.
          label.confidentiality = label.confidentiality.map((clause) =>
            isOrClause(clause) ? { anyOf: [...clause.anyOf] } : clause
          );
        }
        return {
          path: [...entry.path],
          label,
          ...(entry.observes !== undefined ? { observes: entry.observes } : {}),
        };
      }),
    }, cfcLabelViewOriginSpaces(slice));
  }
}
