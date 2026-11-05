import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";

import {
  sameAddresses,
  sortAndCompactPaths,
} from "../reactive-dependencies.ts";
import { SchedulerTriggerIndex } from "../scheduler/trigger-index.ts";
import type { Action, SpaceScopeAndURI } from "../scheduler/types.ts";
import type {
  IMemorySpaceAddress,
  StorageNotification,
  TransactionReactivityLog,
} from "../storage/interface.ts";

/**
 * One named part of a result's dependencies, as the lists its reads were
 * observed in. A part that recurs with the same lists keeps its place in the
 * cache's index.
 */
export type ViewReadPart = {
  /** The recursive reads. */
  reads: readonly (readonly IMemorySpaceAddress[])[];
  /** The shallow reads. */
  shallowReads: readonly (readonly IMemorySpaceAddress[])[];
};

/** A part as the index holds it, under a reader of its own. */
type IndexedPart = ViewReadPart & {
  reader: Action;
  entities: Set<SpaceScopeAndURI>;
};

/** Whether two parts' lists name the same addresses, list by list. */
function sameLists(
  a: readonly (readonly IMemorySpaceAddress[])[],
  b: readonly (readonly IMemorySpaceAddress[])[],
): boolean {
  return a.length === b.length &&
    a.every((list, index) =>
      list === b[index] || sameAddresses(list, b[index])
    );
}

/** Retains a planner result until its observed reads change under its identity. */
export class ViewReadCache<Value> {
  #index: SchedulerTriggerIndex;
  #parts = new Map<string, IndexedPart>();
  #value: Value | undefined;

  /** Binds dependency matching to the viewing session's scope instances. */
  constructor(identity: ScopeKeyIdentity) {
    this.#index = new SchedulerTriggerIndex(() => identity);
  }

  /** Cached result, absent after an observed change or before the first read. */
  get value(): Value | undefined {
    return this.#value;
  }

  /** Replaces the result and its recursive and shallow read dependencies. */
  set(
    value: Value,
    log: Pick<TransactionReactivityLog, "reads" | "shallowReads">,
  ): void {
    this.setParts(
      value,
      new Map([["", { reads: [log.reads], shallowReads: [log.shallowReads] }]]),
    );
  }

  /**
   * Replaces the result and its dependencies, given as named parts. Only a
   * part that is new, or whose lists changed since the result it replaces,
   * is indexed again, so a result whose dependencies mostly recur costs what
   * changed rather than what it reads.
   */
  setParts(value: Value, parts: ReadonlyMap<string, ViewReadPart>): void {
    const next = new Map<string, IndexedPart>();
    for (const [key, part] of parts) {
      const previous = this.#parts.get(key);
      if (
        previous !== undefined && sameLists(previous.reads, part.reads) &&
        sameLists(previous.shallowReads, part.shallowReads)
      ) {
        next.set(key, previous);
        continue;
      }
      const reader: Action = () => {};
      const { entities } = this.#index.addActionReads(
        reader,
        sortAndCompactPaths(part.reads.flat()),
        sortAndCompactPaths(part.shallowReads.flat(), false),
      );
      next.set(key, { ...part, reader, entities });
    }
    for (const [key, previous] of this.#parts) {
      if (next.get(key) === previous) continue;
      this.#index.removeActionFromEntities(previous.reader, previous.entities);
    }
    this.#parts = next;
    this.#value = value;
  }

  /** Invalidates the result using the scheduler's value and path change rules. */
  notify(notification: StorageNotification): void {
    if (this.#value === undefined) return;
    if (notification.type === "reset") {
      this.#value = undefined;
      return;
    }
    for (const change of notification.changes) {
      if (
        this.#index.collectTriggeredActionsForChange(
          notification.space,
          change,
        ).triggeredActions.length > 0
      ) {
        this.#value = undefined;
        return;
      }
    }
  }
}
