import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import { toDocumentPath } from "@commonfabric/memory/v2";

import { canonicalizeDocumentPath } from "../cfc/canonical.ts";
import {
  type NormalizedFullLink,
  toMemorySpaceAddress,
} from "../link-utils.ts";
import { arraysOverlap } from "../reactive-dependencies.ts";
import { normalizeCellScope } from "../scope.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  TransactionReactivityLog,
} from "../storage/interface.ts";
import { localReadWakeDependencies } from "../storage/local-read-policy.ts";
import { reactivityLogFromActivities } from "../storage/reactivity-log.ts";
import {
  getDirectTransactionReactivityLog,
  getTransactionWriteDetails,
} from "../storage/transaction-inspection.ts";
import type {
  AnnotatedEventHandler,
  EventHandler,
  ReactivityLog,
} from "./types.ts";

export function hasAnnotatedWrites(
  handler: EventHandler,
): handler is AnnotatedEventHandler {
  return "writes" in handler && Array.isArray(handler.writes);
}

export function trustedEventWriteCandidatesFromTransaction(
  tx: IExtendedStorageTransaction,
  handler: EventHandler,
  fallbackSpaces: Iterable<MemorySpace> = [],
): NormalizedFullLink[] {
  const candidates: NormalizedFullLink[] = [];
  const seen = new Map<string, number>();
  const detailSpaces = new Set<MemorySpace>(fallbackSpaces);

  // A link names a field by its logical path; a transaction address is rooted
  // at the stored document, so the caller hands over the path already mapped
  // to logical form.
  const addCandidate = (
    write: NormalizedFullLink | IMemorySpaceAddress,
    path: readonly string[],
  ) => {
    const candidate: NormalizedFullLink = {
      space: write.space,
      id: write.id,
      // Transaction memory addresses may omit scope for legacy/default-space writes.
      scope: write.scope ?? "space",
      path: [...path],
      ...("schema" in write && write.schema !== undefined
        ? { schema: write.schema }
        : {}),
    };
    const key = `${candidate.space}/${candidate.id}/${
      candidate.path.join("/")
    }`;
    const existingIndex = seen.get(key);
    if (existingIndex !== undefined) {
      if (
        candidates[existingIndex].schema === undefined &&
        candidate.schema !== undefined
      ) {
        candidates[existingIndex] = {
          ...candidates[existingIndex],
          schema: candidate.schema,
        };
      }
      return;
    }
    seen.set(key, candidates.length);
    candidates.push(candidate);
  };

  if (hasAnnotatedWrites(handler)) {
    for (const write of handler.writes) {
      addCandidate(write, write.path);
      detailSpaces.add(write.space);
    }
  }

  const transactionLog = txToTransactionReactivityLog(tx);
  for (
    const write of [
      ...transactionLog.writes,
      ...(transactionLog.attemptedWrites ?? []),
    ]
  ) {
    // The reactivity log records the journal's document-rooted paths. A write
    // to one of the document's own members names no link.
    const path = canonicalizeDocumentPath(toDocumentPath(write.path));
    if (path !== undefined) addCandidate(write, path);
    detailSpaces.add(write.space);
  }

  for (const input of tx.getCfcState().writePolicyInputs) {
    if (input.kind === "schema") {
      addCandidate({
        space: input.target.space,
        id: input.target.id as URI,
        path: input.target.path,
        ...(input.schema !== undefined ? { schema: input.schema } : {}),
      }, input.target.path);
      detailSpaces.add(input.target.space);
    }
  }

  for (const space of detailSpaces) {
    for (const detail of getTransactionWriteDetails(tx, space)) {
      const path = canonicalizeDocumentPath(detail.address.path);
      if (path !== undefined) addCandidate(detail.address, path);
    }
  }

  return candidates;
}

function addressMatchesLinkPrefix(
  address: IMemorySpaceAddress,
  link: NormalizedFullLink,
): boolean {
  const documentAddress = toMemorySpaceAddress(link);
  return address.space === link.space &&
    address.id === link.id &&
    normalizeCellScope(address.scope) === link.scope &&
    arraysOverlap(documentAddress.path, address.path);
}

export function filterIgnoredAddresses(
  addresses: readonly IMemorySpaceAddress[] | undefined,
  ignoredWrites: readonly NormalizedFullLink[],
): IMemorySpaceAddress[] {
  if (!addresses?.length || ignoredWrites.length === 0) {
    return addresses ? [...addresses] : [];
  }

  return addresses.filter((address) =>
    !ignoredWrites.some((link) => addressMatchesLinkPrefix(address, link))
  );
}

export function txToReactivityLog(
  tx: IExtendedStorageTransaction,
): ReactivityLog {
  const log = toSchedulerReactivityLog(txToTransactionReactivityLog(tx));
  const wakes = localReadWakeDependencies(tx);
  return wakes.length === 0 ? log : { ...log, reads: [...log.reads, ...wakes] };
}

function txToTransactionReactivityLog(
  tx: IExtendedStorageTransaction,
): TransactionReactivityLog {
  const direct = getDirectTransactionReactivityLog(tx);
  if (direct) {
    return direct;
  }
  return reactivityLogFromActivities(tx.journal.activity());
}

function toSchedulerReactivityLog(
  log: TransactionReactivityLog,
): ReactivityLog {
  return {
    reads: log.reads,
    shallowReads: log.shallowReads,
    writes: log.writes,
  };
}
