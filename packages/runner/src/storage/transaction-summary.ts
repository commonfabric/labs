/**
 * Transaction Summary - Condense transaction details for LLM consumption
 *
 * This module provides functions to extract and condense transaction information
 * into concise summaries suitable for LLMs to help humans debug software behavior.
 */

import {
  type CompactDebugStringOptions,
  toCompactDebugString,
} from "@commonfabric/data-model";

import { entityUriSchemePrefix } from "../entity-kind.ts";
import type { MemorySpace } from "../runtime.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "./interface.ts";
import {
  getDirectTransactionReactivityLog,
  getTransactionWriteDetails,
} from "./transaction-inspection.ts";

/**
 * Rendering options for a written value in a summary line: a glimpse of the
 * value, bounded on every axis, since a line names what changed rather than
 * carrying it.
 */
const SUMMARY_VALUE_OPTIONS: CompactDebugStringOptions = {
  maxLength: 100,
  maxArrayLength: 2,
  maxStringLength: 50,
};

/**
 * Summary of a transaction. Its `summary` line, and the rendering
 * `formatTransactionSummary()` makes of it, are condensed for an LLM to
 * read; `writes` carries each written value as it was written, unbounded,
 * and is not itself meant to be serialized or handed to one.
 */
export interface TransactionSummary {
  /** Human-readable one-line summary */
  summary: string;

  /** Activity statistics */
  activity: {
    reads: number;
    writes: number;
  };

  /** Actual writes, with their values as written */
  writes: WriteDetail[];
}

/**
 * Details of what was actually written
 */
export interface WriteDetail {
  /** Object ID (shortened) */
  objectId: string;

  /** Full object ID */
  fullObjectId: string;

  /** Path that was written to */
  path: string;

  /** The value that was written, as written: a rendering bounds it, this does not */
  value: unknown;

  /** The previous value, as it was, if available */
  previousValue?: unknown;

  /** Whether this was a deletion */
  isDeleted: boolean;
}

/**
 * Create a transaction summary from an IExtendedStorageTransaction, whose
 * summary line is condensed and whose writes carry their values as written
 *
 * @param tx - The completed transaction
 * @param space - Optional memory space to filter changes (defaults to first space found)
 * @returns Summary, its `summary` line condensed for LLM consumption
 */
export function summarizeTransaction(
  tx: IExtendedStorageTransaction,
  space?: MemorySpace,
): TransactionSummary {
  const status = tx.status();

  // Summarize activity
  const activity = summarizeActivity(tx);

  // Extract actual writes with values
  const writes = space ? extractWrites(tx, space) : [];

  // Generate summary
  const summary = generateSummary(activity, writes, status.status);

  return {
    summary,
    activity,
    writes,
  };
}

/**
 * Format transaction summary as a string for LLM consumption
 *
 * @param tx - The completed transaction
 * @param space - Optional memory space to filter changes
 * @returns Formatted string summary
 */
export function formatTransactionSummary(
  tx: IExtendedStorageTransaction,
  space?: MemorySpace,
): string {
  const summary = summarizeTransaction(tx, space);

  const parts: string[] = [];

  // If there are detailed writes, format them grouped by object
  if (summary.writes.length > 0) {
    // Group writes by object
    const byObject = new Map<string, WriteDetail[]>();
    for (const write of summary.writes) {
      const existing = byObject.get(write.fullObjectId) || [];
      existing.push(write);
      byObject.set(write.fullObjectId, existing);
    }

    const objectIds = Array.from(byObject.keys());

    // If single object, skip the header
    if (objectIds.length === 1) {
      const writes = byObject.get(objectIds[0])!;
      for (const write of writes) {
        parts.push(formatWrite(write));
      }
    } else {
      // Multiple objects, show headers
      for (const objectId of objectIds) {
        const writes = byObject.get(objectId)!;
        parts.push(`Object ${shortenId(objectId)}:`);
        for (const write of writes) {
          parts.push(`  ${formatWrite(write)}`);
        }
      }
    }
  } else if (summary.activity.writes > 0 && !space) {
    // Hint that we need the space parameter
    parts.push("(pass space parameter to see what was written)");
  } else {
    // No writes or writes occurred elsewhere - show generic summary
    parts.push(summary.summary);
  }

  // Add read count if significant
  if (summary.activity.reads > 10) {
    parts.push(`(${summary.activity.reads} reads for context)`);
  }

  return parts.join("\n");
}

/**
 * Format a single write as "path: old → new" or "path = value"
 */
function formatWrite(write: WriteDetail): string {
  if (write.isDeleted) {
    return `${write.path}: deleted`;
  }

  const newVal = toCompactDebugString(write.value, SUMMARY_VALUE_OPTIONS);

  // If we have previous value, show before → after
  if (write.previousValue !== undefined) {
    const oldVal = toCompactDebugString(
      write.previousValue,
      SUMMARY_VALUE_OPTIONS,
    );
    return `${write.path}: ${oldVal} → ${newVal}`;
  }

  // No previous value, just show assignment
  return `${write.path} = ${newVal}`;
}

/**
 * Debug helper to see all write operations regardless of space
 * Useful for understanding what's happening when writes aren't showing up
 */
export function debugTransactionWrites(
  tx: IExtendedStorageTransaction,
): string {
  const status = tx.status();

  const parts: string[] = [];
  parts.push("=== Transaction Debug ===");

  // List all write operations from activity
  const writes: IMemorySpaceAddress[] = [];
  const directLog = getDirectTransactionReactivityLog(tx);
  if (directLog) {
    for (const write of directLog.writes) writes.push(write);
  } else {
    for (const activity of status.journal.activity()) {
      if ("write" in activity && activity.write) {
        writes.push(activity.write);
      }
    }
  }

  parts.push(`Total writes in activity: ${writes.length}`);

  for (const write of writes) {
    const pathStr = write.path.join(".");
    parts.push(`  Write to: ${write.id}/${pathStr} (space: ${write.space})`);
  }

  // List all spaces that have novelty
  parts.push("\nSpaces with novelty:");
  const spaces = new Set<MemorySpace>();
  for (const write of writes) {
    spaces.add(write.space);
  }

  for (const space of spaces) {
    const noveltyCount =
      Array.from(getTransactionWriteDetails(tx, space)).length;
    parts.push(`  ${space}: ${noveltyCount} attestation(s)`);
  }

  return parts.join("\n");
}

/**
 * Summarize activity from transaction journal
 */
function summarizeActivity(tx: IExtendedStorageTransaction): {
  reads: number;
  writes: number;
} {
  const directLog = getDirectTransactionReactivityLog(tx);
  if (directLog) {
    return {
      reads: directLog.reads.length + directLog.shallowReads.length,
      writes: directLog.writes.length,
    };
  }

  let reads = 0;
  let writes = 0;

  for (const activity of tx.journal.activity()) {
    if ("read" in activity) {
      reads++;
    } else if ("write" in activity) {
      writes++;
    }
  }

  return { reads, writes };
}

/**
 * Extract actual writes with their values from novelty attestations
 */
function extractWrites(
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
): WriteDetail[] {
  const writes: WriteDetail[] = [];

  for (const detail of getTransactionWriteDetails(tx, space)) {
    const fullObjectId = detail.address.id;
    const path = detail.address.path.join(".");
    const value = detail.value;
    const isDeleted = value === undefined;

    writes.push({
      objectId: shortenId(fullObjectId),
      fullObjectId,
      path,
      value,
      previousValue: detail.previousValue,
      isDeleted,
    });
  }

  return writes;
}

/**
 * Generate a human-readable summary
 */
function generateSummary(
  activity: { writes: number; reads: number },
  writes: WriteDetail[],
  status: string,
): string {
  if (status === "error") {
    return "Transaction failed";
  }

  if (activity.writes === 0 && activity.reads === 0) {
    return "Empty transaction";
  }

  if (activity.writes === 0) {
    return "Read-only transaction";
  }

  if (writes.length === 0) {
    return `${activity.writes} write(s) (details unavailable without space parameter)`;
  }

  // Describe the actual writes
  const parts: string[] = [];

  for (const write of writes.slice(0, 3)) {
    if (write.isDeleted) {
      parts.push(`Deleted ${write.path}`);
    } else {
      const valueStr = toCompactDebugString(write.value, SUMMARY_VALUE_OPTIONS);
      parts.push(`${write.path} = ${valueStr}`);
    }
  }

  if (writes.length > 3) {
    parts.push(`... and ${writes.length - 3} more`);
  }

  return parts.join("; ");
}

/**
 * Shorten an ID for display
 */
function shortenId(id: string): string {
  // Entity URI schemes: `of:` drops for brevity; kinded schemes stay
  // visible — the hash preimage is kind-free, so the scheme is the only
  // difference from a state sibling of the same cause.
  const entityScheme = entityUriSchemePrefix(id);
  if (entityScheme !== undefined && entityScheme !== "of:") {
    return entityScheme + id.slice(entityScheme.length).substring(0, 12) +
      "...";
  }
  if (entityScheme === "of:") {
    return id.slice(entityScheme.length).substring(0, 12) + "...";
  }
  if (id.length > 20) {
    return id.substring(0, 20) + "...";
  }
  return id;
}
