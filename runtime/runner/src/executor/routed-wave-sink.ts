/**
 * The wave commit sink of a tenure with a route
 * (docs/plans/serving-loop-owner-routing.md): a home batch, and a change to
 * the home's access list, go to the sink it wraps, which commits them against
 * this process's store; every other batch and change is a crossing into a
 * space another process may own, and goes to that space's owner through the
 * tenure's routed scope, which commits it there as this process's own sink
 * would have (protocol.md §2b). The owner reports the commit to its own
 * server, so this process reports nothing for it. The reads of the sink's
 * contract stay on the sink it wraps: the store is shared, and the owner
 * re-checks the batch when it applies it.
 */

import type { ServedAclChange } from "@commonfabric/memory/v2/server";
import type { MemorySpace, Result } from "../storage/interface.ts";
import type { RoutedScope } from "./routed-plane.ts";
import { servedAclChangeData } from "./served-acl-change.ts";
import type {
  WaveCommitRejection,
  WaveCommitSink,
  WaveSpaceCommit,
} from "./wave.ts";

/** The message of `error`, for the rejection that carries it. */
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The sink described in the file header: `inner`'s reads and home commits,
 * with every crossing into a space other than `home` sent through `route`.
 */
export function routedWaveCommitSink(
  inner: WaveCommitSink,
  route: RoutedScope,
  home: MemorySpace,
): WaveCommitSink {
  return {
    ...(inner.reportsCommits === undefined
      ? {}
      : { reportsCommits: inner.reportsCommits }),
    currentHeads: (space, docs) => inner.currentHeads(space, docs),
    concurrentWritePaths: (space, doc, sinceSeq) =>
      inner.concurrentWritePaths(space, doc, sinceSeq),
    ...(inner.intrusionSince === undefined ? {} : {
      intrusionSince: (space, doc, sinceSeq, holder) =>
        inner.intrusionSince!(space, doc, sinceSeq, holder),
    }),
    ...(inner.staleReads === undefined ? {} : {
      staleReads: (space, reads, holder) =>
        inner.staleReads!(space, reads, holder),
    }),
    ...(inner.sessionOverwritePathsSince === undefined ? {} : {
      sessionOverwritePathsSince: (space, doc, sinceSeq, session) =>
        inner.sessionOverwritePathsSince!(space, doc, sinceSeq, session),
    }),
    commitWave: async (
      batch: WaveSpaceCommit,
    ): Promise<Result<{ seq: number }, WaveCommitRejection>> => {
      if (batch.home) return await inner.commitWave(batch);
      try {
        return { ok: await route.commit(batch.space, batch) };
      } catch (error) {
        // The owner's refusal and a failure to reach it are both the foreign
        // failure of protocol.md §2b: the home commit is withheld and the
        // event replays, which sends the batch again.
        return {
          error: {
            name: "WaveCommitRejected",
            message: `foreign wave batch into ${batch.space} failed at its ` +
              `owner: ${messageOf(error)}`,
          },
        };
      }
    },
    commitSpaceAccessChange: async (
      change: ServedAclChange,
    ): Promise<Result<{ seq?: number }, WaveCommitRejection>> => {
      if (change.space === home) {
        if (inner.commitSpaceAccessChange === undefined) {
          return {
            error: {
              name: "AclDocumentWriteRefused",
              message: `access-list change to ${change.space} refused: ` +
                "this sink cannot commit one",
            },
          };
        }
        return await inner.commitSpaceAccessChange(change);
      }
      try {
        return {
          ok: await route.acl(
            change.space as MemorySpace,
            servedAclChangeData(change),
          ),
        };
      } catch (error) {
        return {
          error: {
            name: "AclDocumentWriteRefused",
            message: `access-list change to ${change.space} failed at its ` +
              `owner: ${messageOf(error)}`,
          },
        };
      }
    },
  };
}
