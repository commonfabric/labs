/** Reports every measured scheduler run within a test initialization or step. */

import type {
  ActionReadStats,
  RuntimeTelemetryMarker,
} from "@commonfabric/runner";

/** Read totals and maximum per-run accesses for one source or builtin. */
interface ActionRow {
  /** Authored source location or builtin name. */
  label: string;

  /** Number of measured runs. */
  runs: number;

  /** Sum of per-run counters. */
  reads: ActionReadStats;

  /** Largest access count of any individual run. */
  maxAccesses: number;
}

/**
 * Collects completion events independently of the scheduler's bounded graph
 * history, including actions created and removed within the measured step.
 */
export class ActionReadReport {
  #rows = new Map<string, ActionRow>();

  /** Records one completion event when it carries read accounting. */
  record(marker: RuntimeTelemetryMarker): void {
    if (marker.type !== "scheduler.run.complete" || !marker.reads) return;
    const reads = marker.reads;
    const key = marker.src !== undefined
      ? `source:${marker.src}`
      : marker.actionInfo?.moduleName !== undefined
      ? `builtin:${marker.actionInfo.moduleName}`
      : `action:${marker.actionId}`;
    const row = this.#rows.get(key);
    if (row) {
      row.runs++;
      row.maxAccesses = Math.max(row.maxAccesses, reads.proxyAccesses);
      row.reads.proxyAccesses += reads.proxyAccesses;
      row.reads.linkResolutions += reads.linkResolutions;
      row.reads.distinctDocuments += reads.distinctDocuments;
      row.reads.registeredDependencies += reads.registeredDependencies;
    } else {
      this.#rows.set(key, {
        label: marker.src ?? marker.actionInfo?.moduleName ?? marker.actionId,
        runs: 1,
        reads: { ...reads },
        maxAccesses: reads.proxyAccesses,
      });
    }
  }

  /** Discards the preceding measurement before a new step begins. */
  clear(): void {
    this.#rows.clear();
  }

  /**
   * Formats totals over all runs and the most expensive sources by accesses.
   * Document and dependency totals sum per-run counts, including repeat runs.
   */
  format(label: string, limit: number): string[] {
    const rows = [...this.#rows.values()].sort((a, b) =>
      b.reads.proxyAccesses - a.reads.proxyAccesses || b.runs - a.runs ||
      a.label.localeCompare(b.label)
    );
    const total = rows.reduce((sum, row) => ({
      runs: sum.runs + row.runs,
      accesses: sum.accesses + row.reads.proxyAccesses,
      links: sum.links + row.reads.linkResolutions,
      documents: sum.documents + row.reads.distinctDocuments,
      dependencies: sum.dependencies + row.reads.registeredDependencies,
    }), { runs: 0, accesses: 0, links: 0, documents: 0, dependencies: 0 });
    const widths = [6, 10, 9, 10, 12, 12];
    const columns = (values: readonly (number | string)[]) =>
      values.map((value, i) => String(value).padStart(widths[i])).join(" ");
    return [
      `    Read cost (${label}): ${total.runs} runs, ${total.accesses} accesses, ${total.links} link hops, ${total.documents} documents/run summed, ${total.dependencies} dependencies/run summed`,
      `      ${
        columns([
          "runs",
          "accesses",
          "max/run",
          "link hops",
          "docs/run Σ",
          "deps/run Σ",
        ])
      }  source`,
      ...rows.slice(0, limit).map((row) =>
        `      ${
          columns([
            row.runs,
            row.reads.proxyAccesses,
            row.maxAccesses,
            row.reads.linkResolutions,
            row.reads.distinctDocuments,
            row.reads.registeredDependencies,
          ])
        }  ${row.label}`
      ),
    ];
  }
}
